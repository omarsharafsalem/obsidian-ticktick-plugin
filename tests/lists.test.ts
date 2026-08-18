import type { App, TFile as TFileType } from "obsidian";
import { TFile } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import type { Capabilities, TickTickClient } from "../src/api/client";
import { blankTask, type NewTask, type Project, type Task } from "../src/api/types";
import {
	DEFAULT_SETTINGS,
	listSkipReason,
	routingForKind,
	type TickTickSyncSettings,
} from "../src/settings";
import { SyncEngine } from "../src/sync/engine";
import { taskToNote } from "../src/sync/mapper";
import { toSnapshot } from "../src/sync/reconcile";
import { emptyState, SyncStore, type SyncEntry } from "../src/sync/state";
import { joinFrontmatter, NoteRepository } from "../src/vault/notes";

/**
 * What a list's `kind` and `closed` flags mean for the notes belonging to it.
 *
 * Both came off a real account, and neither was being read. Three of the user's
 * lists are notes lists rather than task lists, so their entries were being
 * filed among the tasks; and any list can be archived, which is the dangerous
 * one — archiving stops a list returning its tasks, which is byte-for-byte what
 * a list whose every task was deleted looks like. This plugin has destroyed
 * real notes once already by reading absence as intent, so the archived case is
 * exercised end to end here rather than argued about.
 */

function project(overrides: Partial<Project> = {}): Project {
	return { id: "list-a", name: "Errands", closed: false, kind: "TASK", ...overrides };
}

function settingsWith(overrides: Partial<TickTickSyncSettings> = {}): TickTickSyncSettings {
	return {
		...DEFAULT_SETTINGS,
		...overrides,
		listKinds: overrides.listKinds ?? {
			TASK: { ...DEFAULT_SETTINGS.listKinds.TASK },
			NOTE: { ...DEFAULT_SETTINGS.listKinds.NOTE },
		},
	};
}

describe("deciding which lists to skip", () => {
	it("syncs an ordinary task list", () => {
		expect(listSkipReason(project(), settingsWith())).toBeUndefined();
	});

	// A notes list is filed differently, not left behind: its entries are still
	// worth having in the vault.
	it("syncs a notes list", () => {
		expect(listSkipReason(project({ kind: "NOTE" }), settingsWith())).toBeUndefined();
	});

	it("skips an archived list", () => {
		expect(listSkipReason(project({ closed: true }), settingsWith())).toMatch(/archived/i);
	});

	it("says an archived list's notes are left alone, since that is what happens", () => {
		expect(listSkipReason(project({ closed: true }), settingsWith())).toMatch(/left exactly as/i);
	});

	it("skips a list left out of the selection", () => {
		const reason = listSkipReason(project(), settingsWith({ projectFilter: ["list-b"] }));
		expect(reason).toMatch(/not one of the lists selected/i);
	});

	it("syncs a list that is in the selection", () => {
		expect(listSkipReason(project(), settingsWith({ projectFilter: ["list-a"] }))).toBeUndefined();
	});
});

describe("routing a list by its kind", () => {
	const routed = settingsWith({
		taskFolder: "Tasks",
		taskMarker: { property: "note_type", value: "📌 task" },
		listKinds: {
			TASK: { folder: "", noteType: "" },
			NOTE: { folder: "🧠 Notes", noteType: "💭 thought" },
		},
	});

	it("files a notes list where notes go", () => {
		expect(routingForKind("NOTE", routed).folder).toBe("🧠 Notes");
	});

	it("leaves a task list in the task folder", () => {
		expect(routingForKind("TASK", routed).folder).toBe("Tasks");
	});

	/**
	 * The values in a real vault carry emoji as part of the string — "📌 task",
	 * not "task" — and a closed set of them only works if what goes in comes back
	 * out untouched.
	 */
	it("writes the note type exactly as configured, emoji and all", () => {
		expect(routingForKind("NOTE", routed).noteType).toBe("💭 thought");
		expect(routingForKind("TASK", routed).noteType).toBe("📌 task");
	});

	it("falls back to the task folder and marker value when a kind is unconfigured", () => {
		const bare = settingsWith({
			taskFolder: "Tasks",
			taskMarker: { property: "note_type", value: "📌 task" },
		});

		expect(routingForKind("NOTE", bare)).toEqual({ folder: "Tasks", noteType: "📌 task" });
	});

	// TickTick omits the field on some lists, and guessing "notes" on a missing
	// value would file real tasks somewhere they were never meant to go.
	it("treats a list of unreported kind as a task list", () => {
		expect(routingForKind(undefined, routed)).toEqual(routingForKind("TASK", routed));
	});
});

// --- A vault and an account, in memory ---------------------------------------

/**
 * Enough of Obsidian's vault for `NoteRepository` to work against. Files are
 * real objects with real contents, so a note that is renamed, rewritten or
 * trashed is observable afterwards — which is the whole point of the test.
 */
class FakeVault {
	readonly files = new Map<string, TFileType>();
	readonly contents = new Map<string, string>();
	readonly trashed: string[] = [];
	readonly renamed: Array<{ from: string; to: string }> = [];

	add(path: string, contents: string): TFileType {
		const file = new TFile() as TFileType;
		nameFile(file, path);
		file.stat = { mtime: 1_000, ctime: 1_000, size: contents.length };
		this.files.set(path, file);
		this.contents.set(path, contents);
		return file;
	}

	getName(): string {
		return "Test vault";
	}

	async read(file: TFileType): Promise<string> {
		return this.contents.get(file.path) ?? "";
	}

	async modify(file: TFileType, contents: string): Promise<void> {
		this.contents.set(file.path, contents);
	}

	async create(path: string, contents: string): Promise<TFileType> {
		return this.add(path, contents);
	}

	async createFolder(): Promise<void> {}

	getAbstractFileByPath(path: string): TFileType | null {
		return this.files.get(path) ?? null;
	}

	getMarkdownFiles(): TFileType[] {
		return [...this.files.values()];
	}

	getFiles(): TFileType[] {
		return [...this.files.values()];
	}
}

class FakeFileManager {
	constructor(private readonly vault: FakeVault) {}

	async renameFile(file: TFileType, path: string): Promise<void> {
		const contents = this.vault.contents.get(file.path) ?? "";
		this.vault.renamed.push({ from: file.path, to: path });
		this.vault.files.delete(file.path);
		this.vault.contents.delete(file.path);
		nameFile(file, path);
		this.vault.files.set(path, file);
		this.vault.contents.set(path, contents);
	}

	async trashFile(file: TFileType): Promise<void> {
		this.vault.trashed.push(file.path);
		this.vault.files.delete(file.path);
		this.vault.contents.delete(file.path);
	}
}

/** The three name fields Obsidian keeps in step with a file's path. */
function nameFile(file: TFileType, path: string): void {
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
}

const CAPABILITIES: Capabilities = { completedHistory: true, modifiedTime: false, inbox: true };

/** A TickTick account that answers only for the lists it is told about. */
class FakeClient implements TickTickClient {
	readonly capabilities = CAPABILITIES;
	readonly deleted: string[] = [];
	readonly created: NewTask[] = [];

	constructor(
		private projects: Project[],
		private tasks: Task[],
	) {}

	/** Archives a list, exactly as TickTick does: it stops returning its tasks. */
	archive(projectId: string): void {
		this.projects = this.projects.map((p) => (p.id === projectId ? { ...p, closed: true } : p));
	}

	async listProjects(): Promise<Project[]> {
		return this.projects.map((p) => ({ ...p }));
	}

	async listTasksInProject(projectId: string): Promise<Task[]> {
		const list = this.projects.find((p) => p.id === projectId);
		if (!list || list.closed) return [];
		return this.tasks.filter((task) => task.projectId === projectId).map((task) => ({ ...task }));
	}

	async getTask(_projectId: string, taskId: string): Promise<Task | null> {
		return this.tasks.find((task) => task.id === taskId) ?? null;
	}

	async createTask(task: NewTask): Promise<Task> {
		this.created.push(task);
		const created = { ...task, id: `created-${this.created.length}` } as Task;
		this.tasks.push(created);
		return created;
	}

	async updateTask(task: Task): Promise<Task> {
		return task;
	}

	async moveTask(): Promise<void> {}

	async completeTask(): Promise<void> {}

	async deleteTask(_projectId: string, taskId: string): Promise<void> {
		this.deleted.push(taskId);
		this.tasks = this.tasks.filter((task) => task.id !== taskId);
	}

	async listCompletedTasks(): Promise<Task[]> {
		// The account has nothing completed, but the call succeeding is what lets
		// the engine read anything into a task's absence at all — so it must not
		// throw, or every assertion below would pass for the wrong reason.
		return [];
	}
}

interface Harness {
	vault: FakeVault;
	client: FakeClient;
	store: SyncStore;
	settings: TickTickSyncSettings;
	engine: SyncEngine;
}

function engineOn(
	vault: FakeVault,
	client: FakeClient,
	store: SyncStore,
	settings: TickTickSyncSettings,
): SyncEngine {
	const app = { vault, fileManager: new FakeFileManager(vault) } as unknown as App;
	return new SyncEngine({
		client,
		notes: new NoteRepository(app, settings.properties),
		store,
		settings,
		persist: async () => {},
		log: () => {},
	});
}

function entryFor(task: Task, notePath: string): SyncEntry {
	return {
		taskId: task.id,
		projectId: task.projectId,
		notePath,
		base: toSnapshot(task),
		localMtime: 1_000,
		lastSyncedAt: 1_000,
	};
}

function task(overrides: Partial<Task> = {}): Task {
	return {
		...blankTask("list-a"),
		id: "task-1",
		title: "Renew passport",
		content: "at the post office",
		...overrides,
	};
}

/** An account and an empty vault, ready for a first pass. */
function harness(options: {
	projects: Project[];
	tasks: Task[];
	settings?: TickTickSyncSettings;
}): Harness {
	const vault = new FakeVault();
	const settings = options.settings ?? settingsWith();
	const store = new SyncStore(emptyState());
	const client = new FakeClient(options.projects, [...options.tasks]);

	return { vault, client, store, settings, engine: engineOn(vault, client, store, settings) };
}

// --- The archived list --------------------------------------------------------

describe("a list archived between two syncs", () => {
	const lists = [project(), project({ id: "list-b", name: "Someday" })];
	const tasks = [task(), task({ id: "task-2", projectId: "list-b", title: "Learn Welsh" })];

	const NOTE_PATH = "Tasks/Errands/Renew passport.md";

	let setup: Harness;

	beforeEach(async () => {
		setup = harness({ projects: lists, tasks });
		// The pass before the archiving, so both sides are settled and agreed.
		const report = await setup.engine.sync();
		expect(report.errors).toEqual([]);
		expect(setup.vault.files.has(NOTE_PATH)).toBe(true);
	});

	it("leaves the note exactly where it was", async () => {
		setup.client.archive("list-a");
		const before = setup.vault.contents.get(NOTE_PATH);

		const report = await setup.engine.sync();

		expect(report.errors).toEqual([]);
		expect(setup.vault.files.has(NOTE_PATH)).toBe(true);
		expect(setup.vault.contents.get(NOTE_PATH)).toBe(before);
	});

	it("does not sweep the note into the deleted-tasks folder", async () => {
		setup.client.archive("list-a");
		await setup.engine.sync();

		expect(setup.vault.renamed).toEqual([]);
		expect(setup.vault.trashed).toEqual([]);
	});

	it("keeps tracking the task, so un-archiving picks up where it left off", async () => {
		setup.client.archive("list-a");
		await setup.engine.sync();

		expect(setup.store.get("task-1")?.notePath).toBe(NOTE_PATH);
		expect(setup.store.isTombstoned("task-1")).toBe(false);
	});

	it("deletes nothing in TickTick", async () => {
		setup.client.archive("list-a");
		await setup.engine.sync();

		expect(setup.client.deleted).toEqual([]);
	});

	it("does not push the note back as a second task", async () => {
		setup.client.archive("list-a");
		await setup.engine.sync();

		expect(setup.client.created).toEqual([]);
	});

	it("carries on syncing the lists that are still live", async () => {
		setup.client.archive("list-a");
		const report = await setup.engine.sync();

		expect(report.errors).toEqual([]);
		expect(setup.vault.files.has("Tasks/Someday/Learn Welsh.md")).toBe(true);
		expect(setup.store.get("task-2")).toBeDefined();
	});

	/**
	 * The hole the existing guard did not cover.
	 *
	 * That guard reads the *stored* list for a task, and the store is emptied by
	 * "Reset sync state" and by any state version bump. A note whose list was
	 * archived in the meantime then reaches reconcile with no base, no task and
	 * an id proving it was linked once — which reads as a deleted task, and the
	 * note is swept into the archive folder and tombstoned so it can never link
	 * back. Its own list property is the evidence that says otherwise.
	 */
	it("survives an archived list even with the sync state cleared", async () => {
		setup.client.archive("list-a");
		setup.store = new SyncStore(emptyState());

		await engineOn(setup.vault, setup.client, setup.store, setup.settings).sync();

		expect(setup.vault.files.has(NOTE_PATH)).toBe(true);
		expect(setup.vault.renamed).toEqual([]);
		expect(setup.vault.trashed).toEqual([]);
		expect(setup.client.created).toEqual([]);
		expect(setup.store.isTombstoned("task-1")).toBe(false);
	});

	// The archived case must not buy its safety by making genuine deletions
	// invisible: a task deleted from a live list still archives its note.
	it("still archives a note whose task was deleted from a live list", async () => {
		await setup.client.deleteTask("list-a", "task-1");
		await setup.engine.sync();

		expect(setup.vault.renamed).toEqual([
			{ from: NOTE_PATH, to: "🗄️ Archive/Renew passport.md" },
		]);
	});

	// The guard also has to work from the store alone, since a note whose list is
	// archived cannot be re-read from a fetch that never happened.
	it("leaves a note alone when only the sync state knows which list it was in", async () => {
		setup.client.archive("list-a");
		setup.store.set(entryFor(task(), NOTE_PATH));

		await setup.engine.sync();

		expect(setup.vault.files.has(NOTE_PATH)).toBe(true);
		expect(setup.client.deleted).toEqual([]);
	});
});

// --- The notes list -----------------------------------------------------------

describe("a notes list", () => {
	const lists = [project(), project({ id: "list-n", name: "Career Notes", kind: "NOTE" })];
	const tasks = [task(), task({ id: "note-1", projectId: "list-n", title: "Things to read" })];

	const routed = () =>
		settingsWith({
			taskMarker: { property: "note_type", value: "📌 task" },
			listKinds: {
				TASK: { folder: "", noteType: "" },
				NOTE: { folder: "🧠 Notes", noteType: "💭 thought" },
			},
		});

	it("is synced like any other list", async () => {
		const setup = harness({ projects: lists, tasks });
		await setup.engine.sync();

		expect(setup.vault.files.has("Tasks/Career Notes/Things to read.md")).toBe(true);
	});

	it("goes to the folder set for notes lists, not the task folder", async () => {
		const setup = harness({ projects: lists, tasks, settings: routed() });
		await setup.engine.sync();

		expect(setup.vault.files.has("🧠 Notes/Career Notes/Things to read.md")).toBe(true);
		expect(setup.vault.files.has("Tasks/Errands/Renew passport.md")).toBe(true);
	});

	it("calls itself the note type set for notes lists, emoji intact", async () => {
		const setup = harness({ projects: lists, tasks, settings: routed() });
		await setup.engine.sync();

		expect(setup.vault.contents.get("🧠 Notes/Career Notes/Things to read.md")).toContain(
			"note_type: 💭 thought",
		);
		expect(setup.vault.contents.get("Tasks/Errands/Renew passport.md")).toContain(
			"note_type: 📌 task",
		);
	});

	/**
	 * A notes list entry arrives with a status and a priority like anything else
	 * TickTick returns, and they are written rather than dropped. Having task
	 * fields on a note is worth far less than losing what the account holds, and
	 * anyone who does not want them has the per-field direction settings.
	 */
	it("keeps whatever status and priority TickTick reports for it", async () => {
		const setup = harness({
			projects: lists,
			tasks: [task({ id: "note-1", projectId: "list-n", title: "Things to read", priority: "high" })],
			settings: routed(),
		});

		await setup.engine.sync();

		const note = setup.vault.contents.get("🧠 Notes/Career Notes/Things to read.md");
		expect(note).toContain("priority: high");
		expect(note).toContain("status: todo");
	});

	// Routing is about where a note is filed. It must not become another way for
	// a list to go unread, which is how the archived bug started.
	it("is still fetched when nothing has been routed", async () => {
		const setup = harness({ projects: lists, tasks });
		const report = await setup.engine.sync();

		expect(report.errors).toEqual([]);
		expect(setup.store.get("note-1")).toBeDefined();
	});
});

// --- Notes the marker no longer describes -------------------------------------

/**
 * Discovery still matches only the marker's own value. A vault that files notes
 * as "💭 thought" is full of thoughts that were never tasks, and matching those
 * would push every one of them to TickTick as a new task — the one operation
 * that multiplies. What keeps a routed note recognised is its task id.
 */
describe("finding a note whose note type is not the marker value", () => {
	it("keeps syncing a notes-list note across passes", async () => {
		const lists = [project({ id: "list-n", name: "Career Notes", kind: "NOTE" })];
		const setup = harness({
			projects: lists,
			tasks: [task({ id: "note-1", projectId: "list-n", title: "Things to read" })],
			settings: settingsWith({
				discoverAnywhere: true,
				taskMarker: { property: "note_type", value: "📌 task" },
				listKinds: {
					TASK: { folder: "", noteType: "" },
					NOTE: { folder: "🧠 Notes", noteType: "💭 thought" },
				},
			}),
		});

		await setup.engine.sync();
		const report = await setup.engine.sync();

		expect(report.errors).toEqual([]);
		expect(setup.vault.files.has("🧠 Notes/Career Notes/Things to read.md")).toBe(true);
		expect(setup.client.created).toEqual([]);
		expect(setup.vault.trashed).toEqual([]);
	});

	it("does not adopt an ordinary note that merely shares the note type", async () => {
		const settings = settingsWith({
			discoverAnywhere: true,
			taskMarker: { property: "note_type", value: "📌 task" },
			listKinds: {
				TASK: { folder: "", noteType: "" },
				NOTE: { folder: "🧠 Notes", noteType: "💭 thought" },
			},
		});
		const setup = harness({ projects: [project()], tasks: [], settings });

		setup.vault.add(
			"🧠 Notes/A thought I had.md",
			joinFrontmatter({ frontmatter: { note_type: "💭 thought" }, body: "" }),
		);

		await setup.engine.sync();

		expect(setup.client.created).toEqual([]);
		expect(setup.vault.files.has("🧠 Notes/A thought I had.md")).toBe(true);
	});
});

// --- Notes belonging to a list this pass never read ---------------------------

describe("a note whose list is not being synced", () => {
	it("is never pushed as a new task into that list", async () => {
		const lists = [project(), project({ id: "list-b", name: "Someday" })];
		const settings = settingsWith({ projectFilter: ["list-a"] });
		const setup = harness({ projects: lists, tasks: [], settings });

		// A note naming a list left out of the selection. Without a task id it
		// looks brand new, and the list it names is one nothing was read from.
		setup.vault.add(
			"Tasks/Learn Welsh.md",
			joinFrontmatter(
				taskToNote(task({ id: "", projectId: "list-b", title: "Learn Welsh" }), undefined, {
					projectName: "Someday",
				}),
			),
		);

		await setup.engine.sync();

		expect(setup.client.created).toEqual([]);
	});
});
