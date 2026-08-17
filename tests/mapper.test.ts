import { describe, expect, it } from "vitest";
import { blankTask, type Task } from "../src/api/types";
import { DEFAULT_PROPERTIES } from "../src/settings";
import {
	buildBody,
	noteToTask,
	parsedNoteToTask,
	sanitiseFilename,
	splitBody,
	taskToNote,
	type MapperOptions,
} from "../src/sync/mapper";

const options: MapperOptions = { properties: DEFAULT_PROPERTIES, inlineTags: true };

function task(overrides: Partial<Task> = {}): Task {
	return { ...blankTask("p1"), id: "t1", title: "Buy milk", ...overrides };
}

describe("taskToNote", () => {
	it("puts every field into frontmatter properties, not the body", () => {
		const note = taskToNote(
			task({
				priority: "high",
				tags: ["errands🛒", "home"],
				dueDate: "2026-08-20T00:00:00.000Z",
				isAllDay: true,
				repeatFlag: "RRULE:FREQ=WEEKLY",
				content: "Semi-skimmed",
			}),
			options,
		);

		expect(note.frontmatter).toMatchObject({
			ticktick_id: "t1",
			list: "p1",
			status: "todo",
			priority: "high",
			due: "2026-08-20",
			tags: ["errands🛒", "home"],
			recurrence: "RRULE:FREQ=WEEKLY",
		});
		expect(note.body.trim()).toBe("Semi-skimmed");
	});

	it("writes an all-day due date as a bare date and a timed one as an instant", () => {
		const allDay = taskToNote(task({ dueDate: "2026-08-20T00:00:00.000Z", isAllDay: true }), options);
		expect(allDay.frontmatter.due).toBe("2026-08-20");

		const timed = taskToNote(task({ dueDate: "2026-08-20T09:30:00.000Z", isAllDay: false }), options);
		expect(timed.frontmatter.due).toBe("2026-08-20T09:30:00.000Z");
	});

	it("stores tags without a leading hash, as Obsidian's tags property expects", () => {
		const note = taskToNote(task({ tags: ["#work", "home"] }), options);
		expect(note.frontmatter.tags).toEqual(["work", "home"]);
	});

	it("only records a title override when the filename cannot hold the title", () => {
		expect(taskToNote(task({ title: "Buy milk" }), options).frontmatter.ticktick_title).toBeUndefined();
		expect(taskToNote(task({ title: "Read: chapter 3/4" }), options).frontmatter.ticktick_title).toBe(
			"Read: chapter 3/4",
		);
	});

	it("honours custom property names", () => {
		const custom: MapperOptions = {
			...options,
			properties: { ...DEFAULT_PROPERTIES, due: "deadline", priority: "importance" },
		};
		const note = taskToNote(task({ priority: "low", dueDate: "2026-08-20T00:00:00.000Z", isAllDay: true }), custom);
		expect(note.frontmatter.deadline).toBe("2026-08-20");
		expect(note.frontmatter.importance).toBe("low");
		expect(note.frontmatter.due).toBeUndefined();
	});
});

describe("noteToTask", () => {
	it("reads properties back out", () => {
		const parsed = noteToTask(
			{
				frontmatter: {
					ticktick_id: "t1",
					list: "p1",
					status: "completed",
					priority: "medium",
					due: "2026-08-20",
					tags: ["work"],
				},
				body: "notes here",
			},
			"Buy milk",
			options,
		);

		expect(parsed.id).toBe("t1");
		expect(parsed.status).toBe("completed");
		expect(parsed.priority).toBe("medium");
		expect(parsed.dueDate).toBe("2026-08-20T00:00:00.000Z");
		expect(parsed.isAllDay).toBe(true);
		expect(parsed.title).toBe("Buy milk");
	});

	it("prefers the filename as the title", () => {
		const parsed = noteToTask({ frontmatter: {}, body: "" }, "Renamed in Obsidian", options);
		expect(parsed.title).toBe("Renamed in Obsidian");
	});

	it("uses the title override when present", () => {
		const parsed = noteToTask(
			{ frontmatter: { ticktick_title: "Read: chapter 3/4" }, body: "" },
			"Read- chapter 3-4",
			options,
		);
		expect(parsed.title).toBe("Read: chapter 3/4");
	});

	it("unions emoji tags written in the body with the tags property", () => {
		const parsed = noteToTask(
			{ frontmatter: { tags: ["work"] }, body: "pick up the order #errands🛒" },
			"Buy milk",
			options,
		);
		expect(parsed.tags).toEqual(["work", "errands🛒"]);
	});

	it("ignores body tags when inline tags are disabled", () => {
		const parsed = noteToTask(
			{ frontmatter: { tags: ["work"] }, body: "pick up the order #errands🛒" },
			"Buy milk",
			{ ...options, inlineTags: false },
		);
		expect(parsed.tags).toEqual(["work"]);
	});

	it("accepts tags written inline as a string", () => {
		const parsed = noteToTask(
			{ frontmatter: { tags: "work, home🏠" }, body: "" },
			"Buy milk",
			{ ...options, inlineTags: false },
		);
		expect(parsed.tags).toEqual(["work", "home🏠"]);
	});

	it("infers completion from a completion timestamp", () => {
		const parsed = noteToTask(
			{ frontmatter: { completed: "2026-08-19T10:00:00.000Z" }, body: "" },
			"Buy milk",
			options,
		);
		expect(parsed.status).toBe("completed");
	});

	it("tolerates raw TickTick priority integers", () => {
		expect(noteToTask({ frontmatter: { priority: 5 }, body: "" }, "x", options).priority).toBe("high");
	});
});

describe("round trip", () => {
	it("preserves every synced field", () => {
		const original = task({
			title: "Buy milk",
			content: "Semi-skimmed, two litres",
			priority: "high",
			status: "todo",
			tags: ["errands🛒", "home"],
			dueDate: "2026-08-20T09:30:00.000Z",
			isAllDay: false,
			repeatFlag: "RRULE:FREQ=WEEKLY",
			reminders: ["TRIGGER:-PT60M"],
			items: [
				{ title: "oat", completed: true },
				{ title: "soy", completed: false },
			],
		});

		const note = taskToNote(original, options);
		const parsed = noteToTask(note, "Buy milk", options);
		const restored = parsedNoteToTask(parsed, blankTask("p1"));

		expect(restored.title).toBe(original.title);
		expect(restored.content).toBe(original.content);
		expect(restored.priority).toBe(original.priority);
		expect(restored.tags).toEqual(original.tags);
		expect(restored.dueDate).toBe(original.dueDate);
		expect(restored.repeatFlag).toBe(original.repeatFlag);
		expect(restored.reminders).toEqual(original.reminders);
		expect(restored.items).toEqual(original.items);
	});
});

describe("body and checklist", () => {
	it("splits the description from the subtask list", () => {
		const { content, items } = splitBody("Description\n\n## Subtasks\n\n- [x] one\n- [ ] two\n");
		expect(content).toBe("Description");
		expect(items).toEqual([
			{ title: "one", completed: true },
			{ title: "two", completed: false },
		]);
	});

	it("omits the heading when there are no subtasks", () => {
		expect(buildBody("Just text", [])).toBe("Just text\n");
	});

	it("round-trips an empty description with subtasks", () => {
		const body = buildBody("", [{ title: "one", completed: false }]);
		expect(splitBody(body)).toEqual({ content: "", items: [{ title: "one", completed: false }] });
	});
});

describe("sanitiseFilename", () => {
	it("replaces characters a filename cannot hold", () => {
		expect(sanitiseFilename('Read: ch 3/4 "notes"?')).toBe("Read- ch 3-4 -notes");
	});

	it("collapses runs of replaced characters", () => {
		expect(sanitiseFilename("a???b")).toBe("a-b");
	});

	it("keeps emoji, which filenames handle fine", () => {
		expect(sanitiseFilename("Buy milk 🥛")).toBe("Buy milk 🥛");
	});

	it("never returns an empty name", () => {
		expect(sanitiseFilename("///")).toBe("Untitled task");
	});
});
