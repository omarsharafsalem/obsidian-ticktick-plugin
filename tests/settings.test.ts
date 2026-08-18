import { describe, expect, it } from "vitest";
import { hasSyncedBefore, mergeSettings } from "../src/settings";
import { SYNC_STATE_VERSION, type SyncEntry, type SyncState } from "../src/sync/state";

/**
 * Settings written by an older version have to keep working. The status labels
 * moved from one string per status to a list, and reading the old shape as a
 * list threw on every note — 400+ identical errors in one sync.
 */
describe("migrating stored settings", () => {
	it("converts a single status label into a list", () => {
		const merged = mergeSettings({
			labels: {
				status: { todo: "⏳ Not Done", completed: "✅ Done", abandoned: "🚫 Not Doing" },
				priority: { none: "⚪", low: "🔵", medium: "🟡", high: "🔴" },
				reminders: {},
			},
		});

		expect(merged.labels.status.todo).toEqual(["⏳ Not Done"]);
		expect(merged.labels.status.completed).toEqual(["✅ Done"]);
		expect(merged.labels.status.abandoned).toEqual(["🚫 Not Doing"]);
	});

	it("keeps a list that is already a list", () => {
		const merged = mergeSettings({
			labels: { status: { todo: ["🟢 Active", "⏸️ Paused"] } },
		} as never);

		expect(merged.labels.status.todo).toEqual(["🟢 Active", "⏸️ Paused"]);
	});

	it("falls back to the default when the stored value is unusable", () => {
		const merged = mergeSettings({ labels: { status: { todo: 42 } } } as never);
		expect(merged.labels.status.todo).toEqual(["todo"]);
	});

	it("survives settings with no labels at all", () => {
		const merged = mergeSettings({});
		expect(Array.isArray(merged.labels.status.todo)).toBe(true);
		expect(Array.isArray(merged.labels.statusNeutral)).toBe(true);
	});

	it("accepts a neutral list stored as a bare string", () => {
		const merged = mergeSettings({ labels: { statusNeutral: "📦 Archived" } } as never);
		expect(merged.labels.statusNeutral).toEqual(["📦 Archived"]);
	});

	// Settings saved before lists were routed by kind have no entry at all, and
	// an absent one has to mean "as before" rather than an undefined folder.
	it("fills in list routing that was never stored", () => {
		const merged = mergeSettings({ taskFolder: "Tasks" });
		expect(merged.listKinds).toEqual({
			TASK: { folder: "", noteType: "" },
			NOTE: { folder: "", noteType: "" },
		});
	});

	it("keeps a routing that is already stored, emoji and all", () => {
		const merged = mergeSettings({
			listKinds: { NOTE: { folder: "🧠 Notes", noteType: "💭 thought" } },
		} as never);

		expect(merged.listKinds.NOTE).toEqual({ folder: "🧠 Notes", noteType: "💭 thought" });
		expect(merged.listKinds.TASK).toEqual({ folder: "", noteType: "" });
	});
});

/**
 * Syncing now has to be started deliberately, which is right for a fresh
 * install and wrong for every install that already exists: reading the missing
 * flag as "not started" would quietly stop a sync that has been running for
 * months, and the user would have no reason to look for a button. This is the
 * upgrade path, and it is the kind of thing this codebase has got wrong before.
 */
describe("starting syncing on an existing install", () => {
	function entry(overrides: Partial<SyncEntry> = {}): SyncEntry {
		return {
			taskId: "task-1",
			projectId: "list-a",
			notePath: "Tasks/Buy milk.md",
			base: {} as SyncEntry["base"],
			localMtime: 0,
			lastSyncedAt: 0,
			...overrides,
		};
	}

	function state(overrides: Partial<SyncState> = {}): SyncState {
		return { version: SYNC_STATE_VERSION, entries: {}, tombstones: {}, ...overrides };
	}

	it("does not start syncing on a fresh install", () => {
		expect(mergeSettings(undefined, undefined).syncingStarted).toBe(false);
	});

	it("does not start syncing for settings saved before a first sync", () => {
		// Connected, configured, but nothing has ever been synced — the exact case
		// the gate exists for.
		const merged = mergeSettings({ auth: { personalToken: "abc" } }, state());
		expect(merged.syncingStarted).toBe(false);
	});

	it("keeps syncing for an install with tracked notes", () => {
		const merged = mergeSettings(
			{ taskFolder: "Tasks" },
			state({ entries: { "task-1": entry() } }),
		);
		expect(merged.syncingStarted).toBe(true);
	});

	it("keeps syncing for an install that has recorded a full sync", () => {
		const merged = mergeSettings({ taskFolder: "Tasks" }, state({ lastFullSync: 1_700_000_000 }));
		expect(merged.syncingStarted).toBe(true);
	});

	it("keeps syncing for an install whose only trace is a tombstone", () => {
		const merged = mergeSettings({}, state({ tombstones: { "task-9": 1_700_000_000 } }));
		expect(merged.syncingStarted).toBe(true);
	});

	// State written by an older version is discarded on load. Judging the upgrade
	// from the migrated state would tell exactly those installs they were new.
	it("reads the evidence from state an older version wrote", () => {
		const merged = mergeSettings({}, { version: 1, entries: { "task-1": entry() } });
		expect(merged.syncingStarted).toBe(true);
	});

	it("respects the stored answer once there is one", () => {
		const started = mergeSettings({ syncingStarted: true }, state());
		expect(started.syncingStarted).toBe(true);

		// Pausing has to survive a restart, so evidence of past syncing must not
		// override an explicit "no".
		const paused = mergeSettings({ syncingStarted: false }, state({ lastFullSync: 1 }));
		expect(paused.syncingStarted).toBe(false);
	});

	it("reads nothing into a missing or unusable sync state", () => {
		expect(hasSyncedBefore(undefined)).toBe(false);
		expect(hasSyncedBefore(null)).toBe(false);
		expect(hasSyncedBefore("nonsense")).toBe(false);
		expect(hasSyncedBefore({})).toBe(false);
	});
});
