import type { NewTask, Project, Task } from "./types";

/**
 * What a given backend can actually do.
 *
 * The official Open API is deliberately narrow, so the sync engine consults
 * these flags rather than assuming. Where a capability is missing the engine
 * degrades to a slower but correct strategy instead of failing.
 */
export interface Capabilities {
	/** Can list tasks completed in a date range. */
	completedHistory: boolean;
	/** Has a server-side search endpoint. */
	search: boolean;
	/** Exposes the user's tag vocabulary. */
	tags: boolean;
	/** Reports a per-task last-modified timestamp. */
	modifiedTime: boolean;
	/** Can enumerate the Inbox project. */
	inbox: boolean;
}

export interface TickTickClient {
	readonly capabilities: Capabilities;

	listProjects(): Promise<Project[]>;

	/** Tasks that are currently open in the given project. */
	listTasksInProject(projectId: string): Promise<Task[]>;

	/** Resolves to null when the task no longer exists (HTTP 404). */
	getTask(projectId: string, taskId: string): Promise<Task | null>;

	createTask(task: NewTask): Promise<Task>;

	updateTask(task: Task): Promise<Task>;

	completeTask(projectId: string, taskId: string): Promise<void>;

	deleteTask(projectId: string, taskId: string): Promise<void>;

	/**
	 * Tasks completed within the window. Backends without
	 * {@link Capabilities.completedHistory} return an empty array.
	 */
	listCompletedTasks(from: Date, to: Date, projectIds?: string[]): Promise<Task[]>;
}
