import { dateInZone, fromTickTickDate, toTickTickDate, zonedMidnight } from "../util/dates";
import { ApiError, HttpQueue } from "./http";
import type { Capabilities, TickTickClient } from "./client";
import {
	type ChecklistItem,
	type NewTask,
	type Project,
	type ProjectKind,
	type Task,
	type TaskKind,
	priorityFromWire,
	priorityToWire,
	statusFromWire,
	statusToWire,
} from "./types";

export const OPEN_API_BASE = "https://api.ticktick.com/open/v1";

/**
 * The Open API is much less limited than it is often described.
 *
 * It lists completed tasks (`POST /task/completed`), reaches the Inbox through
 * `POST /task/filter` with the reserved id below, and — measured against the
 * live API on 18 Aug 2026 — returns a real `modifiedTime` on every task from
 * `GET /project/{id}/data`, e.g. `2026-08-17T19:01:17.084+0000`.
 *
 * That last point is worth stating plainly because the opposite is widely
 * repeated, and believing it costs the plugin "most recently edited wins":
 * with no modification time the reconciler cannot date a remote edit at all
 * and hands the server every conflict.
 */
const OPEN_API_CAPABILITIES: Capabilities = {
	completedHistory: true,
	modifiedTime: true,
	inbox: true,
	// No cap has been established for `GET /project/{id}/data`. Left unset
	// deliberately: a guessed one would either disable deletion detection for a
	// legitimately sized list or fail to fire when it mattered.
};

/** TickTick's reserved project id for the Inbox, accepted by the filter endpoint. */
export const INBOX_PROJECT_ID = "inbox";

type Json = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normaliseChecklistItem(raw: unknown): ChecklistItem {
	const item = (raw ?? {}) as Json;
	return {
		id: asString(item["id"]),
		title: asString(item["title"]) ?? "",
		completed: item["status"] === 1 || item["status"] === 2,
		startDate: fromTickTickDate(item["startDate"]),
		isAllDay: item["isAllDay"] === true ? true : undefined,
		timeZone: asString(item["timeZone"]),
		completedTime: fromTickTickDate(item["completedTime"]),
	};
}

/**
 * All-day dates are pinned to UTC midnight of the calendar date they fall on in
 * the task's *own* timezone. That way everything above this boundary can treat
 * an all-day date as a plain date, and only this file needs to know about zones.
 */
function normaliseTaskDate(raw: unknown, isAllDay: boolean, timeZone?: string): string | undefined {
	const iso = fromTickTickDate(raw);
	if (!iso || !isAllDay) return iso;

	const date = dateInZone(iso, timeZone);
	return date ? `${date}T00:00:00.000Z` : iso;
}

/** Sends an all-day date as the moment that day begins where the task lives. */
function serialiseTaskDate(
	iso: string | undefined,
	isAllDay: boolean,
	timeZone?: string,
): string | undefined {
	if (!iso) return undefined;
	if (!isAllDay) return toTickTickDate(iso);
	return toTickTickDate(zonedMidnight(iso.slice(0, 10), timeZone) ?? iso);
}

/**
 * Removes the plugin's own backlink from a description.
 *
 * The link is added on the way out and taken off on the way in, so the value
 * compared against the note is always the text the user actually wrote.
 */
export function stripNoteLink(content: string): string {
	return content
		.split("\n")
		.filter((line) => !/\[[^\]]*\]\(obsidian:\/\/[^)]*\)/.test(line))
		.join("\n")
		.trimEnd();
}

function asKind(value: unknown): TaskKind | undefined {
	return value === "TEXT" || value === "CHECKLIST" || value === "NOTE" ? value : undefined;
}

function asProjectKind(value: unknown): ProjectKind | undefined {
	return value === "TASK" || value === "NOTE" ? value : undefined;
}

export function normaliseTask(raw: unknown): Task {
	const task = (raw ?? {}) as Json;
	const isAllDay = task["isAllDay"] === true;

	// A checklist task keeps its description in `desc` and its subtasks in
	// `items`; every other kind uses `content`. Both fields are always returned,
	// so the unused one is carried through rather than dropped.
	const kind = asKind(task["kind"]);
	const rawContent = asString(task["content"]) ?? "";
	const rawDesc = asString(task["desc"]) ?? "";
	const descIsBody = kind === "CHECKLIST";

	return {
		id: asString(task["id"]) ?? "",
		projectId: asString(task["projectId"]) ?? "",
		title: asString(task["title"]) ?? "",
		kind,
		content: stripNoteLink(descIsBody ? rawDesc : rawContent),
		inactiveBody: descIsBody ? rawContent : rawDesc,
		status: statusFromWire(task["status"]),
		priority: priorityFromWire(task["priority"]),
		tags: asArray(task["tags"]).filter((t): t is string => typeof t === "string"),
		dueDate: normaliseTaskDate(task["dueDate"], isAllDay, asString(task["timeZone"])),
		startDate: normaliseTaskDate(task["startDate"], isAllDay, asString(task["timeZone"])),
		isAllDay,
		timeZone: asString(task["timeZone"]),
		reminders: asArray(task["reminders"]).filter((r): r is string => typeof r === "string"),
		repeatFlag: asString(task["repeatFlag"]),
		parentId: asString(task["parentId"]),
		items: asArray(task["items"]).map(normaliseChecklistItem),
		etag: asString(task["etag"]),
		modifiedTime: fromTickTickDate(task["modifiedTime"]),
		completedTime: fromTickTickDate(task["completedTime"]),
		sortOrder: typeof task["sortOrder"] === "number" ? task["sortOrder"] : undefined,
	};
}

export function normaliseProject(raw: unknown): Project {
	const project = (raw ?? {}) as Json;
	return {
		id: asString(project["id"]) ?? "",
		name: asString(project["name"]) ?? "Untitled",
		color: asString(project["color"]),
		closed: project["closed"] === true,
		groupId: asString(project["groupId"]),
		kind: asProjectKind(project["kind"]),
	};
}

/** Builds the request body for create/update. Undefined fields are omitted. */
export function serialiseTask(task: NewTask & { id?: string }): Json {
	const body: Json = {
		title: task.title,
		projectId: task.projectId,
		priority: priorityToWire(task.priority),
		status: statusToWire(task.status),
		isAllDay: task.isAllDay,
	};

	// Write the body back to the field this kind actually uses, and restore the
	// other one untouched. Sending only `content` erases a checklist's `desc`.
	// The backlink is appended here rather than stored, so it never reaches the
	// note and never shows up as a difference between the two sides.
	const described = task.noteUrl
		? `${task.content ? `${task.content}\n\n` : ""}[Open in Obsidian](${task.noteUrl})`
		: task.content;

	if (task.kind === "CHECKLIST") {
		body["desc"] = described;
		body["content"] = task.inactiveBody ?? "";
	} else {
		body["content"] = described;
		if (task.inactiveBody) body["desc"] = task.inactiveBody;
	}

	if (task.kind) body["kind"] = task.kind;

	if (task.id) body["id"] = task.id;
	if (task.tags.length > 0) body["tags"] = task.tags;
	if (task.reminders.length > 0) body["reminders"] = task.reminders;
	if (task.repeatFlag) body["repeatFlag"] = task.repeatFlag;
	if (task.parentId) body["parentId"] = task.parentId;
	if (task.timeZone) body["timeZone"] = task.timeZone;
	if (task.sortOrder !== undefined) body["sortOrder"] = task.sortOrder;

	const due = serialiseTaskDate(task.dueDate, task.isAllDay, task.timeZone);
	if (due) body["dueDate"] = due;
	const start = serialiseTaskDate(task.startDate, task.isAllDay, task.timeZone);
	if (start) body["startDate"] = start;

	if (task.items.length > 0) {
		// sortOrder follows the note's ordering rather than whatever the server
		// had, because the order of the checkbox lines is the user's intent.
		body["items"] = task.items.map((item, index) => {
			const wire: Json = {
				...(item.id ? { id: item.id } : {}),
				title: item.title,
				status: item.completed ? 1 : 0,
				sortOrder: index,
			};

			const start = toTickTickDate(item.startDate);
			if (start) wire["startDate"] = start;
			if (item.isAllDay !== undefined) wire["isAllDay"] = item.isAllDay;
			if (item.timeZone) wire["timeZone"] = item.timeZone;
			const completed = toTickTickDate(item.completedTime);
			if (completed) wire["completedTime"] = completed;

			return wire;
		});
	}

	return body;
}

export interface OpenApiClientOptions {
	/** Returns a currently-valid access token, refreshing it if necessary. */
	getAccessToken: () => Promise<string>;
	queue: HttpQueue;
	baseUrl?: string;
}

export class OpenApiClient implements TickTickClient {
	readonly capabilities = OPEN_API_CAPABILITIES;

	private readonly baseUrl: string;

	constructor(private readonly options: OpenApiClientOptions) {
		this.baseUrl = options.baseUrl ?? OPEN_API_BASE;
	}

	private async send(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: Json,
	): Promise<unknown> {
		const token = await this.options.getAccessToken();
		const response = await this.options.queue.request({
			url: `${this.baseUrl}${path}`,
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});

		if (!response.text) return undefined;
		try {
			return response.json;
		} catch {
			return undefined;
		}
	}

	async listProjects(): Promise<Project[]> {
		const raw = await this.send("GET", "/project");
		const projects = asArray(raw).map(normaliseProject);

		// `GET /project` omits the Inbox, so its tasks would never be enumerated.
		// It is prepended as an ordinary project so the rest of the engine — and
		// the per-list filter in settings — can treat it like any other list.
		return [
			{ id: INBOX_PROJECT_ID, name: "Inbox", closed: false, kind: "TASK" },
			...projects,
		];
	}

	async listTasksInProject(projectId: string): Promise<Task[]> {
		// The Inbox has no `/project/{id}/data` endpoint; the filter endpoint is
		// the only route to it. That caps the Inbox at 200 tasks per sync.
		//
		// Only the Inbox. `POST /task/filter` answers 500 `unknown_exception` for
		// a real project id — measured against the live API on 18 Aug 2026 — so
		// it is not an alternative to the per-project listing for anything else.
		if (projectId === INBOX_PROJECT_ID) {
			const raw = await this.send("POST", "/task/filter", {
				projectIds: [INBOX_PROJECT_ID],
				status: [0],
			});
			return asArray(raw).map(normaliseTask);
		}

		// A 404 here used to answer with an empty array, on the reasoning that a
		// project deleted mid-pass should not abort the sync. It still should not,
		// and it does not — the caller records the failure and moves to the next
		// list. But an empty array is indistinguishable from "this list really has
		// no tasks", which now means the list counts as read and every note behind
		// it looks deleted. Letting it throw is what keeps those notes safe.
		{
			const raw = (await this.send("GET", `/project/${projectId}/data`)) as Json | undefined;
			return asArray(raw?.["tasks"]).map(normaliseTask);
		}
	}

	async getTask(projectId: string, taskId: string): Promise<Task | null> {
		try {
			const raw = await this.send("GET", `/project/${projectId}/task/${taskId}`);
			return raw ? normaliseTask(raw) : null;
		} catch (error) {
			if (error instanceof ApiError && error.isNotFound) return null;
			throw error;
		}
	}

	async createTask(task: NewTask): Promise<Task> {
		const raw = await this.send("POST", "/task", serialiseTask(task));
		const created = normaliseTask(raw);

		// Create accepts parentId and silently ignores it — verified against the
		// live API. Update honours it, so a task that was meant to have a parent
		// gets one in a second call rather than quietly arriving at the top level.
		if (task.parentId && !created.parentId) {
			return this.updateTask({ ...created, parentId: task.parentId });
		}

		return created;
	}

	async updateTask(task: Task): Promise<Task> {
		const raw = await this.send("POST", `/task/${task.id}`, serialiseTask(task));
		// The update response is occasionally empty; fall back to what we sent so
		// callers always receive a usable record.
		return raw ? normaliseTask(raw) : task;
	}

	async moveTask(taskId: string, fromProjectId: string, toProjectId: string): Promise<void> {
		if (!fromProjectId || !toProjectId || fromProjectId === toProjectId) return;

		// The endpoint takes an array; one task at a time keeps a failure
		// attributable to the task that caused it.
		await this.send("POST", "/task/move", [
			{ taskId, fromProjectId, toProjectId },
		] as unknown as Json);
	}

	async completeTask(projectId: string, taskId: string): Promise<void> {
		await this.send("POST", `/project/${projectId}/task/${taskId}/complete`);
	}

	async deleteTask(projectId: string, taskId: string): Promise<void> {
		try {
			await this.send("DELETE", `/project/${projectId}/task/${taskId}`);
		} catch (error) {
			// Already gone is the outcome we wanted.
			if (error instanceof ApiError && error.isNotFound) return;
			throw error;
		}
	}

	/**
	 * Completed tasks drop out of the project listing, so without this a
	 * completion is indistinguishable from a deletion and costs one direct fetch
	 * per task that vanished. TickTick returns at most 200 per call.
	 */
	async listCompletedTasks(from: Date, to: Date, projectIds?: string[]): Promise<Task[]> {
		const body: Json = {
			startDate: toTickTickDate(from.toISOString()),
			endDate: toTickTickDate(to.toISOString()),
		};

		// The Inbox is not a real project id here; omitting it widens the query to
		// every project, which still covers the Inbox.
		const scoped = projectIds?.filter((id) => id !== INBOX_PROJECT_ID) ?? [];
		if (scoped.length > 0) body["projectIds"] = scoped;

		const raw = await this.send("POST", "/task/completed", body);
		return asArray(raw).map(normaliseTask);
	}
}
