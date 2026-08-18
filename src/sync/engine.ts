import type { TFile } from "obsidian";
import type { TickTickClient } from "../api/client";
import { blankTask, type NewTask, type Project, type Task } from "../api/types";
import type { TickTickSyncSettings } from "../settings";
import { NoteRepository, parentFolder, taskNotePath } from "../vault/notes";
import { applyFieldModes } from "./fieldModes";
import {
	noteToTask,
	parsedNoteToTask,
	resolveTitle,
	restoreItemMetadata,
	sanitiseFilename,
	taskToNote,
	type NoteContext,
	type TaskLink,
} from "./mapper";
import { reconcile, toSnapshot, type SyncAction, type TaskSnapshot } from "./reconcile";
import type { SyncEntry, SyncStore } from "./state";

/**
 * Drives one full synchronisation pass.
 *
 * The engine performs I/O and nothing else — every "who wins" decision is
 * delegated to `reconcile`, and every direction rule to `fieldModes`. That
 * split is what keeps the policy testable without a vault or a network.
 */

export interface SyncReport {
	createdLocal: number;
	createdRemote: number;
	updatedLocal: number;
	updatedRemote: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	errors: string[];
	durationMs: number;
	/** Every change a dry run would have made, in the order it would make them. */
	planned: string[];
}

function emptyReport(): SyncReport {
	return {
		createdLocal: 0,
		createdRemote: 0,
		updatedLocal: 0,
		updatedRemote: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: 0,
		errors: [],
		durationMs: 0,
		planned: [],
	};
}

export interface EngineDeps {
	client: TickTickClient;
	notes: NoteRepository;
	store: SyncStore;
	settings: TickTickSyncSettings;
	persist: () => Promise<void>;
	log: (message: string, ...rest: unknown[]) => void;
	/**
	 * Asked before anything is deleted. Returning false skips that deletion.
	 *
	 * Absent means "go ahead", so a headless run still works; the plugin supplies
	 * a prompt when the setting is on.
	 */
	confirmDeletion?: (request: DeletionRequest) => Promise<boolean>;
}

/** What is about to be deleted, and the reasoning that led there. */
export interface DeletionRequest {
	what: "task" | "note";
	title: string;
	/** Plain-language account of why the sync believes this should go. */
	reason: string;
	notePath?: string;
}

interface LocalNote {
	file: TFile;
	snapshot: TaskSnapshot;
	taskId?: string;
	mtime: number;
	/** Everything below the marker, put back verbatim on every write. */
	privateBody: string;
	/** What the status property says now, so an equivalent wording survives. */
	statusLabel?: string;
}

/** A remote record plus the extra context the engine needs to write it back. */
interface RemoteRecord {
	task: Task;
	snapshot: TaskSnapshot;
}

/** Parent and child relationships, resolved across every task in one pass. */
interface TaskLinkIndex {
	contextFor: (task: Task) => NoteContext;
	resolveTaskLink: (target: string) => string | undefined;
}

const NO_LINKS: TaskLinkIndex = {
	contextFor: () => ({}),
	resolveTaskLink: () => undefined,
};

export class SyncEngine {
	private running = false;

	/**
	 * Rebuilt at the start of each pass, once the remote tasks are known.
	 *
	 * Held as state rather than threaded through every write because a pass is
	 * single-flight — `running` guarantees no two overlap.
	 */
	private links: TaskLinkIndex = NO_LINKS;

	/** Real project ids that stand for a project listed under a reserved id. */
	private inboxAliases = new Map<string, string>();

	/** Report what would change and write nothing. Set for the run's duration. */
	private dryRun = false;

	/**
	 * Whether the completed-task list was read successfully this pass.
	 *
	 * It is what makes a missing task readable as deleted rather than finished.
	 * Without it nothing may be concluded from absence at all.
	 */
	private completedFetched = false;

	constructor(private readonly deps: EngineDeps) {}

	get isRunning(): boolean {
		return this.running;
	}

	async sync(options: { dryRun?: boolean } = {}): Promise<SyncReport> {
		this.dryRun = options.dryRun === true;
		if (this.running) {
			throw new Error("A sync is already in progress");
		}
		this.running = true;
		const started = Date.now();
		const report = emptyReport();

		try {
			const projects = await this.loadProjects();
			const projectNames = new Map(projects.map((p) => [p.id, p.name]));
			this.inboxAliases.clear();
			this.completedFetched = false;
			const remote = await this.loadRemoteTasks(projects, report);

			// Fold in any real id discovered while reading tasks, so a task in the
			// Inbox resolves to its name and to any folder mapped for it.
			for (const [realId, listedId] of this.inboxAliases) {
				const name = projectNames.get(listedId);
				if (name && !projectNames.has(realId)) projectNames.set(realId, name);
			}
			this.links = this.buildLinkIndex(remote, projectNames);
			const local = await this.loadLocalNotes(report, projectNames);

			// Before anything else: give a note that has lost its id back the task
			// it belongs to. Left until later, reconcile sees an orphaned task and
			// restores a second note for it, while the note itself looks new and
			// gets a second task — one broken property becoming two duplicates.
			await this.adoptOrphanedTasks(local, remote, report);

			await this.reconcileAll({
				remote,
				local,
				projectNames,
				report,
				syncedProjects: new Set(projectNames.keys()),
			});
			await this.createUnlinkedNotes(local, remote, projectNames, report);

			this.deps.store.markSynced();
			await this.deps.persist();
		} catch (error) {
			report.errors.push(describeError(error));
		} finally {
			this.running = false;
			report.durationMs = Date.now() - started;
		}

		return report;
	}

	// --- Loading ------------------------------------------------------------

	private async loadProjects(): Promise<Project[]> {
		const all = await this.deps.client.listProjects();
		const filter = this.deps.settings.projectFilter;
		const selected = filter.length === 0 ? all : all.filter((p) => filter.includes(p.id));
		return selected.filter((project) => !project.closed);
	}

	private async loadRemoteTasks(
		projects: Project[],
		report: SyncReport,
	): Promise<Map<string, RemoteRecord>> {
		const remote = new Map<string, RemoteRecord>();

		for (const project of projects) {
			try {
				for (const task of await this.deps.client.listTasksInProject(project.id)) {
					if (!task.id) continue;
					// The Inbox is listed under a reserved id, but its tasks come back
					// carrying the account's real one — so nothing downstream matches
					// and the list shows as a raw id. Teach the map the real one.
					if (task.projectId !== project.id) {
						this.inboxAliases.set(task.projectId, project.id);
					}
					remote.set(task.id, { task, snapshot: toSnapshot(task) });
				}
			} catch (error) {
				report.errors.push(`Failed to read list "${project.name}": ${describeError(error)}`);
			}
		}

		// Completed tasks drop out of the project listing, so they are always
		// fetched — not because they are wanted as notes, but because they are the
		// evidence that separates "completed" from "deleted". Without them, a task
		// missing from the listing is ambiguous, and the direct fetch cannot settle
		// it: TickTick deletes to a trash and serves trashed tasks like live ones.
		//
		// Whether a completed task also *becomes* a note is a separate question,
		// answered in reconcileOne.
		if (this.deps.client.capabilities.completedHistory) {
			try {
				const to = new Date();
				const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
				const completed = await this.deps.client.listCompletedTasks(
					from,
					to,
					projects.map((p) => p.id),
				);
				for (const task of completed) {
					if (task.id && !remote.has(task.id)) {
						remote.set(task.id, { task, snapshot: toSnapshot(task) });
					}
				}
				this.completedFetched = true;
			} catch (error) {
				report.errors.push(`Failed to read completed tasks: ${describeError(error)}`);
			}
		}

		this.deps.log("Fetched from TickTick", {
			lists: projects.map((p) => p.name),
			tasks: remote.size,
			// Titles and ids together, so a note that reappeared can be checked
			// against what the account actually still holds.
			titles: [...remote.values()].map((r) => `${r.task.title} — ${r.task.id}`),
		});

		return remote;
	}

	private async loadLocalNotes(
		report: SyncReport,
		projectNames: Map<string, string>,
	): Promise<LocalNote[]> {
		const { notes, settings, store } = this.deps;

		// Scanning the whole vault is only safe with a marker to identify tasks by;
		// without one every note in the vault would look like a task.
		const marker = settings.taskMarker;
		const markerActive = marker.property.trim() !== "";
		const files = notes.listMarkdown(
			markerActive && settings.discoverAnywhere ? "" : settings.taskFolder,
		);

		// The list property holds a name, or a link to the list's own note, so
		// reading a note means turning either back into an id. Matched
		// case-insensitively, since the value is hand-editable.
		const idsByName = new Map<string, string>();
		for (const [id, name] of projectNames) idsByName.set(name.trim().toLowerCase(), id);

		// A configured project note is matched by its full path and by its
		// basename, because [[Health]] and [[Areas/Health]] mean the same note.
		for (const [projectId, page] of Object.entries(settings.listPages)) {
			const link = projectPageLink(page);
			if (!link) continue;
			idsByName.set(link.title.trim().toLowerCase(), projectId);
			if (link.path) idsByName.set(link.path.trim().toLowerCase(), projectId);
		}

		const mapperOptions = {
			properties: settings.properties,
			inlineTags: settings.inlineTags,
			labels: settings.labels,
			syncedRegionMarker: settings.syncedRegionMarker,
			resolveProject: (nameOrId: string) =>
				idsByName.get(nameOrId.trim().toLowerCase()) ??
				(projectNames.has(nameOrId) ? nameOrId : undefined),
			resolveTaskLink: this.links.resolveTaskLink,
		};

		// Folders mapped to a list, longest first so a nested mapping wins over the
		// folder containing it. Moving a note into one of these moves the task.
		const foldersToList = Object.entries(settings.listFolders)
			.map(([projectId, folder]) => ({ projectId, folder: folder.trim().replace(/\/+$/, "") }))
			.filter((entry) => entry.folder !== "")
			.sort((a, b) => b.folder.length - a.folder.length);

		const listForPath = (path: string): string | undefined =>
			foldersToList.find(
				(entry) => path === entry.folder || path.startsWith(`${entry.folder}/`),
			)?.projectId;

		const result: LocalNote[] = [];
		const skipped: string[] = [];

		for (const file of files) {
			try {
				const note = await notes.read(file);
				const parsed = noteToTask(note, note.title, mapperOptions);

				// A note already moved to the deleted-task folder is a record, not
				// a task. Left alone: syncing it again would recreate the task.
				if (inDeletedFolder(file.path, settings.deletedTaskFolder)) continue;

				// A filename cannot hold a colon, a slash or a question mark, so a
				// task titled "Read: chapter 3/4" is filed as "Read- chapter 3-4".
				// The real title is in the last-agreed state, and is kept unless the
				// file has genuinely been renamed to something else — otherwise
				// every awkward title is flattened the first time it is pushed back.
				const tracked = parsed.id ? store.get(parsed.id) : undefined;
				const title = resolveTitle(parsed.title, tracked?.base.title);

				// A note already carrying a task id stays a task whatever else
				// changed, so an edit to the marker cannot orphan a synced note.
				if (!parsed.id && markerActive && !matchesMarker(note.frontmatter, marker)) {
					skipped.push(file.path);
					continue;
				}

				// A note sitting in a folder mapped to a list belongs to that list,
				// so dragging it between mapped folders moves the task in TickTick.
				const folderList = listForPath(file.path);
				const projectId = folderList ?? parsed.projectId ?? "";
				if (folderList && folderList !== parsed.projectId) {
					this.deps.log("Note is in a folder mapped to another list", {
						note: file.path,
						list: folderList,
					});
				}

				result.push({
					file,
					taskId: parsed.id,
					mtime: note.mtime,
					privateBody: parsed.privateBody,
					statusLabel: readStatusLabel(note.frontmatter[settings.properties.status]),
					snapshot: toSnapshot(
						parsedNoteToTask({ ...parsed, title, projectId }, blankTask(projectId)),
					),
				});
			} catch (error) {
				report.errors.push(`Failed to read ${file.path}: ${describeError(error)}`);
			}
		}

		this.deps.log("Scanned local notes", {
			searchedIn: markerActive && settings.discoverAnywhere ? "whole vault" : settings.taskFolder,
			markerActive,
			marker: markerActive ? `${marker.property} = ${marker.value}` : "(none)",
			filesSeen: files.length,
			taskNotes: result.length,
			alreadyLinked: result.filter((note) => note.taskId).length,
			newAndUnlinked: result.filter((note) => !note.taskId).length,
			skippedNoMarker: skipped.length,
			// Only a sample: a whole-vault scan can skip thousands.
			skippedExamples: skipped.slice(0, 10),
		});

		return result;
	}

	// --- Task links -----------------------------------------------------------

	/**
	 * Works out how each task should link to its parent and its children.
	 *
	 * A task only knows its `parentId`, so the child list has to be derived by
	 * asking which tasks point at it. Titles are only unique by luck, so a link
	 * is qualified with its note path whenever the bare title is ambiguous.
	 */
	private buildLinkIndex(
		remote: Map<string, RemoteRecord>,
		projectNames: Map<string, string>,
	): TaskLinkIndex {
		const tasks = [...remote.values()].map((record) => record.task);

		const titleUses = new Map<string, number>();
		for (const task of tasks) {
			const key = sanitiseFilename(task.title).toLowerCase();
			titleUses.set(key, (titleUses.get(key) ?? 0) + 1);
		}

		const linkFor = (task: Task): TaskLink => {
			const title = sanitiseFilename(task.title);
			const ambiguous = (titleUses.get(title.toLowerCase()) ?? 0) > 1;
			return {
				title,
				path: ambiguous ? this.notePathFor(task, projectNames).replace(/\.md$/, "") : undefined,
			};
		};

		const children = new Map<string, TaskLink[]>();
		const idByTarget = new Map<string, string>();

		for (const task of tasks) {
			const link = linkFor(task);
			idByTarget.set(link.title.toLowerCase(), task.id);
			if (link.path) idByTarget.set(link.path.toLowerCase(), task.id);

			if (!task.parentId) continue;
			const siblings = children.get(task.parentId) ?? [];
			siblings.push(link);
			children.set(task.parentId, siblings);
		}

		const byId = new Map(tasks.map((task) => [task.id, task]));

		return {
			contextFor: (task: Task): NoteContext => {
				const parent = task.parentId ? byId.get(task.parentId) : undefined;
				return {
					projectName: projectNames.get(task.projectId),
					projectLink: projectPageLink(this.deps.settings.listPages[task.projectId]),
					parent: parent ? linkFor(parent) : undefined,
					children: children.get(task.id),
				};
			},
			resolveTaskLink: (target: string) => idByTarget.get(target.trim().toLowerCase()),
		};
	}

	/** The path a task's note should occupy, used to disambiguate links. */
	private notePathFor(task: Task, projectNames: Map<string, string>): string {
		const { settings } = this.deps;
		return taskNotePath(task.title, {
			taskFolder: this.folderFor(task),
			projectName: projectNames.get(task.projectId),
			folderPerProject: settings.folderPerProject && !settings.listFolders[task.projectId],
		});
	}

	// --- Reconciliation -----------------------------------------------------

	private async reconcileAll(context: {
		remote: Map<string, RemoteRecord>;
		local: LocalNote[];
		projectNames: Map<string, string>;
		report: SyncReport;
		syncedProjects: Set<string>;
	}): Promise<void> {
		const { remote, local, projectNames, report, syncedProjects } = context;
		const { store } = this.deps;

		const localById = new Map<string, LocalNote>();
		for (const note of local) {
			if (note.taskId) localById.set(note.taskId, note);
		}

		const taskIds = new Set<string>([
			...remote.keys(),
			...localById.keys(),
			...store.entries.map((entry) => entry.taskId),
		]);

		for (const taskId of taskIds) {
			try {
				await this.reconcileOne({
					taskId,
					remote,
					localById,
					projectNames,
					report,
					syncedProjects,
				});
			} catch (error) {
				report.errors.push(`Task ${taskId}: ${describeError(error)}`);
			}
		}
	}

	private async reconcileOne(context: {
		taskId: string;
		remote: Map<string, RemoteRecord>;
		localById: Map<string, LocalNote>;
		projectNames: Map<string, string>;
		report: SyncReport;
		syncedProjects: Set<string>;
	}): Promise<void> {
		const { taskId, remote, localById, projectNames, report, syncedProjects } = context;
		const { store, settings, notes } = this.deps;

		if (store.isTombstoned(taskId)) return;

		const entry = store.get(taskId);
		const localNote = localById.get(taskId);
		let remoteRecord = remote.get(taskId);

		// Nothing on either side. Whatever was being tracked is finished with, so
		// stop tracking it rather than reasoning about which side went first.
		if (!localNote && !remoteRecord && entry && !notes.getFile(entry.notePath)) {
			this.deps.log("Both sides are gone; forgetting", {
				taskId,
				notePath: entry.notePath,
			});
			store.forget(taskId);
			return;
		}

		// Count consecutive passes in which the note has not turned up, and reset
		// the moment it does. This is what "confirmed gone" is measured against.
		if (entry) {
			const missing = localNote ? 0 : (entry.missingPasses ?? 0) + 1;
			if (missing !== (entry.missingPasses ?? 0)) {
				store.set({ ...entry, missingPasses: missing });
			}
		}

		// A note that was not found this pass is not the same thing as a note the
		// user deleted, and only the second should ever delete a TickTick task.
		// If the file is still on disk it simply was not discovered — a renamed
		// property, a marker rule, a changed folder — so the safe reading is that
		// nothing happened. Acting on the difference deletes real tasks.
		if (!localNote && entry?.notePath && notes.getFile(entry.notePath)) {
			this.deps.log("Note exists but was not discovered; leaving its task alone", {
				taskId,
				notePath: entry.notePath,
			});
			report.errors.push(
				`${entry.notePath} still exists but was not recognised as a task, so its TickTick task ` +
					"was left untouched. Check the task ID property and the task marker.",
			);
			return;
		}

		// A task belonging to a list that was not synced was never looked for, so
		// its absence says nothing at all. Without this, narrowing the lists to
		// sync archives every note belonging to the lists left out.
		if (!remoteRecord && entry?.projectId && !syncedProjects.has(entry.projectId)) {
			this.deps.log("Task belongs to a list that is not being synced; leaving it alone", {
				taskId,
				projectId: entry.projectId,
				notePath: entry.notePath,
			});
			return;
		}

		// A tracked task missing from both the open and completed listings has been
		// deleted. That conclusion is only available because completed tasks are
		// always fetched: a direct fetch cannot settle it, since TickTick serves
		// trashed tasks exactly like live ones.
		//
		// If the completed list could not be read, absence proves nothing and the
		// task is left entirely alone.
		if (!remoteRecord && entry && localNote && !this.completedFetched) {
			report.errors.push(
				`Could not read completed tasks, so "${entry.notePath}" was left untouched — its task ` +
					"may have been finished rather than deleted.",
			);
			return;
		}

		// Completed tasks are fetched for evidence. Turning one into a note is a
		// different question, and off by default: a first sync should not backfill
		// months of finished work nobody asked for.
		if (
			!localNote &&
			!entry &&
			remoteRecord?.task.status === "completed" &&
			!settings.syncCompletedTasks
		) {
			return;
		}

		const base = entry?.base;
		const masked =
			localNote && remoteRecord
				? applyFieldModes(base, localNote.snapshot, remoteRecord.snapshot, settings.fieldModes)
				: undefined;

		const action = reconcile(
			{
				// When both sides are present the masked inputs carry the direction
				// rules, including any base synthesised for one-way fields.
				base: masked ? masked.base : base,
				local: masked?.local ?? localNote?.snapshot,
				remote: masked?.remote ?? remoteRecord?.snapshot,
			},
			{
				conflictPolicy: settings.conflictPolicy,
				deleteConflictPolicy: settings.deleteConflictPolicy,
				remoteDeletion: settings.remoteDeletion,
				noteDeletion: settings.noteDeletion,
				localWasLinked: Boolean(localNote?.taskId),
				noteConfirmedGone:
					(store.get(taskId)?.missingPasses ?? 0) >= settings.passesBeforeDeletingTask,
				baseFields: masked?.baseFields,
				localModifiedAt: localNote?.mtime,
				remoteModifiedAt: remoteRecord?.task.modifiedTime
					? new Date(remoteRecord.task.modifiedTime).getTime()
					: undefined,
			},
		);

		await this.execute({
			action,
			taskId,
			entry,
			localNote,
			remoteRecord,
			projectNames,
			report,
		});
	}

	private async execute(context: {
		action: SyncAction;
		taskId: string;
		entry?: SyncEntry;
		localNote?: LocalNote;
		remoteRecord?: RemoteRecord;
		projectNames: Map<string, string>;
		report: SyncReport;
	}): Promise<void> {
		const { action, taskId, entry, localNote, remoteRecord, projectNames, report } = context;
		const { store, notes, client, settings } = this.deps;

		if (this.dryRun) {
			const description = describeAction(action, localNote?.file.path, remoteRecord?.task.title);
			if (description) report.planned.push(description);
			return;
		}

		switch (action.kind) {
			case "noop":
				if (entry && localNote && remoteRecord) {
					// Keep the tie-break timestamps fresh even when nothing moved.
					store.set({ ...entry, localMtime: localNote.mtime, lastSyncedAt: Date.now() });
				}
				return;

			case "forget":
				store.forget(taskId);
				return;

			case "createLocal":
			case "restoreLocal": {
				if (!remoteRecord) return;
				// Restoring reclaims the path the note had. Computing a fresh one
				// would collide with anything still there and add " 2" every time.
				const file = await this.writeNewNote(remoteRecord.task, projectNames, entry?.notePath);
				store.set(this.entryFor(remoteRecord.task, file.path, action.snapshot, file.stat.mtime));
				report.createdLocal++;
				return;
			}

			case "createRemote":
			case "restoreRemote": {
				if (!localNote) return;
				const created = await client.createTask(
					this.toNewTask(action.snapshot, localNote.snapshot.projectId),
				);
				await this.stampNote(localNote.file, created, action.snapshot, localNote);
				store.set(this.entryFor(created, localNote.file.path, action.snapshot, Date.now()));
				report.createdRemote++;
				return;
			}

			case "updateLocal":
			case "updateRemote":
			case "updateBoth": {
				if (!localNote || !remoteRecord) return;
				report.conflicts += action.conflicts.length;

				// Subtasks parsed from a note carry no ids, and pushing them without
				// would make TickTick recreate every item rather than update it.
				const merged: Task = {
					...remoteRecord.task,
					...action.snapshot,
					id: taskId,
					items: restoreItemMetadata(action.snapshot.items, remoteRecord.task.items),
				};

				if (action.kind !== "updateLocal") {
					// A list change is its own operation. Sending it as part of an
					// ordinary update is rejected outright, and the task stays put
					// while the note claims otherwise — so it moves first.
					const from = remoteRecord.task.projectId;
					const to = merged.projectId;
					if (to && from && to !== from) {
						await client.moveTask(taskId, from, to);
						this.deps.log("Moved task to another list", { taskId, from, to });
					}

					await client.updateTask(this.withNoteLink(merged, localNote.file));
					if (merged.status === "completed" && remoteRecord.task.status !== "completed") {
						await client.completeTask(merged.projectId, taskId);
					}
					report.updatedRemote++;
				}

				if (action.kind !== "updateRemote") {
					report.updatedLocal++;
				}

				const file = await this.writeNote(localNote.file, merged, projectNames, localNote);
				store.set(this.entryFor(merged, file.path, action.snapshot, file.stat.mtime));
				return;
			}

			case "orphanLocal": {
				// The task is gone from TickTick but the note is the record of the
				// work, so it moves to the archive rather than being deleted. The
				// folder is what marks it — no property, and it is skipped on every
				// later pass, so it is never pushed back as a new task.
				if (localNote) {
					const target = `${settings.deletedTaskFolder}/${localNote.file.name}`;
					await notes.rename(localNote.file, target);
					this.deps.log("Task deleted in TickTick; note archived to", target);
				}
				store.tombstone(taskId);
				return;
			}

			case "deleteLocal": {
				const allowed = await this.confirmDeletion(report, {
					what: "note",
					title: remoteRecord?.task.title ?? localNote?.file.basename ?? taskId,
					notePath: localNote?.file.path,
					reason:
						"This task is gone from TickTick and the note matches what was last synced, so " +
						"nothing would be lost by removing it. Keeping notes instead is the usual " +
						"choice — see 'When a task is deleted in TickTick'.",
				});
				if (!allowed) return;

				if (localNote) {
					await notes.delete(localNote.file);
					report.deletedLocal++;
				}
				store.forget(taskId);
				return;
			}

			case "deleteRemote": {
				const missing = entry?.missingPasses ?? 0;
				const allowed = await this.confirmDeletion(report, {
					what: "task",
					title: remoteRecord?.task.title ?? taskId,
					notePath: entry?.notePath,
					reason:
						`The note for this task could not be found. Its recorded location was ` +
						`"${entry?.notePath ?? "unknown"}", nothing is on disk there, and it has been ` +
						`missing for ${missing} consecutive sync${missing === 1 ? "" : "s"}. ` +
						"If you did not delete that note, something stopped it being recognised — " +
						"most often the task ID property, the task marker, or the folder being scanned.",
				});
				if (!allowed) return;

				// Deleting is irreversible from here. One sync should never take out
				// a whole list, and a rule that stops notes matching would do exactly
				// that, so past the limit nothing goes and the sync says why.
				const cap = settings.maxDeletedTasksPerSync;
				if (cap > 0 && report.deletedRemote >= cap) {
					report.errors.push(
						`Stopped after deleting ${cap} TickTick tasks in one sync. The rest were left ` +
							"alone. This usually means notes stopped matching their tasks rather than that " +
							"you deleted them — use Preview changes to see what is happening.",
					);
					return;
				}

				if (entry) {
					await client.deleteTask(entry.projectId, taskId);
					report.deletedRemote++;
				}
				store.tombstone(taskId);
				return;
			}
		}
	}

	// --- Writing ------------------------------------------------------------

	/**
	 * Reunites a note that has lost its task id with the task it belongs to.
	 *
	 * A note stops being recognised for several ordinary reasons — the id
	 * property renamed, a settings change, a hand edit — and every one of them
	 * makes it look brand new while leaving its task looking abandoned. Matching
	 * on title within the same list links them back before either half is acted
	 * on, which is the difference between a no-op and a pair of duplicates.
	 */
	private async adoptOrphanedTasks(
		local: LocalNote[],
		remote: Map<string, RemoteRecord>,
		report: SyncReport,
	): Promise<void> {
		const { store } = this.deps;

		const pairs = matchOrphansToTasks(
			local.map((note) => ({
				path: note.file.path,
				taskId: note.taskId,
				title: note.snapshot.title,
				projectId: note.snapshot.projectId,
				trackedTaskId: store.getByPath(note.file.path)?.taskId,
			})),
			[...remote.values()].map((record) => record.task),
		);

		if (pairs.size === 0) return;

		for (const note of local) {
			const taskId = pairs.get(note.file.path);
			if (!taskId) continue;

			const twin = remote.get(taskId)?.task;
			if (!twin) continue;

			if (this.dryRun) {
				report.planned.push(`Re-link ${note.file.path} to its existing task "${twin.title}"`);
				continue;
			}

			// Drop any stale entry for this path first, so the note is not left
			// tracked twice — once to the task it just adopted and once to a
			// task that no longer exists.
			const stale = store.getByPath(note.file.path);
			if (stale && stale.taskId !== twin.id) store.forget(stale.taskId);

			await this.stampNote(note.file, twin, note.snapshot, note);
			store.set(this.entryFor(twin, note.file.path, toSnapshot(twin), Date.now()));

			// So the reconcile pass treats the pair as matched rather than as an
			// orphaned task and an unrelated new note.
			note.taskId = twin.id;

			this.deps.log("Re-linked a note to its existing task", {
				note: note.file.path,
				taskId: twin.id,
			});
		}
	}

	private async createUnlinkedNotes(
		local: LocalNote[],
		remote: Map<string, RemoteRecord>,
		projectNames: Map<string, string>,
		report: SyncReport,
	): Promise<void> {
		const { client, store, settings } = this.deps;
		const inbox = settings.projectFilter[0] ?? [...projectNames.keys()][0];

		const candidates = local.filter(
			(note) => !note.taskId && !store.getByPath(note.file.path),
		);

		// Tasks in TickTick that no note claims. A note about to be "created" that
		// matches one of these is almost certainly the same task that lost its id
		// rather than a new one — adopting it is what stops a rename, a marker
		// change or a reset from duplicating a whole list.
		const claimed = new Set(local.map((note) => note.taskId).filter(Boolean));
		const unclaimed = new Map<string, Task>();
		for (const { task } of remote.values()) {
			if (claimed.has(task.id)) continue;
			const key = `${task.projectId}::${task.title.trim().toLowerCase()}`;
			// First one wins; a genuinely duplicated title is ambiguous either way.
			if (!unclaimed.has(key)) unclaimed.set(key, task);
		}
		const cap = settings.maxNewTasksPerSync;

		// Creating tasks is the one operation that multiplies. If a match rule
		// breaks, every note looks new — so refuse the whole batch rather than
		// fill TickTick with duplicates that then have to be found by hand.
		if (cap > 0 && candidates.length > cap) {
			report.errors.push(
				`${candidates.length} notes look like new tasks, which is more than the limit of ${cap}. ` +
					"No tasks were created. This usually means notes stopped matching their existing " +
					"tasks rather than that they are genuinely new — check a note still has its task ID " +
					"property, and use Preview changes to see the full list.",
			);
			this.deps.log("Refused to create tasks", {
				candidates: candidates.length,
				cap,
				examples: candidates.slice(0, 10).map((note) => note.file.path),
			});
			return;
		}

		for (const note of local) {
			if (note.taskId) continue;
			// Skip anything the store already knows by path — it is mid-link.
			if (store.getByPath(note.file.path)) {
				this.deps.log("Not creating a task: already tracked by path", note.file.path);
				continue;
			}

			const wantedList = note.snapshot.projectId || inbox || "";
			const twin = unclaimed.get(`${wantedList}::${note.snapshot.title.trim().toLowerCase()}`);
			if (twin) {
				// Link the two rather than creating a second task. The next pass
				// reconciles them normally, from the note's own values.
				await this.stampNote(note.file, twin, note.snapshot, note);
				store.set(this.entryFor(twin, note.file.path, toSnapshot(twin), Date.now()));
				unclaimed.delete(`${wantedList}::${note.snapshot.title.trim().toLowerCase()}`);
				this.deps.log("Adopted an existing task instead of creating a duplicate", {
					note: note.file.path,
					taskId: twin.id,
				});
				continue;
			}

			if (!note.snapshot.projectId && !inbox) {
				report.errors.push(
					`Cannot create a task from ${note.file.path}: no list to put it in. ` +
						"Load your lists in settings, or set the note's list property.",
				);
				continue;
			}

			if (this.dryRun) {
				report.planned.push(`Create TickTick task from ${note.file.path}`);
				continue;
			}

			try {
				this.deps.log("Creating a TickTick task from", note.file.path);
				const created = await client.createTask(
					this.toNewTask(note.snapshot, note.snapshot.projectId || inbox || ""),
				);
				await this.stampNote(note.file, created, note.snapshot, note);
				store.set(this.entryFor(created, note.file.path, note.snapshot, Date.now()));
				report.createdRemote++;
			} catch (error) {
				report.errors.push(`Failed to create task from ${note.file.path}: ${describeError(error)}`);
			}
		}
	}

	private async writeNewNote(
		task: Task,
		projectNames: Map<string, string>,
		preferredPath?: string,
	): Promise<TFile> {
		const { notes, settings } = this.deps;
		const projectName = projectNames.get(task.projectId);

		// A note being restored goes back where it was, provided nothing has
		// taken the name since.
		if (preferredPath && !notes.getFile(preferredPath)) {
			return notes.create(preferredPath, this.render(task));
		}

		const path = taskNotePath(task.title, {
			taskFolder: this.folderFor(task),
			projectName,
			// An explicit folder for this list already places the note; adding a
			// per-list subfolder inside it would nest a second time.
			folderPerProject: settings.folderPerProject && !settings.listFolders[task.projectId],
		});
		return notes.create(path, this.render(task));
	}

	/** Writes a task into an existing note, renaming it when the title moved. */
	private async writeNote(
		file: TFile,
		task: Task,
		projectNames: Map<string, string>,
		note?: LocalNote,
	): Promise<TFile> {
		const { notes, settings } = this.deps;
		const projectName = projectNames.get(task.projectId);
		await notes.write(
			file,
			this.render(task, {
				currentStatus: note?.statusLabel,
				privateBody: note?.privateBody,
			}),
		);

		// Once notes are found by property rather than by folder, where a note
		// lives is the user's decision — dragging it back to a computed path
		// would undo a deliberate move. Only the filename follows the title.
		const desired = settings.discoverAnywhere
			? taskNotePath(task.title, {
					taskFolder: parentFolder(file.path),
					folderPerProject: false,
				})
			: taskNotePath(task.title, {
					taskFolder: this.folderFor(task),
					projectName,
					folderPerProject: settings.folderPerProject && !settings.listFolders[task.projectId],
				});

		// Covers a renamed task, and a task moved between lists when folders are
		// managed by the plugin.
		if (file.path !== desired) {
			await notes.rename(file, desired);
		}

		return file;
	}

	/** Records the freshly assigned remote id into a locally authored note. */
	private async stampNote(
		file: TFile,
		task: Task,
		snapshot: TaskSnapshot,
		note?: LocalNote,
	): Promise<void> {
		const merged: Task = { ...task, ...snapshot, id: task.id, projectId: task.projectId };
		await this.deps.notes.write(
			file,
			this.render(merged, {
				currentStatus: note?.statusLabel,
				privateBody: note?.privateBody,
			}),
		);
	}

	/**
	 * Puts a deletion to the user, and records the reasoning either way.
	 *
	 * The reason is logged whether or not the deletion is allowed, because the
	 * interesting case is the one that should not have been proposed at all —
	 * and that is only diagnosable if the reasoning survives.
	 */
	private async confirmDeletion(report: SyncReport, request: DeletionRequest): Promise<boolean> {
		const { settings, confirmDeletion, log } = this.deps;
		log("Deletion proposed", request);

		if (!settings.confirmDeletions || !confirmDeletion) return true;

		const allowed = await confirmDeletion(request);
		if (!allowed) {
			report.errors.push(
				`Skipped deleting the ${request.what} for "${request.title}" at your request. ${request.reason}`,
			);
			log("Deletion declined", request);
		}

		return allowed;
	}

	/** Attaches the note's own URL so TickTick's description can link back to it. */
	private withNoteLink(task: Task, file: TFile): Task {
		if (!this.deps.settings.linkBackToNote) return task;
		return { ...task, noteUrl: this.deps.notes.noteUrl(file) };
	}

	private render(task: Task, note?: { currentStatus?: string; privateBody?: string }) {
		const { settings } = this.deps;
		return taskToNote(
			task,
			{
				properties: settings.properties,
				inlineTags: settings.inlineTags,
				labels: settings.labels,
				marker: settings.taskMarker,
				syncedRegionMarker: settings.syncedRegionMarker,
				useTaskTimeZone: settings.showTimesIn === "task",
			},
			{ ...this.links.contextFor(task), ...note },
		);
	}

	/**
	 * Where a task's note belongs.
	 *
	 * An explicit per-list folder wins over everything, so one list can live
	 * inside an existing project folder while the rest stay together. Archiving
	 * a completed task still overrides both.
	 */
	private folderFor(task: Task): string {
		const { settings } = this.deps;

		if (task.status === "completed" && settings.completedHandling === "archive") {
			return settings.archiveFolder;
		}

		return settings.listFolders[task.projectId]?.trim() || settings.taskFolder;
	}

	private toNewTask(snapshot: TaskSnapshot, projectId: string): NewTask {
		return { ...blankTask(projectId), ...snapshot, projectId: snapshot.projectId || projectId };
	}

	private entryFor(
		task: Task,
		notePath: string,
		base: TaskSnapshot,
		localMtime: number,
	): SyncEntry {
		return {
			taskId: task.id,
			projectId: task.projectId,
			notePath,
			base,
			localMtime,
			remoteModifiedAt: task.modifiedTime ? new Date(task.modifiedTime).getTime() : undefined,
			etag: task.etag,
			lastSyncedAt: Date.now(),
		};
	}
}

/** A one-line summary of what an action would do, for the dry-run report. */
function describeAction(action: SyncAction, notePath?: string, title?: string): string | undefined {
	const what = notePath ?? title ?? "";
	switch (action.kind) {
		case "noop":
		case "forget":
			return undefined;
		case "createLocal":
		case "restoreLocal":
			return `Create note for "${title ?? what}"`;
		case "createRemote":
		case "restoreRemote":
			return `Create TickTick task from ${what}`;
		case "updateLocal":
			return `Update note ${what}`;
		case "updateRemote":
			return `Update TickTick task for ${what}`;
		case "updateBoth":
			return `Update both sides of ${what}`;
		case "orphanLocal":
			return `Archive ${what} — its task is gone from TickTick`;
		case "deleteLocal":
			return `Delete note ${what}`;
		case "deleteRemote":
			return `Delete TickTick task for ${what}`;
	}
}

/** The status property as written, so an equivalent wording can be preserved. */
function readStatusLabel(raw: unknown): string | undefined {
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** True when a note already sits in the folder used for deleted tasks. */
function inDeletedFolder(path: string, folder: string): boolean {
	const root = folder.trim().replace(/\/+$/, "");
	if (!root) return false;
	return path === root || path.startsWith(`${root}/`);
}

/**
 * The link to write for a list whose note has been configured.
 *
 * A value containing a slash is treated as a vault path and linked with the
 * basename as the display text, so the property still reads as the project's
 * name rather than its full location.
 */
function projectPageLink(page: string | undefined): TaskLink | undefined {
	const trimmed = page?.trim().replace(/\.md$/i, "");
	if (!trimmed) return undefined;

	const slash = trimmed.lastIndexOf("/");
	if (slash === -1) return { title: trimmed };
	return { title: trimmed.slice(slash + 1), path: trimmed };
}

/**
 * Whether a note declares itself a task.
 *
 * The property is typically list-typed in a real vault — `note_type: [task]` —
 * so a single value and a list of values both count, and the comparison ignores
 * case since it is hand-entered.
 */
function matchesMarker(
	frontmatter: Record<string, unknown> | undefined,
	marker: { property: string; value: string },
): boolean {
	const raw = (frontmatter ?? {})[marker.property.trim()];
	if (raw === undefined || raw === null) return false;

	const wanted = marker.value.trim().toLowerCase();
	const values = Array.isArray(raw) ? raw : [raw];

	return values.some((entry) => String(entry).trim().toLowerCase() === wanted);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** A note as the orphan matcher sees it — no vault types, no I/O. */
export interface OrphanCandidate {
	path: string;
	/** Set when the note still carries a readable task id. */
	taskId?: string;
	title: string;
	projectId: string;
	/** The task the sync state has recorded against this path, if any. */
	trackedTaskId?: string;
}

/**
 * Pairs notes that have lost their task id with the tasks they belong to.
 *
 * A note stops being recognised for several ordinary reasons — the id property
 * renamed, a settings change, a hand edit — and each one makes the note look
 * brand new while leaving its task looking abandoned. Acting on either half
 * produces a duplicate, so they are matched back together first.
 *
 * Pure on purpose: this is the decision that kept surviving code review and
 * failing against a real vault, and it is only checkable in isolation.
 */
export function matchOrphansToTasks(
	notes: OrphanCandidate[],
	tasks: Task[],
): Map<string, string> {
	const key = (projectId: string, title: string): string =>
		`${projectId}::${title.trim().toLowerCase()}`;

	// Claimed means "a note found in this pass holds its id" — not merely
	// "tracked". A task whose note has gone missing is still tracked, and is
	// exactly the one worth adopting.
	const claimed = new Set(notes.map((note) => note.taskId).filter(Boolean));

	const available = new Map<string, Task>();
	for (const task of tasks) {
		if (claimed.has(task.id)) continue;
		const k = key(task.projectId, task.title);
		// First wins; duplicate titles are ambiguous however they are resolved.
		if (!available.has(k)) available.set(k, task);
	}

	const live = new Set(tasks.map((task) => task.id));
	const pairs = new Map<string, string>();

	for (const note of notes) {
		if (note.taskId) continue;

		// Being tracked by path only counts while that task still exists. An entry
		// left behind by a deleted task must not stop the note being re-linked.
		if (note.trackedTaskId && live.has(note.trackedTaskId)) continue;

		const k = key(note.projectId, note.title);
		const twin = available.get(k);
		if (!twin) continue;

		available.delete(k);
		pairs.set(note.path, twin.id);
	}

	return pairs;
}
