/**
 * An in-memory stand-in for the slice of Obsidian's `App` that
 * `NoteRepository` touches.
 *
 * The engine's most dangerous decisions are about files that are missing, so
 * they cannot be checked against the pure modules alone — the whole question is
 * what the engine concludes from a vault and a network that disagree. This is
 * the smallest thing that lets a real `SyncEngine` run in a test.
 */
import { TFile } from "obsidian";

/** Obsidian keeps path, name and basename in step; so does this. */
function place(target: TFile, path: string): TFile {
	target.path = path;
	target.name = path.slice(path.lastIndexOf("/") + 1);
	target.basename = target.name.replace(/\.md$/, "");
	target.extension = "md";
	return target;
}

function file(path: string, mtime: number): TFile {
	const created = place(new TFile(), path);
	created.stat = { mtime, ctime: mtime, size: 0 };
	return created;
}

export class FakeVault {
	private readonly contents = new Map<string, string>();
	private readonly files = new Map<string, TFile>();
	private readonly folders = new Set<string>();

	/** Mtime stamped on the next write, so a test can order the two sides. */
	clock = 1000;

	/** Paths of every note currently in the vault, for readable assertions. */
	get paths(): string[] {
		return [...this.files.keys()].sort();
	}

	seed(path: string, raw: string, mtime = this.clock): TFile {
		const created = file(path, mtime);
		this.files.set(path, created);
		this.contents.set(path, raw);
		return created;
	}

	contentOf(path: string): string {
		return this.contents.get(path) ?? "";
	}

	/** Edits a note the way a user would, and stamps it as newer or older. */
	edit(path: string, replace: (raw: string) => string, mtime = this.clock): void {
		this.contents.set(path, replace(this.contentOf(path)));
		const existing = this.files.get(path);
		if (existing) existing.stat = { ...existing.stat, mtime };
	}

	get app(): unknown {
		return {
			vault: {
				getName: () => "Test vault",
				read: async (target: TFile) => this.contents.get(target.path) ?? "",
				modify: async (target: TFile, data: string) => {
					this.contents.set(target.path, data);
					target.stat = { ...target.stat, mtime: this.clock };
				},
				create: async (path: string, data: string) => {
					if (this.files.has(path)) throw new Error("File already exists.");
					return this.seed(path, data);
				},
				createFolder: async (path: string) => {
					this.folders.add(path);
				},
				getAbstractFileByPath: (path: string) => this.files.get(path) ?? null,
				getMarkdownFiles: () => [...this.files.values()],
				getFiles: () => [...this.files.values()],
			},
			fileManager: {
				renameFile: async (target: TFile, path: string) => {
					const raw = this.contentOf(target.path);
					this.files.delete(target.path);
					this.contents.delete(target.path);
					place(target, path);
					this.files.set(path, target);
					this.contents.set(path, raw);
				},
				trashFile: async (target: TFile) => {
					this.files.delete(target.path);
					this.contents.delete(target.path);
				},
			},
		};
	}
}
