/**
 * The canonical task shape used everywhere inside this plugin.
 *
 * The Open API is not used directly by the sync engine — responses are
 * normalised into this model first, so the reconciliation logic never has to
 * care about wire format.
 */

export type Priority = "none" | "low" | "medium" | "high";

export type TaskStatus = "todo" | "completed" | "abandoned";

/**
 * TickTick's task kind, which decides where the body text lives on the wire: a
 * checklist task keeps it in `desc`, everything else in `content`.
 */
export type TaskKind = "TEXT" | "CHECKLIST" | "NOTE";

/**
 * What a list holds. TickTick offers two kinds when a list is created, and a
 * notes list is not a to-do list — which is worth knowing, because a vault
 * usually already has somewhere its notes go and somewhere its tasks go. The
 * kind is what tells the two apart without anyone maintaining a rule by hand.
 */
export type ProjectKind = "TASK" | "NOTE";

export interface ChecklistItem {
	/** Present for items that already exist remotely. */
	id?: string;
	title: string;
	completed: boolean;

	// A note renders an item as a plain `- [ ] title` line, so everything below
	// is invisible to it. These are restored from the remote task on the way out
	// rather than being written into the note — see `restoreItemMetadata`.
	// Without that, pushing a note would blank every subtask's dates.
	/** ISO 8601 UTC. */
	startDate?: string;
	isAllDay?: boolean;
	timeZone?: string;
	/** ISO 8601 UTC. */
	completedTime?: string;
}

export interface Task {
	id: string;
	projectId: string;
	title: string;
	/**
	 * Free-form description body, read from whichever wire field this task kind
	 * uses. {@link kind} records which, so a push writes it back to the same one.
	 */
	content: string;
	kind?: TaskKind;
	/**
	 * The body field this task kind does *not* use, kept verbatim.
	 *
	 * TickTick returns both `content` and `desc`; writing only one back erases
	 * the other. Deliberately outside {@link SYNCED_FIELDS} — it is carried
	 * through untouched rather than merged.
	 */
	inactiveBody?: string;
	/**
	 * A link back to this task's note, appended to the description on the way
	 * out and stripped on the way in.
	 *
	 * Outside {@link SYNCED_FIELDS} on purpose: the note never contains it, so
	 * comparing it would report a difference on every single sync and rewrite
	 * both sides forever.
	 */
	noteUrl?: string;
	status: TaskStatus;
	priority: Priority;
	tags: string[];
	/** ISO 8601 UTC, or undefined when unset. */
	dueDate?: string;
	startDate?: string;
	isAllDay: boolean;
	timeZone?: string;
	/** iCal TRIGGER strings, e.g. "TRIGGER:-PT60M". */
	reminders: string[];
	/** Recurrence rule, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO". */
	repeatFlag?: string;
	parentId?: string;
	items: ChecklistItem[];
	/** Server-side optimistic-locking token, when the backend supplies one. */
	etag?: string;
	/** ISO 8601. The Open API does report this, contrary to its own docs. */
	modifiedTime?: string;
	completedTime?: string;
	sortOrder?: number;

	/** Section this task sits in, when it is in one. */
	columnId?: string;
	/**
	 * The section's name, as returned alongside the task.
	 *
	 * Carried because it is what a person reads and what a note shows; the id is
	 * only useful for writing back.
	 */
	columnName?: string;
}

/** A task that does not exist remotely yet. */
export type NewTask = Omit<Task, "id" | "etag" | "modifiedTime">;

/**
 * A section within a list — TickTick's own name for it is a column.
 *
 * Shown as a section header in list view and as a column on a board; the same
 * object either way. It is the only container TickTick has *below* a list, which
 * is what makes it the one place a sub-project can live.
 */
export interface Section {
	id: string;
	projectId: string;
	name: string;
}

/** A list's contents as one read: `/project/{id}/data` returns both. */
export interface ProjectContents {
	tasks: Task[];
	sections: Section[];
}

export interface Project {
	id: string;
	name: string;
	color?: string;
	/**
	 * Archived in TickTick.
	 *
	 * An archived list stops returning its tasks, which is indistinguishable from
	 * every one of them having been deleted — so this has to be read, and read
	 * before anything concludes anything from a task's absence.
	 */
	closed: boolean;
	groupId?: string;
	kind?: ProjectKind;
}

/** The subset of {@link Task} that participates in field-level merging. */
export const SYNCED_FIELDS = [
	"title",
	"columnId",
	"content",
	"status",
	"priority",
	"tags",
	"dueDate",
	"startDate",
	"isAllDay",
	"reminders",
	"repeatFlag",
	"items",
	"projectId",
	"parentId",
] as const;

export type SyncedField = (typeof SYNCED_FIELDS)[number];

/** An empty task, used as the base when building one from partial data. */
export function blankTask(projectId: string): Task {
	return {
		id: "",
		projectId,
		title: "",
		content: "",
		status: "todo",
		priority: "none",
		tags: [],
		isAllDay: false,
		reminders: [],
		items: [],
	};
}

// --- Wire-format conversions -------------------------------------------------

const PRIORITY_TO_WIRE: Record<Priority, number> = {
	none: 0,
	low: 1,
	medium: 3,
	high: 5,
};

export function priorityFromWire(value: unknown): Priority {
	switch (value) {
		case 5:
			return "high";
		case 3:
			return "medium";
		case 1:
			return "low";
		default:
			return "none";
	}
}

export function priorityToWire(priority: Priority): number {
	return PRIORITY_TO_WIRE[priority] ?? 0;
}

export function statusFromWire(value: unknown): TaskStatus {
	if (value === 2) return "completed";
	if (value === -1) return "abandoned";
	return "todo";
}

export function statusToWire(status: TaskStatus): number {
	if (status === "completed") return 2;
	if (status === "abandoned") return -1;
	return 0;
}
