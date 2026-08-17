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

export interface ReconcileOptions {
	conflictPolicy: ConflictPolicy;
	deleteConflictPolicy: DeleteConflictPolicy;
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
					assign(merged, field, local[field]);
					remoteNeedsUpdate = true;
				} else {
					assign(merged, field, remote[field]);
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

// --- Top-level decision ------------------------------------------------------

export function reconcile(input: ReconcileInput, options: ReconcileOptions): SyncAction {
	const { base, local, remote } = input;

	if (!local && !remote) {
		// Both sides gone. Whatever we were tracking is finished.
		return base ? { kind: "forget" } : { kind: "noop" };
	}

	if (!base) {
		if (local && !remote) return { kind: "createRemote", snapshot: local };
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
		// Remote was deleted. Only safe to mirror that if the note is untouched.
		if (snapshotsEqual(local, base)) return { kind: "deleteLocal" };
		return options.deleteConflictPolicy === "propagateDelete"
			? { kind: "deleteLocal" }
			: { kind: "restoreRemote", snapshot: local };
	}

	// remote && !local — the note was deleted.
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
