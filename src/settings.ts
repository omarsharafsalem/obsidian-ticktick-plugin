import type { SyncedField } from "./api/types";
import type { ConflictPolicy, DeleteConflictPolicy } from "./sync/reconcile";
import type { OAuthTokens } from "./auth/oauth";
import type { V2Session } from "./api/v2";

/**
 * Names of the Obsidian properties each TickTick field maps onto.
 *
 * These are real frontmatter properties, so they show up in the file's
 * Properties panel, are editable there, and are queryable by Dataview and
 * Bases. Every name is configurable because vaults already have conventions.
 */
export interface PropertyNames {
	id: string;
	project: string;
	etag: string;
	title: string;
	status: string;
	priority: string;
	due: string;
	start: string;
	tags: string;
	recurrence: string;
	reminders: string;
	completed: string;
	parent: string;
}

export const DEFAULT_PROPERTIES: PropertyNames = {
	id: "ticktick_id",
	project: "list",
	etag: "ticktick_etag",
	title: "ticktick_title",
	status: "status",
	priority: "priority",
	due: "due",
	start: "start",
	tags: "tags",
	recurrence: "recurrence",
	reminders: "reminders",
	completed: "completed",
	parent: "parent_task",
};

/**
 * The Obsidian property type each mapped property should be registered as, so
 * the Properties panel renders a date picker for dates and tag chips for tags
 * rather than treating everything as text.
 */
export const PROPERTY_TYPES: Partial<Record<keyof PropertyNames, string>> = {
	due: "date",
	start: "date",
	completed: "datetime",
	tags: "tags",
	reminders: "multitext",
	status: "text",
	priority: "text",
};

/** Per-field direction control, mirroring how Notion's TickTick sync works. */
export type FieldSyncMode = "off" | "both" | "toObsidian" | "toTickTick";

export type FieldModes = Record<SyncedField, FieldSyncMode>;

export const DEFAULT_FIELD_MODES: FieldModes = {
	title: "both",
	content: "both",
	status: "both",
	priority: "both",
	tags: "both",
	dueDate: "both",
	startDate: "both",
	isAllDay: "both",
	reminders: "both",
	repeatFlag: "both",
	items: "both",
	projectId: "both",
};

export type CompletedHandling = "keep" | "archive" | "delete";

export interface AuthSettings {
	clientId: string;
	clientSecret: string;
	tokens: OAuthTokens | null;
	loopbackPort: number;
}

export interface TickTickSyncSettings {
	auth: AuthSettings;

	/** Opt-in to the unofficial v2 API. See README for the trade-offs. */
	advancedMode: boolean;
	v2Session: V2Session | null;

	/** Vault folder that holds task notes. */
	taskFolder: string;
	/** Create a subfolder per TickTick list. */
	folderPerProject: boolean;

	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	/** Empty means every project. */
	projectFilter: string[];

	properties: PropertyNames;
	fieldModes: FieldModes;
	registerPropertyTypes: boolean;

	/** Also read `#tags` written in the note body, not just the property. */
	inlineTags: boolean;

	conflictPolicy: ConflictPolicy;
	deleteConflictPolicy: DeleteConflictPolicy;

	completedHandling: CompletedHandling;
	archiveFolder: string;

	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: TickTickSyncSettings = {
	auth: {
		clientId: "",
		clientSecret: "",
		tokens: null,
		loopbackPort: 8484,
	},
	advancedMode: false,
	v2Session: null,
	taskFolder: "Tasks",
	folderPerProject: true,
	syncIntervalMinutes: 5,
	syncOnStartup: true,
	projectFilter: [],
	properties: { ...DEFAULT_PROPERTIES },
	fieldModes: { ...DEFAULT_FIELD_MODES },
	registerPropertyTypes: true,
	inlineTags: true,
	conflictPolicy: "newest",
	deleteConflictPolicy: "restore",
	completedHandling: "keep",
	archiveFolder: "Tasks/Archive",
	debugLogging: false,
};

export function fieldAllowsPush(mode: FieldSyncMode): boolean {
	return mode === "both" || mode === "toTickTick";
}

export function fieldAllowsPull(mode: FieldSyncMode): boolean {
	return mode === "both" || mode === "toObsidian";
}

/** Merges stored settings over the defaults, tolerating older shapes. */
export function mergeSettings(stored: unknown): TickTickSyncSettings {
	const raw = (stored ?? {}) as Partial<TickTickSyncSettings>;
	return {
		...DEFAULT_SETTINGS,
		...raw,
		auth: { ...DEFAULT_SETTINGS.auth, ...(raw.auth ?? {}) },
		properties: { ...DEFAULT_PROPERTIES, ...(raw.properties ?? {}) },
		fieldModes: { ...DEFAULT_FIELD_MODES, ...(raw.fieldModes ?? {}) },
	};
}
