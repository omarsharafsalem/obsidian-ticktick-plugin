import { fromTickTickDate, toTickTickDate } from "../util/dates";
import { ApiError, HttpQueue } from "./http";
import type { Capabilities, TickTickClient } from "./client";
import {
	type ChecklistItem,
	type NewTask,
	type Project,
	type Task,
	priorityFromWire,
	priorityToWire,
	statusFromWire,
	statusToWire,
} from "./types";

export const OPEN_API_BASE = "https://api.ticktick.com/open/v1";

/** Everything the official API cannot do. See README for the consequences. */
const OPEN_API_CAPABILITIES: Capabilities = {
	completedHistory: false,
	search: false,
	tags: false,
	modifiedTime: false,
	inbox: false,
};

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
	};
}

export function normaliseTask(raw: unknown): Task {
	const task = (raw ?? {}) as Json;
	const isAllDay = task["isAllDay"] === true;

	return {
		id: asString(task["id"]) ?? "",
		projectId: asString(task["projectId"]) ?? "",
		title: asString(task["title"]) ?? "",
		content: asString(task["content"]) ?? asString(task["desc"]) ?? "",
		status: statusFromWire(task["status"]),
		priority: priorityFromWire(task["priority"]),
		tags: asArray(task["tags"]).filter((t): t is string => typeof t === "string"),
		dueDate: fromTickTickDate(task["dueDate"]),
		startDate: fromTickTickDate(task["startDate"]),
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
		kind: asString(project["kind"]),
	};
}

/** Builds the request body for create/update. Undefined fields are omitted. */
export function serialiseTask(task: NewTask & { id?: string }): Json {
	const body: Json = {
		title: task.title,
		projectId: task.projectId,
		content: task.content,
		priority: priorityToWire(task.priority),
		status: statusToWire(task.status),
		isAllDay: task.isAllDay,
	};

	if (task.id) body["id"] = task.id;
	if (task.tags.length > 0) body["tags"] = task.tags;
	if (task.reminders.length > 0) body["reminders"] = task.reminders;
	if (task.repeatFlag) body["repeatFlag"] = task.repeatFlag;
	if (task.parentId) body["parentId"] = task.parentId;
	if (task.timeZone) body["timeZone"] = task.timeZone;
	if (task.sortOrder !== undefined) body["sortOrder"] = task.sortOrder;

	const due = toTickTickDate(task.dueDate);
	if (due) body["dueDate"] = due;
	const start = toTickTickDate(task.startDate);
	if (start) body["startDate"] = start;

	if (task.items.length > 0) {
		body["items"] = task.items.map((item, index) => ({
			...(item.id ? { id: item.id } : {}),
			title: item.title,
			status: item.completed ? 1 : 0,
			sortOrder: index,
		}));
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
		return asArray(raw).map(normaliseProject);
	}

	async listTasksInProject(projectId: string): Promise<Task[]> {
		try {
			const raw = (await this.send("GET", `/project/${projectId}/data`)) as Json | undefined;
			return asArray(raw?.["tasks"]).map(normaliseTask);
		} catch (error) {
			// A project deleted between listing and fetching is not an error worth
			// aborting the whole sync for.
			if (error instanceof ApiError && error.isNotFound) return [];
			throw error;
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
		return normaliseTask(raw);
	}

	async updateTask(task: Task): Promise<Task> {
		const raw = await this.send("POST", `/task/${task.id}`, serialiseTask(task));
		// The update response is occasionally empty; fall back to what we sent so
		// callers always receive a usable record.
		return raw ? normaliseTask(raw) : task;
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

	async listCompletedTasks(): Promise<Task[]> {
		// Not available on the official API. The sync engine compensates by
		// probing individual tasks that vanish from a project listing.
		return [];
	}
}
