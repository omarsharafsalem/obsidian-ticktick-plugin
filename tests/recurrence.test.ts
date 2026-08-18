import { describe, expect, it } from "vitest";
import {
	completionLogLine,
	findCompletedOccurrences,
	mergeCompletionLog,
	occurrenceMode,
	readOccurrenceMode,
	recurrenceIntervalDays,
	type RecurrenceCandidate,
} from "../src/sync/recurrence";

/**
 * Recurrence policy, checked without an account or a vault.
 *
 * The behaviour these tests are pinned to was probed against the live API:
 * completing a repeating task leaves the live task open under the same id with
 * its due date rolled forward, and files a *separate* record — new id, same
 * title, no repeat rule, a completion time — for the occurrence that was
 * finished. Everything here follows from that.
 */

describe("reading an interval out of a recurrence rule", () => {
	it("reads every day", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=DAILY;INTERVAL=1")).toBe(1);
	});

	it("reads every other day", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=DAILY;INTERVAL=2")).toBe(2);
	});

	it("reads every week", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=WEEKLY;INTERVAL=1")).toBe(7);
	});

	it("reads every third week", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=WEEKLY;INTERVAL=3")).toBe(21);
	});

	it("reads a month as an average month", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=MONTHLY;INTERVAL=1")).toBeCloseTo(30.44, 1);
	});

	it("reads a year as an average year", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=YEARLY;INTERVAL=1")).toBeCloseTo(365.24, 1);
	});

	it("reads sub-daily frequencies", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=HOURLY;INTERVAL=6")).toBeCloseTo(0.25, 5);
		expect(recurrenceIntervalDays("RRULE:FREQ=MINUTELY;INTERVAL=30")).toBeCloseTo(30 / 1440, 5);
	});

	// The gap between occurrences is the question, not the length of a period.
	it("divides a weekly rule by how many days it names", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR")).toBeCloseTo(
			7 / 3,
			5,
		);
	});

	it("divides a monthly rule by how many dates it names", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15")).toBeCloseTo(15.22, 1);
	});

	// Under FREQ=DAILY the same list limits rather than expands.
	it("stretches a daily rule limited to weekdays", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR")).toBeCloseTo(1.4, 5);
	});

	it("defaults a missing interval to every period", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=WEEKLY")).toBe(7);
	});

	it("ignores an interval that is not a positive number", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=DAILY;INTERVAL=0")).toBe(1);
		expect(recurrenceIntervalDays("RRULE:FREQ=DAILY;INTERVAL=-3")).toBe(1);
		expect(recurrenceIntervalDays("RRULE:FREQ=DAILY;INTERVAL=often")).toBe(1);
	});

	it("ignores case and padding", () => {
		expect(recurrenceIntervalDays("  rrule:freq=weekly;interval=2  ")).toBe(14);
	});

	it("reads a rule written without its prefix", () => {
		expect(recurrenceIntervalDays("FREQ=DAILY")).toBe(1);
	});

	// TickTick's own extensions travel alongside the standard parameters.
	it("ignores TickTick's extra parameters", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=WEEKEND")).toBe(1);
		expect(recurrenceIntervalDays("RRULE:FREQ=WEEKLY;TT_TIMES=3;BYDAY=MO")).toBe(7);
	});

	// The spaced-repetition curve has no period to reduce to, so it is unanswered
	// rather than guessed at.
	it("declines TickTick's forgetting-curve rule", () => {
		expect(
			recurrenceIntervalDays("ERULE:NAME=EBBINGHAUS_FORGETTING_CURVE;CYCLE=0;TT_TIMES=1,2,4,7,15"),
		).toBeUndefined();
	});

	it("declines an unknown frequency", () => {
		expect(recurrenceIntervalDays("RRULE:FREQ=FORTNIGHTLY")).toBeUndefined();
	});

	it("declines a rule with no frequency at all", () => {
		expect(recurrenceIntervalDays("RRULE:BYDAY=MO,WE")).toBeUndefined();
	});

	it("declines nonsense without throwing", () => {
		expect(recurrenceIntervalDays("not a rule")).toBeUndefined();
		expect(recurrenceIntervalDays(";;;=;=")).toBeUndefined();
		expect(recurrenceIntervalDays("RRULE:")).toBeUndefined();
	});

	it("declines an absent rule", () => {
		expect(recurrenceIntervalDays(undefined)).toBeUndefined();
		expect(recurrenceIntervalDays("")).toBeUndefined();
		expect(recurrenceIntervalDays("   ")).toBeUndefined();
	});
});

describe("choosing where a finished occurrence is recorded", () => {
	it("gives weekly and rarer a note each", () => {
		expect(occurrenceMode(7, 7)).toBe("note");
		expect(occurrenceMode(30.44, 7)).toBe("note");
	});

	it("logs anything more frequent than the threshold", () => {
		expect(occurrenceMode(1, 7)).toBe("log");
		expect(occurrenceMode(6.99, 7)).toBe("log");
	});

	// The threshold is inclusive, so "7" means "weekly gets a note".
	it("treats the threshold itself as rare enough for a note", () => {
		expect(occurrenceMode(7, 7)).toBe("note");
	});

	it("follows a threshold the vault has moved", () => {
		expect(occurrenceMode(1, 0)).toBe("note");
		expect(occurrenceMode(30.44, 365)).toBe("log");
	});

	// An unreadable rule falls to the option that touches nothing already written.
	it("gives an unreadable rule a note", () => {
		expect(occurrenceMode(undefined, 7)).toBe("note");
	});

	it("lets a per-task override win either way", () => {
		expect(occurrenceMode(1, 7, "note")).toBe("note");
		expect(occurrenceMode(365, 7, "log")).toBe("log");
		expect(occurrenceMode(undefined, 7, "log")).toBe("log");
	});
});

describe("reading the per-task override", () => {
	it("reads both answers", () => {
		expect(readOccurrenceMode("note")).toBe("note");
		expect(readOccurrenceMode("log")).toBe("log");
	});

	it("ignores case and padding", () => {
		expect(readOccurrenceMode("  LOG ")).toBe("log");
	});

	it("accepts the value as a one-element list, as Obsidian may store it", () => {
		expect(readOccurrenceMode(["note"])).toBe("note");
	});

	it("accepts the obvious near-spellings", () => {
		expect(readOccurrenceMode("notes")).toBe("note");
		expect(readOccurrenceMode("logged")).toBe("log");
	});

	// A typo must fall back to the rule rather than move where completions land.
	it("treats anything else as absent", () => {
		expect(readOccurrenceMode("lgo")).toBeUndefined();
		expect(readOccurrenceMode("")).toBeUndefined();
		expect(readOccurrenceMode(undefined)).toBeUndefined();
		expect(readOccurrenceMode(true)).toBeUndefined();
		expect(readOccurrenceMode(3)).toBeUndefined();
	});
});

describe("finding the finished occurrences of a repeating task", () => {
	const live = (overrides: Partial<RecurrenceCandidate> = {}): RecurrenceCandidate => ({
		id: "rec-1",
		projectId: "list-a",
		title: "Water the plants",
		status: "todo",
		repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
		...overrides,
	});

	const finished = (overrides: Partial<RecurrenceCandidate> = {}): RecurrenceCandidate => ({
		id: "occ-1",
		projectId: "list-a",
		title: "Water the plants",
		status: "completed",
		completedTime: "2026-08-17T09:30:00.000Z",
		...overrides,
	});

	it("ties a finished record back to the live task by list and title", () => {
		const [occurrence] = findCompletedOccurrences([live(), finished()]);
		expect(occurrence).toMatchObject({ taskId: "occ-1", parentTaskId: "rec-1", intervalDays: 1 });
	});

	it("records the day it was finished, where the task lives", () => {
		const [occurrence] = findCompletedOccurrences([
			live(),
			finished({ completedTime: "2026-08-17T22:30:00.000Z", timeZone: "Asia/Dubai" }),
		]);
		expect(occurrence.completedOn).toBe("2026-08-18");
	});

	it("ignores a completed task with no repeating twin", () => {
		expect(findCompletedOccurrences([finished({ title: "Something else" })])).toEqual([]);
	});

	it("ignores a completed twin of a task that does not repeat", () => {
		expect(findCompletedOccurrences([live({ repeatFlag: undefined }), finished()])).toEqual([]);
	});

	it("matches within the right list only", () => {
		expect(findCompletedOccurrences([live(), finished({ projectId: "list-b" })])).toEqual([]);
	});

	it("ignores case and padding in the title", () => {
		const found = findCompletedOccurrences([live(), finished({ title: "  water THE plants " })]);
		expect(found).toHaveLength(1);
	});

	// Without a completion time there is nothing to log and nothing to date.
	it("ignores a completed record with no completion time", () => {
		expect(findCompletedOccurrences([live(), finished({ completedTime: undefined })])).toEqual([]);
	});

	// A wrong match would write a completion into somebody else's note, so an
	// ambiguous title is left to the ordinary path instead.
	it("leaves an occurrence unmatched when two repeating tasks share a title", () => {
		const found = findCompletedOccurrences([
			live(),
			live({ id: "rec-2", repeatFlag: "RRULE:FREQ=WEEKLY" }),
			finished(),
		]);
		expect(found).toEqual([]);
	});

	it("does not treat a task as its own occurrence", () => {
		const found = findCompletedOccurrences([
			live({ status: "completed", completedTime: "2026-08-17T09:30:00.000Z" }),
		]);
		expect(found).toEqual([]);
	});

	it("carries the rule's interval, not the occurrence's own absent one", () => {
		const [occurrence] = findCompletedOccurrences([
			live({ repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=2" }),
			finished(),
		]);
		expect(occurrence.intervalDays).toBe(14);
	});

	it("finds every occurrence of the same task", () => {
		const found = findCompletedOccurrences([
			live(),
			finished(),
			finished({ id: "occ-2", completedTime: "2026-08-16T09:30:00.000Z" }),
		]);
		expect(found.map((occurrence) => occurrence.taskId)).toEqual(["occ-1", "occ-2"]);
	});
});

/**
 * The guarantee that makes logging safe to run on every sync: the same
 * completions produce the same lines, and merging them changes nothing.
 */
describe("the completion log", () => {
	it("writes one dated line per occurrence", () => {
		expect(completionLogLine("2026-08-18")).toBe("- 2026-08-18");
	});

	it("adds a line that is not there yet", () => {
		expect(mergeCompletionLog([], ["- 2026-08-18"])).toEqual(["- 2026-08-18"]);
	});

	it("adds nothing when every line is already there", () => {
		const existing = ["- 2026-08-18", "- 2026-08-17"];
		expect(mergeCompletionLog(existing, ["- 2026-08-17"])).toEqual(existing);
	});

	it("is idempotent across repeated merges", () => {
		const lines = ["- 2026-08-18", "- 2026-08-17"];
		const once = mergeCompletionLog([], lines);
		const twice = mergeCompletionLog(once, lines);
		const thrice = mergeCompletionLog(twice, lines);
		expect(thrice).toEqual(once);
	});

	it("collapses two completions on the same day", () => {
		expect(mergeCompletionLog([], ["- 2026-08-18", "- 2026-08-18"])).toEqual(["- 2026-08-18"]);
	});

	it("puts a new batch in newest-first order", () => {
		expect(mergeCompletionLog([], ["- 2026-08-16", "- 2026-08-18", "- 2026-08-17"])).toEqual([
			"- 2026-08-18",
			"- 2026-08-17",
			"- 2026-08-16",
		]);
	});

	it("puts new lines above the ones already there", () => {
		expect(mergeCompletionLog(["- 2026-08-16"], ["- 2026-08-18"])).toEqual([
			"- 2026-08-18",
			"- 2026-08-16",
		]);
	});

	// A line may have been written or edited by hand, so nothing already in the
	// note is reordered or rewritten.
	it("leaves lines already in the note exactly as they are", () => {
		const existing = ["- 2026-08-10 — did it early", "- 2026-08-16"];
		expect(mergeCompletionLog(existing, ["- 2026-08-18"])).toEqual([
			"- 2026-08-18",
			...existing,
		]);
	});

	it("matches an existing line despite surrounding space", () => {
		expect(mergeCompletionLog(["  - 2026-08-18  "], ["- 2026-08-18"])).toEqual([
			"  - 2026-08-18  ",
		]);
	});
});
