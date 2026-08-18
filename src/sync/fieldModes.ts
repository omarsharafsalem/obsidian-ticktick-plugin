import { SYNCED_FIELDS, type SyncedField } from "../api/types";
import { fieldAllowsPull, fieldAllowsPush, type FieldModes } from "../settings";
import type { TaskSnapshot } from "./reconcile";

/**
 * Applies per-field direction settings by rewriting the inputs to the merge.
 *
 * Rather than teaching the merge about directions, a field that may not travel
 * a given way is made to look already-agreed on that side. The merge then
 * reaches the right answer with no extra rules, because a field that never
 * looks changed can never win.
 *
 * The subtlety is the very first sync of a pair, when there is no agreed state
 * to pin against. Masking alone cannot express "this side still needs writing",
 * so a base value is synthesised for the constrained fields: the side that is
 * *not* allowed to win supplies it, which makes the permitted side read as the
 * edit. `baseFields` records exactly which fields that applies to, so genuinely
 * two-way fields keep their no-base semantics and are still reported as
 * conflicts.
 */
export interface MaskedInputs {
	base: TaskSnapshot | undefined;
	local: TaskSnapshot;
	remote: TaskSnapshot;
	/** Fields for which `base` holds a meaningful value. */
	baseFields: Set<SyncedField>;
}

export function applyFieldModes(
	base: TaskSnapshot | undefined,
	local: TaskSnapshot,
	remote: TaskSnapshot,
	modes: FieldModes,
): MaskedInputs {
	const maskedLocal = { ...local };
	const maskedRemote = { ...remote };
	const synthesisedBase = { ...(base ?? local) } as TaskSnapshot;
	const baseFields = new Set<SyncedField>(base ? SYNCED_FIELDS : []);

	for (const field of SYNCED_FIELDS) {
		const mode = modes[field] ?? "both";
		if (mode === "both") continue;

		const canPush = fieldAllowsPush(mode);
		const canPull = fieldAllowsPull(mode);

		if (base) {
			// Pin the blocked side to the agreed value so it reads as unchanged.
			if (!canPush) assign(maskedLocal, field, base[field]);
			if (!canPull) assign(maskedRemote, field, base[field]);
			continue;
		}

		if (canPush && !canPull) {
			// Obsidian wins: pretend TickTick's current value was agreed, so the
			// local value reads as the edit and gets pushed.
			assign(synthesisedBase, field, remote[field]);
		} else if (canPull && !canPush) {
			assign(synthesisedBase, field, local[field]);
		} else {
			// Disabled entirely: make both sides identical so nothing moves.
			assign(maskedRemote, field, local[field]);
			assign(synthesisedBase, field, local[field]);
		}

		baseFields.add(field);
	}

	return {
		base: base ?? (baseFields.size > 0 ? synthesisedBase : undefined),
		local: maskedLocal,
		remote: maskedRemote,
		baseFields,
	};
}

function assign(target: TaskSnapshot, field: SyncedField, value: unknown): void {
	(target as Record<string, unknown>)[field] = value;
}
