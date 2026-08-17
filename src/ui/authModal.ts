import { App, Modal, Setting } from "obsidian";
import type { SyncReport } from "../sync/engine";

/**
 * Shows what a sync would do, without having done any of it.
 *
 * The point of a first run against a real vault is being able to look before
 * anything is written — a list of intended changes is the only way to check the
 * mapping is right while it is still cheap to be wrong.
 */
export class PlannedChangesModal extends Modal {
	constructor(
		app: App,
		private readonly report: SyncReport,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, report } = this;
		contentEl.createEl("h3", { text: "Changes this sync would make" });

		if (report.errors.length > 0) {
			contentEl.createEl("p", {
				text: `${report.errors.length} problem(s) came up while reading:`,
				cls: "mod-warning",
			});
			const errors = contentEl.createEl("ul");
			for (const error of report.errors.slice(0, 20)) errors.createEl("li", { text: error });
		}

		if (report.planned.length === 0) {
			contentEl.createEl("p", { text: "Nothing would change — the two sides already agree." });
			return;
		}

		contentEl.createEl("p", {
			text: `${report.planned.length} change(s). Nothing has been written.`,
		});

		const list = contentEl.createEl("ul");
		// Capped because a first run can plan hundreds; the count above is exact.
		for (const line of report.planned.slice(0, 200)) list.createEl("li", { text: line });
		if (report.planned.length > 200) {
			contentEl.createEl("p", {
				text: `…and ${report.planned.length - 200} more.`,
				cls: "setting-item-description",
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Fallback for when the loopback listener cannot be used — on mobile, or when
 * the port is taken. The user pastes either the raw code or the whole redirected
 * URL from their browser's address bar.
 */
export class PasteCodeModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private readonly onSubmit: (input: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Paste the TickTick authorisation code" });
		contentEl.createEl("p", {
			text:
				"After approving access, your browser was redirected to a page that may not have loaded. " +
				"Copy the whole address from the address bar and paste it below — or just the value of the code parameter.",
		});

		new Setting(contentEl).setName("Code or redirect URL").addText((text) => {
			text.setPlaceholder("http://localhost:8484/callback?code=…");
			text.onChange((value) => (this.value = value));
			text.inputEl.style.width = "100%";
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Connect")
					.setCta()
					.onClick(() => {
						this.onSubmit(this.value);
						this.close();
					}),
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.onSubmit(null);
					this.close();
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
