import { describe, expect, it } from "vitest";
import { normaliseTask, serialiseTask } from "../src/api/openApi";
import { DEFAULT_MAPPER_OPTIONS, taskToNote, type MapperOptions } from "../src/sync/mapper";

/**
 * A real response from TickTick, captured 17 Aug 2026 by creating an all-day
 * task due 18 August from a machine in Europe/London.
 *
 * It settles what the plugin had only been reasoning about: an all-day task is
 * stored as local midnight expressed in UTC, so the day before is what you get
 * if you read the date off the UTC form. Every all-day task east of Greenwich
 * lands a day early that way.
 */
const ALL_DAY_ON_THE_18TH = {
	id: "6a834b048f08bb0249d3cbd5",
	title: "All day test",
	dueDate: "2026-08-17T23:00:00+0000",
	startDate: "2026-08-17T23:00:00+0000",
	timeZone: "Europe/London",
	isAllDay: true,
	status: 0,
	priority: 0,
	tags: [],
	items: [],
};

describe("a real all-day task from TickTick", () => {
	it("resolves to the day the user actually chose", () => {
		const task = normaliseTask(ALL_DAY_ON_THE_18TH);

		// The naive reading — and the bug — is "2026-08-17".
		expect(task.dueDate?.slice(0, 10)).toBe("2026-08-18");
		expect(task.startDate?.slice(0, 10)).toBe("2026-08-18");
		expect(task.isAllDay).toBe(true);
	});

	it("goes back to TickTick as the same instant it arrived", () => {
		const sent = serialiseTask(normaliseTask(ALL_DAY_ON_THE_18TH)) as { dueDate?: string };

		// Round-tripping must not walk the date forward or back a day each sync.
		expect(sent.dueDate).toBe("2026-08-17T23:00:00.000+0000");
	});
});

/**
 * Also captured live. TickTick stores a timed task as an instant, so a task due
 * at 00:30 is 23:30 the previous day in UTC — and Obsidian shows a datetime
 * exactly as written. Storing the UTC form put the task on the wrong day.
 */
const TIMED_AT_0030_ON_THE_18TH = {
	id: "6a834b738f08d7debd65f0f6",
	title: "Timed test 00:30 near midnight",
	dueDate: "2026-08-17T23:30:00+0000",
	timeZone: "Europe/London",
	isAllDay: false,
	status: 0,
	priority: 0,
	tags: [],
	items: [],
};

describe("a real timed task from TickTick", () => {
	// These read the task's own zone rather than the machine's, so they assert
	// the same thing everywhere. Rendering on the reader's clock is the default
	// in the plugin, but a test cannot pin down the reader's clock portably.
	const inTaskZone: MapperOptions = { ...DEFAULT_MAPPER_OPTIONS, useTaskTimeZone: true };

	it("shows the time the user chose, on the day they chose", () => {
		const note = taskToNote(normaliseTask(TIMED_AT_0030_ON_THE_18TH), inTaskZone);

		// The bug wrote "2026-08-17T23:30:00.000Z" — right instant, wrong day
		// to read, because Obsidian displays a datetime verbatim.
		expect(note.frontmatter.due).toBe("2026-08-18T00:30");
	});

	it("keeps an afternoon time on the right day too", () => {
		const note = taskToNote(
			normaliseTask({
				...TIMED_AT_0030_ON_THE_18TH,
				dueDate: "2026-08-18T13:30:00+0000",
			}),
			inTaskZone,
		);

		expect(note.frontmatter.due).toBe("2026-08-18T14:30");
	});

	it("sends the same instant back to TickTick", () => {
		const task = normaliseTask(TIMED_AT_0030_ON_THE_18TH);
		expect((serialiseTask(task) as { dueDate?: string }).dueDate).toBe(
			"2026-08-17T23:30:00.000+0000",
		);
	});
});
