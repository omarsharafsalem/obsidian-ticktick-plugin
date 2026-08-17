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
	/**
	 * Reports a per-task last-modified timestamp.
	 *
	 * The Open API does not, so "most recently edited wins" is answered instead
	 * from when a remote change was first *observed* — see `SyncStore`.
	 */
	modifiedTime: boolean;
	/** Can enumerate the Inbox alongside ordinary projects. */
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

	/**
	 * Moves a task to another list.
	 *
	 * A separate call because changing `projectId` through an ordinary update is
	 * rejected — the API answers 500 `unknown_exception` rather than moving it.
	 */
	moveTask(taskId: string, fromProjectId: string, toProjectId: string): Promise<void>;

	completeTask(projectId: string, taskId: string): Promise<void>;

	deleteTask(projectId: string, taskId: string): Promise<void>;

	/**
	 * Tasks completed within the window. Backends without
	 * {@link Capabilities.completedHistory} return an empty array.
	 */
	listCompletedTasks(from: Date, to: Date, projectIds?: string[]): Promise<Task[]>;
}
