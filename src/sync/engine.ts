import type { TFile } from "obsidian";
import type { TickTickClient } from "../api/client";
import { blankTask, type NewTask, type Project, type Task } from "../api/types";
import type { TickTickSyncSettings } from "../settings";
import { NoteRepository, taskNotePath } from "../vault/notes";
import { applyFieldModes } from "./fieldModes";
import { noteToTask, parsedNoteToTask, restoreItemMetadata, taskToNote } from "./mapper";
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
	};
}

export interface EngineDeps {
	client: TickTickClient;
	notes: NoteRepository;
	store: SyncStore;
	settings: TickTickSyncSettings;
	persist: () => Promise<void>;
	log: (message: string, ...rest: unknown[]) => void;
}

interface LocalNote {
	file: TFile;
	snapshot: TaskSnapshot;
	taskId?: string;
	mtime: number;
}

/** A remote record plus the extra context the engine needs to write it back. */
interface RemoteRecord {
	task: Task;
	snapshot: TaskSnapshot;
}

export class SyncEngine {
	private running = false;

	constructor(private readonly deps: EngineDeps) {}

	get isRunning(): boolean {
		return this.running;
	}

	async sync(): Promise<SyncReport> {
		if (this.running) {
			throw new Error("A sync is already in progress");
		}
		this.running = true;
		const started = Date.now();
		const report = emptyReport();

		try {
			const projects = await this.loadProjects();
			const projectNames = new Map(projects.map((p) => [p.id, p.name]));
			const remote = await this.loadRemoteTasks(projects, report);
			const local = await this.loadLocalNotes(report, projectNames);

			await this.reconcileAll({ remote, local, projectNames, report });
			await this.createUnlinkedNotes(local, projectNames, report);

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
					remote.set(task.id, { task, snapshot: toSnapshot(task) });
				}
			} catch (error) {
				report.errors.push(`Failed to read list "${project.name}": ${describeError(error)}`);
			}
		}

		// Completed tasks drop out of the project listing. Where the backend can
		// report them we fold them back in, which is what lets a completion sync
		// through instead of looking like a deletion.
		if (this.deps.settings.syncCompletedTasks && this.deps.client.capabilities.completedHistory) {
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
			} catch (error) {
				report.errors.push(`Failed to read completed tasks: ${describeError(error)}`);
			}
		}

		return remote;
	}

	private async loadLocalNotes(
		report: SyncReport,
		projectNames: Map<string, string>,
	): Promise<LocalNote[]> {
		const { notes, settings } = this.deps;
		const files = notes.listMarkdown(settings.taskFolder);

		// The list property holds a name, so reading a note means turning it back
		// into an id. Matched case-insensitively, since the value is hand-editable.
		const idsByName = new Map<string, string>();
		for (const [id, name] of projectNames) idsByName.set(name.trim().toLowerCase(), id);

		const mapperOptions = {
			properties: settings.properties,
			inlineTags: settings.inlineTags,
			labels: settings.labels,
			resolveProject: (nameOrId: string) =>
				idsByName.get(nameOrId.trim().toLowerCase()) ??
				(projectNames.has(nameOrId) ? nameOrId : undefined),
		};

		const result: LocalNote[] = [];
		for (const file of files) {
			try {
				const note = await notes.read(file);
				const parsed = noteToTask(note, note.title, mapperOptions);
				result.push({
					file,
					taskId: parsed.id,
					mtime: note.mtime,
					snapshot: toSnapshot(
						parsedNoteToTask(parsed, blankTask(parsed.projectId ?? "")),
					),
				});
			} catch (error) {
				report.errors.push(`Failed to read ${file.path}: ${describeError(error)}`);
			}
		}

		return result;
	}

	// --- Reconciliation -----------------------------------------------------

	private async reconcileAll(context: {
		remote: Map<string, RemoteRecord>;
		local: LocalNote[];
		projectNames: Map<string, string>;
		report: SyncReport;
	}): Promise<void> {
		const { remote, local, projectNames, report } = context;
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
				await this.reconcileOne({ taskId, remote, localById, projectNames, report });
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
	}): Promise<void> {
		const { taskId, remote, localById, projectNames, report } = context;
		const { store, settings } = this.deps;

		if (store.isTombstoned(taskId)) return;

		const entry = store.get(taskId);
		const localNote = localById.get(taskId);
		let remoteRecord = remote.get(taskId);

		// A tracked task missing from the listing is either completed or deleted.
		// Only a direct fetch can tell them apart on the official API.
		if (!remoteRecord && entry) {
			const probed = await this.probeRemote(entry);
			if (probed) remoteRecord = { task: probed, snapshot: toSnapshot(probed) };
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

	private async probeRemote(entry: SyncEntry): Promise<Task | null> {
		try {
			return await this.deps.client.getTask(entry.projectId, entry.taskId);
		} catch (error) {
			// Treat an unreadable task as still present, so a transient failure
			// never deletes a note.
			this.deps.log(`Probe failed for ${entry.taskId}`, error);
			return { ...blankTask(entry.projectId), id: entry.taskId, ...entry.base } as Task;
		}
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
		const { store, notes, client } = this.deps;

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
				const file = await this.writeNewNote(remoteRecord.task, projectNames);
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
				await this.stampNote(
					localNote.file,
					created,
					action.snapshot,
					projectNames.get(created.projectId),
				);
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
					await client.updateTask(merged);
					if (merged.status === "completed" && remoteRecord.task.status !== "completed") {
						await client.completeTask(merged.projectId, taskId);
					}
					report.updatedRemote++;
				}

				if (action.kind !== "updateRemote") {
					report.updatedLocal++;
				}

				const file = await this.writeNote(localNote.file, merged, projectNames);
				store.set(this.entryFor(merged, file.path, action.snapshot, file.stat.mtime));
				return;
			}

			case "deleteLocal": {
				if (localNote) {
					await notes.delete(localNote.file);
					report.deletedLocal++;
				}
				store.forget(taskId);
				return;
			}

			case "deleteRemote": {
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

	private async createUnlinkedNotes(
		local: LocalNote[],
		projectNames: Map<string, string>,
		report: SyncReport,
	): Promise<void> {
		const { client, store, settings } = this.deps;
		const inbox = settings.projectFilter[0] ?? [...projectNames.keys()][0];

		for (const note of local) {
			if (note.taskId) continue;
			// Skip anything the store already knows by path — it is mid-link.
			if (store.getByPath(note.file.path)) continue;

			try {
				const created = await client.createTask(
					this.toNewTask(note.snapshot, note.snapshot.projectId || inbox || ""),
				);
				await this.stampNote(note.file, created, note.snapshot, projectNames.get(created.projectId));
				store.set(this.entryFor(created, note.file.path, note.snapshot, Date.now()));
				report.createdRemote++;
			} catch (error) {
				report.errors.push(`Failed to create task from ${note.file.path}: ${describeError(error)}`);
			}
		}
	}

	private async writeNewNote(task: Task, projectNames: Map<string, string>): Promise<TFile> {
		const { notes, settings } = this.deps;
		const projectName = projectNames.get(task.projectId);
		const path = taskNotePath(task.title, {
			taskFolder: this.folderFor(task),
			projectName,
			// An explicit folder for this list already places the note; adding a
			// per-list subfolder inside it would nest a second time.
			folderPerProject: settings.folderPerProject && !settings.listFolders[task.projectId],
		});
		return notes.create(path, this.render(task, projectName));
	}

	/** Writes a task into an existing note, renaming it when the title moved. */
	private async writeNote(
		file: TFile,
		task: Task,
		projectNames: Map<string, string>,
	): Promise<TFile> {
		const { notes, settings } = this.deps;
		const projectName = projectNames.get(task.projectId);
		await notes.write(file, this.render(task, projectName));

		const desired = taskNotePath(task.title, {
			taskFolder: this.folderFor(task),
			projectName,
			folderPerProject: settings.folderPerProject && !settings.listFolders[task.projectId],
		});

		// Covers both a renamed task and a task moved to a different list.
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
		projectName?: string,
	): Promise<void> {
		const merged: Task = { ...task, ...snapshot, id: task.id, projectId: task.projectId };
		await this.deps.notes.write(file, this.render(merged, projectName));
	}

	private render(task: Task, projectName?: string) {
		const { settings } = this.deps;
		return taskToNote(
			task,
			{
				properties: settings.properties,
				inlineTags: settings.inlineTags,
				labels: settings.labels,
			},
			projectName,
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

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
