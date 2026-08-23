import { beforeEach, describe, expect, it } from "vitest";
import type { Capabilities, TickTickClient } from "../src/api/client";
import { blankTask, type NewTask, type Project, type Task } from "../src/api/types";
import { DEFAULT_SETTINGS, type TickTickSyncSettings } from "../src/settings";
import { SyncEngine } from "../src/sync/engine";
import { SyncStore } from "../src/sync/state";
import { NoteRepository } from "../src/vault/notes";
import { FakeVault } from "./stubs/vault";

/**
 * Whole-engine tests, run against an in-memory vault and a scripted client.
 *
 * Everything here is about the two questions the pure modules cannot answer on
 * their own: what the engine concludes when the network only half-answers, and
 * where the remote edit time comes from when the API refuses to report one.
 */

const OPEN_API: Capabilities = {
	completedHistory: true,
	modifiedTime: false,
	inbox: true,
	// Small enough to fill in a test; the real endpoint stops at 200.
	listPageSize: 3,
};

class FakeClient implements TickTickClient {
	readonly capabilities = OPEN_API;

	projects: Project[] = [{ id: "p1", name: "List one", closed: false }];
	tasks = new Map<string, Task[]>([["p1", []]]);

	/** Lists whose fetch throws, standing in for a timeout or a 500. */
	failing = new Set<string>();
	/** Set when the completed-task listing itself should fail. */
	completedFails = false;

	readonly updated: Task[] = [];
	readonly created: NewTask[] = [];
	readonly deleted: string[] = [];

	async listProjects(): Promise<Project[]> {
		return this.projects;
	}

	async listTasksInProject(projectId: string): Promise<{ tasks: Task[]; sections: [] }> {
		if (this.failing.has(projectId)) throw new Error("the list could not be read");
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
		if (this.completedFails) throw new Error("the completed list could not be read");
		return [];
	}
}

function settings(overrides: Partial<TickTickSyncSettings> = {}): TickTickSyncSettings {
	return { ...DEFAULT_SETTINGS, confirmDeletions: false, ...overrides };
}

function harness(options: Partial<TickTickSyncSettings> = {}) {
	const vault = new FakeVault();
	const client = new FakeClient();
	const store = new SyncStore();
	const config = settings(options);
	const engine = new SyncEngine({
		client,
		notes: new NoteRepository(vault.app as never, config.properties),
		store,
		settings: config,
		persist: async () => {},
		log: () => {},
	});

	return { vault, client, store, engine };
}

function task(overrides: Partial<Task> = {}): Task {
	return {
		...blankTask("p1"),
		id: "task-1",
		title: "Buy milk",
		content: "agreed",
		etag: "etag-1",
		...overrides,
	};
}

const NOTE_PATH = "Tasks/List one/Buy milk.md";

describe("a list that could not be read", () => {
	let context: ReturnType<typeof harness>;

	beforeEach(async () => {
		context = harness();
		context.client.tasks.set("p1", [task()]);
		await context.engine.sync();
	});

	it("writes the note on the pass that succeeds", () => {
		expect(context.vault.paths).toEqual([NOTE_PATH]);
		expect(context.store.get("task-1")).toBeDefined();
	});

	// The failure this guards is the one that has destroyed real data twice: a
	// task missing because nothing asked for it, read as a task that was deleted.
	it("leaves the note alone when the list fetch throws", async () => {
		context.client.failing.add("p1");

		const report = await context.engine.sync();

		expect(context.vault.paths).toEqual([NOTE_PATH]);
		expect(context.store.get("task-1")).toBeDefined();
		expect(report.errors.join(" ")).toContain("List one");
	});

	it("says which list failed, so the untouched notes are explainable", async () => {
		context.client.failing.add("p1");

		const report = await context.engine.sync();

		expect(report.errors.join(" ")).toContain("left untouched");
	});

	// The control: absence only means deletion once something actually looked.
	// Without this the test above would pass on inertia rather than on the guard.
	it("archives the note when the list is read and the task is genuinely gone", async () => {
		context.client.tasks.set("p1", []);

		await context.engine.sync();

		expect(context.vault.paths).toEqual(["🗄️ Archive/Buy milk.md"]);
	});

	it("leaves the note alone when the completed listing failed instead", async () => {
		context.client.tasks.set("p1", []);
		context.client.completedFails = true;

		await context.engine.sync();

		expect(context.vault.paths).toEqual([NOTE_PATH]);
	});

	// The same guard under the setting that makes it matter most: here a task
	// wrongly believed deleted takes the note with it rather than archiving it.
	it("leaves the note alone even when notes are set to follow deletions", async () => {
		const destructive = harness({ remoteDeletion: "deleteNote" });
		destructive.client.tasks.set("p1", [task()]);
		await destructive.engine.sync();
		destructive.client.failing.add("p1");

		await destructive.engine.sync();

		expect(destructive.vault.paths).toEqual([NOTE_PATH]);
	});

	/**
	 * A list filled exactly to the page limit may have been cut off, and nothing
	 * in the response says so. The tasks that did arrive still sync; the ones
	 * that may not have are not deletions.
	 */
	it("concludes nothing from a list that came back exactly full", async () => {
		context.client.tasks.set("p1", [
			task({ id: "task-2", title: "One" }),
			task({ id: "task-3", title: "Two" }),
			task({ id: "task-4", title: "Three" }),
		]);

		const report = await context.engine.sync();

		expect(context.vault.paths).toContain(NOTE_PATH);
		expect(report.errors.join(" ")).toContain("as many as");
	});

	it("still writes the notes for the tasks that did arrive", async () => {
		context.client.tasks.set("p1", [
			task({ id: "task-2", title: "One" }),
			task({ id: "task-3", title: "Two" }),
			task({ id: "task-4", title: "Three" }),
		]);

		await context.engine.sync();

		expect(context.vault.paths).toContain("Tasks/List one/One.md");
	});

	it("deletes that same note once the list is read and the task is gone", async () => {
		const destructive = harness({ remoteDeletion: "deleteNote" });
		destructive.client.tasks.set("p1", [task()]);
		await destructive.engine.sync();
		destructive.client.tasks.set("p1", []);

		await destructive.engine.sync();

		expect(destructive.vault.paths).toEqual([]);
	});
});


/**
 * "Most recently edited wins", answered from the timestamp the API reports.
 *
 * `GET /project/{id}/data` returns a real `modifiedTime` on every task, so
 * there is nothing to infer: the two sides' times are compared directly.
 */
describe("newest wins", () => {
	const AGREED_AT = Date.parse("2026-08-17T19:01:17.084Z");

	async function linked() {
		const context = harness();
		context.client.tasks.set("p1", [
			task({ modifiedTime: new Date(AGREED_AT).toISOString() }),
		]);
		await context.engine.sync();
		return context;
	}

	/** Both sides edited away from what they last agreed on, at chosen times. */
	function diverge(
		context: Awaited<ReturnType<typeof linked>>,
		times: { remote: number; note: number },
	) {
		context.client.tasks.set("p1", [
			task({
				content: "the TickTick version",
				etag: "etag-2",
				modifiedTime: new Date(times.remote).toISOString(),
			}),
		]);
		context.vault.edit(NOTE_PATH, (raw) => raw.replace("agreed", "the note version"), times.note);
	}

	it("keeps the note's version when the note was edited later", async () => {
		const context = await linked();
		diverge(context, { remote: AGREED_AT + 1000, note: AGREED_AT + 60_000 });

		await context.engine.sync();

		expect(context.client.updated.at(-1)?.content).toBe("the note version");
	});

	it("takes TickTick's version when the task was edited later", async () => {
		const context = await linked();
		diverge(context, { remote: AGREED_AT + 60_000, note: AGREED_AT + 1000 });

		await context.engine.sync();

		expect(context.client.updated).toEqual([]);
		expect(context.vault.contentOf(NOTE_PATH)).toContain("the TickTick version");
	});

	// Milliseconds are what separate two edits made in the same second, and are
	// the part of the wire format most likely to be dropped on the way in.
	it("separates two edits a millisecond apart", async () => {
		const context = await linked();
		diverge(context, { remote: AGREED_AT + 5000, note: AGREED_AT + 5001 });

		await context.engine.sync();

		expect(context.client.updated.at(-1)?.content).toBe("the note version");
	});

	// Without a time on one side "newest" is unanswerable, and the reconciler
	// documents that it favours the server. Worth pinning: it is the behaviour
	// the whole plugin fell back to while modifiedTime was believed absent.
	it("falls back to the server when the task carries no time at all", async () => {
		const context = await linked();
		diverge(context, { remote: AGREED_AT + 1000, note: AGREED_AT + 60_000 });
		context.client.tasks.set("p1", [
			task({ content: "the TickTick version", etag: "etag-2", modifiedTime: undefined }),
		]);

		await context.engine.sync();

		expect(context.client.updated).toEqual([]);
		expect(context.vault.contentOf(NOTE_PATH)).toContain("the TickTick version");
	});
});

/**
 * The completed listing is the evidence that separates "finished" from
 * "deleted". Without it, absence from the open listing means nothing at all.
 */
describe("when the completed listing could not be read", () => {
	it("leaves a tracked note alone", async () => {
		const context = harness();
		context.client.tasks.set("p1", [task()]);
		await context.engine.sync();

		context.client.tasks.set("p1", []);
		context.client.completedFails = true;
		await context.engine.sync();

		expect(context.vault.paths).toEqual([NOTE_PATH]);
	});

	// A note can hold a task id with nothing tracked against it — after a state
	// reset, or a re-link that has not landed. It is linked everywhere else in
	// the engine, and it has to be linked here too.
	it("leaves an untracked but linked note alone as well", async () => {
		const context = harness();
		context.client.tasks.set("p1", [task()]);
		await context.engine.sync();

		context.store.forget("task-1");
		context.client.tasks.set("p1", []);
		context.client.completedFails = true;
		await context.engine.sync();

		expect(context.vault.paths).toEqual([NOTE_PATH]);
	});

	// The 23 Aug 2026 data loss. A note pointed at a seconds-old project note the
	// metadata cache had not indexed: its list came back unresolvable, its id was
	// in no fetched list and no state, and "couldn't look" was read as "looked
	// and found nothing" — the note was archived, and two passes later the
	// "missing" note deleted the real task. An unknown id on a note whose list
	// cannot even be resolved is left alone and reported, never archived.
	it("leaves alone a note whose task id and list are both unknown", async () => {
		const context = harness();
		context.vault.seed(
			"Tasks/Planning the audit.md",
			"---\nnote_type: task\nticktick_task_id: ghost-1\nproject: \"[[Nowhere Home]]\"\n---\nbody\n",
		);

		const report = await context.engine.sync();
		await context.engine.sync();

		expect(context.vault.paths).toContain("Tasks/Planning the audit.md");
		expect(context.client.deleted).toEqual([]);
		expect(report.errors.join(" ")).toContain("ghost-1");
	});

	it("archives that same note once the completed listing works", async () => {
		const context = harness();
		context.client.tasks.set("p1", [task()]);
		await context.engine.sync();

		context.store.forget("task-1");
		context.client.tasks.set("p1", []);
		await context.engine.sync();

		expect(context.vault.paths).toEqual(["🗄️ Archive/Buy milk.md"]);
	});
});
