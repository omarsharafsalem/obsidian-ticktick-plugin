import { fromFrontmatterDate, looksAllDay, toFrontmatterDate } from "../util/dates";
import { extractTags, normaliseTag, parseTagList } from "../util/tags";
import { DEFAULT_PROPERTIES, DEFAULT_VALUE_LABELS, type PropertyNames, type ValueLabels } from "../settings";
import { COMPLETION_HEADING } from "./recurrence";
import type { ChecklistItem, Priority, Task, TaskStatus } from "../api/types";

/**
 * Translates between a TickTick task and the note that represents it.
 *
 * Every TickTick field lands in a real Obsidian property rather than in the
 * note body, so the Properties panel is the editing surface and Dataview/Bases
 * queries work without parsing prose. Property names are configurable.
 *
 * Deliberately pure: no Obsidian imports and no filesystem access. YAML parsing
 * happens one layer up in `vault/notes.ts`, which keeps the round-trip
 * behaviour directly unit-testable.
 */

export const SUBTASK_HEADING = "## Subtasks";

/** A task referenced from another task's note, as an Obsidian wikilink. */
export interface TaskLink {
	/** The note's basename, which is the task title once made filename-safe. */
	title: string;
	/**
	 * Extension-less vault path, set only when the bare title is ambiguous.
	 *
	 * Two tasks can share a title, and `[[Buy milk]]` would then resolve to
	 * whichever note Obsidian picked — re-parenting the wrong task on the next
	 * push. Qualifying with the path makes the link exact.
	 */
	path?: string;
}

/** Relationships the mapper cannot work out from a task on its own. */
export interface NoteContext {
	projectName?: string;
	/**
	 * The note representing this task's list, when one is configured.
	 *
	 * Written instead of the plain list name so the task appears in that note's
	 * backlinks, which is how a project page gathers its own work.
	 */
	projectLink?: TaskLink;
	/** The note representing this task's section, when one is configured. */
	subprojectLink?: TaskLink;
	/**
	 * What the note's sub-project property says now.
	 *
	 * Kept so it can be left exactly as it is when the task reports no section.
	 * A task with no section is not a task whose sub-project has been cleared —
	 * it may simply be filed in a list this pass could not read sections for.
	 */
	currentSubproject?: string;
	/**
	 * The note's own filename, without the extension, when it has one yet.
	 *
	 * Used to notice that the file is not actually named after the task — a
	 * collision suffix, or a name Obsidian had to alter — so the real title gets
	 * written down rather than being silently redefined as whatever the file
	 * ended up called.
	 */
	filenameTitle?: string;
	/** Aliases the note already carries, so adding one never removes another. */
	currentAliases?: string[];
	parent?: TaskLink;
	/** Derived from whichever tasks point at this one; never read back. */
	children?: TaskLink[];
	/** What the note's status property says now, so an equivalent value survives. */
	currentStatus?: string;
	/** Text below the marker, preserved exactly as the user left it. */
	privateBody?: string;
	/**
	 * The completion log of a frequently repeating task, put back on every write.
	 *
	 * Nothing here comes from the task, so it has to be handed back in or the
	 * first ordinary update would rewrite the note without it.
	 */
	completions?: string[];
}

/**
 * True when a frontmatter date means a whole day rather than a moment.
 *
 * A bare `2026-08-20` is unambiguous. Exactly midnight counts as well, because
 * a datetime-typed property makes Obsidian rewrite bare dates to include a
 * time — without this every all-day task would look scheduled for 00:00.
 */
function looksLikeWholeDay(raw: unknown, iso: string): boolean {
	if (looksAllDay(raw)) return true;
	return iso.endsWith("T00:00:00.000Z");
}

/** `[[path|title]]` when disambiguation is needed, `[[title]]` otherwise. */
export function formatWikilink(link: TaskLink): string {
	return link.path ? `[[${link.path}|${link.title}]]` : `[[${link.title}]]`;
}

/**
 * Pulls the link target out of `[[target]]` or `[[target|alias]]`.
 *
 * Returns undefined for anything that is not a wikilink, so a value left as a
 * bare task id still parses.
 */
export function parseWikilink(value: string): string | undefined {
	const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
	if (!match) return undefined;
	return (match[1].split("|")[0] ?? "").trim() || undefined;
}

/**
 * Property names this plugin used to write, still read as a fallback.
 *
 * Renaming a default silently orphans every note carrying the old name: the
 * note reads as having no task id, so it looks new and a duplicate task gets
 * created in TickTick. Reading the old names costs nothing and prevents that.
 */
const LEGACY_PROPERTY_NAMES: Partial<Record<keyof PropertyNames, string[]>> = {
	id: ["ticktick_id"],
	project: ["list"],
};

/** The configured property, falling back to names earlier versions wrote. */
function readProperty(
	fm: Record<string, unknown>,
	properties: PropertyNames,
	key: keyof PropertyNames,
): unknown {
	const configured = fm[properties[key]];
	if (configured !== undefined && configured !== null) return configured;

	for (const legacy of LEGACY_PROPERTY_NAMES[key] ?? []) {
		const value = fm[legacy];
		if (value !== undefined && value !== null) return value;
	}

	return undefined;
}

/** Characters Obsidian or the filesystem will not accept in a note name. */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

const MAX_FILENAME_LENGTH = 120;

export interface MapperOptions {
	properties: PropertyNames;
	/** Also harvest `#tags` written in the note body. */
	inlineTags: boolean;
	/**
	 * Turns whatever is written in the list property back into a project id.
	 *
	 * The property holds a list *name*, because an id is meaningless to read and
	 * impossible to edit deliberately. Supplied by the engine, which knows the
	 * account's lists; kept as a plain function so this module stays pure.
	 */
	/**
	 * Whether an unrepresentable title is also written to the note's aliases.
	 *
	 * Off unless asked for: `aliases` is Obsidian's, not this plugin's, and a
	 * vault owner's alias list is not somewhere to write uninvited.
	 */
	aliasTitles?: boolean;
	resolveProject?: (nameOrId: string) => string | undefined;
	/**
	 * Turns whatever is written in the sub-project property back into a section id.
	 *
	 * Scoped to the note's own list by the caller, since two lists may name a
	 * section alike and the wrong id files the task under the wrong sub-project.
	 */
	resolveSection?: (nameOrLink: string) => string | undefined;
	/** The words this vault uses for statuses, priorities and reminders. */
	labels?: ValueLabels;
	/** Turns a wikilink target — a note title or path — back into a task id. */
	resolveTaskLink?: (target: string) => string | undefined;
	/**
	 * Stamped onto notes this plugin creates, so they are recognised by the same
	 * rule as notes written by hand rather than only by where they sit.
	 */
	marker?: { property: string; value: string };
	/** Ends the synced part of the body; everything after it is untouched. */
	syncedRegionMarker?: string;
	/**
	 * Show times on the task's own clock rather than this machine's.
	 *
	 * Off by default: the zone TickTick tags a task with is frequently a stale
	 * account setting, and honouring it then shifts every time by hours.
	 */
	useTaskTimeZone?: boolean;
}

export const DEFAULT_MAPPER_OPTIONS: MapperOptions = {
	properties: DEFAULT_PROPERTIES,
	inlineTags: true,
	labels: DEFAULT_VALUE_LABELS,
};

/**
 * Finds the canonical value whose label matches what is written in a note.
 *
 * Case- and space-insensitive, because the value is hand-editable and a label
 * like "In progress" invites both "in progress" and "In Progress".
 */
function matchLabel<T extends string>(
	written: string,
	labels: Record<T, string>,
): T | undefined {
	const wanted = written.trim().toLowerCase();
	for (const [canonical, label] of Object.entries(labels) as [T, string][]) {
		if (label.trim().toLowerCase() === wanted) return canonical;
	}
	return undefined;
}

/**
 * Reduces an iCal TRIGGER to a signed number of minutes.
 *
 * TickTick sends the same offset in more than one shape — `-PT30M` and
 * `-P0DT0H30M0S` are both "thirty minutes before" — so matching the raw string
 * names one reminder and leaves an identical one showing as a code.
 */
export function triggerToMinutes(trigger: string): number | undefined {
	const match = /^\s*(?:TRIGGER:)?([+-]?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?\s*$/i.exec(
		trigger,
	);
	if (!match) return undefined;

	const [, sign, days, hours, minutes, seconds] = match;
	if (!days && !hours && !minutes && !seconds) return undefined;

	const total =
		Number(days ?? 0) * 1440 +
		Number(hours ?? 0) * 60 +
		Number(minutes ?? 0) +
		Number(seconds ?? 0) / 60;

	return sign === "-" ? -total : total;
}

/** As {@link matchLabel}, but each status owns several accepted spellings. */
function matchStatusLabel(written: string, labels: ValueLabels): TaskStatus | undefined {
	const wanted = written.trim().toLowerCase();
	for (const [canonical, spellings] of Object.entries(labels.status) as [TaskStatus, string[]][]) {
		// Defensive: a hand-edited settings file can put anything here, and one
		// bad value must not take the whole sync down with it.
		if (!Array.isArray(spellings)) continue;
		if (spellings.some((value) => value.trim().toLowerCase() === wanted)) return canonical;
	}
	return undefined;
}

function isNeutralStatus(written: string, labels: ValueLabels): boolean {
	if (!Array.isArray(labels.statusNeutral)) return false;
	const wanted = written.trim().toLowerCase();
	return labels.statusNeutral.some((value) => value.trim().toLowerCase() === wanted);
}

/**
 * What to write for a status, preferring what the note already says.
 *
 * A note reading "Paused" must not become "Active" just because something else
 * about the task changed — TickTick still calls both "not done", so nothing
 * about the status actually moved.
 */
function statusToWrite(status: TaskStatus, labels: ValueLabels, current?: string): string {
	const spellings = Array.isArray(labels.status[status]) ? labels.status[status] : [];
	if (current && matchStatusLabel(current, labels) === status) return current;
	return spellings[0] ?? status;
}

export interface NoteContent {
	frontmatter: Record<string, unknown>;
	body: string;
}

export interface ParsedNote {
	/** Undefined for a note the user wrote by hand that has never synced. */
	id?: string;
	projectId?: string;
	/** Section id the sub-project property resolved to, when it resolved. */
	columnId?: string;
	/**
	 * The status describes filing, not progress — "Archived" and the like.
	 *
	 * Nothing should be pushed for it: archiving a finished task must not reopen
	 * it, and archiving an open one must not complete it.
	 */
	statusNeutral?: boolean;
	/** Everything below the marker, kept so a write can put it back untouched. */
	privateBody: string;
	/** The completion log the note holds, for the same reason. */
	completions: string[];
	/**
	 * True when the parent property holds a link that could not be resolved.
	 *
	 * Distinguishes "the user cleared this" from "the parent has not synced
	 * yet", so a link to a not-yet-created note never silently un-parents.
	 */
	parentUnresolved?: boolean;
	title: string;
	content: string;
	status: TaskStatus;
	priority: Priority;
	tags: string[];
	dueDate?: string;
	startDate?: string;
	isAllDay: boolean;
	reminders: string[];
	repeatFlag?: string;
	parentId?: string;
	items: ChecklistItem[];
}

export function sanitiseFilename(title: string): string {
	const cleaned = title
		.replace(ILLEGAL_FILENAME_CHARS, "-")
		.replace(/\s+/g, " ")
		// A run of illegal characters should collapse to a single separator
		// rather than leaving "notes--" behind.
		.replace(/-{2,}/g, "-")
		// Leading dots hide the file; trailing dots break on Windows.
		.replace(/^\.+/, "")
		.replace(/\.+$/, "")
		// Trim the separators themselves, so a title of only illegal characters
		// falls through to the placeholder below instead of becoming "---".
		.replace(/^[-\s]+/, "")
		.replace(/[-\s]+$/, "");

	const truncated = cleaned.slice(0, MAX_FILENAME_LENGTH).trim();
	return truncated.length > 0 ? truncated : "Untitled task";
}

/**
 * A task's real title, given the note's filename and the last title agreed with
 * TickTick.
 *
 * A filename cannot hold a colon, a slash or a question mark, so "Read: chapter
 * 3/4" is filed as "Read- chapter 3-4". Taking the filename as the title would
 * push that back and flatten the punctuation permanently — so the known title
 * wins whenever the filename is exactly what it sanitises to. A filename that
 * differs is a genuine rename, and then the filename is the intent.
 */
export function resolveTitle(filenameTitle: string, knownTitle?: string): string {
	if (knownTitle && sanitiseFilename(knownTitle) === filenameTitle) return knownTitle;
	return filenameTitle;
}

/** True when the filename alone cannot round-trip the title. */
export function titleNeedsFrontmatter(title: string): boolean {
	return sanitiseFilename(title) !== title;
}

function renderChecklist(items: ChecklistItem[]): string {
	return items.map((item) => `- [${item.completed ? "x" : " "}] ${item.title}`).join("\n");
}

/**
 * Splits a note body into description, checklist and completion log.
 *
 * The plugin-owned headings are the boundaries: text before the first of them
 * is the task description, checkbox lines under `## Subtasks` become checklist
 * items, and dashed lines under `## Completions` are the log of a repeating
 * task's finished occurrences. Anything else inside those sections is dropped
 * on the next write, which is why the headings are documented as plugin-owned.
 *
 * The completion log is deliberately taken out of the description rather than
 * left in it. It belongs to the vault — it is what a frequent repeat gets
 * instead of a note per occurrence — and folding it into `content` would push
 * the whole history into the TickTick task's description on the next sync.
 */
export function splitBody(
	body: string,
	marker?: string,
): { content: string; items: ChecklistItem[]; privateBody: string; completions: string[] } {
	// Everything past the marker belongs to the user. Split it off before
	// anything else looks at the body, so nothing below can be parsed, matched
	// or rewritten — that is the whole guarantee the marker exists to give.
	let synced = body;
	let privateBody = "";

	const wanted = marker?.trim();
	if (wanted) {
		const all = body.split("\n");
		const at = all.findIndex((line) => line.trim() === wanted);
		if (at !== -1) {
			synced = all.slice(0, at).join("\n");
			privateBody = all.slice(at + 1).join("\n");
		}
	}

	const lines = synced.split("\n");
	const headingAt = (heading: string): number =>
		lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());

	const subtasksAt = headingAt(SUBTASK_HEADING);
	const completionsAt = headingAt(COMPLETION_HEADING);
	const headings = [subtasksAt, completionsAt].filter((at) => at !== -1);

	// A section runs to the next plugin-owned heading, so the two can appear in
	// either order without one swallowing the other.
	const endOf = (start: number): number => {
		const later = headings.filter((at) => at > start);
		return later.length > 0 ? Math.min(...later) : lines.length;
	};

	const content =
		headings.length > 0
			? lines.slice(0, Math.min(...headings)).join("\n").trim()
			: synced.trim();

	const items: ChecklistItem[] = [];
	if (subtasksAt !== -1) {
		for (const line of lines.slice(subtasksAt + 1, endOf(subtasksAt))) {
			const match = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
			if (!match) continue;
			const title = match[2].trim();
			if (!title) continue;
			items.push({ title, completed: match[1].toLowerCase() === "x" });
		}
	}

	// Read back trimmed, because the trimmed form is what is written and what a
	// re-sync compares against — matching on it is what keeps appending idempotent.
	const completions: string[] = [];
	if (completionsAt !== -1) {
		for (const line of lines.slice(completionsAt + 1, endOf(completionsAt))) {
			const trimmed = line.trim();
			if (trimmed.startsWith("- ")) completions.push(trimmed);
		}
	}

	return { content, items, privateBody, completions };
}

export function buildBody(
	content: string,
	items: ChecklistItem[],
	options: { marker?: string; privateBody?: string; completions?: string[] } = {},
): string {
	const synced = buildSyncedRegion(content, items, options.completions ?? []);
	const marker = options.marker?.trim();
	if (!marker) return synced;

	// The marker is always emitted, so the boundary is visible from the first
	// write rather than appearing only once there is something below it.
	const below = options.privateBody ?? "";
	const head = synced.length > 0 ? `${synced.trimEnd()}\n\n` : "";
	return below.trim().length > 0 ? `${head}${marker}\n${below}` : `${head}${marker}\n`;
}

function buildSyncedRegion(
	content: string,
	items: ChecklistItem[],
	completions: string[],
): string {
	// Always written in this order, so a note settles into one shape and stops
	// changing. A heading is omitted entirely when its section is empty.
	const sections: string[] = [];

	const trimmed = content.trim();
	if (trimmed.length > 0) sections.push(trimmed);
	if (items.length > 0) sections.push(`${SUBTASK_HEADING}\n\n${renderChecklist(items)}`);
	if (completions.length > 0) {
		sections.push(`${COMPLETION_HEADING}\n\n${completions.join("\n")}`);
	}

	return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

export function taskToNote(
	task: Task,
	options: MapperOptions = DEFAULT_MAPPER_OPTIONS,
	context: NoteContext = {},
): NoteContent {
	const { projectName } = context;
	const p = options.properties;
	const labels = options.labels ?? DEFAULT_VALUE_LABELS;
	const frontmatter: Record<string, unknown> = {
		[p.id]: task.id,
		// A link to the list's own note when there is one, otherwise its name.
		// Either way not the id: the property is meant to be read and edited.
		[p.project]: context.projectLink
			? formatWikilink(context.projectLink)
			: (projectName ?? task.projectId),
		[p.status]: statusToWrite(task.status, labels, context.currentStatus),
		[p.priority]: labels.priority[task.priority] ?? task.priority,
	};

	// Written only when the task actually reports a section, or when the note
	// already had one to keep. Writing an empty value on every task with no
	// section is how a sub-project set by hand would be wiped by the next sync.
	const subproject = context.subprojectLink
		? formatWikilink(context.subprojectLink)
		: (task.columnName ?? context.currentSubproject);
	if (subproject) frontmatter[p.subproject] = subproject;

	// Written only when the filename cannot carry the title, so an ordinary task
	// gains nothing and a punctuated one is still readable. The sync does not
	// depend on it — the real title lives in the plugin's state — but a person
	// reading the note otherwise has no way to see what the task is called.
	// Written when the filename cannot carry the title — either because the title
	// contains characters a filename may not hold, or because the file ended up
	// named something else entirely, which is what a collision suffix does. Left
	// out of an ordinary note, where it would only repeat the filename.
	//
	// The second case matters as much as the first: a note that landed at
	// "Water the plants 2.md" reads its title back from the filename, so without
	// this the next push renames the task to "Water the plants 2".
	const filenameCannotHold =
		titleNeedsFrontmatter(task.title) ||
		(context.filenameTitle !== undefined && context.filenameTitle !== task.title);
	if (filenameCannotHold) {
		frontmatter[p.title] = task.title;

		// And, if asked for, as an alias — the only way to reach a note whose
		// filename is not its name, since the quick switcher and [[links]] both go
		// through the filename. Added, never removed: the list is the user's, and a
		// stale entry costs nothing next to deleting one they wrote.
		//
		// When the option is off nothing is written here at all, rather than the
		// existing list being written back unchanged. `aliases` is not one of the
		// plugin's properties, so leaving it out is what preserves it.
		if (options.aliasTitles) {
			const existing = context.currentAliases ?? [];
			frontmatter["aliases"] = existing.includes(task.title)
				? existing
				: [...existing, task.title];
		}
	}

	const marker = options.marker;
	if (marker?.property.trim()) frontmatter[marker.property.trim()] = marker.value;

	const displayZone = options.useTaskTimeZone ? task.timeZone : undefined;
	const due = toFrontmatterDate(task.dueDate, task.isAllDay, displayZone);
	if (due) frontmatter[p.due] = due;

	const start = toFrontmatterDate(task.startDate, task.isAllDay, displayZone);
	if (start) frontmatter[p.start] = start;

	// Written bare, without '#', which is what Obsidian's tags property expects.
	if (task.tags.length > 0) frontmatter[p.tags] = task.tags.map(normaliseTag);

	if (task.repeatFlag) frontmatter[p.recurrence] = task.repeatFlag;
	// A raw TRIGGER duration means nothing in a Properties panel, so named ones
	// are written by name. Anything unnamed stays raw rather than being lost.
	if (task.reminders.length > 0) {
		frontmatter[p.reminders] = task.reminders.map((trigger) => nameReminder(trigger, labels));
	}
	// Written as a wikilink so the relationship is navigable and shows in the
	// graph. Falls back to the raw id only when the parent's note is unknown —
	// it may not have synced yet, and the next pass will upgrade it.
	if (context.parent) frontmatter[p.parent] = formatWikilink(context.parent);
	else if (task.parentId) frontmatter[p.parent] = task.parentId;

	// Derived from whichever tasks point at this one, so it is rewritten every
	// sync. Re-parenting is done on the child's own parent property.
	if (context.children && context.children.length > 0) {
		frontmatter[p.children] = context.children.map(formatWikilink);
	}
	if (task.completedTime) frontmatter[p.completed] = task.completedTime;

	return {
		frontmatter,
		body: buildBody(task.content, task.items, {
			marker: options.syncedRegionMarker,
			privateBody: context.privateBody,
			completions: context.completions,
		}),
	};
}

function readTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === "string")
			.map(normaliseTag)
			.filter((tag) => tag.length > 0);
	}
	// Obsidian also accepts an inline string: `tags: work, urgent` or `tags: #a #b`.
	if (typeof value === "string") return parseTagList(value);
	return [];
}

/**
 * Turns reminder names back into the iCal TRIGGER durations TickTick expects.
 *
 * A value that matches no name is kept verbatim, so a TRIGGER written by hand
 * still works and an unrecognised one is never silently dropped.
 */
/** The configured name for a trigger, matched on its duration rather than its text. */
function nameReminder(trigger: string, labels: ValueLabels): string {
	const exact = labels.reminders[trigger];
	if (exact) return exact;

	const minutes = triggerToMinutes(trigger);
	if (minutes === undefined) return trigger;

	for (const [known, label] of Object.entries(labels.reminders)) {
		if (triggerToMinutes(known) === minutes) return label;
	}

	return trigger;
}

function readReminders(value: unknown, labels?: ValueLabels): string[] {
	const written = readStringArray(value);
	if (!labels) return written;

	return written.map((entry) => {
		const wanted = entry.trim().toLowerCase();
		for (const [trigger, label] of Object.entries(labels.reminders)) {
			if (label.trim().toLowerCase() === wanted) return trigger;
		}
		return entry;
	});
}

/**
 * Reads the parent property, which holds a wikilink to the parent's note.
 *
 * An empty property means the parent was deliberately removed. A link that
 * resolves to nothing is treated as *unknown* rather than empty, because the
 * parent's note may simply not exist yet — clearing the parent on that basis
 * would silently restructure the task in TickTick.
 */
function readParent(
	raw: unknown,
	options: MapperOptions,
): { parentId?: string; parentUnresolved?: boolean } {
	const written = readString(raw);
	if (!written) return {};

	const target = parseWikilink(written);
	if (target === undefined) {
		// Not a link, so it is still a plain task id from an older note.
		return { parentId: written };
	}

	const resolved = options.resolveTaskLink?.(target);
	return resolved ? { parentId: resolved } : { parentUnresolved: true };
}

function readStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	}
	if (typeof value === "string" && value.trim()) {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return [];
}

/**
 * Unwraps a property Obsidian stores as a list.
 *
 * `status` and `priority` are registered as list-typed so they render as chips
 * with suggestions, which means their value arrives as `["todo"]` rather than
 * `"todo"`. Hand-written notes still use the bare form, so both are accepted.
 */
function readScalar(value: unknown): unknown {
	return Array.isArray(value) ? value[0] : value;
}

function readStatus(raw: unknown, completedAt: unknown, labels?: ValueLabels): TaskStatus {
	const value = readScalar(raw);

	// Your own vocabulary wins, so a vault that calls it "Done" round-trips.
	// The built-in spellings below stay as a fallback for hand-written notes.
	if (typeof value === "string" && labels) {
		const matched = matchStatusLabel(value, labels);
		if (matched) return matched;
	}

	if (typeof value === "string") {
		const normalised = value.trim().toLowerCase();
		if (normalised === "completed" || normalised === "done" || normalised === "x") {
			return "completed";
		}
		if (normalised === "abandoned" || normalised === "cancelled" || normalised === "canceled") {
			return "abandoned";
		}
		if (normalised === "todo" || normalised === "open") return "todo";
	}
	if (typeof value === "boolean") return value ? "completed" : "todo";
	// A completion timestamp implies completion even if `status` was not updated.
	return completedAt ? "completed" : "todo";
}

function readPriority(raw: unknown, labels?: ValueLabels): Priority {
	const value = readScalar(raw);

	if (typeof value === "string" && labels) {
		const matched = matchLabel(value, labels.priority);
		if (matched) return matched;
	}

	if (typeof value === "string") {
		const normalised = value.trim().toLowerCase();
		if (normalised === "high" || normalised === "medium" || normalised === "low") {
			return normalised;
		}
		if (normalised === "none" || normalised === "") return "none";
	}
	// Tolerate the raw TickTick integers, which power users tend to type.
	if (value === 5) return "high";
	if (value === 3) return "medium";
	if (value === 1) return "low";
	return "none";
}

function readString(raw: unknown): string | undefined {
	const value = readScalar(raw);
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (typeof value === "number") return String(value);
	return undefined;
}

/**
 * Reconstructs a task from a note.
 *
 * `filenameTitle` is the file's basename, which is the authoritative title
 * unless the title property carries an explicit override — used when the real
 * title contains characters a filename cannot hold.
 */
export function noteToTask(
	note: NoteContent,
	filenameTitle: string,
	options: MapperOptions = DEFAULT_MAPPER_OPTIONS,
): ParsedNote {
	const p = options.properties;
	const labels = options.labels ?? DEFAULT_VALUE_LABELS;
	const fm = note.frontmatter ?? {};
	const { content, items, privateBody, completions } = splitBody(
		note.body,
		options.syncedRegionMarker,
	);

	const dueRaw = fm[p.due];
	const startRaw = fm[p.start];
	const dueDate = fromFrontmatterDate(dueRaw);
	const startDate = fromFrontmatterDate(startRaw);

	// All-day is read from the shape of the date. A bare date is unambiguous;
	// exactly midnight counts too, because a datetime-typed property makes
	// Obsidian rewrite `2026-08-20` as `2026-08-20T00:00`. The engine overrides
	// this from the last-agreed state when the date has not actually changed.
	const isAllDay =
		(dueDate !== undefined && looksLikeWholeDay(dueRaw, dueDate)) ||
		(dueDate === undefined && startDate !== undefined && looksLikeWholeDay(startRaw, startDate));

	const propertyTags = readTags(fm[p.tags]);
	// Inline tags are unioned in, so `#work🔥` typed in the body reaches TickTick
	// intact rather than being truncated at the emoji.
	const bodyTags = options.inlineTags ? extractTags(note.body) : [];
	const tags = dedupeTags([...propertyTags, ...bodyTags]);

	// The list property holds a name, or a link to the list's note. Either is
	// resolved back to an id. A plain value that resolves to nothing is passed
	// through — it may already be an id — but an unresolved *link* is not, since
	// a note title is never a list id and guessing would move the task.
	const projectRef = readString(readProperty(fm, p, "project"));
	const projectTarget = projectRef ? parseWikilink(projectRef) : undefined;
	const projectId = projectRef
		? projectTarget !== undefined
			? options.resolveProject?.(projectTarget)
			: (options.resolveProject?.(projectRef) ?? projectRef)
		: undefined;

	// Resolved back to a section id the same way the list is: a link is followed,
	// a plain name is looked up, and anything that resolves to nothing is left
	// undefined rather than guessed at — an unresolved name is not an id, and
	// sending a wrong one files the task under the wrong sub-project.
	const subprojectRef = readString(readProperty(fm, p, "subproject"));
	const subprojectTarget = subprojectRef ? parseWikilink(subprojectRef) : undefined;
	const columnId = subprojectRef
		? options.resolveSection?.(subprojectTarget ?? subprojectRef)
		: undefined;

	const statusRaw = readScalar(fm[p.status]);
	const statusNeutral = typeof statusRaw === "string" && isNeutralStatus(statusRaw, labels);

	return {
		id: readString(readProperty(fm, p, "id")),
		projectId,
		columnId,
		statusNeutral,
		privateBody,
		completions,
		// The filename is the authoritative title *unless* the title property spells
		// out one the filename cannot hold. `resolveTitle` settles which: the
		// override wins while the filename is still exactly what it sanitises to,
		// and a filename that differs is a genuine rename, so it wins instead.
		//
		// This was documented above as the behaviour and never actually done — the
		// filename was returned unconditionally, so a title with a colon or a slash
		// was flattened on every push and there was no way to say otherwise.
		title: resolveTitle(filenameTitle, readString(readProperty(fm, p, "title"))),
		content,
		status: readStatus(fm[p.status], fm[p.completed], labels),
		priority: readPriority(fm[p.priority], labels),
		tags,
		dueDate,
		startDate,
		isAllDay,
		reminders: readReminders(fm[p.reminders], labels),
		repeatFlag: readString(fm[p.recurrence]),
		...readParent(fm[p.parent], options),
		items,
	};
}

function dedupeTags(tags: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const tag of tags) {
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(tag);
	}
	return result;
}

function itemKey(title: string): string {
	return title.trim().toLowerCase();
}

/**
 * Restores everything a note cannot hold about a checklist item.
 *
 * A note renders subtasks as plain `- [ ] title` lines, so a checklist read
 * back out of one carries only a title and a tick. Pushing that shape makes
 * TickTick treat every item as new — deleting and recreating the subtasks —
 * and blanks each item's dates and completion time. Matching on title first and
 * falling back to position keeps identity across both reordering and renaming.
 *
 * None of this is written into the note: it is server bookkeeping, and
 * `fieldsEqual` in reconcile.ts compares items on title and completion alone,
 * so carrying it changes no merge decision. `sortOrder` is deliberately *not*
 * restored — the order of the lines in the note is the user's intent.
 */
export function restoreItemMetadata(
	items: ChecklistItem[],
	reference: ChecklistItem[],
): ChecklistItem[] {
	const taken: boolean[] = new Array(reference.length).fill(false);
	const resolved: (ChecklistItem | undefined)[] = new Array(items.length).fill(undefined);

	const byTitle = new Map<string, number[]>();
	reference.forEach((item, index) => {
		if (!item.id) return;
		const bucket = byTitle.get(itemKey(item.title));
		if (bucket) bucket.push(index);
		else byTitle.set(itemKey(item.title), [index]);
	});

	// Pass 1: identical titles, in order, so duplicate titles keep their own ids.
	items.forEach((item, i) => {
		if (item.id) {
			resolved[i] = item;
			return;
		}
		const match = byTitle.get(itemKey(item.title))?.find((index) => !taken[index]);
		if (match === undefined) return;
		taken[match] = true;
		resolved[i] = reference[match];
	});

	// Pass 2: positional fallback, which carries a renamed item's metadata through.
	items.forEach((_item, i) => {
		if (resolved[i] !== undefined) return;
		const candidate = reference[i];
		if (!candidate?.id || taken[i]) return;
		taken[i] = true;
		resolved[i] = candidate;
	});

	return items.map((item, i) => {
		const source = resolved[i];
		if (source === undefined) return item;

		// Title and completion come from the note, which is what the user edited.
		// Everything else is server state the note could not have expressed.
		return {
			...item,
			id: source.id,
			startDate: source.startDate,
			isAllDay: source.isAllDay,
			timeZone: source.timeZone,
			completedTime: source.completedTime,
		};
	});
}

/** Lifts a parsed note into a full task, using `base` for fields notes omit. */
export function parsedNoteToTask(parsed: ParsedNote, base: Task): Task {
	return {
		...base,
		title: parsed.title,
		content: parsed.content,
		priority: parsed.priority,
		tags: parsed.tags,
		dueDate: parsed.dueDate,
		startDate: parsed.startDate,
		isAllDay: parsed.isAllDay,
		reminders: parsed.reminders,
		repeatFlag: parsed.repeatFlag,
		// An unresolvable link leaves the existing parent alone rather than
		// dropping it — see readParent.
		parentId: parsed.parentUnresolved ? base.parentId : parsed.parentId,
		// A filing value such as "Archived" says nothing about progress, so
		// whatever TickTick already believes is kept.
		status: parsed.statusNeutral ? base.status : parsed.status,
		items: parsed.items,
		projectId: parsed.projectId ?? base.projectId,
		// Falls back to the section the task already had. The property being
		// unreadable — a link to a note that no longer exists, a name that matches
		// no section — must not read as "move this out of its sub-project".
		columnId: parsed.columnId ?? base.columnId,
	};
}
