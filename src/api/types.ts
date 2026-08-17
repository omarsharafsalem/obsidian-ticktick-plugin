/**
 * The canonical task shape used everywhere inside this plugin.
 *
 * Neither the official Open API nor the unofficial v2 API is used directly by
 * the sync engine — both are normalised into this model first, so that the
 * reconciliation logic never has to care which backend produced a record.
 */

export type Priority = "none" | "low" | "medium" | "high";

export type TaskStatus = "todo" | "completed" | "abandoned";

export interface ChecklistItem {
	/** Present for items that already exist remotely. */
	id?: string;
	title: string;
	completed: boolean;
}

export interface Task {
	id: string;
	projectId: string;
	title: string;
	/** Free-form description body. */
	content: string;
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
	/** ISO 8601. Only the v2 API reports this; Open API leaves it undefined. */
	modifiedTime?: string;
	completedTime?: string;
	sortOrder?: number;
}

/** A task that does not exist remotely yet. */
export type NewTask = Omit<Task, "id" | "etag" | "modifiedTime">;

export interface Project {
	id: string;
	name: string;
	color?: string;
	closed: boolean;
	groupId?: string;
	kind?: string;
}

/** The subset of {@link Task} that participates in field-level merging. */
export const SYNCED_FIELDS = [
	"title",
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
