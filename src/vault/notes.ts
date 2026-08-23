import {
	type App,
	TFile,
	TFolder,
	normalizePath,
	parseYaml,
	stringifyYaml,
} from "obsidian";
import { PROPERTY_TYPES, type PropertyNames } from "../settings";
import { sanitiseFilename, type NoteContent } from "../sync/mapper";

/**
 * All vault I/O for task notes.
 *
 * Keeping YAML handling here means the mapper stays pure, and it gives one
 * place to enforce the rule that matters most: user-authored frontmatter keys
 * we do not manage are preserved verbatim on every write.
 */

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface ReadNote extends NoteContent {
	file: TFile;
	/** Basename without the .md extension, used as the task title. */
	title: string;
	mtime: number;
}

export function splitFrontmatter(raw: string): NoteContent {
	const match = FRONTMATTER_PATTERN.exec(raw);
	if (!match) {
		return { frontmatter: {}, body: raw };
	}

	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(match[1]);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch {
		// Malformed YAML is treated as absent rather than fatal; the sync will
		// re-link this note by scanning and rewrite valid frontmatter.
	}

	return { frontmatter, body: raw.slice(match[0].length) };
}

export function joinFrontmatter(note: NoteContent): string {
	const keys = Object.keys(note.frontmatter);
	if (keys.length === 0) return note.body;

	const yaml = stringifyYaml(note.frontmatter).trimEnd();
	return `---\n${yaml}\n---\n\n${note.body.replace(/^\n+/, "")}`;
}

export class NoteRepository {
	constructor(
		private readonly app: App,
		private readonly properties: PropertyNames,
	) {}

	async read(file: TFile): Promise<ReadNote> {
		const raw = await this.app.vault.read(file);
		const { frontmatter, body } = splitFrontmatter(raw);
		return {
			file,
			frontmatter,
			body,
			title: file.basename,
			mtime: file.stat.mtime,
		};
	}

	/**
	 * Writes managed properties into a note without disturbing anything else.
	 * Keys the plugin manages but that are absent from `note.frontmatter` are
	 * removed; every other key is left exactly as the user wrote it.
	 */
	async write(file: TFile, note: NoteContent): Promise<void> {
		const raw = await this.app.vault.read(file);
		const existing = splitFrontmatter(raw);
		const managed = new Set<string>(Object.values(this.properties));

		const merged: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(existing.frontmatter)) {
			if (!managed.has(key)) merged[key] = value;
		}
		Object.assign(merged, note.frontmatter);

		const next = joinFrontmatter({ frontmatter: merged, body: note.body });
		// A byte-identical write is not a write. Writing it anyway fires the
		// vault's modify event, which the after-edit nudge hears as a user edit,
		// which schedules another sync, which writes identically again — observed
		// live on 23 Aug 2026 as a self-sustaining ~19s sync loop. Skipping the
		// no-op breaks the cycle at its root and costs nothing.
		if (next === raw) return;

		await this.app.vault.modify(file, next);
	}

	async create(path: string, note: NoteContent): Promise<TFile> {
		await this.ensureFolder(parentFolder(path));
		const body = joinFrontmatter(note);
		let target = await this.uniquePath(path);

		// uniquePath asks Obsidian's index, which does not always agree with the
		// filesystem: macOS is case-insensitive while the index is not, and a title
		// carrying emoji or accents can be normalised differently on disk. Rather
		// than predict which, take the rejection as proof the name is taken and
		// step to the next one.
		for (let attempt = 0; attempt < 25; attempt++) {
			try {
				return await this.app.vault.create(target, body);
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
				target = nextCandidate(target);
			}
		}

		throw new Error(`Could not find a free filename for ${path}`);
	}

	async rename(file: TFile, path: string): Promise<TFile> {
		if (file.path === path) return file;
		await this.ensureFolder(parentFolder(path));

		// A file never blocks its own name. Two tasks sharing a title is ordinary —
		// a repeating task's finished occurrences all carry its — and the second one
		// settles at "Water the plants 2". Counting that as taken would walk it one
		// suffix further on every write it was part of, forever.
		const target = await this.uniquePath(path, file.path);
		if (file.path === target) return file;

		await this.app.fileManager.renameFile(file, target);
		return file;
	}

	/** Moves the note to the system trash or the vault's .trash, per settings. */
	async delete(file: TFile): Promise<void> {
		await this.app.fileManager.trashFile(file);
	}

	/** An `obsidian://` link that opens this note, for putting in a TickTick task. */
	noteUrl(file: TFile): string {
		const vault = encodeURIComponent(this.app.vault.getName());
		const path = encodeURIComponent(file.path);
		return `obsidian://open?vault=${vault}&file=${path}`;
	}

	getFile(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return file instanceof TFile ? file : null;
	}

	/** Every markdown file under `folder`, recursively. An empty folder means all. */
	listMarkdown(folder: string): TFile[] {
		const root = normalizePath(folder);
		if (!root || root === "/" || root === ".") return this.app.vault.getMarkdownFiles();

		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path === root || file.path.startsWith(`${root}/`));
	}

	/**
	 * Every note declaring a value for `property`, keyed by that value.
	 *
	 * How a project note says which TickTick list or section it stands for. The
	 * binding belongs on the note it is about rather than in plugin settings: it
	 * is visible when you open the note, it survives a settings reset, and it
	 * travels with the vault.
	 *
	 * Read from Obsidian's own metadata cache where it has one, so an ordinary
	 * vault costs no file reads. Every claim on an id is returned, not the first:
	 * two notes claiming one list is ambiguous however it is resolved, and the
	 * caller reports it rather than picking.
	 */
	async bindingsFor(property: string): Promise<{
		found: Map<string, TFile[]>;
		scanned: number;
		readFromDisk: number;
	}> {
		const found = new Map<string, TFile[]>();
		const key = property.trim();
		if (!key) return { found, scanned: 0, readFromDisk: 0 };

		const files = this.app.vault.getMarkdownFiles();
		let readFromDisk = 0;

		for (const file of files) {
			const cached = this.app.metadataCache?.getFileCache(file);

			// A file Obsidian has not indexed yet has no cache entry at all, which
			// is not the same as one it has indexed and found nothing in. Only the
			// first is worth a read: on a cold start, or for notes written from
			// outside Obsidian, the cache lags and a binding would be invisible
			// through no fault of the note. Files the cache does know are trusted,
			// so an ordinary vault with no bindings costs no reads whatsoever.
			let value: unknown = cached?.frontmatter?.[key];
			if (cached === null || cached === undefined) {
				readFromDisk++;
				try {
					value = splitFrontmatter(await this.app.vault.read(file)).frontmatter[key];
				} catch {
					continue;
				}
			}

			const text = typeof value === "string" ? value.trim() : "";
			if (!text) continue;
			found.set(text, [...(found.get(text) ?? []), file]);
		}

		return { found, scanned: files.length, readFromDisk };
	}

	async ensureFolder(path: string): Promise<void> {
		const normalised = normalizePath(path);
		if (!normalised || normalised === "/" || normalised === ".") return;

		const existing = this.app.vault.getAbstractFileByPath(normalised);
		if (existing instanceof TFolder) return;
		if (existing) return;

		// Create parents first; Obsidian does not do this for us.
		await this.ensureFolder(parentFolder(normalised));
		try {
			await this.app.vault.createFolder(normalised);
		} catch {
			// A concurrent sync may have created it between the check and the call.
		}
	}

	/**
	 * Appends a numeric suffix when the desired path is taken.
	 *
	 * `except` is the path of the file being moved, which must not count against
	 * itself — see {@link rename}.
	 */
	private async uniquePath(path: string, except?: string): Promise<string> {
		const normalised = normalizePath(path);
		const key = (value: string): string => value.normalize("NFC").toLowerCase();

		// Compared case- and Unicode-insensitively, because the filesystem is:
		// on macOS "Buy Milk.md" and "buy milk.md" are the same file, and an
		// accented title can be stored decomposed while the index holds it composed.
		const taken = new Set(this.app.vault.getFiles().map((file) => key(file.path)));
		if (except) taken.delete(key(except));
		const isTaken = (candidate: string): boolean => taken.has(key(candidate));

		if (!isTaken(normalised)) return normalised;

		const withoutExt = normalised.replace(/\.md$/, "");
		for (let n = 2; n < 1000; n++) {
			const candidate = `${withoutExt} ${n}.md`;
			if (!isTaken(candidate)) return candidate;
		}
		return `${withoutExt} ${Date.now()}.md`;
	}
}

/** Obsidian reports a name clash as a plain Error with this message. */
function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && /already exists/i.test(error.message);
}

/** `Buy milk.md` to `Buy milk 2.md`, `Buy milk 2.md` to `Buy milk 3.md`. */
function nextCandidate(path: string): string {
	const withoutExt = path.replace(/\.md$/, "");
	const numbered = /^(.*) (\d+)$/.exec(withoutExt);
	if (!numbered) return `${withoutExt} 2.md`;
	return `${numbered[1]} ${Number(numbered[2]) + 1}.md`;
}

export function parentFolder(path: string): string {
	const normalised = normalizePath(path);
	const index = normalised.lastIndexOf("/");
	return index === -1 ? "" : normalised.slice(0, index);
}

/** Builds the note path for a task, optionally nested under its project. */
export function taskNotePath(
	title: string,
	options: { taskFolder: string; projectName?: string; folderPerProject: boolean },
): string {
	const name = `${sanitiseFilename(title)}.md`;
	const folder =
		options.folderPerProject && options.projectName
			? `${options.taskFolder}/${sanitiseFilename(options.projectName)}`
			: options.taskFolder;
	return normalizePath(`${folder}/${name}`);
}

/**
 * Registers property types with Obsidian so the Properties panel renders a date
 * picker for dates and tag chips for tags instead of plain text.
 *
 * `metadataTypeManager` is not part of the published API, so every call is
 * guarded — a future Obsidian release that drops it degrades to untyped
 * properties rather than breaking the plugin.
 */
export function registerPropertyTypes(
	app: App,
	properties: PropertyNames,
	dateType: "date" | "datetime" = "datetime",
): void {
	const manager = (
		app as unknown as {
			metadataTypeManager?: { setType?: (name: string, type: string) => void };
		}
	).metadataTypeManager;

	if (!manager || typeof manager.setType !== "function") return;

	// A property's type is global to its name, so due and start cannot be a plain
	// date on one task and a datetime on another — hence the single setting.
	const types: Partial<Record<keyof PropertyNames, string>> = {
		...PROPERTY_TYPES,
		due: dateType,
		start: dateType,
	};

	for (const [key, type] of Object.entries(types)) {
		const name = properties[key as keyof PropertyNames];
		if (!name) continue;
		try {
			manager.setType(name, type);
		} catch {
			// Non-fatal: the property still works, it just renders as text.
		}
	}
}
