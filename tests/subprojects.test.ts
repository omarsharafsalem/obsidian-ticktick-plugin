import { describe, expect, it } from "vitest";
import { normaliseSection, normaliseTask, serialiseTask } from "../src/api/openApi";
import { blankTask, type Task } from "../src/api/types";
import { DEFAULT_PROPERTIES, DEFAULT_SETTINGS } from "../src/settings";
import { DEFAULT_MAPPER_OPTIONS, noteToTask, taskToNote } from "../src/sync/mapper";
import { dedupeFolders, folderForTask, resolveBinding } from "../src/sync/engine";

const P = DEFAULT_PROPERTIES;

function task(overrides: Partial<Task> = {}): Task {
	return { ...blankTask("p1"), id: "t1", title: "Write the spec", ...overrides };
}

// A TickTick folder is an *area*, and a list is a project — so neither can say
// which sub-project a task belongs to. A section can: it is the only container
// below a list, and it travels with the task on the wire.
describe("reading a section off the wire", () => {
	it("keeps the section's id and its name", () => {
		const t = normaliseTask({
			id: "t1",
			projectId: "p1",
			title: "Probe",
			columnId: "c1",
			columnName: "Sub-project probe",
		});
		expect(t.columnId).toBe("c1");
		expect(t.columnName).toBe("Sub-project probe");
	});

	it("reads the sections a list returns alongside its tasks", () => {
		expect(normaliseSection({ id: "c1", projectId: "p1", name: "Build" })).toEqual({
			id: "c1",
			projectId: "p1",
			name: "Build",
		});
	});
});

describe("writing the sub-project onto a note", () => {
	it("writes the section's name", () => {
		const note = taskToNote(task({ columnId: "c1", columnName: "Build" }));
		expect(note.frontmatter[P.subproject]).toBe("Build");
	});

	it("writes a link when the section has a note, so backlinks gather the work", () => {
		const note = taskToNote(task({ columnId: "c1", columnName: "Build" }), undefined, {
			subprojectLink: { title: "🚀 TickTick Plugin" },
		});
		expect(note.frontmatter[P.subproject]).toBe("[[🚀 TickTick Plugin]]");
	});

	// The rule that matters. `NoteRepository.write` deletes any managed property
	// absent from the write, so a task in no section would otherwise erase a
	// sub-project set by hand — on every single sync, silently.
	it("keeps a sub-project the task itself knows nothing about", () => {
		const note = taskToNote(task(), undefined, { currentSubproject: "[[🚀 TickTick Plugin]]" });
		expect(note.frontmatter[P.subproject]).toBe("[[🚀 TickTick Plugin]]");
	});

	it("writes nothing at all when there is neither a section nor an existing value", () => {
		expect(taskToNote(task()).frontmatter).not.toHaveProperty(P.subproject);
	});

	it("lets the task's own section win over what the note used to say", () => {
		const note = taskToNote(task({ columnId: "c2", columnName: "Ship" }), undefined, {
			currentSubproject: "Build",
		});
		expect(note.frontmatter[P.subproject]).toBe("Ship");
	});
});

describe("reading the sub-project back off a note", () => {
	const parse = (value: string, resolve?: (n: string) => string | undefined) =>
		noteToTask(
			{ frontmatter: { [P.id]: "t1", [P.subproject]: value }, body: "" },
			"Write the spec",
			{ ...DEFAULT_MAPPER_OPTIONS, properties: P, resolveSection: resolve },
		);

	it("resolves a plain name to the section's id", () => {
		expect(parse("Build", (n) => (n === "Build" ? "c1" : undefined)).columnId).toBe("c1");
	});

	it("resolves a link by its target, not its raw text", () => {
		expect(parse("[[Build]]", (n) => (n === "Build" ? "c1" : undefined)).columnId).toBe("c1");
	});

	// Two lists may name a section alike, and filing a task under the wrong
	// sub-project is worse than leaving the property for a person to settle.
	it("refuses to guess when the name resolves to nothing", () => {
		expect(parse("Build", () => undefined).columnId).toBeUndefined();
	});
});

describe("sending the section back", () => {
	it("sends the section when there is one", () => {
		const body = serialiseTask(task({ columnId: "c1" })) as Record<string, unknown>;
		expect(body["columnId"]).toBe("c1");
	});

	// "We could not work out which section" is not "no section". Sending an empty
	// value would move the task out of whatever section it is filed under.
	it("sends nothing when the section is unknown", () => {
		const body = serialiseTask(task()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("columnId");
	});
});

// Both found in live testing, 18 Aug, running file 10 against the real account.
describe("a title a filename cannot hold", () => {
	const P2 = DEFAULT_PROPERTIES;
	const parse = (fm: Record<string, unknown>, filename: string) =>
		noteToTask({ frontmatter: { [P2.id]: "t1", ...fm }, body: "" }, filename, {
			...DEFAULT_MAPPER_OPTIONS,
			properties: P2,
		});

	// noteToTask documented the title property as "an explicit override" and then
	// returned the filename unconditionally, so `Read: chapter 3/4` was flattened
	// to `Read- chapter 3-4` on every push with no way to say otherwise.
	it("uses the title property when the filename is its sanitised form", () => {
		expect(parse({ [P2.title]: "Read: chapter 3/4" }, "Read- chapter 3-4").title).toBe(
			"Read: chapter 3/4",
		);
	});

	it("still lets a genuine rename win", () => {
		expect(parse({ [P2.title]: "Read: chapter 3/4" }, "Something else entirely").title).toBe(
			"Something else entirely",
		);
	});

	it("falls back to the filename when no override is written", () => {
		expect(parse({}, "Buy milk").title).toBe("Buy milk");
	});
});

describe("a note whose filename is not its title", () => {
	const P3 = DEFAULT_PROPERTIES;
	const t = (title: string) => ({ ...blankTask("p1"), id: "t1", title }) as Task;

	const withAlias = { ...DEFAULT_MAPPER_OPTIONS, aliasTitles: true };

	it("records the real title, and leaves aliases alone by default", () => {
		const fm = taskToNote(t("Read: chapter 3/4")).frontmatter;
		expect(fm[P3.title]).toBe("Read: chapter 3/4");
		// `aliases` belongs to the vault, not the plugin: untouched unless asked.
		expect(fm).not.toHaveProperty("aliases");
	});

	it("offers it as an alias once the option is on", () => {
		const fm = taskToNote(t("Read: chapter 3/4"), withAlias).frontmatter;
		expect(fm["aliases"]).toEqual(["Read: chapter 3/4"]);
	});

	// The collision case: `create` deduplicates, so a second task of the same
	// title lands at "… 2.md" and would otherwise read its title back from there.
	it("records the title when the file got a collision suffix", () => {
		const fm = taskToNote(t("Water the plants"), undefined, {
			filenameTitle: "Water the plants 2",
		}).frontmatter;
		expect(fm[P3.title]).toBe("Water the plants");
	});

	it("writes neither when the filename says it plainly", () => {
		const fm = taskToNote(t("Buy milk"), undefined, { filenameTitle: "Buy milk" }).frontmatter;
		expect(fm).not.toHaveProperty(P3.title);
		expect(fm).not.toHaveProperty("aliases");
	});

	// Aliases are the user's list. Adding one must never drop one they wrote.
	it("keeps aliases the user already had", () => {
		const fm = taskToNote(t("Read: chapter 3/4"), withAlias, {
			currentAliases: ["my own nickname"],
		}).frontmatter;
		expect(fm["aliases"]).toEqual(["my own nickname", "Read: chapter 3/4"]);
	});

	it("does not add the same alias twice", () => {
		const fm = taskToNote(t("Read: chapter 3/4"), withAlias, {
			currentAliases: ["Read: chapter 3/4"],
		}).frontmatter;
		expect(fm["aliases"]).toEqual(["Read: chapter 3/4"]);
	});

	it("preserves a user's aliases on a note that needs no override", () => {
		const fm = taskToNote(t("Buy milk"), withAlias, {
			filenameTitle: "Buy milk",
			currentAliases: ["groceries"],
		}).frontmatter;
		// Not rewritten at all — which is what leaves the user's list intact.
		expect(fm).not.toHaveProperty("aliases");
	});
});

// One TickTick list holding work for several projects. The property alone is not
// enough: a project's `.base` gathers with file.inFolder(...), so the note has to
// land inside the project folder or its own views will not see it.
describe("a list shared by several projects", () => {
	const base = { ...DEFAULT_SETTINGS };

	it("sends a section's notes to that section's folder, over the list's", () => {
		const settings = {
			...base,
			listFolders: { list1: "Tasks/Shared", sect1: "🚀 Projects/Alpha/🗂️ Working Folders/✅ Tasks" },
		};
		expect(folderForTask({ projectId: "list1", columnId: "sect1" }, settings)).toBe(
			"🚀 Projects/Alpha/🗂️ Working Folders/✅ Tasks",
		);
	});

	it("falls back to the list's folder for a task in no section", () => {
		const settings = { ...base, listFolders: { list1: "Tasks/Shared" } };
		expect(folderForTask({ projectId: "list1" }, settings)).toBe("Tasks/Shared");
	});

	it("falls back to the list's folder for a section with none of its own", () => {
		const settings = { ...base, listFolders: { list1: "Tasks/Shared" } };
		expect(folderForTask({ projectId: "list1", columnId: "sect9" }, settings)).toBe("Tasks/Shared");
	});
});

// A project note declaring which TickTick list it is, rather than the same fact
// being typed a second time into plugin settings.
describe("a binding declared in the vault", () => {
	const found = (m: Record<string, string[]>) => new Map(Object.entries(m));

	it("links the list to the note that claims it", () => {
		expect(resolveBinding("list1", {}, found({ list1: ["Alpha Project Home"] }))).toBe(
			"Alpha Project Home",
		);
	});

	// Someone who typed it into settings meant it.
	it("lets an explicit setting win", () => {
		expect(
			resolveBinding("list1", { list1: "Chosen By Hand" }, found({ list1: ["Alpha Project Home"] })),
		).toBe("Chosen By Hand");
	});

	// Filing work under a project that may not own it is worse than leaving it unset.
	it("resolves to neither when two notes claim the same list", () => {
		expect(resolveBinding("list1", {}, found({ list1: ["Alpha", "Beta"] }))).toBeUndefined();
	});

	it("is undefined when nothing claims it", () => {
		expect(resolveBinding("list9", {}, found({ list1: ["Alpha"] }))).toBeUndefined();
	});

	it("is undefined for a task with no section", () => {
		expect(resolveBinding(undefined, {}, found({ list1: ["Alpha"] }))).toBeUndefined();
	});
});

// Found in live testing: pointing a list at a folder outside the task folder
// wrote the note there and then lost it, because only the task folder was ever
// scanned. Every folder the plugin can write to has to be one it also reads.
describe("which folders get scanned", () => {
	it("includes a list folder outside the task folder", () => {
		expect(dedupeFolders(["Tasks", "🚀 Projects/Alpha/✅ Tasks"])).toEqual([
			"Tasks",
			"🚀 Projects/Alpha/✅ Tasks",
		]);
	});

	it("drops a folder already covered by one of its parents", () => {
		expect(dedupeFolders(["Tasks", "Tasks/Inbox"])).toEqual(["Tasks"]);
	});

	it("does not mistake a name that merely starts the same for a child", () => {
		expect(dedupeFolders(["Tasks", "TasksArchive"])).toEqual(["Tasks", "TasksArchive"]);
	});

	// An unset folder means "not configured". Treating it as the vault root would
	// read every note in the vault as a candidate task on the strength of a blank box.
	it("drops blanks rather than reading them as the whole vault", () => {
		expect(dedupeFolders(["Tasks", "", "   "])).toEqual(["Tasks"]);
	});

	it("collapses duplicates", () => {
		expect(dedupeFolders(["Tasks", "Tasks", " Tasks "])).toEqual(["Tasks"]);
	});
});

// A note can be a task *and* something else — a study topic that is also
// scheduled. One property answers "the plugin owns this", another answers
// "what kind of note is this". Collapsed into one, a topic note has to choose
// between being recognised by the plugin and being visible in the vault's views.
describe("a task that is also another kind of note", () => {
	const t = () => ({ ...blankTask("p1"), id: "t1", title: "Hyponatraemia" }) as Task;

	it("writes both when they are separate properties", () => {
		const fm = taskToNote(t(), {
			...DEFAULT_MAPPER_OPTIONS,
			marker: { property: "is_task", value: "true" },
			noteType: { property: "note_type", value: "🗺️ topic" },
		}).frontmatter;
		expect(fm["is_task"]).toBe("true");
		expect(fm["note_type"]).toBe("🗺️ topic");
	});

	// The ordinary case, and the default: one property doing both jobs.
	it("writes one when they name the same property", () => {
		const fm = taskToNote(t(), {
			...DEFAULT_MAPPER_OPTIONS,
			marker: { property: "note_type", value: "📌 task" },
			noteType: { property: "note_type", value: "📌 task" },
		}).frontmatter;
		expect(fm["note_type"]).toBe("📌 task");
	});

	// The marker is what the plugin reads back, so it must never be overwritten.
	it("never lets the note type overwrite the marker", () => {
		const fm = taskToNote(t(), {
			...DEFAULT_MAPPER_OPTIONS,
			marker: { property: "note_type", value: "📌 task" },
			noteType: { property: "note_type", value: "🗺️ topic" },
		}).frontmatter;
		expect(fm["note_type"]).toBe("📌 task");
	});

	it("writes nothing extra when no note type is configured", () => {
		const fm = taskToNote(t(), {
			...DEFAULT_MAPPER_OPTIONS,
			marker: { property: "is_task", value: "true" },
			noteType: { property: "", value: "" },
		}).frontmatter;
		expect(fm).not.toHaveProperty("note_type");
	});
});
