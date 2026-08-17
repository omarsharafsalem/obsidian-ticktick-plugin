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
 * Renders a date for storage in note frontmatter. All-day tasks get a bare
 * `YYYY-MM-DD` so that Obsidian's date pickers and Dataview treat them as
 * dates rather than instants.
 */
export function toFrontmatterDate(iso: string | undefined, isAllDay: boolean): string | undefined {
	if (!iso) return undefined;
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return undefined;
	return isAllDay ? parsed.toISOString().slice(0, 10) : parsed.toISOString();
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
