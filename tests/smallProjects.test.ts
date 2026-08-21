import { describe, expect, it } from "vitest";
import type { Capabilities, TickTickClient } from "../src/api/client";
import { blankTask, type NewTask, type Project, type Section, type Task } from "../src/api/types";
import { DEFAULT_SETTINGS, type TickTickSyncSettings } from "../src/settings";
import { SyncEngine } from "../src/sync/engine";
import { SyncStore } from "../src/sync/state";
import { NoteRepository } from "../src/vault/notes";
import { FakeVault } from "./stubs/vault";

/**
 * A **small project** — a project whose work lives in a section of a list it
 * shares, rather than in a list of its own.
 *
 * The unit tests in `sections.test.ts` cover the mapper either side of this. What
 * they cannot cover is the wiring, which is where the real risk sits: the engine
 * has to index a section's containing list, let a note's *title* resolve to the
 * section it claims, and let that section's note beat the list's note. Each of
 * those is a separate place the round trip can quietly fail.
 *
 * The property that used to carry this — `subproject`, written on every task on
 * top of `project` — was removed on 21 Aug 2026. A section is a placement, not a
 * level, so the absence of a second property is itself part of what is asserted.
 */

const CAPABILITIES: Capabilities = {
	completedHistory: true,
	modifiedTime: false,
	inbox: true,
	listPageSize: undefined,
};

/** One shared list, holding two small projects a section each, plus loose work. */
class FakeClient implements TickTickClient {
	readonly capabilities = CAPABILITIES;

	projects: Project[] = [{ id: "p1", name: "🏠 Personal", closed: false }];
	sections: Section[] = [
		{ id: "c1", projectId: "p1", name: "Ghazali Book" },
		{ id: "c2", projectId: "p1", name: "Kitchen Shelves" },
	];
	tasks = new Map<string, Task[]>([["p1", []]]);

	readonly created: NewTask[] = [];
	readonly updated: Task[] = [];

	async listProjects(): Promise<Project[]> {
		return this.projects;
	}

	async listTasksInProject(projectId: string): Promise<{ tasks: Task[]; sections: Section[] }> {
		return { tasks: this.tasks.get(projectId) ?? [], sections: this.sections };
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
	async deleteTask(): Promise<void> {}
	async listCompletedTasks(): Promise<Task[]> {
		return [];
	}
}

function harness(options: Partial<TickTickSyncSettings> = {}) {
	const vault = new FakeVault();
	const client = new FakeClient();
	const config: TickTickSyncSettings = {
		...DEFAULT_SETTINGS,
		confirmDeletions: false,
		...options,
	};
	const engine = new SyncEngine({
		client,
		notes: new NoteRepository(vault.app as never, config.properties),
		store: new SyncStore(),
		settings: config,
		persist: async () => {},
		log: () => {},
	});
	return { vault, client, engine, config };
}

function task(overrides: Partial<Task> = {}): Task {
	return { ...blankTask("p1"), id: "t1", title: "Read chapter one", etag: "e1", ...overrides };
}

/** The three notes that make one list stand for two projects and an area. */
function seedProjectNotes(vault: FakeVault): void {
	vault.seed("🏠 Personal/🏠 Personal.md", "---\nticktick_list_id: p1\n---\n");
	vault.seed("🏠 Personal/🚀 Projects/🚀 Ghazali Book.md", "---\nticktick_section_id: c1\n---\n");
	vault.seed("🏠 Personal/🚀 Projects/🚀 Kitchen Shelves.md", "---\nticktick_section_id: c2\n---\n");
}

const frontmatterOf = (raw: string): Record<string, string> =>
	Object.fromEntries(
		(raw.split("---")[1] ?? "")
			.split("\n")
			.filter((line) => line.includes(":"))
			.map((line) => {
				const at = line.indexOf(":");
				return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^['"]|['"]$/g, "")];
			}),
	);

describe("a task in a section a project claims", () => {
	it("names the section's project, not the list's", async () => {
		const { vault, client, engine } = harness();
		seedProjectNotes(vault);
		client.tasks.set("p1", [task({ columnId: "c1", columnName: "Ghazali Book" })]);

		await engine.sync();

		const note = vault.paths.find((path) => path.includes("Read chapter one"));
		expect(note).toBeDefined();
		expect(frontmatterOf(vault.contentOf(note as string)).project).toBe("[[🚀 Ghazali Book]]");
	});

	// The absence *is* the feature. A fourth tier would have written the section
	// here as well, leaving every task carrying two project links.
	it("writes one project link and no second property", async () => {
		const { vault, client, engine } = harness();
		seedProjectNotes(vault);
		client.tasks.set("p1", [task({ columnId: "c1", columnName: "Ghazali Book" })]);

		await engine.sync();

		const note = vault.paths.find((path) => path.includes("Read chapter one")) as string;
		const fm = frontmatterOf(vault.contentOf(note));
		expect(fm).not.toHaveProperty("subproject");
		expect(Object.values(fm).filter((value) => value.includes("Ghazali"))).toHaveLength(1);
	});

	// Two small projects in one list is the case the whole feature exists for.
	it("keeps two projects in one list apart", async () => {
		const { vault, client, engine } = harness();
		seedProjectNotes(vault);
		client.tasks.set("p1", [
			task({ id: "t1", title: "Read chapter one", columnId: "c1", columnName: "Ghazali Book" }),
			task({ id: "t2", title: "Measure the alcove", columnId: "c2", columnName: "Kitchen Shelves" }),
		]);

		await engine.sync();

		const read = (needle: string) =>
			frontmatterOf(vault.contentOf(vault.paths.find((p) => p.includes(needle)) as string)).project;
		expect(read("Read chapter one")).toBe("[[🚀 Ghazali Book]]");
		expect(read("Measure the alcove")).toBe("[[🚀 Kitchen Shelves]]");
	});

	// Loose work in the shared list still belongs to the area's own note. A
	// section nothing claims must not strand its tasks with no project at all.
	it("leaves work outside every section with the list's project", async () => {
		const { vault, client, engine } = harness();
		seedProjectNotes(vault);
		client.tasks.set("p1", [task({ title: "Book the dentist" })]);

		await engine.sync();

		const note = vault.paths.find((path) => path.includes("Book the dentist")) as string;
		expect(frontmatterOf(vault.contentOf(note)).project).toBe("[[🏠 Personal]]");
	});
});

describe("pushing a small project's task back", () => {
	// The direction that would have broken silently. A column id alone does not
	// place a task, so resolving the note's title to a section has to yield the
	// containing list too.
	it("sends it to the section and to the list holding it", async () => {
		const { vault, client, engine } = harness();
		seedProjectNotes(vault);
		vault.seed(
			"Tasks/Read chapter two.md",
			"---\nticktick_task_id:\nproject: '[[🚀 Ghazali Book]]'\n---\n",
		);

		await engine.sync();

		expect(client.created).toHaveLength(1);
		expect(client.created[0].projectId).toBe("p1");
		expect(client.created[0].columnId).toBe("c1");
	});

	it("sends a list-bound project's task to the list with no section", async () => {
		const { vault, client, engine } = harness();
		seedProjectNotes(vault);
		vault.seed(
			"Tasks/Book the optician.md",
			"---\nticktick_task_id:\nproject: '[[🏠 Personal]]'\n---\n",
		);

		await engine.sync();

		expect(client.created).toHaveLength(1);
		expect(client.created[0].projectId).toBe("p1");
		expect(client.created[0].columnId).toBeUndefined();
	});
});
