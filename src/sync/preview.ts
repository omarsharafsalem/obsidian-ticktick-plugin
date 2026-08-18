import type { TFile } from "obsidian";
import type { TickTickClient } from "../api/client";
import type { NewTask, Task } from "../api/types";
import { NoteRepository } from "../vault/notes";
import type { NoteContent } from "./mapper";
import type { SyncReport } from "./engine";
import { SyncStore, type SyncState } from "./state";

/**
 * The dependencies a preview runs against.
 *
 * The engine already takes a `dryRun` flag, and a flag is only as good as every
 * write site's memory of checking it — one that forgot was shipping in
 * `createUnlinkedNotes`, stamping notes during a run that promised to write
 * nothing. So a preview is not given the ability to write at all: the client
 * refuses every mutating call, the note repository refuses every write, the
 * store works on a copy, and persisting throws. A missed flag then becomes a
 * line in the report's problem list instead of an edit to the vault.
 */

/**
 * Where the report is written.
 *
 * The vault root, for the same reason the settings note lives there: a note in
 * the task folder without a task marker would itself be read as a new task.
 */
export const PREVIEW_NOTE_PATH = "TickTick sync preview.md";

/** Raised when a preview reaches for something that would change state. */
class PreviewWriteError extends Error {
	constructor(what: string) {
		super(
			`Preview tried to ${what}. Nothing was changed — this is a bug in the sync, not in your ` +
				"settings; please report it with the sync log.",
		);
	}
}

/**
 * The client with every write removed.
 *
 * Reads pass straight through, so the preview sees exactly what a real sync
 * would see.
 */
export function readOnlyClient(client: TickTickClient): TickTickClient {
	return {
		capabilities: client.capabilities,
		listProjects: () => client.listProjects(),
		listTasksInProject: (projectId: string) => client.listTasksInProject(projectId),
		getTask: (projectId: string, taskId: string) => client.getTask(projectId, taskId),
		listCompletedTasks: (from: Date, to: Date, projectIds?: string[]) =>
			client.listCompletedTasks(from, to, projectIds),
		createTask: (task: NewTask) => {
			throw new PreviewWriteError(`create the TickTick task "${task.title}"`);
		},
		updateTask: (task: Task) => {
			throw new PreviewWriteError(`update the TickTick task "${task.title}"`);
		},
		moveTask: (taskId: string) => {
			throw new PreviewWriteError(`move the TickTick task ${taskId}`);
		},
		completeTask: (_projectId: string, taskId: string) => {
			throw new PreviewWriteError(`complete the TickTick task ${taskId}`);
		},
		deleteTask: (_projectId: string, taskId: string) => {
			throw new PreviewWriteError(`delete the TickTick task ${taskId}`);
		},
	};
}

/**
 * The vault with every write removed, reads left exactly as they are.
 *
 * The refusals are thrown rather than rejected — synchronously, so a call site
 * that forgot to await one is refused just as loudly as one that did.
 */
export class ReadOnlyNoteRepository extends NoteRepository {
	write(file: TFile, _note: NoteContent): Promise<void> {
		throw new PreviewWriteError(`write to ${file.path}`);
	}

	create(path: string, _note: NoteContent): Promise<TFile> {
		throw new PreviewWriteError(`create ${path}`);
	}

	rename(file: TFile, path: string): Promise<TFile> {
		throw new PreviewWriteError(`move ${file.path} to ${path}`);
	}

	delete(file: TFile): Promise<void> {
		throw new PreviewWriteError(`delete ${file.path}`);
	}

	ensureFolder(path: string): Promise<void> {
		throw new PreviewWriteError(`create the folder ${path}`);
	}
}

/**
 * A throwaway copy of the sync state for the preview to reason with.
 *
 * A dry run genuinely needs to move the store about — the count of consecutive
 * passes a note has been missing is what decides whether a deletion would be
 * proposed, and skipping it would make the preview report fewer deletions than
 * the sync would perform. Copying is what lets it think without any of the
 * thinking surviving the run.
 */
export function previewStore(state: SyncState): SyncStore {
	return new SyncStore(structuredClone(state));
}

/** Persisting during a preview is always a bug; there is nothing worth keeping. */
export function refusePersist(): Promise<never> {
	throw new PreviewWriteError("save its sync state");
}

/**
 * The preview written out as a note.
 *
 * A modal disappears the moment you click away, and a first run against a real
 * vault plans hundreds of changes — this is the form you can scroll, search, and
 * still have open beside the settings you are correcting.
 */
export function renderPreviewReport(
	report: SyncReport,
	options: { generatedAt?: number } = {},
): string {
	const when = new Date(options.generatedAt ?? Date.now()).toISOString();

	const lines = [
		"# TickTick sync preview",
		"",
		`Generated ${when} in ${report.durationMs}ms. **Nothing was changed.** This run had no way`,
		"to change anything: it was given a client that refuses every write, a vault that refuses",
		"every write, and a throwaway copy of the sync state.",
		"",
		"## What the next sync would do",
		"",
	];

	if (report.planned.length === 0) {
		lines.push("Nothing. Both sides already agree.", "");
	} else {
		lines.push(`${report.planned.length} change${report.planned.length === 1 ? "" : "s"}:`, "");
		for (const line of report.planned) lines.push(`- ${line}`);
		lines.push("");
	}

	if (report.errors.length > 0) {
		lines.push(
			"## Problems found while reading",
			"",
			"These stopped part of the preview being worked out, so the list above may be incomplete.",
			"",
		);
		for (const error of report.errors) lines.push(`- ${error}`);
		lines.push("");
	}

	return lines.join("\n");
}
