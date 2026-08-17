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
		const existing = splitFrontmatter(await this.app.vault.read(file));
		const managed = new Set<string>(Object.values(this.properties));

		const merged: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(existing.frontmatter)) {
			if (!managed.has(key)) merged[key] = value;
		}
		Object.assign(merged, note.frontmatter);

		await this.app.vault.modify(file, joinFrontmatter({ frontmatter: merged, body: note.body }));
	}

	async create(path: string, note: NoteContent): Promise<TFile> {
		await this.ensureFolder(parentFolder(path));
		const target = await this.uniquePath(path);
		return this.app.vault.create(target, joinFrontmatter(note));
	}

	async rename(file: TFile, path: string): Promise<TFile> {
		if (file.path === path) return file;
		await this.ensureFolder(parentFolder(path));
		const target = await this.uniquePath(path);
		await this.app.fileManager.renameFile(file, target);
		return file;
	}

	/** Moves the note to the system trash or the vault's .trash, per settings. */
	async delete(file: TFile): Promise<void> {
		await this.app.fileManager.trashFile(file);
	}

	getFile(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return file instanceof TFile ? file : null;
	}

	/** Every markdown file under `folder`, recursively. */
	listMarkdown(folder: string): TFile[] {
		const root = normalizePath(folder);
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path === root || file.path.startsWith(`${root}/`));
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

	/** Appends a numeric suffix when the desired path is taken. */
	private async uniquePath(path: string): Promise<string> {
		const normalised = normalizePath(path);
		if (!this.app.vault.getAbstractFileByPath(normalised)) return normalised;

		const withoutExt = normalised.replace(/\.md$/, "");
		for (let n = 2; n < 1000; n++) {
			const candidate = `${withoutExt} ${n}.md`;
			if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
		}
		return `${withoutExt} ${Date.now()}.md`;
	}
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
