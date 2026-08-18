import { mergeSettings, type TickTickSyncSettings } from "./settings";

/**
 * Settings as a note you can read before you apply them.
 *
 * A configuration decides what a sync writes across the whole vault, and until
 * now the only way to see one was to click through eight tabs. Exporting it to
 * a note makes it reviewable in one screen — and, more to the point, makes a
 * configuration something that can be handed over, checked, and only then
 * applied, rather than typed straight into the live plugin.
 *
 * Pure on purpose: no Obsidian, no vault. The plugin supplies the file.
 */

/**
 * Where the exported copy is written.
 *
 * The vault root rather than the task folder on purpose: a note filed among the
 * task notes without a task marker on it would be read as a new task and pushed
 * to TickTick, which is a strange way for a safety feature to behave.
 */
export const SETTINGS_NOTE_PATH = "TickTick sync settings.md";

/**
 * Settings that are never exported and never accepted from an import.
 *
 * `auth` because a note that can be pasted anywhere must not carry account
 * access. `syncingStarted` because starting a sync is a decision the user makes
 * with a button, and a file that could flip it would route around the one
 * safeguard that stops an unconfigured first run.
 */
const NEVER_IMPORTED = ["auth", "syncingStarted"] as const;

/** The fence the settings live in, kept parseable rather than pretty. */
const JSON_BLOCK = /```json\s*\r?\n([\s\S]*?)\r?\n```/;

export function renderSettingsDocument(
	settings: TickTickSyncSettings,
	options: { generatedAt?: number } = {},
): string {
	const when = new Date(options.generatedAt ?? Date.now()).toISOString();

	const lines = [
		"# TickTick sync settings",
		"",
		`Exported ${when}. This note is a copy: editing it changes nothing until you run`,
		"**TickTick: Import settings from the note**.",
		"",
		`Syncing is currently **${settings.syncingStarted ? "started" : "not started"}**. That is not`,
		"part of the configuration below and an import cannot change it — start and pause syncing",
		"from the plugin's Connection settings.",
		"",
		"Your API token, OAuth client ID and secret, and any stored OAuth tokens are deliberately",
		"absent, so this note is safe to paste anywhere. An import can never set them either: it",
		"keeps whatever credentials are already installed.",
		"",
		"```json",
		JSON.stringify(exportable(settings), null, "\t"),
		"```",
		"",
	];

	return lines.join("\n");
}

/**
 * Reads the settings block back out of an exported note.
 *
 * Throws with something a person can act on, because the usual cause is a hand
 * edit that broke the JSON and the message is the only clue they get.
 */
export function parseSettingsDocument(markdown: string): Partial<TickTickSyncSettings> {
	const block = JSON_BLOCK.exec(markdown);
	if (!block) {
		throw new Error("No ```json settings block found in that note.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(block[1]);
	} catch (error) {
		throw new Error(
			`The settings block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("The settings block must be a JSON object.");
	}

	return parsed as Partial<TickTickSyncSettings>;
}

/**
 * The settings an exported note describes, with credentials taken from the
 * install rather than the file.
 *
 * Anything the note leaves out falls back to the default, so what you read is
 * the whole configuration — a partial file cannot leave a stale value behind
 * that the note gave no hint of.
 */
export function settingsFromDocument(
	markdown: string,
	current: TickTickSyncSettings,
): TickTickSyncSettings {
	const incoming = parseSettingsDocument(markdown);
	for (const key of NEVER_IMPORTED) delete incoming[key];

	return {
		...mergeSettings(incoming),
		auth: current.auth,
		syncingStarted: current.syncingStarted,
	};
}

/**
 * The top-level settings an import would change, named in plain language.
 *
 * The point of reviewing a configuration before applying it is knowing what
 * moves, so the import says so rather than reporting a silent success.
 */
export function describeSettingsChanges(
	current: TickTickSyncSettings,
	next: TickTickSyncSettings,
): string[] {
	const changed: string[] = [];

	for (const key of Object.keys(next) as Array<keyof TickTickSyncSettings>) {
		if ((NEVER_IMPORTED as readonly string[]).includes(key)) continue;
		if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) changed.push(key);
	}

	return changed;
}

/** Everything but the credentials and the syncing switch. */
function exportable(settings: TickTickSyncSettings): Partial<TickTickSyncSettings> {
	const copy: Partial<TickTickSyncSettings> = { ...settings };
	for (const key of NEVER_IMPORTED) delete copy[key];
	return copy;
}
