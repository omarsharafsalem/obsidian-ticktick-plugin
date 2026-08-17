import { describe, expect, it } from "vitest";
import { blankTask, type Task } from "../src/api/types";
import {
	mergeSnapshots,
	reconcile,
	snapshotsEqual,
	toSnapshot,
	type ReconcileOptions,
	type TaskSnapshot,
} from "../src/sync/reconcile";

function task(overrides: Partial<Task> = {}): Task {
	return { ...blankTask("p1"), id: "t1", title: "Buy milk", ...overrides };
}

function snap(overrides: Partial<Task> = {}): TaskSnapshot {
	return toSnapshot(task(overrides));
}

const options: ReconcileOptions = {
	conflictPolicy: "newest",
	deleteConflictPolicy: "restore",
	remoteDeletion: "deleteNote",
	noteDeletion: "deleteTask",
	noteConfirmedGone: true,
};

describe("reconcile — creation", () => {
	it("creates remotely when only the note exists", () => {
		expect(reconcile({ local: snap() }, options).kind).toBe("createRemote");
	});

	it("creates locally when only the task exists", () => {
		expect(reconcile({ remote: snap() }, options).kind).toBe("createLocal");
	});

	it("does nothing when neither side has anything", () => {
		expect(reconcile({}, options).kind).toBe("noop");
	});
});

describe("reconcile — updates", () => {
	it("does nothing when both sides match the base", () => {
		const base = snap();
		expect(reconcile({ base, local: snap(), remote: snap() }, options).kind).toBe("noop");
	});

	it("pushes a local-only edit to TickTick", () => {
		const base = snap();
		const action = reconcile(
			{ base, local: snap({ title: "Buy oat milk" }), remote: snap() },
			options,
		);
		expect(action.kind).toBe("updateRemote");
		if (action.kind === "updateRemote") {
			expect(action.snapshot.title).toBe("Buy oat milk");
			expect(action.conflicts).toEqual([]);
		}
	});

	it("pulls a remote-only edit into the vault", () => {
		const base = snap();
		const action = reconcile(
			{ base, local: snap(), remote: snap({ priority: "high" }) },
			options,
		);
		expect(action.kind).toBe("updateLocal");
		if (action.kind === "updateLocal") expect(action.snapshot.priority).toBe("high");
	});

	it("merges edits to different fields without a conflict", () => {
		const base = snap();
		const action = reconcile(
			{
				base,
				local: snap({ title: "Buy oat milk" }),
				remote: snap({ priority: "high" }),
			},
			options,
		);

		expect(action.kind).toBe("updateBoth");
		if (action.kind === "updateBoth") {
			expect(action.conflicts).toEqual([]);
			expect(action.snapshot.title).toBe("Buy oat milk");
			expect(action.snapshot.priority).toBe("high");
		}
	});

	it("does not reopen a task completed remotely", () => {
		// The classic two-way sync bug: without a base, a stale local 'todo'
		// looks like an edit and reopens the task.
		const base = snap({ status: "todo" });
		const action = reconcile(
			{ base, local: snap({ status: "todo" }), remote: snap({ status: "completed" }) },
			options,
		);

		expect(action.kind).toBe("updateLocal");
		if (action.kind === "updateLocal") expect(action.snapshot.status).toBe("completed");
	});
});

describe("reconcile — conflicts", () => {
	const base = snap({ title: "Original" });
	const local = snap({ title: "Local edit" });
	const remote = snap({ title: "Remote edit" });

	it("prefers the newest side when timestamps are available", () => {
		const action = reconcile(
			{ base, local, remote },
			{ ...options, localModifiedAt: 2000, remoteModifiedAt: 1000 },
		);
		expect(action.kind).toBe("updateRemote");
		if (action.kind === "updateRemote") {
			expect(action.snapshot.title).toBe("Local edit");
			expect(action.conflicts).toEqual(["title"]);
		}
	});

	it("falls back to TickTick when no timestamps are available", () => {
		const action = reconcile({ base, local, remote }, options);
		expect(action.kind).toBe("updateLocal");
		if (action.kind === "updateLocal") expect(action.snapshot.title).toBe("Remote edit");
	});

	it("honours an explicit local preference", () => {
		const action = reconcile({ base, local, remote }, { ...options, conflictPolicy: "preferLocal" });
		if (action.kind === "updateRemote") expect(action.snapshot.title).toBe("Local edit");
		else throw new Error(`expected updateRemote, got ${action.kind}`);
	});

	it("treats a first-time link with differing values as a conflict", () => {
		const action = reconcile({ local, remote }, options);
		if (action.kind === "updateLocal" || action.kind === "updateRemote") {
			expect(action.conflicts).toContain("title");
		} else {
			throw new Error(`expected an update action, got ${action.kind}`);
		}
	});
});

describe("reconcile — deletion", () => {
	it("deletes the note when the task was deleted and the note is untouched", () => {
		const base = snap();
		expect(reconcile({ base, local: snap() }, options).kind).toBe("deleteLocal");
	});

	it("deletes the task when the note was deleted and the task is untouched", () => {
		const base = snap();
		expect(reconcile({ base, remote: snap() }, options).kind).toBe("deleteRemote");
	});

	it("restores rather than discarding an edit made to the surviving side", () => {
		const base = snap();
		expect(reconcile({ base, local: snap({ title: "Edited" }) }, options).kind).toBe(
			"restoreRemote",
		);
		expect(reconcile({ base, remote: snap({ title: "Edited" }) }, options).kind).toBe(
			"restoreLocal",
		);
	});

	it("propagates the delete when configured to", () => {
		const base = snap();
		const propagate: ReconcileOptions = { ...options, deleteConflictPolicy: "propagateDelete" };
		expect(reconcile({ base, local: snap({ title: "Edited" }) }, propagate).kind).toBe("deleteLocal");
		expect(reconcile({ base, remote: snap({ title: "Edited" }) }, propagate).kind).toBe(
			"deleteRemote",
		);
	});

	/**
	 * Pruning finished tasks in TickTick is routine housekeeping; the note is
	 * often the only surviving record that the work happened.
	 */
	it("keeps the note when a task is deleted in TickTick", () => {
		const keep: ReconcileOptions = { ...options, remoteDeletion: "keepNote" };
		const base = snap();

		expect(reconcile({ base, local: snap() }, keep).kind).toBe("orphanLocal");
	});

	it("keeps the note even when it was edited since", () => {
		const keep: ReconcileOptions = { ...options, remoteDeletion: "keepNote" };
		const base = snap();

		expect(reconcile({ base, local: snap({ title: "Edited" }) }, keep).kind).toBe("orphanLocal");
	});

	it("does not restore the task in TickTick when keeping the note", () => {
		const keep: ReconcileOptions = { ...options, remoteDeletion: "keepNote" };
		const base = snap();

		// restoreRemote would recreate the task the user just tidied away.
		expect(reconcile({ base, local: snap({ title: "Edited" }) }, keep).kind).not.toBe(
			"restoreRemote",
		);
	});

	it("still deletes a note in TickTick's favour when asked to", () => {
		const mirror: ReconcileOptions = { ...options, remoteDeletion: "deleteNote" };
		const base = snap();

		expect(reconcile({ base, local: snap() }, mirror).kind).toBe("deleteLocal");
	});

	it("keeping notes does not change what happens when the note is deleted", () => {
		const keep: ReconcileOptions = { ...options, remoteDeletion: "keepNote" };
		const base = snap();

		// Deleting the note is still the user asking for the task to go.
		expect(reconcile({ base, remote: snap() }, keep).kind).toBe("deleteRemote");
	});

	/**
	 * The default, and the important one. A note can be missing because its id
	 * property was renamed, a marker rule changed, a folder moved or a read
	 * failed — none of which are deletion, and all of which look identical from
	 * here. Recreating a note is free; recreating a task is not.
	 */
	it("never deletes a task by default — it restores the note instead", () => {
		const safe: ReconcileOptions = { ...options, noteDeletion: "keepTask" };
		const base = snap();

		expect(reconcile({ base, remote: snap() }, safe).kind).toBe("restoreLocal");
	});

	it("does not delete even when asked to, until the note is confirmed gone", () => {
		const unconfirmed: ReconcileOptions = { ...options, noteConfirmedGone: false };
		const base = snap();

		expect(reconcile({ base, remote: snap() }, unconfirmed).kind).toBe("restoreLocal");
	});

	it("deletes only once asked to and confirmed", () => {
		const confirmed: ReconcileOptions = {
			...options,
			noteDeletion: "deleteTask",
			noteConfirmedGone: true,
		};

		expect(reconcile({ base: snap(), remote: snap() }, confirmed).kind).toBe("deleteRemote");
	});

	it("keeping the task does not stop a note being deleted for a gone task", () => {
		const safe: ReconcileOptions = { ...options, noteDeletion: "keepTask" };

		// The two directions are independent: this one is still TickTick's call.
		expect(reconcile({ base: snap(), local: snap() }, safe).kind).toBe("deleteLocal");
	});

	/**
	 * TickTick descriptions are usually empty while a note may hold real writing.
	 * On a first link-up there is no base to say who changed what, so without
	 * this the merge hands the empty side the win and the writing is gone.
	 */
	it("never lets an empty description overwrite a written one", () => {
		const local = snap({ content: "Five paragraphs of context I wrote." });
		const remote = snap({ content: "" });

		const action = reconcile({ local, remote }, options);
		expect(action).toMatchObject({ kind: expect.stringContaining("update") });
		if ("snapshot" in action) {
			expect(action.snapshot.content).toBe("Five paragraphs of context I wrote.");
		}
	});

	it("never lets an empty title overwrite a real one", () => {
		const action = reconcile({ local: snap({ title: "Buy milk" }), remote: snap({ title: "" }) }, options);
		if ("snapshot" in action) expect(action.snapshot.title).toBe("Buy milk");
	});

	it("still lets a real edit replace existing text", () => {
		const base = snap({ content: "old" });
		const action = reconcile(
			{ base, local: snap({ content: "old" }), remote: snap({ content: "new" }) },
			options,
		);
		if ("snapshot" in action) expect(action.snapshot.content).toBe("new");
	});

	it("forgets a task that vanished from both sides", () => {
		expect(reconcile({ base: snap() }, options).kind).toBe("forget");
	});
});

describe("field equality", () => {
	it("ignores tag order and casing", () => {
		expect(snapshotsEqual(snap({ tags: ["a", "B"] }), snap({ tags: ["b", "A"] }))).toBe(true);
	});

	it("ignores trailing whitespace in text", () => {
		expect(snapshotsEqual(snap({ content: "hi  \n" }), snap({ content: "hi" }))).toBe(true);
	});

	it("compares dates as instants, not strings", () => {
		expect(
			snapshotsEqual(
				snap({ dueDate: "2026-08-20T10:00:00.000Z" }),
				snap({ dueDate: "2026-08-20T12:00:00.000+02:00" }),
			),
		).toBe(true);
	});

	it("treats subtask order as significant", () => {
		const a = snap({ items: [{ title: "one", completed: false }, { title: "two", completed: false }] });
		const b = snap({ items: [{ title: "two", completed: false }, { title: "one", completed: false }] });
		expect(snapshotsEqual(a, b)).toBe(false);
	});
});

describe("mergeSnapshots", () => {
	it("reports which fields conflicted", () => {
		const result = mergeSnapshots(
			snap({ title: "base", content: "base" }),
			snap({ title: "local", content: "local" }),
			snap({ title: "remote", content: "base" }),
			options,
		);
		expect(result.conflicts).toEqual(["title"]);
		expect(result.snapshot.content).toBe("local");
	});
});

/**
 * Clearing the sync state must not resurrect work that was tidied away. A note
 * carrying a task id was linked before, so its task being gone means the task
 * was deleted — not that the note is new and needs one.
 */
describe("reconcile — a note that was linked before", () => {
	const options: ReconcileOptions = {
		conflictPolicy: "newest",
		deleteConflictPolicy: "restore",
		remoteDeletion: "keepNote",
		noteDeletion: "keepTask",
	};

	it("does not create a new task for a note whose task is gone", () => {
		const action = reconcile({ local: snap() }, { ...options, localWasLinked: true });
		expect(action.kind).not.toBe("createRemote");
	});

	it("archives it instead, keeping the note", () => {
		const action = reconcile({ local: snap() }, { ...options, localWasLinked: true });
		expect(action.kind).toBe("orphanLocal");
	});

	it("deletes the note instead when told to mirror TickTick", () => {
		const action = reconcile(
			{ local: snap() },
			{ ...options, localWasLinked: true, remoteDeletion: "deleteNote" },
		);
		expect(action.kind).toBe("deleteLocal");
	});

	it("still creates a task for a note that was never linked", () => {
		const action = reconcile({ local: snap() }, { ...options, localWasLinked: false });
		expect(action.kind).toBe("createRemote");
	});
});
