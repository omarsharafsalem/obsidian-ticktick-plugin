/**
 * TickTick emits and expects timestamps as `2026-08-20T10:00:00.000+0000` —
 * ISO 8601 with a basic-format offset that `Date` parses inconsistently across
 * engines. Everything inside the plugin uses canonical UTC ISO strings instead,
 * and converts at the API boundary.
 */

/** Sentinel the API accepts to clear a date field. */
export const CLEAR_DATE = "1970-01-01T00:00:00.000+0000";

export function fromTickTickDate(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;

	// Normalise `+0000` / `-0730` into `+00:00` / `-07:30` before parsing.
	const normalised = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
	const parsed = new Date(normalised);
	if (Number.isNaN(parsed.getTime())) return undefined;

	// The epoch sentinel means "no date", not 1970.
	if (parsed.getTime() === 0) return undefined;

	return parsed.toISOString();
}

export function toTickTickDate(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return undefined;
	return parsed.toISOString().replace("Z", "+0000");
}

/**
 * The calendar date an instant falls on, as seen from `timeZone`.
 *
 * An all-day task is a *date*, but the wire carries an instant, and which date
 * that instant belongs to depends on the task's own timezone. Reading the date
 * off the UTC form instead — which this plugin used to do — shifts an all-day
 * task to the previous day for anyone east of Greenwich.
 *
 * `en-CA` is used because it formats as `YYYY-MM-DD`.
 */
export function dateInZone(iso: string, timeZone?: string): string | undefined {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return undefined;

	try {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: timeZone || "UTC",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(parsed);
	} catch {
		// An unknown zone should not lose the date entirely.
		return parsed.toISOString().slice(0, 10);
	}
}

/** How far `timeZone` is from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);

	const field = (type: string): number =>
		Number(parts.find((part) => part.type === type)?.value ?? "0");

	// `hour` comes back as 24 at midnight under hour12: false in some engines.
	const hour = field("hour") % 24;
	const asUtc = Date.UTC(field("year"), field("month") - 1, field("day"), hour, field("minute"), field("second"));

	return asUtc - at.getTime();
}

/**
 * The instant at which a bare `YYYY-MM-DD` begins in `timeZone`.
 *
 * The inverse of {@link dateInZone}, so an all-day task survives the round trip
 * to TickTick and back on the same calendar day.
 */
export function zonedMidnight(dateOnly: string, timeZone?: string): string | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return undefined;

	const utcMidnight = new Date(`${dateOnly}T00:00:00.000Z`);
	if (Number.isNaN(utcMidnight.getTime())) return undefined;
	if (!timeZone) return utcMidnight.toISOString();

	try {
		// Offsets are themselves date-dependent, so apply and re-measure once —
		// enough to settle any DST boundary the first guess landed the wrong side of.
		const firstPass = new Date(utcMidnight.getTime() - zoneOffsetMs(utcMidnight, timeZone));
		return new Date(utcMidnight.getTime() - zoneOffsetMs(firstPass, timeZone)).toISOString();
	} catch {
		return utcMidnight.toISOString();
	}
}

/**
 * The wall-clock time of an instant in a given zone, as `YYYY-MM-DDTHH:mm`.
 *
 * Obsidian's datetime properties are naive — no zone, displayed exactly as
 * written — so an instant has to be converted before it is stored, not after.
 */
export function timeInZone(iso: string, timeZone?: string): string | undefined {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return undefined;

	try {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: timeZone || undefined,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		}).formatToParts(parsed);

		const get = (type: string): string =>
			parts.find((part) => part.type === type)?.value ?? "00";

		// `hour` comes back as 24 at midnight under hour12: false in some engines.
		const hour = String(Number(get("hour")) % 24).padStart(2, "0");
		return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
	} catch {
		return parsed.toISOString().slice(0, 16);
	}
}

/**
 * Renders a date for storage in note frontmatter.
 *
 * All-day tasks get a bare `YYYY-MM-DD`. A timed task gets the wall-clock time
 * where the task lives, because Obsidian shows a datetime exactly as written:
 * storing the UTC form makes a task due at 00:30 read as 23:30 the day before.
 */
export function toFrontmatterDate(
	iso: string | undefined,
	isAllDay: boolean,
	timeZone?: string,
): string | undefined {
	if (!iso) return undefined;
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return undefined;
	if (isAllDay) return parsed.toISOString().slice(0, 10);
	return timeInZone(iso, timeZone);
}

export function fromFrontmatterDate(value: unknown): string | undefined {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
	}
	if (typeof value !== "string" || !value.trim()) return undefined;

	const trimmed = value.trim();
	// A bare date is interpreted as UTC midnight, matching all-day semantics.
	const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
		? new Date(`${trimmed}T00:00:00.000Z`)
		: new Date(trimmed);

	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** True when a frontmatter value carries no time component. */
export function looksAllDay(value: unknown): boolean {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}
