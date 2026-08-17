import { ApiError, HttpQueue } from "./http";
import type { Capabilities, TickTickClient } from "./client";
import { normaliseProject, normaliseTask, serialiseTask } from "./openApi";
import type { NewTask, Project, Task } from "./types";

/**
 * Client for TickTick's internal v2 API — the one the web app talks to.
 *
 * This is unofficial. It is not covered by TickTick's developer terms, it
 * authenticates with a session token rather than OAuth, and TickTick can change
 * or break it without notice. It exists here only because the official API
 * cannot report completed-task history or per-task modification times, which
 * makes deletion detection and conflict resolution slower and less precise.
 *
 * Nothing in the plugin depends on this client; it is opt-in and every call
 * site degrades gracefully when it is disabled or fails.
 */

export const V2_BASE = "https://api.ticktick.com/api/v2";

const V2_CAPABILITIES: Capabilities = {
	completedHistory: true,
	search: true,
	tags: true,
	modifiedTime: true,
	inbox: true,
};

type Json = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export interface V2Session {
	token: string;
	/** Epoch milliseconds when we obtained the token; used to age it out. */
	obtainedAt: number;
}

export interface V2ClientOptions {
	queue: HttpQueue;
	getSession: () => V2Session | null;
	setSession: (session: V2Session | null) => Promise<void>;
	/** Called when the session is rejected, so the UI can prompt for re-login. */
	onAuthFailure?: () => void;
}

/** Exchanges username and password for a session token. */
export async function v2SignOn(
	queue: HttpQueue,
	username: string,
	password: string,
): Promise<V2Session> {
	const response = await queue.request({
		url: `${V2_BASE}/user/signon?wc=true&remember=true`,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-device":
				'{"platform":"web","os":"obsidian","device":"obsidian-ticktick-sync","version":1}',
		},
		body: JSON.stringify({ username, password }),
	});

	const payload = (response.json ?? {}) as Json;
	const token = payload["token"];
	if (typeof token !== "string" || !token) {
		throw new Error("TickTick sign-on did not return a session token");
	}

	return { token, obtainedAt: Date.now() };
}

export class V2Client implements TickTickClient {
	readonly capabilities = V2_CAPABILITIES;

	constructor(private readonly options: V2ClientOptions) {}

	private async send(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const session = this.options.getSession();
		if (!session) {
			throw new Error("TickTick advanced mode is enabled but not signed in");
		}

		try {
			const response = await this.options.queue.request({
				url: `${V2_BASE}${path}`,
				method,
				headers: {
					"Content-Type": "application/json",
					Cookie: `t=${session.token}`,
					"x-device":
						'{"platform":"web","os":"obsidian","device":"obsidian-ticktick-sync","version":1}',
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});

			if (!response.text) return undefined;
			try {
				return response.json;
			} catch {
				return undefined;
			}
		} catch (error) {
			if (error instanceof ApiError && error.isAuthFailure) {
				await this.options.setSession(null);
				this.options.onAuthFailure?.();
			}
			throw error;
		}
	}

	/**
	 * Full state in a single round trip — projects, open tasks and tags. This is
	 * the main reason the v2 path exists: the official API needs one request per
	 * project to gather the same information.
	 */
	async batchCheck(): Promise<{ projects: Project[]; tasks: Task[]; tags: string[] }> {
		const raw = ((await this.send("GET", "/batch/check/0")) ?? {}) as Json;
		const syncBean = (raw["syncTaskBean"] ?? {}) as Json;

		return {
			projects: asArray(raw["projectProfiles"]).map(normaliseProject),
			tasks: asArray(syncBean["update"]).map(normaliseTask),
			tags: asArray(raw["tags"])
				.map((tag) => (tag as Json)["name"])
				.filter((name): name is string => typeof name === "string"),
		};
	}

	async listProjects(): Promise<Project[]> {
		return (await this.batchCheck()).projects;
	}

	async listTasksInProject(projectId: string): Promise<Task[]> {
		const { tasks } = await this.batchCheck();
		return tasks.filter((task) => task.projectId === projectId);
	}

	async getTask(projectId: string, taskId: string): Promise<Task | null> {
		try {
			const raw = await this.send("GET", `/task/${taskId}?projectId=${projectId}`);
			return raw ? normaliseTask(raw) : null;
		} catch (error) {
			if (error instanceof ApiError && error.isNotFound) return null;
			throw error;
		}
	}

	async createTask(task: NewTask): Promise<Task> {
		const payload = serialiseTask(task);
		const raw = ((await this.send("POST", "/batch/task", { add: [payload] })) ?? {}) as Json;

		// The batch endpoint answers with an id2etag map rather than the record.
		const idMap = (raw["id2etag"] ?? {}) as Json;
		const createdId = Object.keys(idMap)[0];
		if (!createdId) {
			throw new Error("TickTick did not return an id for the created task");
		}

		const fetched = await this.getTask(task.projectId, createdId);
		return fetched ?? { ...task, id: createdId };
	}

	async updateTask(task: Task): Promise<Task> {
		await this.send("POST", "/batch/task", { update: [serialiseTask(task)] });
		return task;
	}

	async completeTask(projectId: string, taskId: string): Promise<void> {
		const existing = await this.getTask(projectId, taskId);
		if (!existing) return;
		await this.updateTask({ ...existing, status: "completed" });
	}

	async deleteTask(projectId: string, taskId: string): Promise<void> {
		await this.send("POST", "/batch/task", {
			delete: [{ taskId, projectId }],
		});
	}

	async listCompletedTasks(from: Date, to: Date, projectIds?: string[]): Promise<Task[]> {
		const params = new URLSearchParams({
			from: from.toISOString().replace("Z", "+0000"),
			to: to.toISOString().replace("Z", "+0000"),
			limit: "500",
		});

		const raw = await this.send("GET", `/project/all/completedInAll/?${params.toString()}`);
		const tasks = asArray(raw).map(normaliseTask);

		const filtered = projectIds
			? tasks.filter((task) => projectIds.includes(task.projectId))
			: tasks;

		// completedInAll omits the status field on some records; force it, since
		// the whole point of this call is that these tasks are done.
		return filtered.map((task) => ({
			...task,
			status: task.status === "todo" ? "completed" : task.status,
			completedTime: task.completedTime ?? task.modifiedTime,
		}));
	}
}
