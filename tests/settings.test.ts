import { describe, expect, it } from "vitest";
import { mergeSettings } from "../src/settings";

/**
 * Settings written by an older version have to keep working. The status labels
 * moved from one string per status to a list, and reading the old shape as a
 * list threw on every note — 400+ identical errors in one sync.
 */
describe("migrating stored settings", () => {
	it("converts a single status label into a list", () => {
		const merged = mergeSettings({
			labels: {
				status: { todo: "⏳ Not Done", completed: "✅ Done", abandoned: "🚫 Not Doing" },
				priority: { none: "⚪", low: "🔵", medium: "🟡", high: "🔴" },
				reminders: {},
			},
		});

		expect(merged.labels.status.todo).toEqual(["⏳ Not Done"]);
		expect(merged.labels.status.completed).toEqual(["✅ Done"]);
		expect(merged.labels.status.abandoned).toEqual(["🚫 Not Doing"]);
	});

	it("keeps a list that is already a list", () => {
		const merged = mergeSettings({
			labels: { status: { todo: ["🟢 Active", "⏸️ Paused"] } },
		} as never);

		expect(merged.labels.status.todo).toEqual(["🟢 Active", "⏸️ Paused"]);
	});

	it("falls back to the default when the stored value is unusable", () => {
		const merged = mergeSettings({ labels: { status: { todo: 42 } } } as never);
		expect(merged.labels.status.todo).toEqual(["todo"]);
	});

	it("survives settings with no labels at all", () => {
		const merged = mergeSettings({});
		expect(Array.isArray(merged.labels.status.todo)).toBe(true);
		expect(Array.isArray(merged.labels.statusNeutral)).toBe(true);
	});

	it("accepts a neutral list stored as a bare string", () => {
		const merged = mergeSettings({ labels: { statusNeutral: "📦 Archived" } } as never);
		expect(merged.labels.statusNeutral).toEqual(["📦 Archived"]);
	});
});
