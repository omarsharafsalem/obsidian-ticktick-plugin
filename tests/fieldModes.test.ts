import { describe, expect, it } from "vitest";
import { blankTask, type Task } from "../src/api/types";
import { DEFAULT_FIELD_MODES, type FieldModes } from "../src/settings";
import { applyFieldModes } from "../src/sync/fieldModes";
import { reconcile, toSnapshot, type ReconcileOptions, type TaskSnapshot } from "../src/sync/reconcile";

function snap(overrides: Partial<Task> = {}): TaskSnapshot {
	return toSnapshot({ ...blankTask("p1"), id: "t1", title: "Buy milk", ...overrides });
}

const options: ReconcileOptions = {
	conflictPolicy: "newest",
	deleteConflictPolicy: "restore",
	remoteDeletion: "deleteNote",
	noteDeletion: "deleteTask",
	noteConfirmedGone: true,
};

function modes(overrides: Partial<FieldModes>): FieldModes {
	return { ...DEFAULT_FIELD_MODES, ...overrides };
}

/** Runs the same pipeline the engine uses: mask by direction, then reconcile. */
function run(
	base: TaskSnapshot | undefined,
	local: TaskSnapshot,
	remote: TaskSnapshot,
	fieldModes: FieldModes,
) {
	const masked = applyFieldModes(base, local, remote, fieldModes);
	return reconcile(
		{ base: masked.base, local: masked.local, remote: masked.remote },
		{ ...options, baseFields: masked.baseFields },
	);
}

describe("one-way fields", () => {
	it("ignores a local edit to a pull-only field", () => {
		const base = snap({ priority: "none" });
		const action = run(base, snap({ priority: "high" }), snap(), modes({ priority: "toObsidian" }));
		expect(action.kind).toBe("noop");
	});

	it("still pulls a remote edit to a pull-only field", () => {
		const base = snap({ priority: "none" });
		const action = run(base, snap(), snap({ priority: "high" }), modes({ priority: "toObsidian" }));
		expect(action.kind).toBe("updateLocal");
	});

	it("ignores a remote edit to a push-only field", () => {
		const base = snap({ title: "Buy milk" });
		const action = run(base, snap(), snap({ title: "Changed remotely" }), modes({ title: "toTickTick" }));
		expect(action.kind).toBe("noop");
	});

	it("still pushes a local edit to a push-only field", () => {
		const base = snap({ title: "Buy milk" });
		const action = run(base, snap({ title: "Changed locally" }), snap(), modes({ title: "toTickTick" }));
		expect(action.kind).toBe("updateRemote");
	});

	it("ignores edits on both sides of a disabled field", () => {
		const base = snap({ content: "base" });
		const action = run(base, snap({ content: "local" }), snap({ content: "remote" }), modes({ content: "off" }));
		expect(action.kind).toBe("noop");
	});
});

describe("one-way fields on first link", () => {
	it("does not report a conflict for a pull-only field with no base", () => {
		const action = run(
			undefined,
			snap({ priority: "low" }),
			snap({ priority: "high" }),
			modes({ priority: "toObsidian" }),
		);

		if (action.kind === "updateLocal" || action.kind === "updateRemote" || action.kind === "updateBoth") {
			expect(action.conflicts).not.toContain("priority");
			expect(action.snapshot.priority).toBe("high");
		} else {
			expect(action.kind).toBe("noop");
		}
	});

	it("still reports a two-way field as conflicted alongside a one-way one", () => {
		// The synthesised base must not leak into fields that never asked for it.
		const action = run(
			undefined,
			snap({ title: "Local", priority: "low" }),
			snap({ title: "Remote", priority: "high" }),
			modes({ priority: "toObsidian" }),
		);

		if (action.kind === "updateLocal" || action.kind === "updateRemote" || action.kind === "updateBoth") {
			expect(action.conflicts).toEqual(["title"]);
			expect(action.snapshot.priority).toBe("high");
		} else {
			throw new Error(`expected an update action, got ${action.kind}`);
		}
	});

	it("takes the local value for a push-only field with no base", () => {
		const action = run(
			undefined,
			snap({ title: "Local" }),
			snap({ title: "Remote" }),
			modes({ title: "toTickTick" }),
		);
		expect(action.kind).toBe("updateRemote");
		if (action.kind === "updateRemote") expect(action.snapshot.title).toBe("Local");
	});
});

describe("two-way remains the default", () => {
	it("leaves both sides untouched when every field is two-way", () => {
		const base = snap();
		const local = snap({ title: "Local" });
		const remote = snap();
		const masked = applyFieldModes(base, local, remote, DEFAULT_FIELD_MODES);
		expect(masked.local).toEqual(local);
		expect(masked.remote).toEqual(remote);
	});
});
