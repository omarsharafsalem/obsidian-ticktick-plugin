import { App, Modal, Setting } from "obsidian";

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
