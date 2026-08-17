import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TickTickSyncPlugin from "../main";
import { SYNCED_FIELDS, type Project, type SyncedField } from "../api/types";
import { ApiError } from "../api/http";
import { v2SignOn } from "../api/v2";
import { awaitLoopbackCode, exchangeAuthCode, extractAuthCode, randomState } from "../auth/oauth";
import { DEFAULT_PROPERTIES, type FieldSyncMode, type PropertyNames } from "../settings";
import { emptyState, SyncStore } from "../sync/state";
import { PasteCodeModal, V2LoginModal } from "./authModal";

const FIELD_LABELS: Record<SyncedField, string> = {
	title: "Title",
	content: "Description",
	status: "Status",
	priority: "Priority",
	tags: "Tags",
	dueDate: "Due date",
	startDate: "Start date",
	isAllDay: "All-day flag",
	reminders: "Reminders",
	repeatFlag: "Recurrence",
	items: "Subtasks",
	projectId: "List",
};

const PROPERTY_LABELS: Record<keyof PropertyNames, string> = {
	id: "Task ID",
	project: "List",
	etag: "Version tag",
	title: "Title override",
	status: "Status",
	priority: "Priority",
	due: "Due date",
	start: "Start date",
	tags: "Tags",
	recurrence: "Recurrence",
	reminders: "Reminders",
	completed: "Completed at",
	parent: "Parent task",
};

/**
 * Turns a sign-on failure into something actionable. TickTick reports both a
 * wrong password and a lockout as HTTP 500, so the raw message is a wall of
 * JSON that does not say what to do next.
 */
function signInFailureMessage(error: unknown): string {
	if (error instanceof ApiError && error.isLockout) {
		return (
			"TickTick has temporarily blocked sign-in after too many failed attempts. " +
			"Wait before trying again, and check the password by signing in at ticktick.com first."
		);
	}

	if (error instanceof ApiError && error.isCredentialFailure) {
		return "TickTick rejected that email or password. Check them at ticktick.com, then try again.";
	}

	return `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
}

export class TickTickSettingTab extends PluginSettingTab {
	/** Lists fetched from TickTick, cached so the tab can redraw without refetching. */
	private projects: Project[] | null = null;

	constructor(
		app: App,
		private readonly plugin: TickTickSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderConnection(containerEl);
		this.renderSync(containerEl);
		this.renderProperties(containerEl);
		this.renderFieldDirections(containerEl);
		this.renderConflicts(containerEl);
		this.renderAdvanced(containerEl);
	}

	// --- Connection ---------------------------------------------------------

	private renderConnection(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Connection" });

		new Setting(root)
			.setName("Advanced mode (unofficial API)")
			.setDesc(
				"Uses TickTick's internal API instead of the official one. Unlocks tags, completed-task " +
					"history and per-task modification times, which make conflict resolution and deletion " +
					"detection far more precise. It is not covered by TickTick's developer terms and can " +
					"break without notice.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.advancedMode).onChange(async (value) => {
					settings.advancedMode = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (settings.advancedMode) {
			this.renderV2Connection(root);
			return;
		}

		root.createEl("p", {
			text:
				"Register an app at developer.ticktick.com and set its redirect URI to the address below, " +
				"then paste the credentials here.",
			cls: "setting-item-description",
		});

		new Setting(root)
			.setName("Redirect URI")
			.setDesc("Copy this into your TickTick app registration exactly.")
			.addText((text) => {
				text.setValue(`http://localhost:${settings.auth.loopbackPort}/callback`);
				text.inputEl.readOnly = true;
			});

		new Setting(root).setName("Client ID").addText((text) =>
			text.setValue(settings.auth.clientId).onChange(async (value) => {
				settings.auth.clientId = value.trim();
				await this.plugin.saveSettings();
			}),
		);

		new Setting(root).setName("Client secret").addText((text) => {
			text.inputEl.type = "password";
			text.setValue(settings.auth.clientSecret).onChange(async (value) => {
				settings.auth.clientSecret = value.trim();
				await this.plugin.saveSettings();
			});
		});

		new Setting(root)
			.setName("Callback port")
			.setDesc("Must match the port in the redirect URI you registered.")
			.addText((text) =>
				text.setValue(String(settings.auth.loopbackPort)).onChange(async (value) => {
					const port = Number.parseInt(value, 10);
					if (Number.isFinite(port) && port > 0 && port < 65536) {
						settings.auth.loopbackPort = port;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(root)
			.setName(settings.auth.tokens ? "Connected" : "Not connected")
			.setDesc(
				settings.auth.tokens
					? "Obsidian holds an access token for your TickTick account."
					: "Authorise Obsidian to read and write your TickTick tasks.",
			)
			.addButton((button) =>
				button
					.setButtonText(settings.auth.tokens ? "Reconnect" : "Connect")
					.setCta()
					.onClick(() => void this.connectOAuth()),
			)
			.addButton((button) =>
				button
					.setButtonText("Disconnect")
					.setDisabled(!settings.auth.tokens)
					.onClick(async () => {
						settings.auth.tokens = null;
						await this.plugin.saveSettings();
						this.display();
					}),
			);
	}

	private renderV2Connection(root: HTMLElement): void {
		const { settings } = this.plugin;

		new Setting(root)
			.setName(settings.v2Session ? "Signed in" : "Not signed in")
			.setDesc(
				settings.v2Session
					? "A session token is stored for the internal API."
					: "Sign in with your TickTick email and password.",
			)
			.addButton((button) =>
				button
					.setButtonText(settings.v2Session ? "Sign in again" : "Sign in")
					.setCta()
					.onClick(() => this.connectV2()),
			)
			.addButton((button) =>
				button
					.setButtonText("Sign out")
					.setDisabled(!settings.v2Session)
					.onClick(async () => {
						settings.v2Session = null;
						await this.plugin.saveSettings();
						this.display();
					}),
			);
	}

	private async connectOAuth(): Promise<void> {
		const { settings } = this.plugin;
		if (!settings.auth.clientId || !settings.auth.clientSecret) {
			new Notice("Enter your TickTick client ID and secret first.");
			return;
		}

		const state = randomState();
		window.open(this.plugin.authorizeUrl(state), "_blank");

		const code = await awaitLoopbackCode(settings.auth.loopbackPort, state);
		if (code) {
			await this.finishOAuth(code);
			return;
		}

		// Loopback unavailable (mobile) or timed out — fall back to pasting.
		new PasteCodeModal(this.app, (input) => {
			if (!input) return;
			const parsed = extractAuthCode(input);
			if (!parsed) {
				new Notice("Could not find an authorisation code in that text.");
				return;
			}
			void this.finishOAuth(parsed);
		}).open();
	}

	private async finishOAuth(code: string): Promise<void> {
		try {
			const tokens = await exchangeAuthCode(this.plugin.queue, this.plugin.oauthConfig(), code);
			this.plugin.settings.auth.tokens = tokens;
			await this.plugin.saveSettings();
			new Notice("Connected to TickTick.");
			this.display();
		} catch (error) {
			new Notice(`Could not connect: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private connectV2(): void {
		new V2LoginModal(this.app, (credentials) => {
			if (!credentials) return;
			void (async () => {
				try {
					const session = await v2SignOn(
						this.plugin.queue,
						credentials.username,
						credentials.password,
					);
					this.plugin.settings.v2Session = session;
					await this.plugin.saveSettings();
					new Notice("Signed in to TickTick.");
					this.display();
				} catch (error) {
					new Notice(signInFailureMessage(error), 15_000);
				}
			})();
		}).open();
	}

	// --- Sync ---------------------------------------------------------------

	private renderSync(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Sync" });

		new Setting(root)
			.setName("Task folder")
			.setDesc("Every task becomes one note inside this folder.")
			.addText((text) =>
				text.setValue(settings.taskFolder).onChange(async (value) => {
					settings.taskFolder = value.trim() || "Tasks";
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Subfolder per list")
			.setDesc("Mirror your TickTick lists as folders.")
			.addToggle((toggle) =>
				toggle.setValue(settings.folderPerProject).onChange(async (value) => {
					settings.folderPerProject = value;
					await this.plugin.saveSettings();
				}),
			);

		this.renderListFilter(root);

		new Setting(root)
			.setName("Sync every")
			.setDesc(
				"Minutes between automatic syncs. TickTick has no webhooks, so changes are found by " +
					"polling. Set to 0 to sync only on demand.",
			)
			.addText((text) =>
				text.setValue(String(settings.syncIntervalMinutes)).onChange(async (value) => {
					const minutes = Number.parseInt(value, 10);
					if (Number.isFinite(minutes) && minutes >= 0) {
						settings.syncIntervalMinutes = minutes;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(root).setName("Sync on startup").addToggle((toggle) =>
			toggle.setValue(settings.syncOnStartup).onChange(async (value) => {
				settings.syncOnStartup = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(root)
			.setName("Completed tasks")
			.setDesc("What to do with a note once its task is completed.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ keep: "Keep in place", archive: "Move to archive folder", delete: "Delete note" })
					.setValue(settings.completedHandling)
					.onChange(async (value) => {
						settings.completedHandling = value as typeof settings.completedHandling;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root).setName("Archive folder").addText((text) =>
			text.setValue(settings.archiveFolder).onChange(async (value) => {
				settings.archiveFolder = value.trim() || "Tasks/Archive";
				await this.plugin.saveSettings();
			}),
		);

		new Setting(root).addButton((button) =>
			button
				.setButtonText("Sync now")
				.setCta()
				.onClick(() => void this.plugin.runSync()),
		);
	}

	// --- List filter --------------------------------------------------------

	/**
	 * Scopes sync to a chosen set of lists. An empty selection means every list,
	 * which is the default and what `SyncEngine.loadProjects` expects.
	 *
	 * The list names have to come from the account, so this needs a connection.
	 * Until then the raw ids are shown, so a selection made earlier is still
	 * visible and clearable offline.
	 */
	private renderListFilter(root: HTMLElement): void {
		const { settings } = this.plugin;

		const summarise = (): string =>
			settings.projectFilter.length === 0
				? "Every list is synced. Select one or more to narrow it — worth doing while testing, so only a spare list is touched."
				: `Syncing ${settings.projectFilter.length} of your lists. Everything else is ignored.`;

		const setting = new Setting(root).setName("Lists to sync").setDesc(summarise());

		setting.addButton((button) =>
			button.setButtonText(this.projects ? "Refresh lists" : "Load lists").onClick(async () => {
				if (!this.plugin.isConnected()) {
					new Notice("Connect to TickTick first, then load your lists.");
					return;
				}

				button.setDisabled(true).setButtonText("Loading…");
				try {
					this.projects = await this.plugin.createClient().listProjects();
					if (this.projects.length === 0) new Notice("TickTick returned no lists.");
					this.display();
				} catch (error) {
					new Notice(
						`Could not load lists: ${error instanceof Error ? error.message : String(error)}`,
					);
					button.setDisabled(false).setButtonText("Load lists");
				}
			}),
		);

		setting.addExtraButton((button) =>
			button
				.setIcon("rotate-ccw")
				.setTooltip("Clear the selection and sync every list")
				.onClick(async () => {
					settings.projectFilter = [];
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		if (!this.projects) {
			if (settings.projectFilter.length > 0) {
				root.createEl("p", {
					cls: "setting-item-description",
					text: `Limited to list ${settings.projectFilter.join(", ")}. Load your lists to see names.`,
				});
			}
			return;
		}

		for (const project of this.projects) {
			new Setting(root)
				.setName(project.name)
				.setDesc(project.closed ? `${project.id} · archived in TickTick` : project.id)
				.addToggle((toggle) =>
					toggle.setValue(settings.projectFilter.includes(project.id)).onChange(async (value) => {
						const selected = new Set(settings.projectFilter);
						if (value) selected.add(project.id);
						else selected.delete(project.id);
						settings.projectFilter = [...selected];
						await this.plugin.saveSettings();
						// Keep the summary above honest without redrawing the whole tab.
						setting.setDesc(summarise());
					}),
				);
		}
	}

	// --- Properties ---------------------------------------------------------

	private renderProperties(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Properties" });
		root.createEl("p", {
			text:
				"Each TickTick field maps to a real Obsidian property, editable in the Properties panel " +
				"and queryable from Dataview or Bases. Rename any of them to match your vault.",
			cls: "setting-item-description",
		});

		new Setting(root)
			.setName("Register property types")
			.setDesc(
				"Tell Obsidian that dates are dates and tags are tags, so the Properties panel shows a " +
					"date picker and tag chips instead of plain text.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.registerPropertyTypes).onChange(async (value) => {
					settings.registerPropertyTypes = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Read tags from the note body")
			.setDesc(
				"Also treat #hashtags written anywhere in the note as task tags. Emoji tags such as " +
					"#errands🛒 are parsed correctly, including skin tones, flags and joined sequences.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.inlineTags).onChange(async (value) => {
					settings.inlineTags = value;
					await this.plugin.saveSettings();
				}),
			);

		for (const key of Object.keys(PROPERTY_LABELS) as Array<keyof PropertyNames>) {
			new Setting(root)
				.setName(PROPERTY_LABELS[key])
				.setDesc(`Default: ${DEFAULT_PROPERTIES[key]}`)
				.addText((text) =>
					text.setValue(settings.properties[key]).onChange(async (value) => {
						settings.properties[key] = value.trim() || DEFAULT_PROPERTIES[key];
						await this.plugin.saveSettings();
					}),
				);
		}
	}

	// --- Field directions ---------------------------------------------------

	private renderFieldDirections(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "What syncs, and which way" });
		root.createEl("p", {
			text: "Control each field independently. Anything set to one-way never overwrites the other side.",
			cls: "setting-item-description",
		});

		for (const field of SYNCED_FIELDS) {
			new Setting(root).setName(FIELD_LABELS[field]).addDropdown((dropdown) =>
				dropdown
					.addOptions({
						both: "Two-way",
						toObsidian: "TickTick → Obsidian",
						toTickTick: "Obsidian → TickTick",
						off: "Do not sync",
					})
					.setValue(settings.fieldModes[field])
					.onChange(async (value) => {
						settings.fieldModes[field] = value as FieldSyncMode;
						await this.plugin.saveSettings();
					}),
			);
		}
	}

	// --- Conflicts ----------------------------------------------------------

	private renderConflicts(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Conflicts" });

		new Setting(root)
			.setName("When both sides changed the same field")
			.setDesc(
				"'Most recently edited' needs modification times, which only advanced mode provides; " +
					"on the official API it falls back to preferring TickTick.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						newest: "Most recently edited wins",
						preferRemote: "TickTick wins",
						preferLocal: "Obsidian wins",
					})
					.setValue(settings.conflictPolicy)
					.onChange(async (value) => {
						settings.conflictPolicy = value as typeof settings.conflictPolicy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("When one side was deleted and the other edited")
			.setDesc("Restoring is the safe default: an edit is never silently thrown away.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						restore: "Recreate the deleted side",
						propagateDelete: "Delete both",
					})
					.setValue(settings.deleteConflictPolicy)
					.onChange(async (value) => {
						settings.deleteConflictPolicy = value as typeof settings.deleteConflictPolicy;
						await this.plugin.saveSettings();
					}),
			);
	}

	// --- Advanced -----------------------------------------------------------

	private renderAdvanced(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Advanced" });

		new Setting(root)
			.setName("Debug logging")
			.setDesc("Write sync detail to the developer console.")
			.addToggle((toggle) =>
				toggle.setValue(settings.debugLogging).onChange(async (value) => {
					settings.debugLogging = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Reset sync state")
			.setDesc(
				"Forgets which note maps to which task. Nothing is deleted — the next sync re-links by " +
					"task ID and treats every pair as a first-time link.",
			)
			.addButton((button) =>
				button
					.setWarning()
					.setButtonText("Reset")
					.onClick(async () => {
						this.plugin.store = new SyncStore(emptyState());
						await this.plugin.persist();
						new Notice("Sync state reset.");
					}),
			);
	}
}
