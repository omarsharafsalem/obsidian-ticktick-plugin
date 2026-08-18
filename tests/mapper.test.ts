import { describe, expect, it } from "vitest";
import { blankTask, type Task } from "../src/api/types";
import { DEFAULT_PROPERTIES, DEFAULT_VALUE_LABELS } from "../src/settings";
import {
	buildBody,
	noteToTask,
	parsedNoteToTask,
	resolveTitle,
	restoreItemMetadata,
	sanitiseFilename,
	splitBody,
	taskToNote,
	triggerToMinutes,
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
			ticktick_task_id: "t1",
			project: "p1",
			status: "todo",
			priority: "high",
			due: "2026-08-20",
			tags: ["errands🛒", "home"],
			recurrence: "RRULE:FREQ=WEEKLY",
		});
		expect(note.body.trim()).toBe("Semi-skimmed");
	});

	// The timezone is stated rather than inherited, so this asserts the same
	// thing on any machine — including CI, which runs in UTC.
	it("writes an all-day due date as a bare date and a timed one as wall-clock time", () => {
		const allDay = taskToNote(task({ dueDate: "2026-08-20T00:00:00.000Z", isAllDay: true }), options);
		expect(allDay.frontmatter.due).toBe("2026-08-20");

		const timed = taskToNote(
			task({ dueDate: "2026-08-20T09:30:00.000Z", isAllDay: false, timeZone: "Europe/London" }),
			// The zone is asked for explicitly. Without this the test would assert
			// the machine's own clock, which passes here and fails on CI in UTC.
			{ ...options, useTaskTimeZone: true },
		);
		// 09:30 UTC is 10:30 in London in August, and that is what a reader wants.
		expect(timed.frontmatter.due).toBe("2026-08-20T10:30");
	});

	it("stores tags without a leading hash, as Obsidian's tags property expects", () => {
		const note = taskToNote(task({ tags: ["#work", "home"] }), options);
		expect(note.frontmatter.tags).toEqual(["work", "home"]);
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
					ticktick_task_id: "t1",
					project: "p1",
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

	it("takes the title from the filename", () => {
		const parsed = noteToTask({ frontmatter: {}, body: "" }, "Read- chapter 3-4", options);
		expect(parsed.title).toBe("Read- chapter 3-4");
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
		// -PT60M and -PT1H are the same hour, so the round trip may return the
		// canonical spelling. What must survive is the offset, not the text.
		expect(restored.reminders.map(triggerToMinutes)).toEqual(
			original.reminders.map(triggerToMinutes),
		);

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
		expect(note.frontmatter.project).toBe("Errands");
	});

	it("falls back to the id when the name is unknown", () => {
		const note = taskToNote(task({ projectId: "6226ff98" }), options);
		expect(note.frontmatter.project).toBe("6226ff98");
	});

	it("writes a link to the project note when one is configured", () => {
		const note = taskToNote(task({ projectId: "6226ff98" }), options, {
			projectName: "Health & Fitness",
			projectLink: { title: "Health dashboard" },
		});

		expect(note.frontmatter.project).toBe("[[Health dashboard]]");
	});

	it("qualifies the project link with a path when given one", () => {
		const note = taskToNote(task({ projectId: "6226ff98" }), options, {
			projectLink: { title: "Health dashboard", path: "Areas/Health/Health dashboard" },
		});

		expect(note.frontmatter.project).toBe("[[Areas/Health/Health dashboard|Health dashboard]]");
	});

	it("resolves a project link back to the list", () => {
		const parsed = noteToTask(
			{ frontmatter: { project: "[[Health dashboard]]" }, body: "" },
			"Buy milk",
			{
				...options,
				resolveProject: (target) => (target === "Health dashboard" ? "6226ff98" : undefined),
			},
		);

		expect(parsed.projectId).toBe("6226ff98");
	});

	// A note title is never a list id, so passing it through would move the task.
	it("does not treat an unresolved link as a list id", () => {
		const parsed = noteToTask(
			{ frontmatter: { project: "[[Some other note]]" }, body: "" },
			"Buy milk",
			{ ...options, resolveProject: () => undefined },
		);

		expect(parsed.projectId).toBeUndefined();
	});

	it("turns the name back into an id when reading", () => {
		const parsed = noteToTask({ frontmatter: { project: "Errands" }, body: "" }, "Buy milk", {
			...options,
			resolveProject: (name) => (name.toLowerCase() === "errands" ? "6226ff98" : undefined),
		});

		expect(parsed.projectId).toBe("6226ff98");
	});

	it("passes an unrecognised value through rather than guessing", () => {
		const parsed = noteToTask({ frontmatter: { project: "6226ff98" }, body: "" }, "Buy milk", {
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
		const parsed = noteToTask({ frontmatter: { project: ["Errands"] }, body: "" }, "Buy milk", {
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
			status: { todo: ["Not started"], completed: ["Done"], abandoned: ["Won't do"] },
			statusNeutral: ["Archived"],
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

describe("the task marker", () => {
	it("stamps notes it creates so they match hand-written ones", () => {
		const note = taskToNote(task(), {
			...options,
			marker: { property: "note_type", value: "task" },
		});

		expect(note.frontmatter.note_type).toBe("task");
	});

	it("writes nothing when no marker is configured", () => {
		const note = taskToNote(task(), { ...options, marker: { property: "", value: "task" } });
		expect(note.frontmatter.note_type).toBeUndefined();
	});
});

describe("the all-day flag", () => {
	it("writes no all-day property — the date's shape carries it", () => {
		const note = taskToNote(task({ dueDate: "2026-08-20T00:00:00.000Z", isAllDay: true }), options);
		expect(note.frontmatter.all_day).toBeUndefined();
		expect(note.frontmatter.due).toBe("2026-08-20");
	});

	it("leaves the flag off a timed task", () => {
		const note = taskToNote(task({ dueDate: "2026-08-20T09:30:00.000Z", isAllDay: false }), options);
		expect(note.frontmatter.all_day).toBeUndefined();
	});

	// Once due is registered as a datetime, Obsidian rewrites a bare date to
	// include a time. Without the explicit flag the task would look scheduled.

	// Obsidian rewrites a bare date once `due` is datetime-typed, so midnight
	// has to count as all-day or every one of them would look scheduled.
	it("treats exactly midnight as all-day", () => {
		const parsed = noteToTask(
			{ frontmatter: { due: "2026-08-20T00:00:00.000Z" }, body: "" },
			"Buy milk",
			options,
		);

		expect(parsed.isAllDay).toBe(true);
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
		expect(splitBody(body)).toEqual({
			content: "",
			items: [{ title: "one", completed: false }],
			privateBody: "",
			completions: [],
		});
	});
});

/**
 * The completion log of a repeating task that recurs too often to earn a note
 * per occurrence. It lives inside the synced region so it round-trips, but out
 * of the description so the history is never pushed into TickTick's own.
 */
describe("the completion log", () => {
	const log = ["- 2026-08-18", "- 2026-08-17"];

	it("writes the log under its own heading", () => {
		const body = buildBody("Water them", [], { completions: log });
		expect(body).toBe("Water them\n\n## Completions\n\n- 2026-08-18\n- 2026-08-17\n");
	});

	it("omits the heading when there is nothing logged", () => {
		expect(buildBody("Water them", [], { completions: [] })).toBe("Water them\n");
	});

	it("round-trips through the note unchanged", () => {
		const body = buildBody("Water them", [{ title: "one", completed: true }], {
			completions: log,
		});
		expect(splitBody(body)).toEqual({
			content: "Water them",
			items: [{ title: "one", completed: true }],
			privateBody: "",
			completions: log,
		});
	});

	// The whole point of a separate section: the log is vault-side history, and
	// folding it into the description would push it all to TickTick.
	it("stays out of the description", () => {
		const body = buildBody("Water them", [], { completions: log });
		const parsed = noteToTask({ frontmatter: {}, body }, "Water the plants", options);
		expect(parsed.content).toBe("Water them");
		expect(parsed.completions).toEqual(log);
	});

	it("is put back on an ordinary write, which knows nothing about it", () => {
		const body = buildBody("Water them", [], { completions: log });
		const parsed = noteToTask({ frontmatter: {}, body }, "Water the plants", options);
		const rewritten = taskToNote(task({ content: "A new description" }), options, {
			completions: parsed.completions,
		});

		expect(rewritten.body).toContain("- 2026-08-18");
		expect(rewritten.body).toContain("A new description");
	});

	it("keeps subtasks and completions apart whichever order they are written in", () => {
		const body = [
			"Water them",
			"",
			"## Completions",
			"",
			"- 2026-08-18",
			"",
			"## Subtasks",
			"",
			"- [x] one",
		].join("\n");

		expect(splitBody(body)).toEqual({
			content: "Water them",
			items: [{ title: "one", completed: true }],
			privateBody: "",
			completions: ["- 2026-08-18"],
		});
	});

	it("does not read the log as a subtask, or a subtask as a log line", () => {
		const body = buildBody("", [{ title: "one", completed: false }], { completions: log });
		const parsed = splitBody(body);
		expect(parsed.items).toEqual([{ title: "one", completed: false }]);
		expect(parsed.completions).toEqual(log);
	});

	it("leaves the log alone when the marker puts it below the boundary", () => {
		const marker = "<!-- ticktick:end -->";
		const body = ["Water them", "", marker, "", "## Completions", "", "- 2026-08-18"].join("\n");
		const parsed = splitBody(body, marker);
		expect(parsed.completions).toEqual([]);
		expect(parsed.privateBody).toContain("- 2026-08-18");
	});
});

/**
 * The guarantee the marker exists to give: everything below it belongs to the
 * user, and the sync never reads, rewrites or deletes any of it.
 */
describe("the synced region", () => {
	const marker = "<!-- ticktick:end -->";
	const withMarker: MapperOptions = { ...options, syncedRegionMarker: marker };

	const note = [
		"The description that syncs.",
		"",
		marker,
		"",
		"My own notes. Five emails of context.",
		"- [ ] a checkbox that is NOT a subtask",
	].join("\n");

	it("reads only the part above the marker as the description", () => {
		const parsed = noteToTask({ frontmatter: {}, body: note }, "Buy milk", withMarker);
		expect(parsed.content).toBe("The description that syncs.");
	});

	it("does not treat checkboxes below the marker as subtasks", () => {
		const parsed = noteToTask({ frontmatter: {}, body: note }, "Buy milk", withMarker);
		expect(parsed.items).toEqual([]);
	});

	it("gives the private part back byte for byte", () => {
		const parsed = noteToTask({ frontmatter: {}, body: note }, "Buy milk", withMarker);
		const rewritten = taskToNote(task({ content: "A new description from TickTick" }), withMarker, {
			privateBody: parsed.privateBody,
		});

		expect(rewritten.body).toContain("My own notes. Five emails of context.");
		expect(rewritten.body).toContain("- [ ] a checkbox that is NOT a subtask");
		expect(rewritten.body).toContain("A new description from TickTick");
		expect(rewritten.body).not.toContain("The description that syncs.");
	});

	it("survives TickTick clearing the description entirely", () => {
		const parsed = noteToTask({ frontmatter: {}, body: note }, "Buy milk", withMarker);
		const rewritten = taskToNote(task({ content: "" }), withMarker, {
			privateBody: parsed.privateBody,
		});

		expect(rewritten.body).toContain("My own notes. Five emails of context.");
	});

	it("syncs the whole body when no marker is configured", () => {
		const parsed = noteToTask({ frontmatter: {}, body: note }, "Buy milk", options);
		expect(parsed.content).toContain("My own notes");
	});

	it("emits the marker so the boundary exists from the first write", () => {
		const written = taskToNote(task({ content: "Hello" }), withMarker);
		expect(written.body).toContain(marker);
	});
});

describe("status groups", () => {
	const vaultWords: MapperOptions = {
		...options,
		labels: {
			status: {
				todo: ["🟢 Active", "⏳ Awaiting", "⏸️ Paused", "🗄️ Parked"],
				completed: ["✅ Done"],
				abandoned: ["🚫 Not Doing"],
			},
			statusNeutral: ["📦 Archived"],
			priority: { none: "⚪ No Priority", low: "🔵 Low", medium: "🟡 Medium", high: "🔴 High" },
			reminders: {},
		},
	};

	it("reads every value in a group as that status", () => {
		for (const value of ["🟢 Active", "⏳ Awaiting", "⏸️ Paused", "🗄️ Parked"]) {
			const parsed = noteToTask({ frontmatter: { status: value }, body: "" }, "x", vaultWords);
			expect({ value, status: parsed.status }).toEqual({ value, status: "todo" });
		}
	});

	// The bug this guards: a due-date edit rewriting Paused as Active, because
	// both mean not-done and nothing about the status actually moved.
	it("keeps the note's own wording when the status has not changed", () => {
		const note = taskToNote(task({ status: "todo" }), vaultWords, { currentStatus: "⏸️ Paused" });
		expect(note.frontmatter.status).toBe("⏸️ Paused");
	});

	it("writes the group's first value when the status genuinely changes", () => {
		const note = taskToNote(task({ status: "completed" }), vaultWords, {
			currentStatus: "⏸️ Paused",
		});
		expect(note.frontmatter.status).toBe("✅ Done");
	});

	it("writes the default when the note has no status yet", () => {
		expect(taskToNote(task({ status: "todo" }), vaultWords).frontmatter.status).toBe("🟢 Active");
	});

	// Archiving a finished task must not reopen it, and archiving an open one
	// must not complete it — so a filing value pushes nothing either way.
	it("lets a filing value defer to whatever TickTick already says", () => {
		const parsed = noteToTask(
			{ frontmatter: { status: "📦 Archived" }, body: "" },
			"x",
			vaultWords,
		);
		expect(parsed.statusNeutral).toBe(true);

		const done = parsedNoteToTask(parsed, { ...blankTask("p1"), status: "completed" });
		expect(done.status).toBe("completed");

		const open = parsedNoteToTask(parsed, { ...blankTask("p1"), status: "todo" });
		expect(open.status).toBe("todo");
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

/**
 * Renaming a default property silently orphans every note carrying the old
 * name: the note reads as having no task id, looks new, and a duplicate task
 * gets created in TickTick. This is what that looked like in practice.
 */
describe("property names from earlier versions", () => {
	it("still finds a task id written as ticktick_id", () => {
		const parsed = noteToTask(
			{ frontmatter: { ticktick_id: "6a82dd125f3251294a7e1c57" }, body: "" },
			"Buy milk",
			options,
		);

		expect(parsed.id).toBe("6a82dd125f3251294a7e1c57");
	});

	it("still finds a list written as list", () => {
		const parsed = noteToTask({ frontmatter: { list: "Errands" }, body: "" }, "Buy milk", {
			...options,
			resolveProject: (name) => (name === "Errands" ? "p1" : undefined),
		});

		expect(parsed.projectId).toBe("p1");
	});

	it("prefers the configured name when both are present", () => {
		const parsed = noteToTask(
			{ frontmatter: { ticktick_task_id: "new", ticktick_id: "old" }, body: "" },
			"Buy milk",
			options,
		);

		expect(parsed.id).toBe("new");
	});
});

/**
 * TickTick sends the same offset in more than one shape. Matching the raw
 * string named one reminder and left an identical one showing as a code.
 */
describe("reminder names", () => {
	const withNames: MapperOptions = {
		...options,
		labels: {
			...DEFAULT_VALUE_LABELS,
			reminders: { "TRIGGER:-PT30M": "30 minutes before", "TRIGGER:PT0S": "On time" },
		},
	};

	it("reads a duration whichever way it is written", () => {
		expect(triggerToMinutes("TRIGGER:-PT30M")).toBe(-30);
		expect(triggerToMinutes("TRIGGER:-P0DT0H30M0S")).toBe(-30);
		expect(triggerToMinutes("TRIGGER:-PT1H")).toBe(-60);
		expect(triggerToMinutes("TRIGGER:-P1D")).toBe(-1440);
	});

	it("names the expanded form the same as the short one", () => {
		const note = taskToNote(task({ reminders: ["TRIGGER:-P0DT0H30M0S"] }), withNames);
		expect(note.frontmatter.reminders).toEqual(["30 minutes before"]);
	});

	it("names two spellings of the same offset identically", () => {
		const note = taskToNote(
			task({ reminders: ["TRIGGER:-PT30M", "TRIGGER:-P0DT0H30M0S"] }),
			withNames,
		);
		expect(note.frontmatter.reminders).toEqual(["30 minutes before", "30 minutes before"]);
	});

	it("leaves an offset with no name as its raw trigger", () => {
		const note = taskToNote(task({ reminders: ["TRIGGER:-PT45M"] }), withNames);
		expect(note.frontmatter.reminders).toEqual(["TRIGGER:-PT45M"]);
	});

	it("ignores anything that is not a duration", () => {
		expect(triggerToMinutes("TRIGGER:nonsense")).toBeUndefined();
	});
});

/**
 * A filename cannot hold a colon or a slash, so the note for "Read: chapter 3/4"
 * is called "Read- chapter 3-4". Treating that as the title pushed the mangled
 * version back to TickTick and flattened the punctuation for good.
 */
describe("recovering a title a filename cannot hold", () => {
	it("keeps the real title when the filename is just its sanitised form", () => {
		expect(resolveTitle("Read- chapter 3-4", "Read: chapter 3/4")).toBe("Read: chapter 3/4");
	});

	it("takes the filename when the note was genuinely renamed", () => {
		expect(resolveTitle("Something else entirely", "Read: chapter 3/4")).toBe(
			"Something else entirely",
		);
	});

	it("uses the filename when nothing is known yet", () => {
		expect(resolveTitle("A brand new note")).toBe("A brand new note");
	});

	it("leaves an ordinary title alone", () => {
		expect(resolveTitle("Buy milk", "Buy milk")).toBe("Buy milk");
	});

	it("survives a title that is only punctuation", () => {
		const filed = sanitiseFilename("???");
		expect(resolveTitle(filed, "???")).toBe("???");
	});
});

/**
 * The filename cannot hold a colon or a slash, so without a property there is
 * nowhere in Obsidian showing what the task is really called. The sync does not
 * depend on it — the title lives in plugin state — but a reader does.
 */
describe("showing a title the filename cannot hold", () => {
	it("writes the real title when punctuation forces a different filename", () => {
		const note = taskToNote(task({ title: "Read: chapter 3/4" }), options);
		expect(note.frontmatter.ticktick_title).toBe("Read: chapter 3/4");
	});

	it("writes nothing for an ordinary title", () => {
		const note = taskToNote(task({ title: "Buy milk" }), options);
		expect(note.frontmatter.ticktick_title).toBeUndefined();
	});

	it("covers every character a filename rejects", () => {
		const note = taskToNote(task({ title: "Meeting: notes 1/2 — who?" }), options);
		expect(note.frontmatter.ticktick_title).toBe("Meeting: notes 1/2 — who?");
	});
});
