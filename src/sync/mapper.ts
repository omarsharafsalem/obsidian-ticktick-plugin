import { fromFrontmatterDate, looksAllDay, toFrontmatterDate } from "../util/dates";
import { extractTags, normaliseTag, parseTagList } from "../util/tags";
import { DEFAULT_PROPERTIES, DEFAULT_VALUE_LABELS, type PropertyNames, type ValueLabels } from "../settings";
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
	parent?: TaskLink;
	/** Derived from whichever tasks point at this one; never read back. */
	children?: TaskLink[];
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
	resolveProject?: (nameOrId: string) => string | undefined;
	/** The words this vault uses for statuses, priorities and reminders. */
	labels?: ValueLabels;
	/** Turns a wikilink target — a note title or path — back into a task id. */
	resolveTaskLink?: (target: string) => string | undefined;
	/**
	 * Stamped onto notes this plugin creates, so they are recognised by the same
	 * rule as notes written by hand rather than only by where they sit.
	 */
	marker?: { property: string; value: string };
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

export interface NoteContent {
	frontmatter: Record<string, unknown>;
	body: string;
}

export interface ParsedNote {
	/** Undefined for a note the user wrote by hand that has never synced. */
	id?: string;
	projectId?: string;
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

/** True when the filename alone cannot round-trip the title. */
export function titleNeedsFrontmatter(title: string): boolean {
	return sanitiseFilename(title) !== title;
}

function renderChecklist(items: ChecklistItem[]): string {
	return items.map((item) => `- [${item.completed ? "x" : " "}] ${item.title}`).join("\n");
}

/**
 * Splits a note body into description and checklist.
 *
 * The `## Subtasks` heading is the boundary: text before it is the task
 * description, checkbox lines after it become checklist items. Non-checkbox
 * lines inside that section are dropped on the next write, which is why the
 * heading is documented as plugin-owned.
 */
export function splitBody(body: string): { content: string; items: ChecklistItem[] } {
	const lines = body.split("\n");
	const headingIndex = lines.findIndex(
		(line) => line.trim().toLowerCase() === SUBTASK_HEADING.toLowerCase(),
	);

	if (headingIndex === -1) {
		return { content: body.trim(), items: [] };
	}

	const content = lines.slice(0, headingIndex).join("\n").trim();
	const items: ChecklistItem[] = [];

	for (const line of lines.slice(headingIndex + 1)) {
		const match = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
		if (!match) continue;
		const title = match[2].trim();
		if (!title) continue;
		items.push({ title, completed: match[1].toLowerCase() === "x" });
	}

	return { content, items };
}

export function buildBody(content: string, items: ChecklistItem[]): string {
	const trimmed = content.trim();
	if (items.length === 0) {
		return trimmed.length > 0 ? `${trimmed}\n` : "";
	}

	const checklist = `${SUBTASK_HEADING}\n\n${renderChecklist(items)}\n`;
	return trimmed.length > 0 ? `${trimmed}\n\n${checklist}` : checklist;
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
		// The list's name, not its id: the property is meant to be read and
		// edited. Falls back to the id only when the name is unknown.
		[p.project]: projectName ?? task.projectId,
		[p.status]: labels.status[task.status] ?? task.status,
		[p.priority]: labels.priority[task.priority] ?? task.priority,
	};

	// The etag is a server version token and deliberately never reaches the
	// note — it is bookkeeping, kept in the plugin's own state instead.
	if (titleNeedsFrontmatter(task.title)) frontmatter[p.title] = task.title;

	const marker = options.marker;
	if (marker?.property.trim()) frontmatter[marker.property.trim()] = marker.value;

	const due = toFrontmatterDate(task.dueDate, task.isAllDay);
	if (due) frontmatter[p.due] = due;

	// Recorded explicitly rather than left to be inferred from the date's shape:
	// with `due` registered as a datetime, Obsidian rewrites a bare date to
	// include a time, and the task would look scheduled when it is not.
	if (task.isAllDay) frontmatter[p.allDay] = true;

	const start = toFrontmatterDate(task.startDate, task.isAllDay);
	if (start) frontmatter[p.start] = start;

	// Written bare, without '#', which is what Obsidian's tags property expects.
	if (task.tags.length > 0) frontmatter[p.tags] = task.tags.map(normaliseTag);

	if (task.repeatFlag) frontmatter[p.recurrence] = task.repeatFlag;
	// A raw TRIGGER duration means nothing in a Properties panel, so named ones
	// are written by name. Anything unnamed stays raw rather than being lost.
	if (task.reminders.length > 0) {
		frontmatter[p.reminders] = task.reminders.map(
			(trigger) => labels.reminders[trigger] ?? trigger,
		);
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

	return { frontmatter, body: buildBody(task.content, task.items) };
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
		const matched = matchLabel(value, labels.status);
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
	const { content, items } = splitBody(note.body);

	const dueRaw = fm[p.due];
	const startRaw = fm[p.start];
	const dueDate = fromFrontmatterDate(dueRaw);
	const startDate = fromFrontmatterDate(startRaw);

	// A date written without a time means an all-day task.
	// The explicit flag wins. Falling back to the date's shape keeps notes
	// written before the property existed, and hand-written ones, working.
	const allDayFlag = readScalar(fm[p.allDay]);
	const isAllDay =
		typeof allDayFlag === "boolean"
			? allDayFlag
			: (dueDate !== undefined && looksAllDay(dueRaw)) ||
				(dueDate === undefined && startDate !== undefined && looksAllDay(startRaw));

	const propertyTags = readTags(fm[p.tags]);
	// Inline tags are unioned in, so `#work🔥` typed in the body reaches TickTick
	// intact rather than being truncated at the emoji.
	const bodyTags = options.inlineTags ? extractTags(note.body) : [];
	const tags = dedupeTags([...propertyTags, ...bodyTags]);

	// The list property holds a name, so it has to be turned back into an id.
	// An unrecognised value is passed through untouched: it may already be an id,
	// and guessing would silently move the task to the wrong list.
	const projectRef = readString(fm[p.project]);
	const projectId = projectRef ? (options.resolveProject?.(projectRef) ?? projectRef) : undefined;

	return {
		id: readString(fm[p.id]),
		projectId,
		title: readString(fm[p.title]) ?? filenameTitle,
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
		status: parsed.status,
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
		items: parsed.items,
		projectId: parsed.projectId ?? base.projectId,
	};
}
