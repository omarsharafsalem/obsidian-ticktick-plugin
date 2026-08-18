import { dateInZone } from "../util/dates";
import type { TaskStatus } from "../api/types";

/**
 * What a repeating task's finished occurrences become.
 *
 * Completing a repeating task in TickTick does two separate things. The live
 * task keeps its id: its due date rolls forward, its status returns to open and
 * it never reports itself completed. Alongside that, a brand new record appears
 * in the completed listing — its own id, the same title, no repeat rule, and a
 * completion time — standing for the occurrence that was actually finished.
 *
 * So an occurrence really is a task, and one-note-per-task would give it a note
 * of its own. That is right for a weekly review and wrong for a daily habit,
 * which would bury the vault under a note a day. Which of the two applies is
 * decided from the recurrence rule, here, in isolation from any account or
 * vault — the same reason `matchOrphansToTasks` was pulled out of the engine.
 *
 * Deliberately pure: no Obsidian imports and no filesystem access.
 */

/** Where a finished occurrence is recorded. */
export type OccurrenceMode = "note" | "log";

/** The heading the completion log lives under, inside the synced region. */
export const COMPLETION_HEADING = "## Completions";

/**
 * Roughly how many days one period of each frequency lasts.
 *
 * Months and years are averages, because the question being answered is "often
 * or seldom", not "which day". Nothing downstream needs a calendar.
 */
const DAYS_PER_FREQUENCY: Record<string, number> = {
	SECONDLY: 1 / 86400,
	MINUTELY: 1 / 1440,
	HOURLY: 1 / 24,
	DAILY: 1,
	WEEKLY: 7,
	MONTHLY: 30.436875,
	YEARLY: 365.2425,
};

/** How many entries a `BYDAY`-style list holds; an absent list counts as one. */
function countList(value: string | undefined): number {
	if (!value) return 1;
	const entries = value.split(",").filter((entry) => entry.trim().length > 0);
	return entries.length > 0 ? entries.length : 1;
}

/** `INTERVAL`, defaulting to every period as RFC 5545 does. */
function readInterval(value: string | undefined): number {
	const written = Number.parseInt(value ?? "", 10);
	return Number.isFinite(written) && written > 0 ? written : 1;
}

/**
 * Reduces a recurrence rule to the approximate gap between occurrences, in days.
 *
 * Undefined means the rule could not be read, which is not the same as "does not
 * repeat" — TickTick also emits `ERULE:` for its spaced-repetition curve, whose
 * gaps are a list of days rather than a period, and there is no honest interval
 * to reduce that to. Callers treat unreadable as "leave it on the ordinary
 * path" rather than guessing, so an unparsed rule can never move a completion
 * somewhere unexpected.
 *
 * Unknown parameters, including TickTick's own `TT_*` extensions, are ignored.
 */
export function recurrenceIntervalDays(repeatFlag: string | undefined): number | undefined {
	const rule = repeatFlag?.trim();
	if (!rule) return undefined;

	// The kind prefix, when there is one. Anything that is not an RRULE has no
	// FREQ to read, so it is left unanswered rather than half-parsed.
	const colon = rule.indexOf(":");
	if (colon !== -1 && rule.slice(0, colon).trim().toUpperCase() !== "RRULE") return undefined;

	const params = new Map<string, string>();
	for (const part of rule.slice(colon + 1).split(";")) {
		const equals = part.indexOf("=");
		if (equals === -1) continue;
		params.set(
			part.slice(0, equals).trim().toUpperCase(),
			part.slice(equals + 1).trim().toUpperCase(),
		);
	}

	const frequency = params.get("FREQ") ?? "";
	const base = DAYS_PER_FREQUENCY[frequency];
	if (base === undefined) return undefined;

	const period = base * readInterval(params.get("INTERVAL"));

	// FREQ says how long a period is; a BY* list says how many times it fires
	// inside one. The gap between occurrences is what the threshold asks about,
	// so "every week on Monday, Wednesday and Friday" is two and a third days.
	if (frequency === "WEEKLY") return period / countList(params.get("BYDAY"));
	if (frequency === "MONTHLY") {
		return (
			period / Math.max(countList(params.get("BYMONTHDAY")), countList(params.get("BYDAY")))
		);
	}

	// Under FREQ=DAILY the same list limits instead of expanding — only the named
	// weekdays qualify — so "every weekday" is five occurrences per seven days.
	const byDay = params.get("BYDAY");
	if (frequency === "DAILY" && byDay) return (period * 7) / countList(byDay);

	return period;
}

/**
 * The per-task override, read from whichever property the vault configures.
 *
 * Anything unrecognised counts as absent rather than as an instruction, so a
 * typo falls back to the frequency rule instead of quietly changing where a
 * completion is written. Accepts a bare value or a one-element list, since
 * Obsidian stores some properties either way.
 */
export function readOccurrenceMode(raw: unknown): OccurrenceMode | undefined {
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value !== "string") return undefined;

	switch (value.trim().toLowerCase()) {
		case "note":
		case "notes":
			return "note";
		case "log":
		case "logged":
			return "log";
		default:
			return undefined;
	}
}

/**
 * Whether a finished occurrence gets its own note or a line in the repeating
 * task's note.
 *
 * An unreadable rule falls to "note", which is what the occurrence would have
 * got anyway: it is a real task, so a note is the ordinary path, while logging
 * writes into a note that already exists and holds the user's own text. When
 * the rule cannot be read, the option that touches nothing already there wins.
 */
export function occurrenceMode(
	intervalDays: number | undefined,
	thresholdDays: number,
	override?: OccurrenceMode,
): OccurrenceMode {
	if (override) return override;
	if (intervalDays === undefined) return "note";
	return intervalDays >= thresholdDays ? "note" : "log";
}

/** A task as the recurrence policy sees it — no vault types, no I/O. */
export interface RecurrenceCandidate {
	id: string;
	projectId: string;
	title: string;
	status: TaskStatus;
	repeatFlag?: string;
	/** ISO 8601 UTC. Set on the finished record, never on the live task. */
	completedTime?: string;
	timeZone?: string;
}

export interface CompletedOccurrence {
	/** The finished record's own id, which the sync has never seen before. */
	taskId: string;
	/** The live repeating task this is one occurrence of. */
	parentTaskId: string;
	/** Approximate days between occurrences; undefined when the rule is unreadable. */
	intervalDays?: number;
	/** The calendar date it was finished on, where the task lives. */
	completedOn?: string;
}

/**
 * Picks out the finished occurrences of repeating tasks from one pass's tasks.
 *
 * The finished record carries no repeat rule and no link back to the task it
 * came from, so the only evidence tying the two together is that they share a
 * list and a title. A title used by two repeating tasks in one list is left
 * unmatched: an occurrence that is not recognised is treated as the ordinary
 * task it looks like, which costs a note, whereas a wrong match would write a
 * completion into somebody else's.
 */
export function findCompletedOccurrences(tasks: RecurrenceCandidate[]): CompletedOccurrence[] {
	const key = (projectId: string, title: string): string =>
		`${projectId}::${title.trim().toLowerCase()}`;

	// Null marks a key claimed by more than one repeating task, so a later lookup
	// finds the ambiguity rather than the first arrival.
	const repeating = new Map<string, RecurrenceCandidate | null>();
	for (const task of tasks) {
		if (task.status === "completed" || !task.repeatFlag) continue;
		const k = key(task.projectId, task.title);
		repeating.set(k, repeating.has(k) ? null : task);
	}

	const occurrences: CompletedOccurrence[] = [];
	for (const task of tasks) {
		if (task.status !== "completed" || !task.completedTime) continue;

		const parent = repeating.get(key(task.projectId, task.title));
		if (!parent || parent.id === task.id) continue;

		occurrences.push({
			taskId: task.id,
			parentTaskId: parent.id,
			intervalDays: recurrenceIntervalDays(parent.repeatFlag),
			completedOn: dateInZone(task.completedTime, task.timeZone),
		});
	}

	return occurrences;
}

/**
 * One line per day on which the task was finished.
 *
 * A bare date is the whole format on purpose. The line has to come back out of
 * the note byte-identical for a re-sync to recognise it, and it is that
 * identity which makes appending idempotent. Two completions of the same task
 * on one day therefore collapse to a single line, which is the right reading
 * for the everyday repeats this mode exists for.
 */
export function completionLogLine(completedOn: string): string {
	return `- ${completedOn}`;
}

/**
 * Folds new completion lines into the ones the note already holds.
 *
 * Lines already present are kept exactly as they are, in the order they are in:
 * one of them may have been written or edited by hand, and reordering the log
 * would rewrite it. Only the incoming batch is sorted, newest first, so a first
 * sync backfilling ninety days still reads in a sensible order.
 */
export function mergeCompletionLog(existing: string[], added: string[]): string[] {
	const seen = new Set(existing.map((line) => line.trim()));

	const fresh: string[] = [];
	// Lexicographic order on a leading `YYYY-MM-DD` is chronological order.
	for (const line of [...added].sort().reverse()) {
		const key = line.trim();
		if (seen.has(key)) continue;
		seen.add(key);
		fresh.push(line);
	}

	return fresh.length > 0 ? [...fresh, ...existing] : existing;
}
