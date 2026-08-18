import type { NewTask, Project, ProjectContents, Task } from "./types";

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
	 * Without one, "most recently edited wins" cannot be answered and every
	 * conflict falls to the server. The Open API does report it, contrary to
	 * how it is usually described — see `OPEN_API_CAPABILITIES`.
	 */
	modifiedTime: boolean;
	/** Can enumerate the Inbox alongside ordinary projects. */
	inbox: boolean;
	/**
	 * Most tasks one call to {@link TickTickClient.listTasksInProject} can
	 * return, where the backend caps it. Omitted when there is no cap.
	 *
	 * A list that comes back exactly this full may have been cut off, and
	 * nothing says so — so the engine treats it as only partly read rather than
	 * mistaking the tail it never received for tasks that were deleted.
	 */
	listPageSize?: number;
}

export interface TickTickClient {
	readonly capabilities: Capabilities;

	listProjects(): Promise<Project[]>;

	/**
	 * What is currently open in the given project, and the sections it holds.
	 *
	 * Both come from one read, so the sections are free. They matter because a
	 * section is the only container below a list, and therefore the only thing a
	 * task can carry that says which sub-project it belongs to.
	 */
	listTasksInProject(projectId: string): Promise<ProjectContents>;

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
