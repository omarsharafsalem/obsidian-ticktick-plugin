import type { TaskSnapshot } from "./reconcile";

/**
 * Durable record of what the last successful sync agreed on.
 *
 * This is the piece that turns a guessing two-way sync into a correct one. For
 * every linked task it stores the agreed state (`base`), so the next run can
 * tell an edit from a stale value on either side, and can distinguish a
 * deletion from a task it has simply never seen.
 */

export const SYNC_STATE_VERSION = 2;

export interface SyncEntry {
	taskId: string;
	projectId: string;
	/** Vault-relative path of the note representing this task. */
	notePath: string;
	/**
	 * Consecutive syncs in which this task's note was not found.
	 *
	 * Reset the moment the note turns up. Deleting a task requires this to have
	 * risen above the configured threshold, so a single missed pass -- a failed
	 * read, a rule mid-change -- can never destroy anything.
	 */
	missingPasses?: number;
	/** State both sides agreed on at the end of the last sync. */
	base: TaskSnapshot;
	/** Note mtime when we last wrote or read it, for conflict tie-breaks. */
	localMtime: number;
	/** Remote modification time, when the backend reports one. */
	remoteModifiedAt?: number;
	etag?: string;
	lastSyncedAt: number;
}

export interface SyncState {
	version: number;
	/** Keyed by TickTick task id. */
	entries: Record<string, SyncEntry>;
	/**
	 * Tasks deleted deliberately, with the time of deletion. Without these a
	 * task deleted locally reappears on the next pull before the delete has
	 * propagated.
	 */
	tombstones: Record<string, number>;
	lastFullSync?: number;
}

/** Tombstones older than this are pruned; the delete has long since settled. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyState(): SyncState {
	return { version: SYNC_STATE_VERSION, entries: {}, tombstones: {} };
}

export function migrateState(stored: unknown): SyncState {
	const raw = stored as Partial<SyncState> | undefined;
	if (!raw || typeof raw !== "object" || raw.version !== SYNC_STATE_VERSION) {
		// Older or absent state cannot be trusted for three-way merging. Starting
		// clean re-links notes by id on the next run, which is safe: without a
		// base every linked pair is treated as a first-time link rather than as
		// an edit, so nothing is silently overwritten.
		return emptyState();
	}

	return {
		version: SYNC_STATE_VERSION,
		entries: raw.entries ?? {},
		tombstones: raw.tombstones ?? {},
		lastFullSync: raw.lastFullSync,
	};
}

export class SyncStore {
	private pathIndex = new Map<string, string>();

	constructor(private state: SyncState = emptyState()) {
		this.reindex();
	}

	private reindex(): void {
		this.pathIndex = new Map();
		for (const entry of Object.values(this.state.entries)) {
			this.pathIndex.set(entry.notePath, entry.taskId);
		}
	}

	get raw(): SyncState {
		return this.state;
	}

	get entries(): SyncEntry[] {
		return Object.values(this.state.entries);
	}

	get(taskId: string): SyncEntry | undefined {
		return this.state.entries[taskId];
	}

	getByPath(path: string): SyncEntry | undefined {
		const taskId = this.pathIndex.get(path);
		return taskId ? this.state.entries[taskId] : undefined;
	}

	/**
	 * Drops the entry tracking this path, and the path index with it.
	 *
	 * For an entry whose task has provably gone: left in place it keeps the note
	 * bound to something that no longer exists, and no later pass can free it.
	 */
	forgetPath(path: string): void {
		const taskId = this.pathIndex.get(path);
		if (!taskId) return;
		this.pathIndex.delete(path);
		delete this.state.entries[taskId];
	}

	set(entry: SyncEntry): void {
		const previous = this.state.entries[entry.taskId];
		if (previous && previous.notePath !== entry.notePath) {
			this.pathIndex.delete(previous.notePath);
		}
		this.state.entries[entry.taskId] = entry;
		this.pathIndex.set(entry.notePath, entry.taskId);
	}

	forget(taskId: string): void {
		const entry = this.state.entries[taskId];
		if (entry) this.pathIndex.delete(entry.notePath);
		delete this.state.entries[taskId];
	}

	/** Records a deliberate deletion so the task is not re-created next run. */
	tombstone(taskId: string): void {
		this.forget(taskId);
		this.state.tombstones[taskId] = Date.now();
	}

	isTombstoned(taskId: string): boolean {
		return this.state.tombstones[taskId] !== undefined;
	}

	markSynced(now = Date.now()): void {
		this.state.lastFullSync = now;
		this.pruneTombstones(now);
	}

	private pruneTombstones(now: number): void {
		for (const [taskId, at] of Object.entries(this.state.tombstones)) {
			if (now - at > TOMBSTONE_TTL_MS) delete this.state.tombstones[taskId];
		}
	}

	/** Paths of every note the store currently tracks. */
	trackedPaths(): Set<string> {
		return new Set(this.pathIndex.keys());
	}
}
