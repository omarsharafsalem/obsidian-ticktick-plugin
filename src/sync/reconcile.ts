import { SYNCED_FIELDS, type SyncedField, type Task } from "../api/types";

/**
 * Three-way merge for tasks.
 *
 * Every decision this plugin makes about "who wins" lives here, as pure
 * functions over plain data. The engine that performs the reads and writes
 * contains no policy of its own.
 *
 * The three inputs are:
 *   base   — the state at the end of the last successful sync
 *   local  — the note as it stands now
 *   remote — the TickTick task as it stands now
 *
 * Comparing both sides against `base` is what makes it possible to tell an edit
 * from a stale value. Without it, a two-way sync can only guess, which is how
 * you end up with a completed task quietly reopening itself.
 */

export type TaskSnapshot = Pick<Task, SyncedField>;

export type ConflictPolicy = "newest" | "preferRemote" | "preferLocal";

/** What to do when one side was deleted while the other was edited. */
export type DeleteConflictPolicy = "restore" | "propagateDelete";

/**
 * What happens to a note when its task is deleted in TickTick.
 *
 * "keepNote" leaves it in place and stops syncing it, treating the vault as the
 * durable record — deleting finished tasks in TickTick is housekeeping, not an
 * instruction to erase the history of the work.
 */
export type RemoteDeletionPolicy = "keepNote" | "deleteNote";

/**
 * What happens to a TickTick task when its note is missing.
 *
 * "keepTask" is the default and means the plugin never deletes in TickTick.
 * A note can be missing for many reasons that are not deletion — an unmatched
 * id, a marker rule, a moved folder, a failed read — and every one of them
 * looks the same from here. Recreating a note is free; recreating a task and
 * its history is not.
 */
export type NoteDeletionPolicy = "keepTask" | "deleteTask";

export interface ReconcileOptions {
	conflictPolicy: ConflictPolicy;
	deleteConflictPolicy: DeleteConflictPolicy;
	/** What to do with the note when its task disappears from TickTick. */
	remoteDeletion: RemoteDeletionPolicy;
	/** What to do with the task when its note is missing. */
	noteDeletion: NoteDeletionPolicy;
	/**
	 * Whether the note already carries a task id.
	 *
	 * A note that does is not new, whatever the stored state says. Without this,
	 * clearing the state turns every note whose task has since been deleted into
	 * a fresh task -- one reset quietly recreating everything that was tidied up.
	 */
	localWasLinked?: boolean;
	/**
	 * Whether the note's absence has actually been established.
	 *
	 * False means "not seen this pass", which is not evidence of anything. Only
	 * a note confirmed gone — across more than one pass — may delete a task.
	 */
	noteConfirmedGone?: boolean;
	/** Epoch ms of the note's last modification, when known. */
	localModifiedAt?: number;
	/** Epoch ms of the remote task's last modification, when known. */
	remoteModifiedAt?: number;
	/**
	 * Fields for which `base` holds a meaningful value. Omit to treat the whole
	 * base as meaningful, which is the normal case; the direction masking in
	 * `fieldModes` uses it to synthesise a base for constrained fields only.
	 */
	baseFields?: Set<SyncedField>;
}

export type SyncAction =
	| { kind: "noop" }
	| { kind: "createRemote"; snapshot: TaskSnapshot }
	| { kind: "createLocal"; snapshot: TaskSnapshot }
	| { kind: "updateRemote"; snapshot: TaskSnapshot; conflicts: SyncedField[] }
	| { kind: "updateLocal"; snapshot: TaskSnapshot; conflicts: SyncedField[] }
	| { kind: "updateBoth"; snapshot: TaskSnapshot; conflicts: SyncedField[] }
	| { kind: "deleteLocal" }
	/** Remote is gone but the note is kept, and stops syncing, as a record. */
	| { kind: "orphanLocal" }
	| { kind: "deleteRemote" }
	| { kind: "restoreRemote"; snapshot: TaskSnapshot }
	| { kind: "restoreLocal"; snapshot: TaskSnapshot }
	| { kind: "forget" };

export interface ReconcileInput {
	base?: TaskSnapshot;
	local?: TaskSnapshot;
	remote?: TaskSnapshot;
}

// --- Equality ----------------------------------------------------------------

function normaliseText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function tagsEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const left = [...a].map((t) => t.toLowerCase()).sort();
	const right = [...b].map((t) => t.toLowerCase()).sort();
	return left.every((value, index) => value === right[index]);
}

export function fieldsEqual(field: SyncedField, a: unknown, b: unknown): boolean {
	if (field === "tags") {
		return tagsEqual((a as string[]) ?? [], (b as string[]) ?? []);
	}

	if (field === "reminders") {
		const left = [...(((a as string[]) ?? []))].sort();
		const right = [...(((b as string[]) ?? []))].sort();
		return left.length === right.length && left.every((value, i) => value === right[i]);
	}

	if (field === "items") {
		const left = (a as Task["items"]) ?? [];
		const right = (b as Task["items"]) ?? [];
		return (
			left.length === right.length &&
			left.every(
				(item, i) =>
					normaliseText(item.title) === normaliseText(right[i]?.title ?? "") &&
					item.completed === right[i]?.completed,
			)
		);
	}

	if (field === "title" || field === "content") {
		return normaliseText((a as string) ?? "") === normaliseText((b as string) ?? "");
	}

	if (field === "dueDate" || field === "startDate") {
		// Absent and empty mean the same thing; compare as instants otherwise.
		const left = a ? new Date(a as string).getTime() : null;
		const right = b ? new Date(b as string).getTime() : null;
		return left === right;
	}

	return a === b;
}

export function snapshotsEqual(a: TaskSnapshot, b: TaskSnapshot): boolean {
	return SYNCED_FIELDS.every((field) => fieldsEqual(field, a[field], b[field]));
}

export function changedFields(from: TaskSnapshot, to: TaskSnapshot): SyncedField[] {
	return SYNCED_FIELDS.filter((field) => !fieldsEqual(field, from[field], to[field]));
}

// --- Field-level merge -------------------------------------------------------

type FieldOutcome = "same" | "takeLocal" | "takeRemote" | "conflict";

function resolveField(
	field: SyncedField,
	base: TaskSnapshot | undefined,
	local: TaskSnapshot,
	remote: TaskSnapshot,
	baseFields?: Set<SyncedField>,
): FieldOutcome {
	if (fieldsEqual(field, local[field], remote[field])) return "same";

	// No base means these two records were only just linked. There is no way to
	// tell which side changed, so this is a genuine conflict.
	if (!base || (baseFields && !baseFields.has(field))) return "conflict";

	const localChanged = !fieldsEqual(field, local[field], base[field]);
	const remoteChanged = !fieldsEqual(field, remote[field], base[field]);

	if (localChanged && !remoteChanged) return "takeLocal";
	if (remoteChanged && !localChanged) return "takeRemote";
	return "conflict";
}

function conflictWinner(options: ReconcileOptions): "local" | "remote" {
	if (options.conflictPolicy === "preferLocal") return "local";
	if (options.conflictPolicy === "preferRemote") return "remote";

	const { localModifiedAt, remoteModifiedAt } = options;
	if (localModifiedAt !== undefined && remoteModifiedAt !== undefined) {
		return localModifiedAt >= remoteModifiedAt ? "local" : "remote";
	}

	// The official API reports no modification time, so "newest" is not
	// answerable. Favour the server, which is the side other devices also see.
	return "remote";
}

export interface MergeResult {
	snapshot: TaskSnapshot;
	conflicts: SyncedField[];
	localNeedsUpdate: boolean;
	remoteNeedsUpdate: boolean;
}

export function mergeSnapshots(
	base: TaskSnapshot | undefined,
	local: TaskSnapshot,
	remote: TaskSnapshot,
	options: ReconcileOptions,
): MergeResult {
	const merged = { ...remote } as TaskSnapshot;
	const conflicts: SyncedField[] = [];
	let localNeedsUpdate = false;
	let remoteNeedsUpdate = false;

	const winner = conflictWinner(options);

	for (const field of SYNCED_FIELDS) {
		const outcome = resolveField(field, base, local, remote, options.baseFields);

		switch (outcome) {
			case "same":
				assign(merged, field, remote[field]);
				break;
			case "takeLocal":
				assign(merged, field, local[field]);
				remoteNeedsUpdate = true;
				break;
			case "takeRemote":
				assign(merged, field, remote[field]);
				localNeedsUpdate = true;
				break;
			case "conflict":
				conflicts.push(field);
				if (winner === "local") {
					assign(merged, field, preferNonEmpty(field, local[field], remote[field]));
					remoteNeedsUpdate = true;
				} else {
					assign(merged, field, preferNonEmpty(field, remote[field], local[field]));
					localNeedsUpdate = true;
				}
				break;
		}
	}

	return { snapshot: merged, conflicts, localNeedsUpdate, remoteNeedsUpdate };
}

function assign(target: TaskSnapshot, field: SyncedField, value: unknown): void {
	(target as Record<string, unknown>)[field] = value;
}

/**
 * Never let nothing overwrite something.
 *
 * TickTick descriptions are usually empty while the note may hold real writing,
 * and on a first link-up there is no base to tell who changed what — so the
 * merge would hand the empty side the win and the writing would be gone.
 * Clearing text deliberately still works: it just has to be done on the side
 * that has the text.
 */
function preferNonEmpty(field: SyncedField, chosen: unknown, other: unknown): unknown {
	if (field !== "content" && field !== "title") return chosen;
	const isBlank = (value: unknown) => typeof value !== "string" || value.trim() === "";
	return isBlank(chosen) && !isBlank(other) ? other : chosen;
}

// --- Top-level decision ------------------------------------------------------

export function reconcile(input: ReconcileInput, options: ReconcileOptions): SyncAction {
	const { base, local, remote } = input;

	if (!local && !remote) {
		// Both sides gone. Whatever we were tracking is finished.
		return base ? { kind: "forget" } : { kind: "noop" };
	}

	if (!base) {
		if (local && !remote) {
			// Carrying an id means this pair was linked before, so a missing task
			// means the task was deleted — not that the note is new. Creating here
			// would resurrect everything deleted since the state was last cleared.
			if (options.localWasLinked) {
				return options.remoteDeletion === "keepNote"
					? { kind: "orphanLocal" }
					: { kind: "deleteLocal" };
			}
			return { kind: "createRemote", snapshot: local };
		}
		if (remote && !local) return { kind: "createLocal", snapshot: remote };
		// Both exist but were never synced together — first link-up.
		const merged = mergeSnapshots(undefined, local!, remote!, options);
		return decideUpdate(merged);
	}

	if (local && remote) {
		const merged = mergeSnapshots(base, local, remote, options);
		return decideUpdate(merged);
	}

	if (local && !remote) {
		// Remote was deleted. Pruning finished tasks in TickTick is routine
		// housekeeping, while the note is often the only record that the work
		// happened — so keeping it is the default rather than mirroring.
		if (options.remoteDeletion === "keepNote") return { kind: "orphanLocal" };

		// Only safe to mirror the delete if the note is untouched.
		if (snapshotsEqual(local, base)) return { kind: "deleteLocal" };
		return options.deleteConflictPolicy === "propagateDelete"
			? { kind: "deleteLocal" }
			: { kind: "restoreRemote", snapshot: local };
	}

	// remote && !local — the note is missing.
	//
	// Restoring it is the safe reading and the default: the task still exists,
	// so the note can simply be written again. Deleting the task is only
	// considered when asked for, and then only once the note has actually been
	// established as gone rather than merely absent from one pass.
	if (options.noteDeletion !== "deleteTask" || !options.noteConfirmedGone) {
		return { kind: "restoreLocal", snapshot: remote! };
	}

	if (snapshotsEqual(remote!, base)) return { kind: "deleteRemote" };
	return options.deleteConflictPolicy === "propagateDelete"
		? { kind: "deleteRemote" }
		: { kind: "restoreLocal", snapshot: remote! };
}

function decideUpdate(merged: MergeResult): SyncAction {
	const { snapshot, conflicts, localNeedsUpdate, remoteNeedsUpdate } = merged;

	if (localNeedsUpdate && remoteNeedsUpdate) {
		return { kind: "updateBoth", snapshot, conflicts };
	}
	if (remoteNeedsUpdate) return { kind: "updateRemote", snapshot, conflicts };
	if (localNeedsUpdate) return { kind: "updateLocal", snapshot, conflicts };
	return { kind: "noop" };
}

/** Reduces a full task to the fields that participate in merging. */
export function toSnapshot(task: Task): TaskSnapshot {
	const snapshot = {} as TaskSnapshot;
	for (const field of SYNCED_FIELDS) {
		assign(snapshot, field, task[field]);
	}
	return snapshot;
}
