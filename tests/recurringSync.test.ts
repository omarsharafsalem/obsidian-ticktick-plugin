import { beforeEach, describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import type { Capabilities, TickTickClient } from "../src/api/client";
import { blankTask, type NewTask, type Project, type Task } from "../src/api/types";
import { DEFAULT_FIELD_MODES, mergeSettings, type TickTickSyncSettings } from "../src/settings";
import { SyncEngine } from "../src/sync/engine";
import { SyncStore } from "../src/sync/state";
import { NoteRepository } from "../src/vault/notes";

/**
 * A whole sync pass over a repeating task, run against an in-memory vault.
 *
 * The pure modules settle what the policy *should* be; this settles what the
 * engine actually does with it, which is where the damage would happen. The
 * facts it is pinned to were probed against the live API: completing a
 * repeating task leaves the live task open under the same id with its due date
 * rolled forward, and files a separate record — new id, same title, no repeat
 * rule — for the occurrence that was finished.
 */

const LIST: Project = { id: "list-a", name: "Personal", closed: false };

function file(path: string, mtime: number): TFile {
	const created = new TFile();
	rename(created, path);
	created.extension = "md";
	created.stat = { mtime, ctime: mtime, size: 0 };
	return created;
}

/** `name` carries the extension and `basename` does not; archiving uses `name`. */
function rename(target: TFile, path: string): void {
	target.path = path;
	target.name = path.split("/").pop() ?? "";
	target.basename = target.name.replace(/\.md$/, "");
}

/** Enough of Obsidian's vault for the real NoteRepository to run against. */
class FakeApp {
	private files = new Map<string, TFile>();
	private contents = new Map<string, string>();
	private folders = new Set<string>();
	private clock = 1000;

	readonly vault = {
		getName: () => "Test vault",
		getMarkdownFiles: () => [...this.files.values()],
		getFiles: () => [...this.files.values()],
		getAbstractFileByPath: (path: string): TFile | TFolder | null => {
			const found = this.files.get(path);
			if (found) return found;
			if (!this.folders.has(path)) return null;
			const folder = new TFolder();
			folder.path = path;
			return folder;
		},
		read: async (target: TFile): Promise<string> => this.contents.get(target.path) ?? "",
		modify: async (target: TFile, data: string): Promise<void> => {
			this.contents.set(target.path, data);
			target.stat.mtime = ++this.clock;
		},
		create: async (path: string, data: string): Promise<TFile> => {
			if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
			const created = file(path, ++this.clock);
			this.files.set(path, created);
			this.contents.set(path, data);
			return created;
		},
		createFolder: async (path: string): Promise<void> => {
			this.folders.add(path);
		},
	};

	readonly fileManager = {
		renameFile: async (target: TFile, path: string): Promise<void> => {
			const body = this.contents.get(target.path) ?? "";
			this.files.delete(target.path);
			this.contents.delete(target.path);
			rename(target, path);
			this.files.set(path, target);
			this.contents.set(path, body);
		},
		trashFile: async (target: TFile): Promise<void> => {
			this.files.delete(target.path);
			this.contents.delete(target.path);
		},
	};

	/** Puts a note in the vault directly, as if the user had written it. */
	seed(path: string, raw: string): TFile {
		const created = file(path, ++this.clock);
		this.files.set(path, created);
		this.contents.set(path, raw);
		return created;
	}

	paths(): string[] {
		return [...this.files.keys()].sort();
	}

	body(path: string): string {
		return this.contents.get(path) ?? "";
	}
}

const CAPABILITIES: Capabilities = { completedHistory: true, modifiedTime: false, inbox: true };

class FakeClient implements TickTickClient {
	readonly capabilities = CAPABILITIES;
	readonly deleted: string[] = [];
	readonly created: NewTask[] = [];
	readonly updated: string[] = [];

	constructor(
		private open: Task[],
		private completed: Task[],
	) {}

	async listProjects(): Promise<Project[]> {
		return [LIST];
	}

	async listTasksInProject(projectId: string): Promise<{ tasks: Task[]; sections: [] }> {
		return { tasks: this.open.filter((task) => task.projectId === projectId), sections: [] };
	}

	async getTask(): Promise<Task | null> {
		return null;
	}

	async createTask(task: NewTask): Promise<Task> {
		this.created.push(task);
		return { ...task, id: `made-${this.created.length}` };
	}

	async updateTask(task: Task): Promise<Task> {
		this.updated.push(task.id);
		return task;
	}

	async moveTask(): Promise<void> {}

	async completeTask(): Promise<void> {}

	async deleteTask(_projectId: string, taskId: string): Promise<void> {
		this.deleted.push(taskId);
	}

	async listCompletedTasks(): Promise<Task[]> {
		return this.completed;
	}
}

function repeating(overrides: Partial<Task> = {}): Task {
	return {
		...blankTask(LIST.id),
		id: "rec-1",
		title: "Water the plants",
		repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
		dueDate: "2026-08-19T00:00:00.000Z",
		isAllDay: true,
		status: "todo",
		...overrides,
	};
}

/** One finished occurrence: its own id, the same title, no repeat rule. */
function occurrence(id: string, day: string, overrides: Partial<Task> = {}): Task {
	return {
		...blankTask(LIST.id),
		id,
		title: "Water the plants",
		status: "completed",
		completedTime: `${day}T09:00:00.000Z`,
		dueDate: `${day}T00:00:00.000Z`,
		isAllDay: true,
		...overrides,
	};
}

interface Harness {
	app: FakeApp;
	client: FakeClient;
	settings: TickTickSyncSettings;
	store: SyncStore;
	run: (options?: { dryRun?: boolean }) => ReturnType<SyncEngine["sync"]>;
}

function harness(open: Task[], completed: Task[], overrides: Partial<TickTickSyncSettings> = {}) {
	const app = new FakeApp();
	const client = new FakeClient(open, completed);
	const settings = mergeSettings(overrides);
	const store = new SyncStore();
	const notes = new NoteRepository(app as unknown as App, settings.properties);

	const engine = new SyncEngine({
		client,
		notes,
		store,
		settings,
		persist: async () => {},
		log: () => {},
	});

	const value: Harness = {
		app,
		client,
		settings,
		store,
		// A fresh engine per pass would lose nothing, but reusing one is what the
		// plugin does and it is the state carried between passes that goes wrong.
		run: (options = {}) => engine.sync(options),
	};
	return value;
}

const noteFor = (app: FakeApp, title: string): string =>
	app.paths().find((path) => path.endsWith(`/${title}.md`)) ?? "";

describe("a repeating task that recurs too often for a note each", () => {
	let world: Harness;

	beforeEach(() => {
		world = harness([repeating()], [occurrence("occ-1", "2026-08-18")]);
	});

	it("gives the repeating task one note and the occurrence none", async () => {
		const report = await world.run();

		expect(report.errors).toEqual([]);
		expect(world.app.paths()).toEqual(["Tasks/Personal/Water the plants.md"]);
	});

	it("logs the completion in the repeating task's own note", async () => {
		await world.run();

		const body = world.app.body("Tasks/Personal/Water the plants.md");
		expect(body).toContain("## Completions");
		expect(body).toContain("- 2026-08-18");
	});

	// The whole reason the log lives in its own section: a re-sync has to produce
	// exactly the same lines, or every pass grows the note.
	it("writes the same log however many times it syncs", async () => {
		await world.run();
		const once = world.app.body("Tasks/Personal/Water the plants.md");

		await world.run();
		await world.run();

		expect(world.app.body("Tasks/Personal/Water the plants.md")).toBe(once);
		expect(world.app.paths()).toEqual(["Tasks/Personal/Water the plants.md"]);
	});

	it("adds the next day's completion above the one before it", async () => {
		await world.run();

		const later = harness(
			[repeating({ dueDate: "2026-08-20T00:00:00.000Z" })],
			[occurrence("occ-1", "2026-08-18"), occurrence("occ-2", "2026-08-19")],
		);
		// Same vault, different pass: what the first sync wrote is what the second
		// has to merge into.
		const path = "Tasks/Personal/Water the plants.md";
		later.app.seed(path, world.app.body(path));
		await later.run();

		const lines = later.app
			.body(path)
			.split("\n")
			.filter((line) => line.startsWith("- 2026"));
		expect(lines).toEqual(["- 2026-08-19", "- 2026-08-18"]);
	});

	// Ninety days of a daily habit is ninety finished records, all carrying the
	// same title. Before this was handled they became ninety notes.
	it("does not fill the vault when the whole window is backfilled", async () => {
		const days = Array.from({ length: 90 }, (_, index) =>
			occurrence(`occ-${index}`, `2026-0${index < 60 ? 6 : 8}-${String((index % 28) + 1).padStart(2, "0")}`),
		);
		const many = harness([repeating()], days);

		const report = await many.run();

		expect(report.errors).toEqual([]);
		expect(many.app.paths()).toEqual(["Tasks/Personal/Water the plants.md"]);
	});

	it("leaves what the user wrote below the marker exactly as it was", async () => {
		await world.run();
		const path = "Tasks/Personal/Water the plants.md";

		const mine = "Five emails of context, and a checkbox that is not a subtask:\n- [ ] mine";
		world.app.seed(path, `${world.app.body(path)}\n${mine}`);
		await world.run();

		expect(world.app.body(path)).toContain(mine);
	});
});

describe("a repeating task rare enough to earn a note each", () => {
	it("gives every finished occurrence its own note", async () => {
		const world = harness(
			[repeating({ repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1" })],
			[occurrence("occ-1", "2026-08-11"), occurrence("occ-2", "2026-08-04")],
		);

		const report = await world.run();

		expect(report.errors).toEqual([]);
		expect(report.createdLocal).toBe(3);
		expect(world.app.paths()).toHaveLength(3);
	});

	// Two notes for one title is ordinary here, and the second settles at "Water
	// the plants 2". It has to stay there. Normally it does, because the filename
	// is read back as the title — but with titles flowing one way only, the note's
	// wanted name is the plain one, which is taken. A name that counted itself as
	// taken would then step one suffix further on every single write.
	it("keeps an occurrence note's name when titles only flow inwards", async () => {
		const open = [repeating({ repeatFlag: "RRULE:FREQ=WEEKLY" })];
		const finished = [occurrence("occ-1", "2026-08-11")];
		const titlesInwards = { fieldModes: { ...DEFAULT_FIELD_MODES, title: "toObsidian" as const } };

		const world = harness(open, finished, titlesInwards);
		await world.run();
		const first = world.app.paths();
		expect(first).toContain("Tasks/Personal/Water the plants 2.md");

		let carried = new Map(first.map((path) => [path, world.app.body(path)]));

		for (let pass = 0; pass < 3; pass++) {
			const next = harness(open, finished, titlesInwards);
			for (const [path, body] of carried) next.app.seed(path, body);
			for (const entry of world.store.entries) next.store.set(entry);

			// An edit above the marker, which is what puts a note through the write
			// path: anything below it is private and never counts as a change.
			const edited = noteFor(next.app, "Water the plants 2");
			next.app.seed(
				edited,
				next.app
					.body(edited)
					.replace(next.settings.syncedRegionMarker, `Watered them all. ${pass}\n`),
			);

			await next.run();
			expect(next.app.paths()).toEqual(first);
			carried = new Map(next.app.paths().map((path) => [path, next.app.body(path)]));
		}
	});

	it("does not log them in the repeating task's note as well", async () => {
		const world = harness(
			[repeating({ repeatFlag: "RRULE:FREQ=WEEKLY" })],
			[occurrence("occ-1", "2026-08-11")],
		);

		await world.run();

		expect(world.app.body(noteFor(world.app, "Water the plants"))).not.toContain("## Completions");
	});

	// A first sync of something rare but long-running still reaches back ninety
	// days, so the count is bounded and the rest wait for a later pass.
	it("stops at the cap and says so rather than creating them all", async () => {
		const many = Array.from({ length: 12 }, (_, index) =>
			occurrence(`occ-${index}`, `2026-08-${String(index + 1).padStart(2, "0")}`),
		);
		const world = harness([repeating({ repeatFlag: "RRULE:FREQ=WEEKLY" })], many, {
			recurrence: {
				thresholdDays: 7,
				overrideProperty: "recurrence_occurrences",
				maxOccurrenceNotesPerSync: 4,
			},
		});

		const report = await world.run();

		// Four occurrence notes, plus the repeating task's own.
		expect(report.createdLocal).toBe(5);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toContain("Stopped after creating 4 notes");
	});
});

describe("overriding the frequency rule on one task", () => {
	const seedNote = (app: FakeApp, override: string): void => {
		app.seed(
			"Tasks/Personal/Water the plants.md",
			[
				"---",
				"ticktick_task_id: rec-1",
				"project: Personal",
				"status: todo",
				`recurrence_occurrences: ${override}`,
				"---",
				"",
			].join("\n"),
		);
	};

	it("gives a daily task a note per occurrence when asked to", async () => {
		const world = harness([repeating()], [occurrence("occ-1", "2026-08-18")]);
		seedNote(world.app, "note");

		await world.run();

		expect(world.app.paths()).toHaveLength(2);
	});

	it("logs a weekly task's occurrences when asked to", async () => {
		const world = harness(
			[repeating({ repeatFlag: "RRULE:FREQ=WEEKLY" })],
			[occurrence("occ-1", "2026-08-11")],
		);
		seedNote(world.app, "log");

		await world.run();

		expect(world.app.paths()).toEqual(["Tasks/Personal/Water the plants.md"]);
		expect(world.app.body("Tasks/Personal/Water the plants.md")).toContain("- 2026-08-11");
	});

	it("keeps the property the user set", async () => {
		const world = harness([repeating()], [occurrence("occ-1", "2026-08-18")]);
		seedNote(world.app, "note");

		await world.run();

		expect(world.app.body("Tasks/Personal/Water the plants.md")).toContain(
			"recurrence_occurrences: note",
		);
	});

	// A typo must not silently move where completions are written.
	it("falls back to the frequency rule on an unrecognised value", async () => {
		const world = harness([repeating()], [occurrence("occ-1", "2026-08-18")]);
		seedNote(world.app, "note-please");

		await world.run();

		expect(world.app.paths()).toEqual(["Tasks/Personal/Water the plants.md"]);
	});
});

/**
 * The rule that outranks every feature in this plugin: nothing about a repeating
 * task rolling forward may take a note away. This has destroyed real data once,
 * by reading something missing from a fetch as an instruction to delete.
 */
describe("a roll-forward never costs a note", () => {
	const rolledForward = async (repeat: string): Promise<Harness> => {
		const world = harness([repeating({ repeatFlag: repeat })], []);
		await world.run();

		// The next pass, after a completion: same id, same title, due date moved on,
		// status still open, and a finished record beside it.
		const next = harness(
			[repeating({ repeatFlag: repeat, dueDate: "2026-08-20T00:00:00.000Z" })],
			[occurrence("occ-1", "2026-08-19")],
		);
		for (const path of world.app.paths()) next.app.seed(path, world.app.body(path));
		await next.run();
		return next;
	};

	it("keeps the note where it is, whatever the frequency", async () => {
		for (const repeat of ["RRULE:FREQ=DAILY", "RRULE:FREQ=WEEKLY", "RRULE:FREQ=MONTHLY"]) {
			const world = await rolledForward(repeat);
			expect(world.app.paths()).toContain("Tasks/Personal/Water the plants.md");
		}
	});

	it("never archives it as though its task had been deleted", async () => {
		const world = await rolledForward("RRULE:FREQ=DAILY");
		expect(world.app.paths().some((path) => path.startsWith("🗄️"))).toBe(false);
	});

	it("never deletes the task in TickTick", async () => {
		const world = await rolledForward("RRULE:FREQ=DAILY");
		expect(world.client.deleted).toEqual([]);
	});

	it("creates no second task for the note", async () => {
		const world = await rolledForward("RRULE:FREQ=DAILY");
		expect(world.client.created).toEqual([]);
	});

	// The occurrence is a completed record with the repeating task's title, so a
	// note that lost its id must adopt the live task and not the finished one.
	it("re-links a note that lost its id to the live task, not the occurrence", async () => {
		const world = harness([repeating()], [occurrence("occ-1", "2026-08-18")]);
		world.app.seed(
			"Tasks/Personal/Water the plants.md",
			["---", "project: Personal", "status: todo", "---", ""].join("\n"),
		);

		await world.run();

		expect(world.app.body("Tasks/Personal/Water the plants.md")).toContain(
			"ticktick_task_id: rec-1",
		);
		expect(world.client.created).toEqual([]);
	});
});

/**
 * The completed listing reaches back ninety days and no further, so an
 * occurrence note eventually stops being confirmable. That is the window
 * moving, not a deletion, and reading it as one is the mistake that cost real
 * data before.
 */
describe("an occurrence note older than the fetched window", () => {
	it("is left exactly where it is once its record ages out", async () => {
		const world = harness(
			[repeating({ repeatFlag: "RRULE:FREQ=WEEKLY" })],
			[occurrence("occ-1", "2026-05-11")],
		);
		await world.run();

		const before = world.app.paths();
		expect(before).toHaveLength(2);

		// The same vault and the same state, but the finished record has now fallen
		// out of the window.
		const later = harness([repeating({ repeatFlag: "RRULE:FREQ=WEEKLY" })], []);
		for (const path of before) later.app.seed(path, world.app.body(path));
		for (const entry of world.store.entries) later.store.set(entry);

		const report = await later.run();

		expect(later.app.paths()).toEqual(before);
		expect(report.deletedLocal).toBe(0);
		expect(later.client.deleted).toEqual([]);
	});
});
