import { describe, expect, it } from "vitest";
import { blankTask, type Task } from "../src/api/types";
import { matchOrphansToTasks, type OrphanCandidate } from "../src/sync/engine";

/**
 * Re-linking a note that has lost its task id. This kept passing code review
 * and failing against a real vault, four times, each attempt fixing something
 * real that the next one then tripped over — so it lives here now, where the
 * decision can be checked without a vault, a network or a sync.
 */
function task(overrides: Partial<Task> = {}): Task {
	return { ...blankTask("list-a"), id: "task-1", title: "R2 — break my ID property", ...overrides };
}

function note(overrides: Partial<OrphanCandidate> = {}): OrphanCandidate {
	return {
		path: "Tasks/R2 — break my ID property.md",
		title: "R2 — break my ID property",
		projectId: "list-a",
		...overrides,
	};
}

describe("matching orphaned notes to their tasks", () => {
	it("re-links a note whose id property was renamed", () => {
		const pairs = matchOrphansToTasks([note()], [task()]);
		expect(pairs.get("Tasks/R2 — break my ID property.md")).toBe("task-1");
	});

	it("leaves a note that still has its id alone", () => {
		const pairs = matchOrphansToTasks([note({ taskId: "task-1" })], [task()]);
		expect(pairs.size).toBe(0);
	});

	// The failure of the first attempt: being tracked is not being claimed.
	it("re-links even when the sync state still tracks that task", () => {
		const pairs = matchOrphansToTasks([note({ trackedTaskId: "task-99" })], [task()]);
		expect(pairs.get("Tasks/R2 — break my ID property.md")).toBe("task-1");
	});

	// The second: a dead entry must not strand the note forever.
	it("re-links when the tracked task no longer exists", () => {
		const pairs = matchOrphansToTasks([note({ trackedTaskId: "deleted-task" })], [task()]);
		expect(pairs.size).toBe(1);
	});

	it("does not re-link while the tracked task is still alive", () => {
		const pairs = matchOrphansToTasks(
			[note({ trackedTaskId: "task-1" })],
			[task(), task({ id: "task-1", title: "Something else" })],
		);
		expect(pairs.size).toBe(0);
	});

	// The third: a task already held by another note is not up for grabs.
	it("does not steal a task another note already holds", () => {
		const pairs = matchOrphansToTasks(
			[note(), note({ path: "Tasks/Copy.md", taskId: "task-1" })],
			[task()],
		);
		expect(pairs.size).toBe(0);
	});

	it("matches within the right list only", () => {
		const pairs = matchOrphansToTasks([note({ projectId: "list-b" })], [task()]);
		expect(pairs.size).toBe(0);
	});

	it("ignores case and padding in the title", () => {
		const pairs = matchOrphansToTasks([note({ title: "  r2 — BREAK my id PROPERTY " })], [task()]);
		expect(pairs.size).toBe(1);
	});

	it("gives one task to only one note", () => {
		const pairs = matchOrphansToTasks([note(), note({ path: "Tasks/Other.md" })], [task()]);
		expect(pairs.size).toBe(1);
	});

	it("leaves a genuinely new note unmatched", () => {
		const pairs = matchOrphansToTasks([note({ title: "Brand new thing" })], [task()]);
		expect(pairs.size).toBe(0);
	});

	// The fourth: a repeating task's finished occurrences all carry its title, so
	// a note that lost its id would otherwise bind itself to whichever record was
	// listed first — a record of one day, which can never change again.
	it("prefers the live task over a finished record of the same title", () => {
		const pairs = matchOrphansToTasks(
			[note()],
			[
				task({ id: "occurrence", status: "completed", completedTime: "2026-08-17T09:00:00.000Z" }),
				task({ id: "live", repeatFlag: "RRULE:FREQ=DAILY" }),
			],
		);
		expect(pairs.get("Tasks/R2 — break my ID property.md")).toBe("live");
	});

	it("still adopts a finished task when that is the only one there is", () => {
		const pairs = matchOrphansToTasks(
			[note()],
			[task({ id: "done", status: "completed", completedTime: "2026-08-17T09:00:00.000Z" })],
		);
		expect(pairs.get("Tasks/R2 — break my ID property.md")).toBe("done");
	});
});
