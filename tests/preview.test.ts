import { describe, expect, it } from "vitest";
import type { App, TFile as ObsidianFile } from "obsidian";
import { TFile } from "obsidian";
import type { TickTickClient } from "../src/api/client";
import { blankTask, type NewTask, type Project, type Task } from "../src/api/types";
import { DEFAULT_PROPERTIES, DEFAULT_SETTINGS, type TickTickSyncSettings } from "../src/settings";
import { SyncEngine } from "../src/sync/engine";
import {
	previewStore,
	readOnlyClient,
	ReadOnlyNoteRepository,
	refusePersist,
	renderPreviewReport,
} from "../src/sync/preview";
import { toSnapshot } from "../src/sync/reconcile";
import { SYNC_STATE_VERSION, type SyncState } from "../src/sync/state";

/**
 * A preview is only worth having if it *cannot* write, rather than if every
 * write site remembers to check a flag — one that forgot was shipping, stamping
 * notes during a run that promised to change nothing. So the check here is not
 * "did the engine behave" but "was it able to misbehave at all": every write
 * this pass could reach is recorded, and the list has to come back empty.
 */

/** Every mutating call the fakes see. Empty is the whole point. */
type Writes = string[];

function file(path: string, mtime = 1_000): ObsidianFile {
	const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
	return Object.assign(new TFile(), {
		path,
		basename,
		name: `${basename}.md`,
		extension: "md",
		stat: { mtime, ctime: 0, size: 0 },
	}) as unknown as ObsidianFile;
}

function fakeApp(notes: Record<string, string>, writes: Writes): App {
	const files = Object.keys(notes).map((path) => file(path));

	const vault = {
		getName: () => "Test vault",
		getMarkdownFiles: () => files,
		getFiles: () => files,
		getAbstractFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
		read: async (target: ObsidianFile) => notes[target.path] ?? "",
		modify: async (target: ObsidianFile) => void writes.push(`modify ${target.path}`),
		create: async (path: string) => void writes.push(`create ${path}`),
		createFolder: async (path: string) => void writes.push(`createFolder ${path}`),
	};

	const fileManager = {
		renameFile: async (target: ObsidianFile, path: string) =>
			void writes.push(`rename ${target.path} ${path}`),
		trashFile: async (target: ObsidianFile) => void writes.push(`trash ${target.path}`),
	};

	return { vault, fileManager } as unknown as App;
}

function fakeClient(tasks: Task[], writes: Writes): TickTickClient {
	const project: Project = { id: "list-a", name: "Personal", closed: false };

	return {
		capabilities: { completedHistory: true, modifiedTime: false, inbox: true },
		listProjects: async () => [project],
		listTasksInProject: async () => ({ tasks, sections: [] }),
		getTask: async () => null,
		listCompletedTasks: async () => [],
		createTask: async (task: NewTask) => {
			writes.push(`createTask ${task.title}`);
			return { ...task, id: "new" } as Task;
		},
		updateTask: async (task: Task) => {
			writes.push(`updateTask ${task.id}`);
			return task;
		},
		moveTask: async (taskId: string) => void writes.push(`moveTask ${taskId}`),
		completeTask: async (_projectId: string, taskId: string) =>
			void writes.push(`completeTask ${taskId}`),
		deleteTask: async (_projectId: string, taskId: string) =>
			void writes.push(`deleteTask ${taskId}`),
	};
}

function task(overrides: Partial<Task>): Task {
	return { ...blankTask("list-a"), id: "task-1", title: "Untitled", ...overrides };
}

function settings(): TickTickSyncSettings {
	return {
		...DEFAULT_SETTINGS,
		syncingStarted: true,
		folderPerProject: false,
		// Pinned so the merge's answer is the same on every machine; the point of
		// the test is the writes, not which side wins.
		conflictPolicy: "preferRemote",
	};
}

/**
 * A vault and an account that between them ask for one of everything: a note to
 * create, a task to create, and a task renamed under a note that would have to
 * move.
 */
function scenario() {
	const writes: Writes = [];

	const notes = {
		"Tasks/Old name.md": "---\nticktick_task_id: task-2\nstatus: todo\n---\n\nMy own writing.\n",
		"Tasks/New idea.md": "Something I have not sent to TickTick yet.\n",
	};

	const remote = [
		task({ id: "task-1", title: "Buy milk" }),
		task({ id: "task-2", title: "New name", content: "Renamed in TickTick." }),
	];

	const state: SyncState = {
		version: SYNC_STATE_VERSION,
		entries: {
			"task-2": {
				taskId: "task-2",
				projectId: "list-a",
				notePath: "Tasks/Old name.md",
				base: toSnapshot(task({ id: "task-2", title: "Old name" })),
				localMtime: 1_000,
				lastSyncedAt: 1,
			},
			// Tracked, with no note on disk and no task in the account — the branch
			// that reaches for the store hardest.
			"task-3": {
				taskId: "task-3",
				projectId: "list-a",
				notePath: "Tasks/Vanished.md",
				base: toSnapshot(task({ id: "task-3", title: "Vanished" })),
				localMtime: 1_000,
				lastSyncedAt: 1,
			},
		},
		tombstones: {},
	};

	const engine = new SyncEngine({
		client: readOnlyClient(fakeClient(remote, writes)),
		notes: new ReadOnlyNoteRepository(fakeApp(notes, writes), DEFAULT_PROPERTIES),
		store: previewStore(state),
		settings: settings(),
		persist: refusePersist,
		log: () => {},
	});

	return { engine, writes, state };
}

describe("previewing a sync", () => {
	it("plans the changes it would make", async () => {
		const { engine } = scenario();
		const report = await engine.sync({ dryRun: true });

		expect(report.planned).toContain('Create note for "Buy milk"');
		expect(report.planned).toContain("Create TickTick task from Tasks/New idea.md");
		expect(report.planned).toContain("Move note Tasks/Old name.md → Tasks/New name.md");
	});

	it("writes nothing to the vault and nothing to TickTick", async () => {
		const { engine, writes } = scenario();
		await engine.sync({ dryRun: true });

		expect(writes).toEqual([]);
	});

	// Every refusal lands in the error list, so an empty one is the proof that
	// nothing even tried.
	it("does not have to be stopped from writing", async () => {
		const { engine } = scenario();
		const report = await engine.sync({ dryRun: true });

		expect(report.errors).toEqual([]);
	});

	it("leaves the sync state exactly as it found it", async () => {
		const { engine, state } = scenario();
		const before = structuredClone(state);

		await engine.sync({ dryRun: true });

		// The pass genuinely moves the store about — counting the passes a note
		// has been missing for is what decides whether a deletion is proposed —
		// so this is checking that none of it survived.
		expect(state).toEqual(before);
	});

	/**
	 * The write that was actually shipping: a note whose title matches a task
	 * nobody claims is adopted rather than duplicated, and that adoption stamped
	 * the note before anything checked whether this was a dry run.
	 */
	it("does not stamp a note while adopting the task it matches", async () => {
		const writes: Writes = [];
		const engine = new SyncEngine({
			client: readOnlyClient(fakeClient([task({ id: "task-1", title: "Buy milk" })], writes)),
			notes: new ReadOnlyNoteRepository(
				fakeApp({ "Tasks/Buy milk.md": "Just a note.\n" }, writes),
				DEFAULT_PROPERTIES,
			),
			store: previewStore({ version: SYNC_STATE_VERSION, entries: {}, tombstones: {} }),
			settings: settings(),
			persist: refusePersist,
			log: () => {},
		});

		const report = await engine.sync({ dryRun: true });

		expect(report.planned).toContain('Re-link Tasks/Buy milk.md to its existing task "Buy milk"');
		expect(writes).toEqual([]);
		expect(report.errors).toEqual([]);
	});

	it("reports nothing as created, updated or deleted", async () => {
		const { engine } = scenario();
		const report = await engine.sync({ dryRun: true });

		expect(report.createdLocal + report.createdRemote).toBe(0);
		expect(report.updatedLocal + report.updatedRemote).toBe(0);
		expect(report.deletedLocal + report.deletedRemote).toBe(0);
	});
});

describe("the read-only dependencies", () => {
	it("refuses every write on the client and allows every read", async () => {
		const writes: Writes = [];
		const client = readOnlyClient(fakeClient([task({ id: "task-1" })], writes));

		expect(() => client.createTask(blankTask("list-a"))).toThrow(/Preview tried to create/);
		expect(() => client.updateTask(task({ id: "task-1" }))).toThrow(/Preview tried to update/);
		expect(() => client.moveTask("task-1", "list-a", "list-b")).toThrow(/Preview tried to move/);
		expect(() => client.completeTask("list-a", "task-1")).toThrow(/Preview tried to complete/);
		expect(() => client.deleteTask("list-a", "task-1")).toThrow(/Preview tried to delete/);
		expect(writes).toEqual([]);

		expect(await client.listProjects()).toHaveLength(1);
		expect((await client.listTasksInProject("list-a")).tasks).toHaveLength(1);
	});

	it("refuses every write on the vault and allows every read", async () => {
		const writes: Writes = [];
		const notes = { "Tasks/Buy milk.md": "---\nticktick_task_id: task-1\n---\n\nBody\n" };
		const repository = new ReadOnlyNoteRepository(fakeApp(notes, writes), DEFAULT_PROPERTIES);
		const target = file("Tasks/Buy milk.md");
		const content = { frontmatter: {}, body: "" };

		expect(() => repository.write(target, content)).toThrow(/Preview tried to write/);
		expect(() => repository.create("Tasks/New.md", content)).toThrow(/Preview tried to create/);
		expect(() => repository.rename(target, "Tasks/Other.md")).toThrow(/Preview tried to move/);
		expect(() => repository.delete(target)).toThrow(/Preview tried to delete/);
		expect(() => repository.ensureFolder("Tasks")).toThrow(/Preview tried to create/);
		expect(() => refusePersist()).toThrow(/Preview tried to save/);
		expect(writes).toEqual([]);

		expect(repository.listMarkdown("Tasks")).toHaveLength(1);
		expect((await repository.read(target)).frontmatter.ticktick_task_id).toBe("task-1");
	});
});

describe("the preview report", () => {
	it("lists the planned changes and says nothing was written", () => {
		const rendered = renderPreviewReport(
			{
				createdLocal: 0,
				createdRemote: 0,
				updatedLocal: 0,
				updatedRemote: 0,
				deletedLocal: 0,
				deletedRemote: 0,
				conflicts: 0,
				errors: ["Failed to read list \"Personal\""],
				durationMs: 12,
				planned: ['Create note for "Buy milk"'],
			},
			{ generatedAt: 0 },
		);

		expect(rendered).toContain("**Nothing was changed.**");
		expect(rendered).toContain('- Create note for "Buy milk"');
		expect(rendered).toContain("## Problems found while reading");
	});

	it("says so plainly when the two sides already agree", () => {
		const rendered = renderPreviewReport(
			{
				createdLocal: 0,
				createdRemote: 0,
				updatedLocal: 0,
				updatedRemote: 0,
				deletedLocal: 0,
				deletedRemote: 0,
				conflicts: 0,
				errors: [],
				durationMs: 3,
				planned: [],
			},
			{ generatedAt: 0 },
		);

		expect(rendered).toContain("Nothing. Both sides already agree.");
		expect(rendered).not.toContain("## Problems found while reading");
	});
});
