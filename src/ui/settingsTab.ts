import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TickTickSyncPlugin from "../main";
import { SETTINGS_NOTE_PATH } from "../settingsDocument";
import {
	SYNCED_FIELDS,
	type Priority,
	type Project,
	type ProjectKind,
	type Section,
	type SyncedField,
	type TaskStatus,
} from "../api/types";
import { awaitLoopbackCode, exchangeAuthCode, extractAuthCode, randomState } from "../auth/oauth";
import {
	DEFAULT_PROPERTIES,
	listSkipReason,
	type FieldSyncMode,
	type PropertyNames,
} from "../settings";
import { emptyState, SyncStore } from "../sync/state";
import { PasteCodeModal, PlannedChangesModal } from "./authModal";

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
	columnId: "Sub-project (section)",
	parentId: "Parent task",
};

const KIND_LABELS: Record<ProjectKind, string> = {
	TASK: "Task lists",
	NOTE: "Notes lists",
};

const PROPERTY_LABELS: Record<keyof PropertyNames, string> = {
	id: "Task ID",
	project: "List",
	subproject: "Sub-project",
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
	children: "Child tasks",
};

/** One value per line, blanks dropped — safe for labels containing spaces and emoji. */
function splitLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

const TABS = [
	{ id: "connection", label: "Connection" },
	{ id: "sync", label: "Sync" },
	{ id: "lists", label: "Lists" },
	{ id: "properties", label: "Properties" },
	{ id: "values", label: "Values" },
	{ id: "directions", label: "What syncs" },
	{ id: "conflicts", label: "Conflicts" },
	{ id: "advanced", label: "Advanced" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export class TickTickSettingTab extends PluginSettingTab {
	/** Lists fetched from TickTick, cached so the tab can redraw without refetching. */
	private projects: Project[] | null = null;

	/**
	 * Sections found in the lists being synced, by list id.
	 *
	 * Fetched with the lists rather than stored, because a section is TickTick's
	 * to rename or remove. They are here so a sub-project can be pointed at its
	 * note — the same wiring a list already has, one level down.
	 */
	private sections = new Map<string, Section[]>();

	/** Survives redraws, so toggling a setting does not throw you back to the top. */
	private activeTab: TabId = "connection";

	constructor(
		app: App,
		private readonly plugin: TickTickSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderTabs(containerEl);
		const body = containerEl.createDiv();

		switch (this.activeTab) {
			case "sync":
				this.renderSync(body);
				break;
			case "lists":
				this.renderLists(body);
				break;
			case "properties":
				this.renderProperties(body);
				break;
			case "values":
				this.renderValues(body);
				break;
			case "directions":
				this.renderFieldDirections(body);
				break;
			case "conflicts":
				this.renderConflicts(body);
				break;
			case "advanced":
				this.renderAdvanced(body);
				break;
			default:
				this.renderConnection(body);
		}
	}

	/**
	 * A row of section buttons. Obsidian has no settings-tab primitive, so this
	 * is a plain button row styled inline — cheaper than shipping a stylesheet
	 * for one control, and it inherits the theme's button colours either way.
	 */
	private renderTabs(root: HTMLElement): void {
		const nav = root.createDiv();
		nav.style.display = "flex";
		nav.style.flexWrap = "wrap";
		nav.style.gap = "0.4em";
		nav.style.marginBottom = "1.5em";

		for (const tab of TABS) {
			const button = nav.createEl("button", { text: tab.label });
			if (tab.id === this.activeTab) button.addClass("mod-cta");
			button.onclick = () => {
				this.activeTab = tab.id;
				this.display();
			};
		}
	}

	// --- Connection ---------------------------------------------------------

	private renderConnection(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Connection" });

		new Setting(root)
			.setName("Personal API token")
			.setDesc(
				"The simplest way to connect. In the TickTick web app: avatar (top left) > Settings > " +
					"Account > API Token. Create one, paste it here, and nothing below is needed. " +
					"Treat it like a password — it grants access to your account.",
			)
			.addText((text) => {
				const hadToken = settings.auth.personalToken !== "";

				text.inputEl.type = "password";
				text.setPlaceholder("Paste your API token");
				text.setValue(settings.auth.personalToken).onChange(async (value) => {
					settings.auth.personalToken = value.trim();
					await this.plugin.saveSettings();
				});

				// Redraw once the field is done, so the OAuth fields below appear or
				// disappear to match. Redrawing on every keystroke would steal focus
				// mid-paste.
				text.inputEl.addEventListener("blur", () => {
					if ((settings.auth.personalToken !== "") !== hadToken) this.display();
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon("rotate-ccw")
					.setTooltip("Clear the token and use OAuth instead")
					.onClick(async () => {
						settings.auth.personalToken = "";
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (settings.auth.personalToken) {
			new Setting(root)
				.setName("Connected")
				.setDesc(
					"Using your personal API token — there is nothing else to authorise. Clear the token " +
						"above to use an app registration instead.",
				);
			this.renderSyncingGate(root);
			return;
		}

		root.createEl("p", {
			text:
				"Or register an app at developer.ticktick.com and set its redirect URI to the address " +
				"below, then paste the credentials here.",
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

		this.renderSyncingGate(root);
	}

	/**
	 * The switch between being connected and actually syncing.
	 *
	 * Pasting a token used to make the plugin live immediately, while everything
	 * that decides what a sync writes — the property names, the value labels, the
	 * task marker, which lists, which folders — was still empty. What that
	 * produces is a vault full of notes to undo by hand, so starting is now its
	 * own decision, taken once the rest is filled in and a preview has been read.
	 */
	private renderSyncingGate(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Syncing" });

		new Setting(root)
			.setName(settings.syncingStarted ? "Syncing is on" : "Syncing has not been started")
			.setDesc(
				settings.syncingStarted
					? "Scheduled, startup and manual syncs all run. Pausing stops every one of them and " +
							"changes nothing in the vault or in TickTick."
					: "No task note is read or written until you start. Work through the tabs above first, " +
							"then run Preview sync — it writes a report of what the first sync would do and " +
							"changes nothing.",
			)
			.addButton((button) => {
				if (settings.syncingStarted) {
					button.setButtonText("Pause syncing").onClick(async () => {
						await this.plugin.pauseSyncing();
						this.display();
					});
					return;
				}

				button
					.setButtonText("Start syncing")
					.setCta()
					.onClick(async () => {
						if (!this.plugin.isConnected()) {
							new Notice("Connect to TickTick first.");
							return;
						}
						await this.plugin.startSyncing();
						this.display();
					});
			})
			.addButton((button) =>
				button.setButtonText("Preview sync").onClick(() => void this.plugin.previewSync()),
			);
	}

	private async connectOAuth(): Promise<void> {
		const { settings } = this.plugin;

		if (settings.auth.personalToken) {
			new Notice("Already connected with your personal API token — nothing to authorise.");
			return;
		}

		if (!settings.auth.clientId || !settings.auth.clientSecret) {
			new Notice(
				"This button is for authorising an app registration. To connect your own account, " +
					"paste a personal API token above instead.",
				10_000,
			);
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

	// --- Sync ---------------------------------------------------------------

	private renderSync(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Sync" });

		if (!settings.syncingStarted) {
			root.createEl("p", {
				cls: "mod-warning",
				text:
					"Syncing has not been started, so none of this is in effect yet. Fill it in, preview " +
					"it, then press Start syncing on the Connection tab.",
			});
		}

		new Setting(root)
			.setName("Mark a note as a task with")
			.setDesc(
				"A property and value that identify a task, e.g. note_type = task. Without this, every " +
					"note in the task folder is treated as a task and would be pushed to TickTick. With " +
					"it, task notes can sit among ordinary ones. A note that already has a task ID stays " +
					"a task regardless.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Property, e.g. note_type")
					.setValue(settings.taskMarker.property)
					.onChange(async (value) => {
						settings.taskMarker.property = value.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addText((text) =>
				text
					.setPlaceholder("Value, e.g. task")
					.setValue(settings.taskMarker.value)
					.onChange(async (value) => {
						settings.taskMarker.value = value.trim() || "task";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Find task notes anywhere in the vault")
			.setDesc(
				"Search the whole vault rather than just the task folder, so a task can live inside the " +
					"project folder it belongs to. Needs the marker above — without it every note in your " +
					"vault would count as a task.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.discoverAnywhere).onChange(async (value) => {
					if (value && !settings.taskMarker.property.trim()) {
						new Notice("Set the task marker property first — otherwise every note is a task.");
						toggle.setValue(false);
						return;
					}
					settings.discoverAnywhere = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Synced part of the note ends at")
			.setDesc(
				"Everything below this line is yours — never read, rewritten or deleted, so a task can " +
					"carry as much writing as it needs without any of it reaching TickTick. The text above " +
					"it is the task's description. Leave blank to sync the whole body.",
			)
			.addText((text) =>
				text
					.setPlaceholder("<!-- ticktick:end -->")
					.setValue(settings.syncedRegionMarker)
					.onChange(async (value) => {
						settings.syncedRegionMarker = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Link back to the note from TickTick")
			.setDesc(
				"Adds a link to the Obsidian note at the end of the TickTick task's description. It is " +
					"stripped again when reading, so it never shows up in the note itself.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.linkBackToNote).onChange(async (value) => {
					settings.linkBackToNote = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Add an alias for titles a filename cannot hold")
			.setDesc(
				"Some titles cannot be a filename — a colon or a slash, or a second task with the " +
					"same name. The real title is always written to the title property; this also adds " +
					"it to the note's aliases, so it can be found in the quick switcher and linked as " +
					"[[the real title]]. Aliases never create links on their own. Existing aliases are " +
					"kept — the plugin only adds, never removes.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.aliasUnrepresentableTitles).onChange(async (value) => {
					settings.aliasUnrepresentableTitles = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Deleted tasks go to")
			.setDesc(
				"When a task is deleted in TickTick its note moves here rather than being deleted — the " +
					"folder is the record. Notes in this folder are never synced again.",
			)
			.addText((text) =>
				text.setValue(settings.deletedTaskFolder).onChange(async (value) => {
					settings.deletedTaskFolder = value.trim() || "🗄️ Archive";
					await this.plugin.saveSettings();
				}),
			);

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
			.setName("Stop if more than this many new tasks")
			.setDesc(
				"Creating tasks is the only thing a sync does that multiplies — a note that stops " +
					"matching its task looks new, so one bad match turns every note into a duplicate. " +
					"Above this count nothing is created and the sync says so instead. 0 removes the limit.",
			)
			.addText((text) =>
				text.setValue(String(settings.maxNewTasksPerSync)).onChange(async (value) => {
					const limit = Number.parseInt(value, 10);
					if (Number.isFinite(limit) && limit >= 0) {
						settings.maxNewTasksPerSync = limit;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(root)
			.setName("Stop if more than this many tasks would be deleted")
			.setDesc(
				"A task is deleted in TickTick when its note is gone — but a note that simply was not " +
					"recognised looks identical. Deleting cannot be undone from here, so past this count " +
					"nothing is deleted and the sync says why. 0 removes the limit.",
			)
			.addText((text) =>
				text.setValue(String(settings.maxDeletedTasksPerSync)).onChange(async (value) => {
					const limit = Number.parseInt(value, 10);
					if (Number.isFinite(limit) && limit >= 0) {
						settings.maxDeletedTasksPerSync = limit;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(root)
			.setName("Pull tasks already completed")
			.setDesc(
				"Off by default. When on, the first sync creates a note for everything completed in the " +
					"last 90 days, which buries your open tasks. A task you complete after it has synced " +
					"updates either way — this only controls the initial backfill.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.syncCompletedTasks).onChange(async (value) => {
					settings.syncCompletedTasks = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Repeating tasks: note per occurrence from")
			.setDesc(
				"Finishing a repeating task rolls the task forward and files a separate record for the " +
					"occurrence you finished. Occurrences at least this many days apart get a note each; " +
					"anything more frequent is logged under a Completions heading in the task's own note, " +
					"so a daily habit does not fill the vault. 7 means weekly and rarer get notes.",
			)
			.addText((text) =>
				text.setValue(String(settings.recurrence.thresholdDays)).onChange(async (value) => {
					const days = Number.parseFloat(value);
					if (Number.isFinite(days) && days >= 0) {
						settings.recurrence.thresholdDays = days;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(root)
			.setName("Override that rule with the property")
			.setDesc(
				"Set this property on a repeating task's note to 'note' or 'log' to decide for that task " +
					"alone. Anything else is ignored and the rule above applies. Never written by the " +
					"plugin — it is yours to set and yours to remove.",
			)
			.addText((text) =>
				text.setValue(settings.recurrence.overrideProperty).onChange(async (value) => {
					settings.recurrence.overrideProperty = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Stop after this many occurrence notes")
			.setDesc(
				"The completed list reaches back 90 days, so the first sync of a task that repeats " +
					"often would create a note per occurrence at once. Past this count the rest are left " +
					"for later syncs. 0 removes the limit.",
			)
			.addText((text) =>
				text
					.setValue(String(settings.recurrence.maxOccurrenceNotesPerSync))
					.onChange(async (value) => {
						const limit = Number.parseInt(value, 10);
						if (Number.isFinite(limit) && limit >= 0) {
							settings.recurrence.maxOccurrenceNotesPerSync = limit;
							await this.plugin.saveSettings();
						}
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

		new Setting(root)
			.addButton((button) =>
				button
					.setButtonText("Sync now")
					.setCta()
					.onClick(() => void this.plugin.runSync()),
			)
			.addButton((button) =>
				button.setButtonText("Preview changes").onClick(async () => {
					const report = await this.plugin.previewSync();
					if (report) new PlannedChangesModal(this.app, report).open();
				}),
			);
	}

	// --- Lists ----------------------------------------------------------------

	/**
	 * Scopes sync to a chosen set of lists. An empty selection means every list,
	 * which is the default and what `SyncEngine.loadProjects` expects.
	 *
	 * The list names have to come from the account, so this needs a connection.
	 * Until then the raw ids are shown, so a selection made earlier is still
	 * visible and clearable offline.
	 */
	private renderLists(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Lists" });

		const summarise = (): string =>
			settings.projectFilter.length === 0
				? "Every list is synced. Select one or more to narrow it — worth doing while testing, so only a spare list is touched."
				: `Syncing ${settings.projectFilter.length} of your lists. Everything else is ignored.`;

		this.renderListKinds(root);

		const setting = new Setting(root).setName("Lists to sync").setDesc(summarise());

		setting.addButton((button) =>
			button.setButtonText(this.projects ? "Refresh lists" : "Load lists").onClick(async () => {
				if (!this.plugin.isConnected()) {
					new Notice("Connect to TickTick first, then load your lists.");
					return;
				}

				button.setDisabled(true).setButtonText("Loading…");
				try {
					const client = this.plugin.createClient();
					this.projects = await client.listProjects();
					if (this.projects.length === 0) new Notice("TickTick returned no lists.");

					// Only for lists actually being synced: sections come from the
					// per-list read, so asking about every list would be a request per
					// list for answers nobody wants.
					this.sections = new Map();
					for (const id of settings.projectFilter) {
						try {
							const { sections } = await client.listTasksInProject(id);
							if (sections.length > 0) this.sections.set(id, sections);
						} catch {
							// A list that will not answer is reported by the sync itself;
							// failing to offer its sections is not worth an error here.
						}
					}
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

		// Whether a list is selected is already visible on its own toggle, so the
		// only reason worth spelling out is the one nothing else on this page
		// shows. Computed from the same function the engine filters on, so the two
		// cannot end up describing different lists.
		const reasonFor = (project: Project): string | undefined =>
			listSkipReason(project, { ...settings, projectFilter: [] });

		const skipped = this.projects.filter((project) => reasonFor(project));
		if (skipped.length > 0) {
			root.createEl("p", {
				cls: "setting-item-description",
				text: `Not synced: ${skipped.map((project) => project.name).join(", ")}. Each says why below.`,
			});
		}

		for (const project of this.projects) {
			const reason = reasonFor(project);

			new Setting(root)
				.setName(reason ? `${project.name} — not synced` : project.name)
				.setDesc(
					(reason ? `${reason} ` : "") +
						(project.kind === "NOTE" ? "A notes list, filed as set above. " : "") +
						"Folder for this list's notes, and the note that represents the project. " +
						"Set a project note and the list property becomes a link to it, so every task " +
						"appears in that note's backlinks. Both are optional.",
				)
				.addText((text) => {
					text.setPlaceholder("Folder for this list");
					text.setValue(settings.listFolders[project.id] ?? "").onChange(async (value) => {
						const folder = value.trim();
						if (folder) settings.listFolders[project.id] = folder;
						else delete settings.listFolders[project.id];
						await this.plugin.saveSettings();
					});
				})
				.addText((text) => {
					text.setPlaceholder("Project note, e.g. Health dashboard");
					text.setValue(settings.listPages[project.id] ?? "").onChange(async (value) => {
						const page = value.trim();
						if (page) settings.listPages[project.id] = page;
						else delete settings.listPages[project.id];
						await this.plugin.saveSettings();
					});
				})
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

			// One row per section, so a sub-project can be pointed at its note the
			// same way its project is. A section is the only container TickTick has
			// below a list, which is what makes it the place a sub-project lives.
			for (const section of this.sections.get(project.id) ?? []) {
				new Setting(root)
					.setClass("ticktick-subproject-row")
					.setName(`↳ ${section.name}`)
					.setDesc(
						"A section of this list, treated as a sub-project. Name the note for it and " +
							"the sub-project property becomes a link, so its tasks show up in that " +
							"note's backlinks.",
					)
					.addText((text) => {
						text.setPlaceholder("Sub-project note");
						text.setValue(settings.listPages[section.id] ?? "").onChange(async (value) => {
							const page = value.trim();
							if (page) settings.listPages[section.id] = page;
							else delete settings.listPages[section.id];
							await this.plugin.saveSettings();
						});
					});
			}
		}
	}

	/**
	 * Routes a list by the kind TickTick already reports it as.
	 *
	 * A vault that tracks tasks usually already has a folder for notes, a folder
	 * for tasks and a property saying which a note is — so rather than making
	 * that a rule to maintain by hand, this joins it to what the account already
	 * knows. Left blank, every list is filed exactly as before.
	 */
	private renderListKinds(root: HTMLElement): void {
		const { settings } = this.plugin;
		const marker = settings.taskMarker.property.trim();

		root.createEl("p", {
			cls: "setting-item-description",
			text:
				"TickTick marks each list as a task list or a notes list. Leave a row blank to file that " +
				"kind as before — the task folder, and the marker value from the Sync tab. " +
				(marker
					? `The note type is written to "${marker}" exactly as typed, so a value carrying an ` +
						"emoji keeps it."
					: "Set the task marker property on the Sync tab first — without one there is nowhere " +
						"to write the note type."),
		});

		for (const kind of ["TASK", "NOTE"] as ProjectKind[]) {
			new Setting(root)
				.setName(KIND_LABELS[kind])
				.setDesc(
					kind === "NOTE"
						? "Where notes lists are filed, and what their notes call themselves — e.g. a notes " +
							"folder and 💭 thought."
						: "Where ordinary task lists are filed, and what their notes call themselves.",
				)
				.addText((text) => {
					text.setPlaceholder(`Folder, default ${settings.taskFolder}`);
					text.setValue(settings.listKinds[kind].folder).onChange(async (value) => {
						settings.listKinds[kind].folder = value.trim();
						await this.plugin.saveSettings();
					});
				})
				.addText((text) => {
					text.setPlaceholder(`Note type, default ${settings.taskMarker.value}`);
					// Not trimmed to a word or lowercased: "📌 task" is the value, emoji
					// and space included, and altering it would stop matching the vault.
					text.setValue(settings.listKinds[kind].noteType).onChange(async (value) => {
						settings.listKinds[kind].noteType = value.trim();
						await this.plugin.saveSettings();
					});
				});
		}
	}

	// --- Values ---------------------------------------------------------------

	/**
	 * Lets an existing vault keep its own vocabulary.
	 *
	 * Renaming the *property* is only half the job: a vault that already tracks
	 * tasks will call things "Done" or "P1", and TickTick stores those as codes.
	 * These are the translations, and they apply in both directions.
	 */
	private renderValues(root: HTMLElement): void {
		const { settings } = this.plugin;
		root.createEl("h2", { text: "Values" });
		root.createEl("p", {
			text:
				"What each TickTick value is called in your notes. Set these to the words your vault " +
				"already uses — they are written into notes and read back out, so a two-way sync still " +
				"sends TickTick the code it expects.",
			cls: "setting-item-description",
		});

		root.createEl("p", {
			text:
				"TickTick knows three statuses and a working vault usually has more, so each one takes a " +
				"list — one value per line. The first line is what gets written when the status actually " +
				"changes; the rest are recognised and left alone. A task sitting at 'Paused' stays " +
				"Paused when its due date moves, because TickTick still calls both of them not-done.",
			cls: "setting-item-description",
		});

		const statusHelp: Record<TaskStatus, string> = {
			todo: "Not done. TickTick stores this as status 0.",
			completed: "Ticked off. TickTick stores this as status 2.",
			abandoned: "Won't do. TickTick stores this as status -1.",
		};

		for (const key of ["todo", "completed", "abandoned"] as TaskStatus[]) {
			new Setting(root)
				.setName(`Status: ${key}`)
				.setDesc(statusHelp[key])
				.addTextArea((text) => {
					text.inputEl.rows = 4;
					text.setValue(settings.labels.status[key].join("\n")).onChange(async (value) => {
						const values = splitLines(value);
						settings.labels.status[key] = values.length > 0 ? values : [key];
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(root)
			.setName("Status: filing only")
			.setDesc(
				"Values that describe filing rather than progress — 'Archived', say. They never change " +
					"anything in TickTick in either direction, because archiving a finished task must not " +
					"reopen it and archiving an open one must not complete it. One per line.",
			)
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text.setValue(settings.labels.statusNeutral.join("\n")).onChange(async (value) => {
					settings.labels.statusNeutral = splitLines(value);
					await this.plugin.saveSettings();
				});
			});

		const priorityHelp: Record<Priority, string> = {
			none: "No priority. TickTick sends 0.",
			low: "TickTick sends 1.",
			medium: "TickTick sends 3.",
			high: "TickTick sends 5.",
		};

		for (const key of ["none", "low", "medium", "high"] as Priority[]) {
			new Setting(root)
				.setName(`Priority: ${key}`)
				.setDesc(priorityHelp[key])
				.addText((text) =>
					text.setValue(settings.labels.priority[key]).onChange(async (value) => {
						settings.labels.priority[key] = value.trim() || key;
						await this.plugin.saveSettings();
					}),
				);

		}

		root.createEl("p", {
			text:
				"Reminders are stored by TickTick as iCal durations — TRIGGER:-PT30M means thirty " +
				"minutes before the task is due. The names below are what appears in your notes; a " +
				"reminder TickTick sends that is not listed here stays as its raw TRIGGER rather than " +
				"being dropped.",
			cls: "setting-item-description",
		});

		for (const trigger of Object.keys(settings.labels.reminders)) {
			new Setting(root)
				.setName(trigger)
				.addText((text) =>
					text.setValue(settings.labels.reminders[trigger]).onChange(async (value) => {
						settings.labels.reminders[trigger] = value.trim() || trigger;
						await this.plugin.saveSettings();
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
			.setName("Due and start show")
			.setDesc(
				"Whether the date properties carry a time. Obsidian applies a property's type by name, " +
					"so this cannot differ per task — choose 'Date and time' if any of your tasks are " +
					"time-blocked. All-day tasks stay marked as all-day either way.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ datetime: "Date and time", date: "Date only" })
					.setValue(settings.dateProperties)
					.onChange(async (value) => {
						settings.dateProperties = value as typeof settings.dateProperties;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Hide these properties")
			.setDesc(
				"Hidden from the Properties panel, one per line. The task ID is always hidden whatever it " +
					"is called, so it does not need listing here: it " +
					"has to stay in the note — it is what re-links a note to its task after a reset — but " +
					"it is machine bookkeeping, not something to read. The value is still in the file, " +
					"visible in Source mode; this only stops it cluttering the panel.",
			)
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text.setValue(settings.hiddenProperties.join("\n")).onChange(async (value) => {
					settings.hiddenProperties = splitLines(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(root)
			.setName("Show times on")
			.setDesc(
				"Whose clock a due time is written on. TickTick tags each task with a timezone, but that " +
					"is often a stale account setting from wherever the account was last used — and a wrong " +
					"one shifts every time by hours. Your own clock is the default, since you are the one " +
					"reading the note. All-day tasks are unaffected either way.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ local: "My timezone", task: "The task's timezone" })
					.setValue(settings.showTimesIn)
					.onChange(async (value) => {
						settings.showTimesIn = value as typeof settings.showTimesIn;
						await this.plugin.saveSettings();
					}),
			);

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
			.setName("Ask before deleting anything")
			.setDesc(
				"Shows a prompt naming what would go and why, on either side. Worth leaving on until " +
					"the plugin has earned your trust — the reason it gives is what makes a wrong " +
					"deletion diagnosable, and it is written to the debug log either way.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.confirmDeletions).onChange(async (value) => {
					settings.confirmDeletions = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("When a note is missing")
			.setDesc(
				"A note can be missing because you deleted it — or because its task ID property was " +
					"renamed, a marker rule changed, a folder moved, or a read failed. All of those look " +
					"identical from here, and only one of them means delete. Keeping the task is the " +
					"default: the note is simply written again, which costs nothing if it was a mistake.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						keepTask: "Keep the task and restore the note",
						deleteTask: "Delete the task in TickTick",
					})
					.setValue(settings.noteDeletion)
					.onChange(async (value) => {
						settings.noteDeletion = value as typeof settings.noteDeletion;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Syncs a note must be missing before deleting its task")
			.setDesc(
				"Only used when the setting above deletes. One pass proves nothing — requiring the same " +
					"answer twice turns a transient miss into a no-op rather than a deletion.",
			)
			.addText((text) =>
				text.setValue(String(settings.passesBeforeDeletingTask)).onChange(async (value) => {
					const passes = Number.parseInt(value, 10);
					if (Number.isFinite(passes) && passes >= 1) {
						settings.passesBeforeDeletingTask = passes;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(root)
			.setName("When a task is deleted in TickTick")
			.setDesc(
				"Clearing out finished tasks in TickTick is housekeeping, and the note is often the only " +
					"record that the work happened — so by default the note stays. It is stamped with the " +
					"date TickTick lost it and stops syncing, rather than being recreated as a new task.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						keepNote: "Keep the note as a record",
						deleteNote: "Delete the note too",
					})
					.setValue(settings.remoteDeletion)
					.onChange(async (value) => {
						settings.remoteDeletion = value as typeof settings.remoteDeletion;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("When both sides changed the same field")
			.setDesc(
				"'Most recently edited' needs per-task modification times, which the Open API does not " +
					"provide, so it currently falls back to preferring TickTick.",
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

		/*
		 * A configuration decides what gets written across the whole vault, and
		 * eight tabs of controls is not a form anyone can check at a glance. As a
		 * note it can be read in one screen, kept, diffed, handed over — and, the
		 * point of it, reviewed before it is applied rather than after.
		 */
		new Setting(root)
			.setName("Settings as a note")
			.setDesc(
				`Writes your configuration to "${SETTINGS_NOTE_PATH}" so it can be read and checked, and ` +
					"reads it back again. Your API token and any OAuth secrets are left out, so the note is " +
					"safe to paste anywhere — and an import can never set them, or start syncing.",
			)
			.addButton((button) =>
				button.setButtonText("Export").onClick(() => void this.plugin.exportSettingsNote()),
			)
			.addButton((button) =>
				button.setButtonText("Import").onClick(async () => {
					await this.plugin.importSettingsNote();
					this.display();
				}),
			);

		new Setting(root)
			.setName("Reload settings from disk")
			.setDesc(
				"Re-reads data.json, so settings edited outside Obsidian take effect without restarting " +
					"it. Anything changed here and not yet saved is discarded.",
			)
			.addButton((button) =>
				button.setButtonText("Reload").onClick(async () => {
					await this.plugin.reloadSettings();
					this.display();
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

		new Setting(root)
			.setName("Rebuild every note")
			.setDesc(
				"For testing a change to the mapping: deletes the notes this plugin created, forgets the " +
					"sync state, and pulls everything again from scratch. Only notes carrying a task ID are " +
					"touched, and they go to your trash rather than being erased. Nothing is deleted in " +
					"TickTick.",
			)
			.addButton((button) => {
				let armed = false;

				button
					.setWarning()
					.setButtonText("Rebuild")
					.onClick(async () => {
						// Two-step rather than a modal: the first press only arms it, so a
						// stray click on a destructive action cannot do anything.
						if (!armed) {
							armed = true;
							button.setButtonText("Click again to confirm");
							window.setTimeout(() => {
								armed = false;
								button.setButtonText("Rebuild");
							}, 5000);
							return;
						}

						button.setDisabled(true).setButtonText("Rebuilding…");
						try {
							const removed = await this.plugin.deleteSyncedNotes();
							this.plugin.store = new SyncStore(emptyState());
							await this.plugin.persist();
							new Notice(`Removed ${removed} note${removed === 1 ? "" : "s"}. Syncing…`);
							await this.plugin.runSync();
						} catch (error) {
							new Notice(
								`Rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						} finally {
							armed = false;
							button.setDisabled(false).setButtonText("Rebuild");
						}
					});
			});
	}
}
