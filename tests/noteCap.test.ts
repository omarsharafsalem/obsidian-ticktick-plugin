import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Capabilities, TickTickClient } from "../src/api/client";
import { blankTask, type NewTask, type Project, type Task } from "../src/api/types";
import { DEFAULT_SETTINGS, mergeSettings, type TickTickSyncSettings } from "../src/settings";
import { SyncEngine } from "../src/sync/engine";
import { SyncStore } from "../src/sync/state";
import { NoteRepository } from "../src/vault/notes";
import { FakeVault } from "./stubs/vault";

/**
 * The limit on notes created from TickTick, and the one pass it must not fire
 * on.
 *
 * Creating notes multiplies exactly as creating tasks does — a task the pass
 * cannot match to its note looks like a task with no note — so the cap refuses
 * the whole batch rather than writing part of it. The interesting case is the
 * first sync, where creating a note per task is the entire point.
 */

const CAPABILITIES: Capabilities = {
	completedHistory: true,
	modifiedTime: false,
	inbox: true,
	// No page limit, so a big list does not also trip the partial-listing guard
	// and cloud the reports these tests read.
	listPageSize: undefined,
};

class FakeClient implements TickTickClient {
	readonly capabilities = CAPABILITIES;

	projects: Project[] = [{ id: "p1", name: "List one", closed: false }];
	tasks = new Map<string, Task[]>([["p1", []]]);

	readonly created: NewTask[] = [];
	readonly updated: Task[] = [];
	readonly deleted: string[] = [];

	async listProjects(): Promise<Project[]> {
		return this.projects;
	}

	async listTasksInProject(projectId: string): Promise<{ tasks: Task[]; sections: [] }> {
		return { tasks: this.tasks.get(projectId) ?? [], sections: [] };
	}

	async getTask(): Promise<Task | null> {
		return null;
	}

	async createTask(task: NewTask): Promise<Task> {
		this.created.push(task);
		return { ...blankTask(task.projectId), ...task, id: `created-${this.created.length}` };
	}

	async updateTask(task: Task): Promise<Task> {
		this.updated.push(task);
		return { ...task, etag: `pushed-${this.updated.length}` };
	}

	async moveTask(): Promise<void> {}

	async completeTask(): Promise<void> {}

	async deleteTask(_projectId: string, taskId: string): Promise<void> {
		this.deleted.push(taskId);
	}

	async listCompletedTasks(): Promise<Task[]> {
		return [];
	}
}

function harness(options: Partial<TickTickSyncSettings> = {}) {
	const vault = new FakeVault();
	const client = new FakeClient();
	const store = new SyncStore();
	const config: TickTickSyncSettings = { ...DEFAULT_SETTINGS, confirmDeletions: false, ...options };
	const engine = new SyncEngine({
		client,
		notes: new NoteRepository(vault.app as never, config.properties),
		store,
		settings: config,
		persist: async () => {},
		log: () => {},
	});

	return { vault, client, store, engine, config };
}

/** `count` tasks that no note has ever seen, numbered so titles stay distinct. */
function tasks(count: number, from = 1): Task[] {
	return Array.from({ length: count }, (_, index) => ({
		...blankTask("p1"),
		id: `task-${from + index}`,
		title: `Task ${from + index}`,
		etag: `etag-${from + index}`,
	}));
}

/** Deletes a note behind the engine's back, the way a user would. */
async function removeNote(vault: FakeVault, path: string): Promise<void> {
	const app = vault.app as {
		vault: { getAbstractFileByPath(path: string): TFile | null };
		fileManager: { trashFile(file: TFile): Promise<void> };
	};
	const file = app.vault.getAbstractFileByPath(path);
	if (file) await app.fileManager.trashFile(file);
}

/**
 * A vault that has already completed a sync, holding one note for one task.
 *
 * The point of every test below is what happens on the *second* pass, because
 * the first is the one pass on which the cap deliberately does nothing.
 */
async function alreadySynced(options: Partial<TickTickSyncSettings> = {}) {
	const context = harness(options);
	context.client.tasks.set("p1", tasks(1));
	await context.engine.sync();
	return context;
}

describe("the first sync of a vault", () => {
	// A real account has hundreds of tasks and every one of them is genuinely
	// new. A cap that refused this would be wrong on the only pass where it is
	// guaranteed to be wrong, and the number would just be raised until it never
	// fired again.
	it("creates a note per task however low the limit is", async () => {
		const { client, engine, vault } = harness({ maxNewNotesPerSync: 2 });
		client.tasks.set("p1", tasks(6));

		const report = await engine.sync();

		expect(report.createdLocal).toBe(6);
		expect(report.errors).toEqual([]);
		expect(vault.paths).toHaveLength(6);
	});

	it("does not exempt the pass after it", async () => {
		const context = harness({ maxNewNotesPerSync: 2 });
		context.client.tasks.set("p1", tasks(6));
		await context.engine.sync();

		context.client.tasks.set("p1", tasks(12));
		const report = await context.engine.sync();

		expect(report.createdLocal).toBe(0);
		expect(context.vault.paths).toHaveLength(6);
	});
});

describe("a vault that has synced before", () => {
	it("refuses the whole batch rather than creating part of it", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 2 });
		context.client.tasks.set("p1", tasks(7));

		const report = await context.engine.sync();

		expect(report.createdLocal).toBe(0);
		expect(context.vault.paths).toEqual(["Tasks/List one/Task 1.md"]);
	});

	it("says how many were planned and what most likely caused it", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 2 });
		context.client.tasks.set("p1", tasks(7));

		const report = await context.engine.sync();

		const said = report.errors.join(" ");
		expect(said).toContain("6 TickTick tasks");
		expect(said).toContain("limit of 2");
		expect(said).toContain("stopped being matched");
		expect(said).toContain("task ID property");
	});

	it("tracks nothing it refused, so a later pass can still write them", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 2 });
		context.client.tasks.set("p1", tasks(7));
		await context.engine.sync();

		expect(context.store.get("task-4")).toBeUndefined();

		context.config.maxNewNotesPerSync = 20;
		const report = await context.engine.sync();

		expect(report.createdLocal).toBe(6);
		expect(context.vault.paths).toHaveLength(7);
	});

	it("creates them when the batch is within the limit", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 6 });
		context.client.tasks.set("p1", tasks(7));

		const report = await context.engine.sync();

		expect(report.createdLocal).toBe(6);
		expect(report.errors).toEqual([]);
		expect(context.vault.paths).toHaveLength(7);
	});

	// The boundary itself: the limit is how many may be created, not how many
	// may be exceeded.
	it("allows a batch exactly the size of the limit", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 3 });
		context.client.tasks.set("p1", tasks(4));

		const report = await context.engine.sync();

		expect(report.createdLocal).toBe(3);
		expect(report.errors).toEqual([]);
	});

	it("counts restoring a deleted note as creating one", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 20 });
		context.client.tasks.set("p1", tasks(5));
		await context.engine.sync();
		expect(context.vault.paths).toHaveLength(5);

		for (const path of context.vault.paths) await removeNote(context.vault, path);
		context.config.maxNewNotesPerSync = 2;

		const report = await context.engine.sync();

		expect(report.createdLocal).toBe(0);
		expect(context.vault.paths).toEqual([]);
		expect(report.errors.join(" ")).toContain("limit of 2");
	});

	// Refusing the creations must not punish the notes that are fine. An update
	// concerns a task that already has a note, so it cannot multiply.
	it("still updates the notes it already has", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 2 });
		const [existing] = tasks(1);
		context.client.tasks.set("p1", [
			{ ...existing, title: "Task 1", content: "changed in TickTick", etag: "etag-changed" },
			...tasks(6, 2),
		]);

		const report = await context.engine.sync();

		expect(report.createdLocal).toBe(0);
		expect(report.updatedLocal).toBe(1);
		expect(context.vault.contentOf("Tasks/List one/Task 1.md")).toContain("changed in TickTick");
	});
});

describe("a limit of zero", () => {
	it("means no limit at all", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 0 });
		context.client.tasks.set("p1", tasks(40));

		const report = await context.engine.sync();

		expect(report.createdLocal).toBe(39);
		expect(report.errors).toEqual([]);
		expect(context.vault.paths).toHaveLength(40);
	});
});

describe("the setting itself", () => {
	it("defaults to a number rather than being absent", () => {
		expect(DEFAULT_SETTINGS.maxNewNotesPerSync).toBeGreaterThan(0);
	});

	// Settings written before this limit existed have nothing stored for it, and
	// reading that absence as zero would turn the cap off for every install that
	// upgrades — which is every install that has one.
	it("reaches settings written before it existed", () => {
		expect(mergeSettings({ taskFolder: "Tasks" }).maxNewNotesPerSync).toBe(
			DEFAULT_SETTINGS.maxNewNotesPerSync,
		);
	});

	it("keeps a stored value, including a deliberate zero", () => {
		expect(mergeSettings({ maxNewNotesPerSync: 5 }).maxNewNotesPerSync).toBe(5);
		expect(mergeSettings({ maxNewNotesPerSync: 0 }).maxNewNotesPerSync).toBe(0);
	});
});

describe("a preview", () => {
	// A dry run writes nothing, so the cap has nothing to protect — but the
	// warning is the whole reason to run one, and listing hundreds of notes it
	// would refuse to write would be reassuring about the wrong thing.
	it("reports the refusal rather than listing what it would have created", async () => {
		const context = await alreadySynced({ maxNewNotesPerSync: 2 });
		context.client.tasks.set("p1", tasks(7));

		const report = await context.engine.sync({ dryRun: true });

		expect(report.errors.join(" ")).toContain("limit of 2");
		expect(report.planned.join(" ")).not.toContain("Task 5");
	});
});
