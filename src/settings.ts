import type { Priority, Project, ProjectKind, SyncedField, TaskStatus } from "./api/types";
import type {
	ConflictPolicy,
	DeleteConflictPolicy,
	NoteDeletionPolicy,
	RemoteDeletionPolicy,
} from "./sync/reconcile";
import type { OAuthTokens } from "./auth/oauth";
import type { SyncState } from "./sync/state";

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
	/** The sub-project — a section inside the list. */
	subproject: string;
	status: string;
	priority: string;
	due: string;
	start: string;
	tags: string;
	recurrence: string;
	reminders: string;
	completed: string;
	/**
	 * The real title, written only when a filename cannot hold it.
	 *
	 * A note for "Read: chapter 3/4" has to be called "Read- chapter 3-4", so
	 * without this there is nowhere in Obsidian showing what the task is actually
	 * called. Absent on every ordinary title, where the filename says it already.
	 */
	title: string;
	parent: string;
	/** Links to the tasks whose parent is this one. Derived, never read back. */
	children: string;
}

export const DEFAULT_PROPERTIES: PropertyNames = {
	id: "ticktick_task_id",
	project: "project",
	subproject: "subproject",
	status: "status",
	title: "ticktick_title",
	priority: "priority",
	due: "due",
	start: "start",
	tags: "tags",
	recurrence: "recurrence",
	reminders: "reminders",
	completed: "completed",
	parent: "parent_task",
	children: "child_tasks",
};

/**
 * The Obsidian property type each mapped property should be registered as, so
 * the Properties panel renders a date picker for dates and tag chips for tags
 * rather than treating everything as text.
 */
export const PROPERTY_TYPES: Partial<Record<keyof PropertyNames, string>> = {
	completed: "datetime",
	tags: "tags",
	reminders: "multitext",
	// Obsidian has no single-select type. "multitext" is the closest: it renders
	// as chips and suggests values already used in the vault, which beats a free
	// text box for a field with a fixed set of values. The mapper reads either a
	// bare value or a one-element list, so hand-edited notes still parse.
	status: "multitext",
	priority: "multitext",
	project: "multitext",
	subproject: "multitext",
	parent: "text",
	children: "multitext",
};

/**
 * The words your vault uses for each value TickTick stores as a code.
 *
 * Renaming a *property* is not enough to drop this plugin into an existing
 * vault: TickTick's priority is an integer and its status is 0/2/-1, and a vault
 * that already tracks tasks will have its own vocabulary — "Done", "P1",
 * "In progress". These maps are the translation, applied in both directions, so
 * notes read in your language and still push the right codes back.
 */
export interface ValueLabels {
	/**
	 * The values that mean each TickTick status. The first is the one written
	 * when the status genuinely changes; the rest are recognised and left alone.
	 *
	 * TickTick knows three statuses and a working vault usually has more, so this
	 * is deliberately many-to-one: "Paused" and "Awaiting" both mean not done,
	 * and neither should be flattened to "Active" just because a due date moved.
	 */
	status: Record<TaskStatus, string[]>;
	/**
	 * Values describing *filing* rather than progress, e.g. "Archived".
	 *
	 * They never drive a change in either direction: archiving a finished task
	 * must not reopen it, and archiving an open one must not complete it.
	 */
	statusNeutral: string[];
	priority: Record<Priority, string>;
	/** iCal TRIGGER string to the name you would rather read. */
	reminders: Record<string, string>;
}

export const DEFAULT_STATUS_LABELS: Record<TaskStatus, string[]> = {
	todo: ["todo"],
	completed: ["completed"],
	abandoned: ["abandoned"],
};

export const DEFAULT_NEUTRAL_STATUSES: string[] = [];

export const DEFAULT_PRIORITY_LABELS: Record<Priority, string> = {
	none: "none",
	low: "low",
	medium: "medium",
	high: "high",
};

/**
 * TickTick stores reminders as iCal TRIGGER durations — `TRIGGER:-PT30M` is
 * "thirty minutes before". Unreadable in a Properties panel, and impossible to
 * write by hand correctly, so the common ones get names. Anything not listed
 * passes through as its raw TRIGGER rather than being dropped.
 */
export const DEFAULT_REMINDER_LABELS: Record<string, string> = {
	"TRIGGER:PT0S": "On time",
	"TRIGGER:-PT5M": "5 minutes before",
	"TRIGGER:-PT15M": "15 minutes before",
	"TRIGGER:-PT30M": "30 minutes before",
	"TRIGGER:-PT1H": "1 hour before",
	"TRIGGER:-PT2H": "2 hours before",
	"TRIGGER:-P1D": "1 day before",
	"TRIGGER:-P2D": "2 days before",
	"TRIGGER:-P1W": "1 week before",
};

export const DEFAULT_VALUE_LABELS: ValueLabels = {
	status: { ...DEFAULT_STATUS_LABELS },
	statusNeutral: [...DEFAULT_NEUTRAL_STATUSES],
	priority: { ...DEFAULT_PRIORITY_LABELS },
	reminders: { ...DEFAULT_REMINDER_LABELS },
};

/** Per-field direction control, mirroring how Notion's TickTick sync works. */
export type FieldSyncMode = "off" | "both" | "toObsidian" | "toTickTick";

export type FieldModes = Record<SyncedField, FieldSyncMode>;

export const DEFAULT_FIELD_MODES: FieldModes = {
	title: "both",
	columnId: "both",
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
	parentId: "both",
};

export type CompletedHandling = "keep" | "archive" | "delete";

/**
 * Where one kind of TickTick list is filed, and what its notes call themselves.
 *
 * A vault usually already has somewhere for notes and somewhere for tasks, and
 * a property saying which is which. TickTick already knows the difference — it
 * reports each list as a task list or a notes list — so this is the join
 * between the two, rather than a rule the user has to maintain by hand.
 *
 * Both fields are empty by default, meaning "carry on as before": the ordinary
 * task folder, and the marker value already configured. Nothing here invents a
 * folder or a vocabulary for anybody.
 */
export interface KindRouting {
	/** Folder for this kind's notes. Empty means {@link TickTickSyncSettings.taskFolder}. */
	folder: string;
	/**
	 * What this kind's notes write into the marker property — `note_type`, or
	 * whatever it has been renamed to.
	 *
	 * A free string, and it is compared and written verbatim: a vault whose
	 * values read "📌 task" and "💭 thought" means those exactly, emoji
	 * included. Empty means the marker's own value, so a task list is unchanged.
	 */
	noteType: string;
}

export const DEFAULT_LIST_KINDS: Record<ProjectKind, KindRouting> = {
	TASK: { folder: "", noteType: "" },
	NOTE: { folder: "", noteType: "" },
};

/**
 * How a repeating task's finished occurrences are recorded.
 *
 * Completing a repeating task leaves the live task exactly where it was — same
 * id, due date rolled forward, status back to open — and files a separate
 * record for the occurrence that was finished, with an id of its own. That
 * record is a real task, so one note per task would give it a note. Which is
 * what you want from a weekly review, and not at all what you want from a daily
 * habit: "something that recurs weekly, I don't mind having a note every week,
 * but something that recurs daily would just clutter things up."
 */
export interface RecurrenceSettings {
	/**
	 * Occurrences at least this many days apart get a note each. Anything more
	 * frequent is logged in the repeating task's own note instead.
	 */
	thresholdDays: number;

	/**
	 * Frontmatter property that overrides the frequency rule for one task.
	 *
	 * `note` gives every occurrence its own note; `log` records them all in this
	 * note. Anything else is ignored, so a typo falls back to the frequency rule
	 * rather than quietly moving where completions are written. Never written by
	 * the plugin — it is yours to set and yours to remove.
	 */
	overrideProperty: string;

	/**
	 * Most occurrence notes one sync may create. Zero removes the limit.
	 *
	 * The completed listing reaches back ninety days, so the first sync of a task
	 * that repeats often would otherwise create a note per occurrence all at once.
	 */
	maxOccurrenceNotesPerSync: number;
}

export const DEFAULT_RECURRENCE_SETTINGS: RecurrenceSettings = {
	thresholdDays: 7,
	overrideProperty: "recurrence_occurrences",
	maxOccurrenceNotesPerSync: 20,
};

export interface AuthSettings {
	/**
	 * A token created in TickTick under Settings > Account > API Token.
	 *
	 * The Open API accepts it as a bearer token directly, so it replaces the
	 * whole OAuth flow for a single account. Takes precedence over `tokens`.
	 */
	personalToken: string;
	clientId: string;
	clientSecret: string;
	tokens: OAuthTokens | null;
	loopbackPort: number;
}

export interface TickTickSyncSettings {
	auth: AuthSettings;

	/**
	 * Whether the user has started syncing, as opposed to merely connected.
	 *
	 * A working token proves only that the account can be reached. What a sync
	 * actually *does* is decided by everything else on this page — the property
	 * names, the value labels, the task marker, which lists, which folders — and
	 * none of it is right until it has been filled in. A sync that runs before
	 * then writes notes across the vault that then have to be undone by hand, so
	 * no task note is read or written until this is switched on deliberately.
	 *
	 * Listing lists is deliberately outside the gate: choosing them is part of
	 * the configuring this is protecting.
	 */
	syncingStarted: boolean;

	/**
	 * The property that marks a note as a task, e.g. `note_type: task`.
	 *
	 * Without it the only thing separating a task from an ordinary note is which
	 * folder it sits in, so anything filed alongside a task would be pushed to
	 * TickTick as one. With it, task notes can live among ordinary notes.
	 *
	 * An empty `property` disables the check and restores folder-only behaviour.
	 */
	taskMarker: { property: string; value: string };

	/**
	 * The property saying what kind of note this is, when that is not the marker.
	 *
	 * Left empty, the marker does both jobs and nothing changes. Set to a
	 * different property and a note can be a task *and* something else at once —
	 * the marker answers "the plugin owns this", this answers "what it is".
	 *
	 * The value written comes from the list's kind routing, so a notes list and
	 * a task list can describe themselves differently.
	 */
	noteTypeProperty: string;

	/**
	 * Look for task notes across the whole vault rather than under
	 * {@link taskFolder}. Requires a marker, or every note would be a task.
	 */
	discoverAnywhere: boolean;

	/** Vault folder that holds task notes, and where new ones are created. */
	taskFolder: string;
	/** Create a subfolder per TickTick list. */
	folderPerProject: boolean;

	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	/** Empty means every project. */
	projectFilter: string[];

	/**
	 * Where each kind of list is filed, and what its notes call themselves.
	 *
	 * TickTick lists come in two kinds, and a notes list is not a to-do list —
	 * but it is still worth having in the vault, filed where notes go rather
	 * than among the tasks. Both entries are empty by default, which routes
	 * every list exactly as before.
	 */
	listKinds: Record<ProjectKind, KindRouting>;

	/**
	 * Where a note goes when its task is deleted in TickTick.
	 *
	 * The folder is the record that the task is gone, which is why no property
	 * marks it. A setting rather than a constant so it can follow a vault's own
	 * structure — this plugin should work in any vault, not one.
	 */
	deletedTaskFolder: string;

	/**
	 * Ends the part of the note body that syncs to TickTick.
	 *
	 * Everything after this line is never read or written, so a task can carry
	 * as much writing as it needs without any of it reaching TickTick. A note
	 * with no marker syncs its whole body, which is what older notes expect.
	 */
	syncedRegionMarker: string;

	/** Put a link back to the note in the TickTick task's description. */
	linkBackToNote: boolean;

	/**
	 * Also record an unrepresentable title in the note's `aliases`.
	 *
	 * Only ever on a note whose filename could not carry its title — illegal
	 * characters, or a collision suffix. The title property records it either
	 * way; the alias is what makes the note reachable *by* that title, since the
	 * quick switcher and `[[links]]` both go through the filename otherwise.
	 *
	 * Off by default. `aliases` is a vault-wide Obsidian concept rather than one
	 * of this plugin's own properties, and writing into someone's alias list
	 * should be asked for rather than assumed.
	 */
	aliasUnrepresentableTitles: boolean;

	/**
	 * Where each list's notes are created, keyed by project id.
	 *
	 * A list with no entry falls back to {@link taskFolder}, so this can be set
	 * for one list without disturbing the rest. Overrides `folderPerProject`.
	 */
	listFolders: Record<string, string>;

	/**
	 * The note that represents each list, keyed by project id.
	 *
	 * When set, the list property is written as a wikilink to that note instead
	 * of a plain name, so every task shows up in the project note's backlinks and
	 * the link is navigable. Reading resolves the link back to the list.
	 */
	listPages: Record<string, string>;

	/**
	 * Sections that stand for a project in their own right, keyed by section id.
	 *
	 * A section is normally a sub-project — a part of the work its list stands
	 * for. But a list can also be a shared container holding several unrelated
	 * projects, one section each, and then the section answers "which project"
	 * and there is no sub-project to name.
	 *
	 * Pair it with a folder in {@link listFolders} for the same section: a
	 * project's `.base` gathers its notes with `file.inFolder(...)`, so the
	 * property alone would name the project without putting the note in its view.
	 */
	sectionIsProject: Record<string, boolean>;

	/**
	 * Frontmatter property by which a project note claims a TickTick list.
	 *
	 * A note saying `ticktick_list_id: <id>` binds that list to itself, and every
	 * task in the list is linked to it — no per-list setting, nothing to keep in
	 * step. Settings still work, and win where both are given, so an existing
	 * install is unaffected and a deliberate override stays possible.
	 *
	 * Blank turns discovery off.
	 */
	listBindingProperty: string;

	/** The same thing one level down: a note claiming a section. */
	sectionBindingProperty: string;

	/**
	 * Most new TickTick tasks one sync may create before it stops.
	 *
	 * Creating a task is the only operation that multiplies: a note that fails to
	 * match an existing task looks new, so one bad match rule turns every note in
	 * the vault into a duplicate. A cap turns that into a message instead of
	 * hundreds of tasks. Zero disables the limit.
	 */
	maxNewTasksPerSync: number;

	/**
	 * Most TickTick tasks one sync may delete before it stops.
	 *
	 * Deleting cannot be undone from here, and the trigger is a note being
	 * absent — which a discovery rule can cause for every note at once. The cap
	 * bounds the damage to something recoverable. Zero disables the limit.
	 */
	maxDeletedTasksPerSync: number;

	/**
	 * Pull tasks that are already completed in TickTick.
	 *
	 * Off by default: it creates a note for everything finished in the last 90
	 * days, which buries the open tasks. A task completed *after* it has synced
	 * still updates either way — this only controls the initial backfill.
	 */
	syncCompletedTasks: boolean;

	/**
	 * Whether due and start render with a time as well as a date.
	 *
	 * A property type is global to its name in Obsidian, so this cannot vary per
	 * task: pick "datetime" if any of your tasks are time-blocked.
	 */
	dateProperties: "date" | "datetime";

	/**
	 * Whose clock a time is shown on.
	 *
	 * "local" uses the machine reading the vault. "task" uses the zone TickTick
	 * tagged the task with — which sounds more correct but is often a stale
	 * account setting from wherever the account was last used, and a wrong zone
	 * shifts every time by hours. Local is the default because the person
	 * reading the note is the one whose clock matters.
	 */
	showTimesIn: "local" | "task";

	properties: PropertyNames;
	/** The vocabulary those properties use. See {@link ValueLabels}. */
	labels: ValueLabels;
	fieldModes: FieldModes;
	registerPropertyTypes: boolean;

	/**
	 * Properties to hide from the Properties panel.
	 *
	 * The task id has to live in the note — it is what re-links a note to its
	 * task after a state reset, and the only thing that survives a rename — but
	 * it is machine bookkeeping and reads as clutter. Hiding is a display
	 * concern, so it is solved with a style rule rather than by moving the data.
	 */
	hiddenProperties: string[];

	/** Also read `#tags` written in the note body, not just the property. */
	inlineTags: boolean;

	conflictPolicy: ConflictPolicy;
	deleteConflictPolicy: DeleteConflictPolicy;
	/** What happens to a note when its task is deleted in TickTick. */
	remoteDeletion: RemoteDeletionPolicy;

	/**
	 * What happens to a TickTick task when its note is missing.
	 *
	 * Defaults to keeping the task. Deleting is the only irreversible thing this
	 * plugin does, and its trigger is ambiguous by nature.
	 */
	noteDeletion: NoteDeletionPolicy;

	/**
	 * Ask before anything is deleted, on either side.
	 *
	 * On by default while the plugin is still earning trust: a prompt that names
	 * what is going and why turns a silent mistake into a decision, and the
	 * reason it gives is what makes the mistake diagnosable afterwards.
	 */
	confirmDeletions: boolean;

	/**
	 * Syncs a note must be missing for before its task may be deleted.
	 *
	 * One pass proves nothing — a read can fail, a rule can change. Requiring the
	 * same answer twice turns a transient miss into a no-op instead of a
	 * deletion. Only used when {@link noteDeletion} is "deleteTask".
	 */
	passesBeforeDeletingTask: number;

	completedHandling: CompletedHandling;
	archiveFolder: string;

	/** What a repeating task's finished occurrences become. */
	recurrence: RecurrenceSettings;

	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: TickTickSyncSettings = {
	auth: {
		personalToken: "",
		clientId: "",
		clientSecret: "",
		tokens: null,
		loopbackPort: 8484,
	},
	syncingStarted: false,
	taskMarker: { property: "", value: "task" },
	noteTypeProperty: "",
	discoverAnywhere: false,
	taskFolder: "Tasks",
	folderPerProject: true,
	syncIntervalMinutes: 5,
	syncOnStartup: true,
	projectFilter: [],
	listKinds: { TASK: { ...DEFAULT_LIST_KINDS.TASK }, NOTE: { ...DEFAULT_LIST_KINDS.NOTE } },
	listFolders: {},
	listPages: {},
	sectionIsProject: {},
	listBindingProperty: "ticktick_list_id",
	sectionBindingProperty: "ticktick_section_id",
	deletedTaskFolder: "🗄️ Archive",
	syncedRegionMarker: "<!-- ticktick:end -->",
	linkBackToNote: true,
	aliasUnrepresentableTitles: false,
	dateProperties: "datetime",
	showTimesIn: "local",
	maxNewTasksPerSync: 20,
	maxDeletedTasksPerSync: 10,
	syncCompletedTasks: false,
	properties: { ...DEFAULT_PROPERTIES },
	labels: {
		status: { ...DEFAULT_STATUS_LABELS },
		statusNeutral: [...DEFAULT_NEUTRAL_STATUSES],
		priority: { ...DEFAULT_PRIORITY_LABELS },
		reminders: { ...DEFAULT_REMINDER_LABELS },
	},
	fieldModes: { ...DEFAULT_FIELD_MODES },
	registerPropertyTypes: true,
	hiddenProperties: ["ticktick_task_id"],
	inlineTags: true,
	conflictPolicy: "newest",
	deleteConflictPolicy: "restore",
	remoteDeletion: "keepNote",
	noteDeletion: "keepTask",
	confirmDeletions: true,
	passesBeforeDeletingTask: 2,
	completedHandling: "keep",
	archiveFolder: "Tasks/Archive",
	recurrence: { ...DEFAULT_RECURRENCE_SETTINGS },
	debugLogging: false,
};

/**
 * Why a list is not being synced, in words worth showing someone.
 *
 * One function rather than a filter in the engine and a label in the settings
 * tab, because the two drifting apart is how a list ends up silently skipped —
 * which is its own bug. The engine skips exactly the lists this explains, and
 * the settings tab explains exactly the lists the engine skips.
 */
export function listSkipReason(
	project: Project,
	settings: TickTickSyncSettings,
): string | undefined {
	if (settings.projectFilter.length > 0 && !settings.projectFilter.includes(project.id)) {
		return "Not one of the lists selected below, so nothing in it is read or written.";
	}

	if (project.closed) {
		return (
			"Archived in TickTick, which stops it returning any tasks. Notes already synced from it " +
			"are left exactly as they are — an archived list is not a deleted one."
		);
	}

	return undefined;
}

/**
 * How a list of this kind is filed, with the fallbacks applied.
 *
 * An unreported kind is treated as a task list: TickTick omits the field on
 * some lists, and guessing "notes" on a missing value would file real tasks
 * somewhere they were never meant to go.
 */
export function routingForKind(
	kind: ProjectKind | undefined,
	settings: TickTickSyncSettings,
): { folder: string; noteType: string } {
	const routing = settings.listKinds[kind ?? "TASK"] ?? DEFAULT_LIST_KINDS.TASK;
	return {
		folder: routing.folder.trim() || settings.taskFolder,
		noteType: routing.noteType.trim() || settings.taskMarker.value,
	};
}

export function fieldAllowsPush(mode: FieldSyncMode): boolean {
	return mode === "both" || mode === "toTickTick";
}

export function fieldAllowsPull(mode: FieldSyncMode): boolean {
	return mode === "both" || mode === "toObsidian";
}

/**
 * Reads a status list from stored settings, whatever shape it is in.
 *
 * Earlier versions stored one string per status. Spreading that over the array
 * defaults leaves a string where a list is expected, and every read of it then
 * fails — so the conversion happens here, once, rather than being guarded at
 * each use.
 */
function toStatusList(value: unknown, fallback: string[]): string[] {
	const values = Array.isArray(value) ? value : [value];
	const cleaned = values
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Whether this vault has synced before, judged from the sync state on disk.
 *
 * Read from the state exactly as stored, not from the migrated one: state
 * written by an older version is discarded on load, and an install whose history
 * was just discarded would read as brand new — which is precisely the install
 * that must not be quietly switched off.
 */
export function hasSyncedBefore(storedState: unknown): boolean {
	if (!storedState || typeof storedState !== "object") return false;

	const raw = storedState as Partial<SyncState>;
	if (typeof raw.lastFullSync === "number") return true;

	// Tombstones count as well: a task deleted through this plugin is proof a
	// pass ran, even if every entry has since been forgotten.
	return Object.keys(raw.entries ?? {}).length > 0 || Object.keys(raw.tombstones ?? {}).length > 0;
}

/**
 * Whether syncing should already be under way for settings written earlier.
 *
 * The switch is newer than the installs it has to serve, so a vault that has
 * been syncing for months has nothing stored for it — and reading that absence
 * as "not started" would silently stop a sync that was working. The vault's own
 * sync state settles it. Without that evidence it stays off: being asked to
 * press a button costs a moment, while a first sync nobody was ready for costs
 * an afternoon of undoing notes by hand.
 */
function resolveSyncingStarted(
	raw: Partial<TickTickSyncSettings>,
	storedState: unknown,
): boolean {
	if (typeof raw.syncingStarted === "boolean") return raw.syncingStarted;
	return hasSyncedBefore(storedState);
}

/**
 * Merges stored settings over the defaults, tolerating older shapes.
 *
 * `storedState` is the persisted sync state that sits alongside them, needed
 * only to tell an upgrade from a fresh install — see {@link resolveSyncingStarted}.
 */
export function mergeSettings(stored: unknown, storedState?: unknown): TickTickSyncSettings {
	const raw = (stored ?? {}) as Partial<TickTickSyncSettings>;
	return {
		...DEFAULT_SETTINGS,
		...raw,
		syncingStarted: resolveSyncingStarted(raw, storedState),
		auth: { ...DEFAULT_SETTINGS.auth, ...(raw.auth ?? {}) },
		properties: { ...DEFAULT_PROPERTIES, ...(raw.properties ?? {}) },
		fieldModes: { ...DEFAULT_FIELD_MODES, ...(raw.fieldModes ?? {}) },
		listFolders: { ...(raw.listFolders ?? {}) },
		listPages: { ...(raw.listPages ?? {}) },
		listKinds: {
			TASK: { ...DEFAULT_LIST_KINDS.TASK, ...(raw.listKinds?.TASK ?? {}) },
			NOTE: { ...DEFAULT_LIST_KINDS.NOTE, ...(raw.listKinds?.NOTE ?? {}) },
		},
		hiddenProperties: [...(raw.hiddenProperties ?? DEFAULT_SETTINGS.hiddenProperties)],
		taskMarker: { ...DEFAULT_SETTINGS.taskMarker, ...(raw.taskMarker ?? {}) },
		recurrence: { ...DEFAULT_RECURRENCE_SETTINGS, ...(raw.recurrence ?? {}) },
		labels: {
			status: {
				todo: toStatusList(raw.labels?.status?.todo, DEFAULT_STATUS_LABELS.todo),
				completed: toStatusList(raw.labels?.status?.completed, DEFAULT_STATUS_LABELS.completed),
				abandoned: toStatusList(raw.labels?.status?.abandoned, DEFAULT_STATUS_LABELS.abandoned),
			},
			statusNeutral: toStatusList(raw.labels?.statusNeutral, DEFAULT_NEUTRAL_STATUSES),
			priority: { ...DEFAULT_PRIORITY_LABELS, ...(raw.labels?.priority ?? {}) },
			// Merged rather than replaced, so adding a custom TRIGGER keeps the
			// built-in names working.
			reminders: { ...DEFAULT_REMINDER_LABELS, ...(raw.labels?.reminders ?? {}) },
		},
	};
}
