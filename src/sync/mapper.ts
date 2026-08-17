import { fromFrontmatterDate, looksAllDay, toFrontmatterDate } from "../util/dates";
import { extractTags, normaliseTag, parseTagList } from "../util/tags";
import { DEFAULT_PROPERTIES, type PropertyNames } from "../settings";
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

/** Characters Obsidian or the filesystem will not accept in a note name. */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

const MAX_FILENAME_LENGTH = 120;

export interface MapperOptions {
	properties: PropertyNames;
	/** Also harvest `#tags` written in the note body. */
	inlineTags: boolean;
}

export const DEFAULT_MAPPER_OPTIONS: MapperOptions = {
	properties: DEFAULT_PROPERTIES,
	inlineTags: true,
};

export interface NoteContent {
	frontmatter: Record<string, unknown>;
	body: string;
}

export interface ParsedNote {
	/** Undefined for a note the user wrote by hand that has never synced. */
	id?: string;
	projectId?: string;
	etag?: string;
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
): NoteContent {
	const p = options.properties;
	const frontmatter: Record<string, unknown> = {
		[p.id]: task.id,
		[p.project]: task.projectId,
		[p.status]: task.status,
		[p.priority]: task.priority,
	};

	if (task.etag) frontmatter[p.etag] = task.etag;
	if (titleNeedsFrontmatter(task.title)) frontmatter[p.title] = task.title;

	const due = toFrontmatterDate(task.dueDate, task.isAllDay);
	if (due) frontmatter[p.due] = due;

	const start = toFrontmatterDate(task.startDate, task.isAllDay);
	if (start) frontmatter[p.start] = start;

	// Written bare, without '#', which is what Obsidian's tags property expects.
	if (task.tags.length > 0) frontmatter[p.tags] = task.tags.map(normaliseTag);

	if (task.repeatFlag) frontmatter[p.recurrence] = task.repeatFlag;
	if (task.reminders.length > 0) frontmatter[p.reminders] = [...task.reminders];
	if (task.parentId) frontmatter[p.parent] = task.parentId;
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

function readStatus(value: unknown, completedAt: unknown): TaskStatus {
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

function readPriority(value: unknown): Priority {
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

function readString(value: unknown): string | undefined {
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
	const fm = note.frontmatter ?? {};
	const { content, items } = splitBody(note.body);

	const dueRaw = fm[p.due];
	const startRaw = fm[p.start];
	const dueDate = fromFrontmatterDate(dueRaw);
	const startDate = fromFrontmatterDate(startRaw);

	// A date written without a time means an all-day task.
	const isAllDay =
		(dueDate !== undefined && looksAllDay(dueRaw)) ||
		(dueDate === undefined && startDate !== undefined && looksAllDay(startRaw));

	const propertyTags = readTags(fm[p.tags]);
	// Inline tags are unioned in, so `#work🔥` typed in the body reaches TickTick
	// intact rather than being truncated at the emoji.
	const bodyTags = options.inlineTags ? extractTags(note.body) : [];
	const tags = dedupeTags([...propertyTags, ...bodyTags]);

	return {
		id: readString(fm[p.id]),
		projectId: readString(fm[p.project]),
		etag: readString(fm[p.etag]),
		title: readString(fm[p.title]) ?? filenameTitle,
		content,
		status: readStatus(fm[p.status], fm[p.completed]),
		priority: readPriority(fm[p.priority]),
		tags,
		dueDate,
		startDate,
		isAllDay,
		reminders: readStringArray(fm[p.reminders]),
		repeatFlag: readString(fm[p.recurrence]),
		parentId: readString(fm[p.parent]),
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
 * Re-attaches remote checklist item ids to items parsed out of a note.
 *
 * A note renders subtasks as plain `- [ ] title` lines, so a checklist read
 * back out of one carries no ids. Pushing that shape makes TickTick treat every
 * item as new, which deletes and recreates the subtasks and loses their
 * per-item completion times. Matching on title first and falling back to
 * position keeps identity across both reordering and renaming.
 *
 * Item ids are deliberately absent from the note itself: they are server
 * bookkeeping, and `fieldsEqual` in reconcile.ts already compares items on
 * title and completion alone, so carrying them here changes no merge decision.
 */
export function reattachItemIds(
	items: ChecklistItem[],
	reference: ChecklistItem[],
): ChecklistItem[] {
	const taken: boolean[] = new Array(reference.length).fill(false);
	const resolved: (string | undefined)[] = new Array(items.length).fill(undefined);

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
			resolved[i] = item.id;
			return;
		}
		const match = byTitle.get(itemKey(item.title))?.find((index) => !taken[index]);
		if (match === undefined) return;
		taken[match] = true;
		resolved[i] = reference[match].id;
	});

	// Pass 2: positional fallback, which carries a renamed item's id through.
	items.forEach((_item, i) => {
		if (resolved[i] !== undefined) return;
		const candidate = reference[i];
		if (!candidate?.id || taken[i]) return;
		taken[i] = true;
		resolved[i] = candidate.id;
	});

	return items.map((item, i) => {
		const id = resolved[i];
		return id === undefined ? item : { ...item, id };
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
		parentId: parsed.parentId,
		items: parsed.items,
		projectId: parsed.projectId ?? base.projectId,
	};
}
