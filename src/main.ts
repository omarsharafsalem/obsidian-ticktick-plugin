import { Notice, Plugin, TFile, debounce } from "obsidian";
import { HttpQueue } from "./api/http";
import type { TickTickClient } from "./api/client";
import { OpenApiClient } from "./api/openApi";
import {
	buildAuthorizeUrl,
	loopbackRedirectUri,
	refreshTokens,
	tokensNeedRefresh,
	type OAuthConfig,
} from "./auth/oauth";
import { DEFAULT_SETTINGS, mergeSettings, type TickTickSyncSettings } from "./settings";
import {
	describeSettingsChanges,
	renderSettingsDocument,
	SETTINGS_NOTE_PATH,
	settingsFromDocument,
} from "./settingsDocument";
import { SyncEngine, type SyncReport } from "./sync/engine";
import {
	PREVIEW_NOTE_PATH,
	previewStore,
	readOnlyClient,
	ReadOnlyNoteRepository,
	refusePersist,
	renderPreviewReport,
} from "./sync/preview";
import { migrateState, SyncStore, type SyncState } from "./sync/state";
import { NoteRepository, registerPropertyTypes } from "./vault/notes";
import { applyHiddenProperties, removeHiddenProperties } from "./vault/hideProperties";
import { TickTickSettingTab } from "./ui/settingsTab";
import { ConfirmDeletionModal } from "./ui/authModal";

interface PersistedData {
	settings: TickTickSyncSettings;
	syncState: SyncState;
}

export default class TickTickSyncPlugin extends Plugin {
	settings: TickTickSyncSettings = { ...DEFAULT_SETTINGS };
	store = new SyncStore();
	queue = new HttpQueue();

	private statusBar: HTMLElement | null = null;
	private timer: number | null = null;

	async onload(): Promise<void> {
		await this.loadPersisted();

		if (this.settings.registerPropertyTypes) {
			registerPropertyTypes(this.app, this.settings.properties, this.settings.dateProperties);
		}

		applyHiddenProperties(this.hiddenPropertyNames());

		this.statusBar = this.addStatusBarItem();
		this.setStatus("idle");

		this.addSettingTab(new TickTickSettingTab(this.app, this));

		this.watchSettingsFile();

		this.addRibbonIcon("checkmark", "Sync TickTick", () => void this.runSync());

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.runSync(),
		});

		this.addCommand({
			id: "sync-active-note",
			name: "Push the active note to TickTick",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.runSync();
				return true;
			},
		});

		this.addCommand({
			id: "preview-sync",
			name: "Preview sync",
			callback: () => void this.previewSync(),
		});

		this.addCommand({
			id: "start-syncing",
			name: "Start syncing",
			checkCallback: (checking) => {
				if (this.settings.syncingStarted) return false;
				if (!checking) void this.startSyncing();
				return true;
			},
		});

		this.addCommand({
			id: "pause-syncing",
			name: "Pause syncing",
			checkCallback: (checking) => {
				if (!this.settings.syncingStarted) return false;
				if (!checking) void this.pauseSyncing();
				return true;
			},
		});

		this.addCommand({
			id: "export-settings",
			name: "Export settings to a note",
			callback: () => void this.exportSettingsNote(),
		});

		this.addCommand({
			id: "import-settings",
			name: "Import settings from the note",
			callback: () => void this.importSettingsNote(),
		});

		this.addCommand({
			id: "reload-settings",
			name: "Reload settings from disk",
			callback: () => void this.reloadSettings(),
		});

		// A vault change means the next scheduled sync has something to do; this
		// only nudges the timer, it never syncs on every keystroke.
		const nudge = debounce(() => this.scheduleSoon(), 5000, true);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.isTaskNote(file)) nudge();
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			this.restartTimer();
			if (this.settings.syncOnStartup && this.settings.syncingStarted && this.isConnected()) {
				void this.runSync({ silent: true });
			}
		});
	}

	onunload(): void {
		removeHiddenProperties();
		this.clearTimer();
	}

	// --- Persistence --------------------------------------------------------

	private async loadPersisted(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<PersistedData>;
		// The stored sync state goes in as well: it is the only evidence of
		// whether this vault has been syncing already, which is what decides
		// whether an upgrade starts started. See `resolveSyncingStarted`.
		this.settings = mergeSettings(raw.settings, raw.syncState);
		this.store = new SyncStore(migrateState(raw.syncState));
	}

	async persist(): Promise<void> {
		const data: PersistedData = { settings: this.settings, syncState: this.store.raw };
		// The watcher must not react to the plugin's own writes — only to edits
		// made from outside. The timestamp outlives the write because the file
		// event arrives after saveData resolves.
		this.ownWriteAt = Date.now();
		await this.saveData(data);
	}

	/** When the plugin itself last wrote data.json; watcher events near it are ours. */
	private ownWriteAt = 0;

	/**
	 * Reload settings automatically when data.json is edited from outside.
	 *
	 * The file is the plugin's real interface for anything the settings tab
	 * cannot express — and before this watcher, an external edit raced the
	 * plugin's own saves: whichever wrote last won, and on 22–23 Aug 2026 that
	 * race silently discarded the same configuration four times in one evening,
	 * each loss surfacing later as tasks in the wrong list. Now the edit simply
	 * takes effect within a moment, announced by a Notice.
	 *
	 * Own writes are ignored via the timestamp above; edits arriving while a
	 * sync runs are deferred until it finishes rather than swapped mid-pass.
	 */
	private watchSettingsFile(): void {
		const adapter = this.app.vault.adapter as { basePath?: string };
		if (!adapter.basePath || !this.manifest.dir) return; // mobile, or unexpected host
		let fs: typeof import("fs");
		try {
			fs = require("fs");
		} catch {
			return;
		}
		const path = `${adapter.basePath}/${this.manifest.dir}/data.json`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const watcher = fs.watch(path, () => {
				if (Date.now() - this.ownWriteAt < 2000) return;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					if (this.syncInFlight) {
						this.reloadAfterSync = true;
						return;
					}
					void this.reloadSettings();
				}, 500);
			});
			this.register(() => watcher.close());
		} catch {
			// A missing file or an unsupported platform just means no watcher.
		}
	}

	private reloadAfterSync = false;

	async saveSettings(): Promise<void> {
		await this.persist();
		this.applySettings();
	}

	/**
	 * Re-reads data.json, so a configuration edited outside Obsidian takes
	 * effect without a restart.
	 *
	 * The file is the plugin's real interface for anything the settings tab
	 * cannot express, and until now editing it meant restarting the app — which
	 * is enough friction that people edit it live instead and lose the changes on
	 * the next save.
	 */
	async reloadSettings(): Promise<void> {
		await this.loadPersisted();
		this.applySettings();
		new Notice("TickTick settings reloaded from disk.");
	}

	/** Everything derived from settings, redone whenever they change. */
	private applySettings(): void {
		if (this.settings.registerPropertyTypes) {
			registerPropertyTypes(this.app, this.settings.properties, this.settings.dateProperties);
		}
		applyHiddenProperties(this.hiddenPropertyNames());
		this.restartTimer();
	}

	// --- Starting and pausing -----------------------------------------------

	/**
	 * Lets scheduled, startup and manual syncs run.
	 *
	 * Separate from connecting because a token proves only that the account can
	 * be reached, and the settings that decide what a sync does to the vault are
	 * all still empty at that point.
	 */
	async startSyncing(): Promise<void> {
		this.settings.syncingStarted = true;
		await this.saveSettings();
		new Notice("TickTick syncing started.");
	}

	async pauseSyncing(): Promise<void> {
		this.settings.syncingStarted = false;
		await this.saveSettings();
		new Notice(
			"TickTick syncing paused. Nothing will be read or written until you start it again.",
		);
	}

	// --- Settings as a note --------------------------------------------------

	/** Writes the current configuration out where it can be read and checked. */
	async exportSettingsNote(): Promise<void> {
		try {
			const file = await this.writePluginNote(
				SETTINGS_NOTE_PATH,
				renderSettingsDocument(this.settings),
			);
			new Notice(`Settings written to ${SETTINGS_NOTE_PATH}. Your credentials are not in it.`);
			await this.openNote(file);
		} catch (error) {
			new Notice(`Could not export settings: ${describeError(error)}`);
		}
	}

	/**
	 * Applies the configuration in the exported note.
	 *
	 * Credentials are taken from what is already installed and the syncing switch
	 * is left alone, so a note that has been passed around cannot hand out
	 * account access or start a sync on its own.
	 */
	async importSettingsNote(): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(SETTINGS_NOTE_PATH);
		if (!(file instanceof TFile)) {
			new Notice(`There is no ${SETTINGS_NOTE_PATH} in this vault. Export your settings first.`);
			return;
		}

		try {
			const next = settingsFromDocument(await this.app.vault.read(file), this.settings);
			const changed = describeSettingsChanges(this.settings, next);
			this.settings = next;
			await this.saveSettings();

			new Notice(
				changed.length === 0
					? "Settings imported — nothing differed from what was already set."
					: `Settings imported. Changed: ${changed.join(", ")}.`,
			);
		} catch (error) {
			new Notice(`Could not import settings: ${describeError(error)}`, 10_000);
		}
	}

	/**
	 * Writes one of the plugin's own notes, creating or replacing it.
	 *
	 * Not through `NoteRepository`: that one merges managed task properties into
	 * whatever it writes, and these are documents about the plugin rather than
	 * tasks.
	 */
	private async writePluginNote(path: string, contents: string): Promise<TFile> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, contents);
			return existing;
		}

		return this.app.vault.create(path, contents);
	}

	private async openNote(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	// --- Client wiring ------------------------------------------------------

	isConnected(): boolean {
		return this.settings.auth.personalToken !== "" || this.settings.auth.tokens !== null;
	}

	oauthConfig(): OAuthConfig {
		return {
			clientId: this.settings.auth.clientId,
			clientSecret: this.settings.auth.clientSecret,
			redirectUri: loopbackRedirectUri(this.settings.auth.loopbackPort),
		};
	}

	authorizeUrl(state: string): string {
		return buildAuthorizeUrl(this.oauthConfig(), state);
	}

	private async accessToken(): Promise<string> {
		const auth = this.settings.auth;

		// A personal token is already a bearer token, so there is nothing to
		// exchange or refresh. It wins over OAuth when both are configured.
		if (auth.personalToken) return auth.personalToken;

		if (!auth.tokens) {
			throw new Error("Not connected to TickTick. Open the plugin settings to connect.");
		}

		if (tokensNeedRefresh(auth.tokens) && auth.tokens.refreshToken) {
			auth.tokens = await refreshTokens(this.queue, this.oauthConfig(), auth.tokens.refreshToken);
			await this.persist();
		}

		return auth.tokens.accessToken;
	}

	createClient(): TickTickClient {
		return new OpenApiClient({
			queue: this.queue,
			getAccessToken: () => this.accessToken(),
		});
	}

	/**
	 * The properties to hide, always including the task id.
	 *
	 * The id is hidden by name, and the name is configurable — so hiding a fixed
	 * string leaves it on screen for anyone whose property is called something
	 * else. It is derived rather than listed for exactly that reason.
	 */
	private hiddenPropertyNames(): string[] {
		return [...new Set([this.settings.properties.id, ...this.settings.hiddenProperties])];
	}

	/**
	 * Trashes every note this plugin created, and reports how many.
	 *
	 * A note counts as ours only if it carries the task-ID property, so anything
	 * hand-written in the same folder is left alone. Files go to the trash rather
	 * than being erased, and nothing is sent to TickTick — this is a local reset
	 * for re-testing the mapping from a clean slate.
	 */
	async deleteSyncedNotes(): Promise<number> {
		const notes = new NoteRepository(this.app, this.settings.properties);
		const idProperty = this.settings.properties.id;
		let removed = 0;

		for (const file of notes.listMarkdown(this.settings.taskFolder)) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.frontmatter?.[idProperty]) continue;
			await notes.delete(file);
			removed++;
		}

		return removed;
	}

	// --- Syncing ------------------------------------------------------------

	/** Held across the whole pass, because the engine is rebuilt for each one. */
	private syncInFlight = false;

	async runSync(options: { silent?: boolean; dryRun?: boolean } = {}): Promise<SyncReport | null> {
		if (!this.isConnected()) {
			if (!options.silent) new Notice("TickTick is not connected yet. Check plugin settings.");
			return null;
		}

		const preview = options.dryRun === true;

		// The gate. A preview is exempt because it cannot write anything, and
		// looking at what a sync would do is exactly how you decide it is safe to
		// let one happen.
		if (!preview && !this.settings.syncingStarted) {
			if (!options.silent) {
				new Notice(
					"TickTick syncing has not been started yet. Finish setting up, run Preview sync to " +
						"check what would happen, then press Start syncing in the plugin settings.",
					10_000,
				);
			}
			return null;
		}

		const engine = new SyncEngine({
			// A preview is not asked to behave; it is given nothing that can write.
			// See `sync/preview.ts` — the guarantee is that a forgotten dry-run
			// check becomes a reported problem rather than an edit to the vault.
			client: preview ? readOnlyClient(this.createClient()) : this.createClient(),
			notes: preview
				? new ReadOnlyNoteRepository(this.app, this.settings.properties)
				: new NoteRepository(this.app, this.settings.properties),
			store: preview ? previewStore(this.store.raw) : this.store,
			settings: this.settings,
			persist: preview ? refusePersist : () => this.persist(),
			log: (message, ...rest) => this.log(message, ...rest),
			confirmDeletion: preview
				? undefined
				: (request) =>
						new Promise<boolean>((resolve) => {
							new ConfirmDeletionModal(this.app, request, resolve).open();
						}),
		});

		// `engine` was built two statements ago, so its own `isRunning` is always
		// false and never guarded anything. The flag has to outlive the engine to
		// mean anything, or the timer firing mid-sync runs a second pass over a
		// vault the first one is still writing to.
		if (this.syncInFlight) return null;
		this.syncInFlight = true;

		this.setStatus("syncing");
		try {
			const report = await engine.sync({ dryRun: options.dryRun });
			this.setStatus("idle");
			if (!options.silent || report.errors.length > 0) {
				new Notice(summarise(report));
			}
			this.log("Sync finished", report);
			return report;
		} catch (error) {
			this.setStatus("error");
			new Notice(`TickTick sync failed: ${describeError(error)}`);
			return null;
		} finally {
			this.syncInFlight = false;
			if (this.reloadAfterSync) {
				this.reloadAfterSync = false;
				void this.reloadSettings();
			}
		}
	}

	/**
	 * Reports what the next sync would do, and writes it where it can be read.
	 *
	 * Deliberately available before syncing has been started: this is the check
	 * that makes starting a reasonable thing to do at all. The report is a note
	 * rather than a modal because a first run against a real vault plans hundreds
	 * of changes, and a list you can scroll and search beside the settings you
	 * are correcting is worth more than one that vanishes on a stray click.
	 */
	async previewSync(): Promise<SyncReport | null> {
		const report = await this.runSync({ silent: true, dryRun: true });
		if (!report) return null;

		try {
			const file = await this.writePluginNote(PREVIEW_NOTE_PATH, renderPreviewReport(report));
			await this.openNote(file);
		} catch (error) {
			new Notice(`Could not write the preview report: ${describeError(error)}`);
		}

		new Notice(
			`TickTick: ${report.planned.length} change(s) planned. Nothing has been written.` +
				(report.errors.length > 0 ? ` ${report.errors.length} problem(s) — see the report.` : ""),
		);

		return report;
	}

	// --- Timer --------------------------------------------------------------

	private restartTimer(): void {
		this.clearTimer();

		// Nothing is scheduled until syncing has been started. `runSync` refuses
		// as well, but a timer that fires every five minutes into a refusal is
		// only a bug waiting for someone to "fix" it by removing the check.
		if (!this.settings.syncingStarted) return;

		const minutes = this.settings.syncIntervalMinutes;
		if (minutes <= 0) return;

		this.timer = window.setInterval(() => void this.runSync({ silent: true }), minutes * 60_000);
		this.registerInterval(this.timer);
	}

	/** Brings the next automatic sync forward after a local edit. */
	private scheduleSoon(): void {
		if (!this.settings.syncingStarted) return;
		if (this.settings.syncIntervalMinutes <= 0) return;
		window.setTimeout(() => void this.runSync({ silent: true }), 10_000);
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
	}

	// --- Helpers ------------------------------------------------------------

	private isTaskNote(file: TFile): boolean {
		const folder = this.settings.taskFolder;
		return file.path === folder || file.path.startsWith(`${folder}/`);
	}

	private setStatus(state: "idle" | "syncing" | "error"): void {
		if (!this.statusBar) return;
		const label =
			state === "syncing" ? "TickTick: syncing…" : state === "error" ? "TickTick: error" : "TickTick";
		this.statusBar.setText(label);
	}

	log(message: string, ...rest: unknown[]): void {
		if (!this.settings.debugLogging) return;
		console.log(`[ticktick-sync] ${message}`, ...rest);
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function summarise(report: SyncReport): string {
	if (report.errors.length > 0) {
		return `TickTick sync finished with ${report.errors.length} error(s). ${report.errors[0]}`;
	}

	const parts: string[] = [];
	const created = report.createdLocal + report.createdRemote;
	const updated = report.updatedLocal + report.updatedRemote;
	const deleted = report.deletedLocal + report.deletedRemote;

	if (created) parts.push(`${created} created`);
	if (updated) parts.push(`${updated} updated`);
	if (deleted) parts.push(`${deleted} deleted`);
	if (report.conflicts) parts.push(`${report.conflicts} conflict(s) resolved`);

	return parts.length > 0 ? `TickTick: ${parts.join(", ")}.` : "TickTick: already up to date.";
}
