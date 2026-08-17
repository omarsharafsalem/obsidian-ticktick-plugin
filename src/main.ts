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
import { SyncEngine, type SyncReport } from "./sync/engine";
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

		applyHiddenProperties(this.settings.hiddenProperties);

		this.statusBar = this.addStatusBarItem();
		this.setStatus("idle");

		this.addSettingTab(new TickTickSettingTab(this.app, this));

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
			if (this.settings.syncOnStartup && this.isConnected()) {
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
		this.settings = mergeSettings(raw.settings);
		this.store = new SyncStore(migrateState(raw.syncState));
	}

	async persist(): Promise<void> {
		const data: PersistedData = { settings: this.settings, syncState: this.store.raw };
		await this.saveData(data);
	}

	async saveSettings(): Promise<void> {
		await this.persist();
		if (this.settings.registerPropertyTypes) {
			registerPropertyTypes(this.app, this.settings.properties, this.settings.dateProperties);
		}
		applyHiddenProperties(this.settings.hiddenProperties);
		this.restartTimer();
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

	async runSync(options: { silent?: boolean; dryRun?: boolean } = {}): Promise<SyncReport | null> {
		if (!this.isConnected()) {
			if (!options.silent) new Notice("TickTick is not connected yet. Check plugin settings.");
			return null;
		}

		const engine = new SyncEngine({
			client: this.createClient(),
			notes: new NoteRepository(this.app, this.settings.properties),
			store: this.store,
			settings: this.settings,
			persist: () => this.persist(),
			log: (message, ...rest) => this.log(message, ...rest),
			confirmDeletion: (request) =>
				new Promise<boolean>((resolve) => {
					new ConfirmDeletionModal(this.app, request, resolve).open();
				}),
		});

		if (engine.isRunning) return null;

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
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`TickTick sync failed: ${message}`);
			return null;
		}
	}

	// --- Timer --------------------------------------------------------------

	private restartTimer(): void {
		this.clearTimer();
		const minutes = this.settings.syncIntervalMinutes;
		if (minutes <= 0) return;

		this.timer = window.setInterval(() => void this.runSync({ silent: true }), minutes * 60_000);
		this.registerInterval(this.timer);
	}

	/** Brings the next automatic sync forward after a local edit. */
	private scheduleSoon(): void {
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
