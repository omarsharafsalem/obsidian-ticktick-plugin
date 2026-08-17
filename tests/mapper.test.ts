import { describe, expect, it } from "vitest";
import { blankTask, type Task } from "../src/api/types";
import { DEFAULT_PROPERTIES } from "../src/settings";
import {
	buildBody,
	noteToTask,
	parsedNoteToTask,
	restoreItemMetadata,
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
				{ id: "i1", title: "oat", completed: true },
				{ id: "i2", title: "soy", completed: false },
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

		// A note stores subtasks as plain checkbox lines, so ids cannot survive
		// the round trip on their own. Titles and completion must.
		expect(restored.items).toEqual([
			{ title: "oat", completed: true },
			{ title: "soy", completed: false },
		]);
		// Re-attaching against the remote task is what restores full identity,
		// so an update edits the existing items instead of recreating them.
		expect(restoreItemMetadata(restored.items, original.items)).toEqual(original.items);
	});
});

describe("the list property", () => {
	it("writes the list's name, not its id", () => {
		const note = taskToNote(task({ projectId: "6226ff98" }), options, { projectName: "Errands" });
		expect(note.frontmatter.list).toBe("Errands");
	});

	it("falls back to the id when the name is unknown", () => {
		const note = taskToNote(task({ projectId: "6226ff98" }), options);
		expect(note.frontmatter.list).toBe("6226ff98");
	});

	it("turns the name back into an id when reading", () => {
		const parsed = noteToTask({ frontmatter: { list: "Errands" }, body: "" }, "Buy milk", {
			...options,
			resolveProject: (name) => (name.toLowerCase() === "errands" ? "6226ff98" : undefined),
		});

		expect(parsed.projectId).toBe("6226ff98");
	});

	it("passes an unrecognised value through rather than guessing", () => {
		const parsed = noteToTask({ frontmatter: { list: "6226ff98" }, body: "" }, "Buy milk", {
			...options,
			resolveProject: () => undefined,
		});

		expect(parsed.projectId).toBe("6226ff98");
	});

	it("never writes the etag into the note", () => {
		const note = taskToNote(task({ etag: "t3kc5m5f" }), options);
		expect(JSON.stringify(note.frontmatter)).not.toContain("t3kc5m5f");
	});
});

describe("list-typed properties", () => {
	// status and priority are registered as list-typed so they render as chips,
	// which means Obsidian hands them back wrapped in an array.
	it("reads status and priority out of a single-element list", () => {
		const parsed = noteToTask(
			{ frontmatter: { status: ["completed"], priority: ["high"] }, body: "" },
			"Buy milk",
			options,
		);

		expect(parsed.status).toBe("completed");
		expect(parsed.priority).toBe("high");
	});

	it("still reads them written plainly by hand", () => {
		const parsed = noteToTask(
			{ frontmatter: { status: "completed", priority: "high" }, body: "" },
			"Buy milk",
			options,
		);

		expect(parsed.status).toBe("completed");
		expect(parsed.priority).toBe("high");
	});

	it("reads a list-wrapped list name", () => {
		const parsed = noteToTask({ frontmatter: { list: ["Errands"] }, body: "" }, "Buy milk", {
			...options,
			resolveProject: (name) => (name === "Errands" ? "6226ff98" : undefined),
		});

		expect(parsed.projectId).toBe("6226ff98");
	});
});

/**
 * Dropping the plugin into a vault that already tracks tasks means speaking that
 * vault's vocabulary, not just renaming properties.
 */
describe("value labels", () => {
	const vaultWords: MapperOptions = {
		...options,
		labels: {
			status: { todo: "Not started", completed: "Done", abandoned: "Won't do" },
			priority: { none: "—", low: "P3", medium: "P2", high: "P1" },
			reminders: { "TRIGGER:-PT30M": "30 minutes before", "TRIGGER:PT0S": "On time" },
		},
	};

	it("writes the vault's own words into the note", () => {
		const note = taskToNote(
			task({ status: "completed", priority: "high", reminders: ["TRIGGER:-PT30M"] }),
			vaultWords,
		);

		expect(note.frontmatter.status).toBe("Done");
		expect(note.frontmatter.priority).toBe("P1");
		expect(note.frontmatter.reminders).toEqual(["30 minutes before"]);
	});

	it("reads them back into the codes TickTick expects", () => {
		const parsed = noteToTask(
			{
				frontmatter: { status: "Done", priority: "P1", reminders: ["30 minutes before"] },
				body: "",
			},
			"Buy milk",
			vaultWords,
		);

		expect(parsed.status).toBe("completed");
		expect(parsed.priority).toBe("high");
		expect(parsed.reminders).toEqual(["TRIGGER:-PT30M"]);
	});

	it("round-trips every status and priority", () => {
		for (const status of ["todo", "completed", "abandoned"] as const) {
			for (const priority of ["none", "low", "medium", "high"] as const) {
				const note = taskToNote(task({ status, priority }), vaultWords);
				const parsed = noteToTask(note, "Buy milk", vaultWords);

				expect({ status: parsed.status, priority: parsed.priority }).toEqual({ status, priority });
			}
		}
	});

	it("matches a label regardless of case or padding", () => {
		const parsed = noteToTask(
			{ frontmatter: { status: "  done  ", priority: "p1" }, body: "" },
			"Buy milk",
			vaultWords,
		);

		expect(parsed.status).toBe("completed");
		expect(parsed.priority).toBe("high");
	});

	it("keeps an unnamed reminder as its raw TRIGGER rather than dropping it", () => {
		const note = taskToNote(task({ reminders: ["TRIGGER:-P3D"] }), vaultWords);
		expect(note.frontmatter.reminders).toEqual(["TRIGGER:-P3D"]);

		const parsed = noteToTask(note, "Buy milk", vaultWords);
		expect(parsed.reminders).toEqual(["TRIGGER:-P3D"]);
	});

	it("still understands the built-in spellings in a hand-written note", () => {
		const parsed = noteToTask(
			{ frontmatter: { status: "completed", priority: "high" }, body: "" },
			"Buy milk",
			vaultWords,
		);

		expect(parsed.status).toBe("completed");
		expect(parsed.priority).toBe("high");
	});
});

describe("the all-day flag", () => {
	it("marks an all-day task explicitly", () => {
		const note = taskToNote(task({ dueDate: "2026-08-20T00:00:00.000Z", isAllDay: true }), options);
		expect(note.frontmatter.all_day).toBe(true);
	});

	it("leaves the flag off a timed task", () => {
		const note = taskToNote(task({ dueDate: "2026-08-20T09:30:00.000Z", isAllDay: false }), options);
		expect(note.frontmatter.all_day).toBeUndefined();
	});

	// Once due is registered as a datetime, Obsidian rewrites a bare date to
	// include a time. Without the explicit flag the task would look scheduled.
	it("trusts the flag over the shape of the date", () => {
		const parsed = noteToTask(
			{ frontmatter: { due: "2026-08-20T00:00:00.000Z", all_day: true }, body: "" },
			"Buy milk",
			options,
		);

		expect(parsed.isAllDay).toBe(true);
	});

	it("treats an explicit false as timed even for a bare date", () => {
		const parsed = noteToTask(
			{ frontmatter: { due: "2026-08-20", all_day: false }, body: "" },
			"Buy milk",
			options,
		);

		expect(parsed.isAllDay).toBe(false);
	});

	it("falls back to the date's shape when the flag is absent", () => {
		expect(
			noteToTask({ frontmatter: { due: "2026-08-20" }, body: "" }, "x", options).isAllDay,
		).toBe(true);
		expect(
			noteToTask({ frontmatter: { due: "2026-08-20T09:30:00.000Z" }, body: "" }, "x", options)
				.isAllDay,
		).toBe(false);
	});

	it("round-trips a timed task without losing the time", () => {
		const original = task({ dueDate: "2026-08-20T14:30:00.000Z", isAllDay: false });
		const parsed = noteToTask(taskToNote(original, options), "Buy milk", options);

		expect(parsed.dueDate).toBe("2026-08-20T14:30:00.000Z");
		expect(parsed.isAllDay).toBe(false);
	});
});

describe("parent and child links", () => {
	it("writes the parent as a wikilink", () => {
		const note = taskToNote(task({ parentId: "p-1" }), options, {
			parent: { title: "Plan the trip" },
		});

		expect(note.frontmatter.parent_task).toBe("[[Plan the trip]]");
	});

	it("qualifies with a path when the title is ambiguous", () => {
		const note = taskToNote(task({ parentId: "p-1" }), options, {
			parent: { title: "Buy milk", path: "Tasks/Work/Buy milk" },
		});

		expect(note.frontmatter.parent_task).toBe("[[Tasks/Work/Buy milk|Buy milk]]");
	});

	it("lists children as links", () => {
		const note = taskToNote(task(), options, {
			children: [{ title: "Book flights" }, { title: "Pack" }],
		});

		expect(note.frontmatter.child_tasks).toEqual(["[[Book flights]]", "[[Pack]]"]);
	});

	it("omits the children property when there are none", () => {
		const note = taskToNote(task(), options);
		expect(note.frontmatter.child_tasks).toBeUndefined();
	});

	it("falls back to the raw id when the parent's note is unknown", () => {
		const note = taskToNote(task({ parentId: "p-1" }), options);
		expect(note.frontmatter.parent_task).toBe("p-1");
	});

	it("resolves a link back to a task id", () => {
		const parsed = noteToTask(
			{ frontmatter: { parent_task: "[[Plan the trip]]" }, body: "" },
			"Book flights",
			{ ...options, resolveTaskLink: (target) => (target === "Plan the trip" ? "p-1" : undefined) },
		);

		expect(parsed.parentId).toBe("p-1");
	});

	it("resolves a path-qualified link by its path", () => {
		const parsed = noteToTask(
			{ frontmatter: { parent_task: "[[Tasks/Work/Buy milk|Buy milk]]" }, body: "" },
			"Sub",
			{
				...options,
				resolveTaskLink: (target) => (target === "Tasks/Work/Buy milk" ? "p-9" : undefined),
			},
		);

		expect(parsed.parentId).toBe("p-9");
	});

	// A parent whose note has not synced yet must not look like "no parent",
	// or the push would restructure the task in TickTick.
	it("keeps the existing parent when a link cannot be resolved", () => {
		const parsed = noteToTask(
			{ frontmatter: { parent_task: "[[Not synced yet]]" }, body: "" },
			"Book flights",
			{ ...options, resolveTaskLink: () => undefined },
		);

		expect(parsed.parentUnresolved).toBe(true);

		const restored = parsedNoteToTask(parsed, { ...blankTask("p1"), parentId: "existing" });
		expect(restored.parentId).toBe("existing");
	});

	it("clearing the property does remove the parent", () => {
		const parsed = noteToTask({ frontmatter: {}, body: "" }, "Book flights", options);
		const restored = parsedNoteToTask(parsed, { ...blankTask("p1"), parentId: "existing" });

		expect(restored.parentId).toBeUndefined();
	});

	it("still accepts a bare task id written by an older sync", () => {
		const parsed = noteToTask({ frontmatter: { parent_task: "p-1" }, body: "" }, "Sub", options);
		expect(parsed.parentId).toBe("p-1");
	});

	it("ignores the derived children property when reading", () => {
		const parsed = noteToTask(
			{ frontmatter: { child_tasks: ["[[Book flights]]"] }, body: "" },
			"Plan the trip",
			options,
		);

		expect(parsed.parentId).toBeUndefined();
	});
});

describe("restoreItemMetadata", () => {
	const remote = [
		{ id: "i1", title: "oat", completed: false },
		{ id: "i2", title: "soy", completed: false },
		{ id: "i3", title: "almond", completed: false },
	];

	it("restores the per-item dates a note cannot express", () => {
		const dated = [
			{
				id: "i1",
				title: "oat",
				completed: true,
				startDate: "2026-08-20T09:00:00.000Z",
				isAllDay: false,
				timeZone: "Europe/London",
				completedTime: "2026-08-21T11:00:00.000Z",
			},
		];
		// What splitBody gives back: a title and a tick, nothing else.
		const parsed = [{ title: "oat", completed: true }];

		expect(restoreItemMetadata(parsed, dated)[0]).toEqual(dated[0]);
	});

	it("takes title and completion from the note, not the remote item", () => {
		const dated = [
			{ id: "i1", title: "oat", completed: false, startDate: "2026-08-20T09:00:00.000Z" },
		];
		const parsed = [{ title: "oat", completed: true }];

		const [restored] = restoreItemMetadata(parsed, dated);
		expect(restored.completed).toBe(true);
		expect(restored.startDate).toBe("2026-08-20T09:00:00.000Z");
	});

	it("restores ids for items that kept their titles", () => {
		const parsed = [
			{ title: "oat", completed: true },
			{ title: "soy", completed: false },
			{ title: "almond", completed: false },
		];

		expect(restoreItemMetadata(parsed, remote).map((item) => item.id)).toEqual(["i1", "i2", "i3"]);
	});

	it("follows the title when items are reordered", () => {
		const parsed = [
			{ title: "almond", completed: false },
			{ title: "oat", completed: false },
			{ title: "soy", completed: false },
		];

		expect(restoreItemMetadata(parsed, remote).map((item) => item.id)).toEqual(["i3", "i1", "i2"]);
	});

	it("falls back to position so a renamed item keeps its id", () => {
		const parsed = [
			{ title: "oat", completed: false },
			{ title: "soya milk", completed: false },
			{ title: "almond", completed: false },
		];

		expect(restoreItemMetadata(parsed, remote).map((item) => item.id)).toEqual(["i1", "i2", "i3"]);
	});

	it("leaves genuinely new items without an id", () => {
		const parsed = [
			{ title: "oat", completed: false },
			{ title: "soy", completed: false },
			{ title: "almond", completed: false },
			{ title: "hazelnut", completed: false },
		];

		expect(restoreItemMetadata(parsed, remote).map((item) => item.id)).toEqual([
			"i1",
			"i2",
			"i3",
			undefined,
		]);
	});

	it("gives duplicate titles distinct ids rather than reusing one", () => {
		const duplicated = [
			{ id: "a", title: "call", completed: false },
			{ id: "b", title: "call", completed: false },
		];
		const parsed = [
			{ title: "call", completed: true },
			{ title: "call", completed: false },
		];

		expect(restoreItemMetadata(parsed, duplicated).map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("does not invent ids when the task had no items before", () => {
		const parsed = [{ title: "first subtask", completed: false }];
		expect(restoreItemMetadata(parsed, [])).toEqual(parsed);
	});

	it("matches titles ignoring surrounding whitespace and case", () => {
		const parsed = [{ title: "  OAT  ", completed: false }];
		expect(restoreItemMetadata(parsed, remote)[0].id).toBe("i1");
	});

	it("keeps an id the item already carries", () => {
		const parsed = [{ id: "explicit", title: "oat", completed: false }];
		expect(restoreItemMetadata(parsed, remote)[0].id).toBe("explicit");
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
