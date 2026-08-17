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

/** Username and password prompt for the unofficial v2 sign-on. */
export class V2LoginModal extends Modal {
	private username = "";
	private password = "";

	constructor(
		app: App,
		private readonly onSubmit: (credentials: { username: string; password: string } | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Sign in to TickTick (advanced mode)" });
		contentEl.createEl("p", {
			text:
				"Advanced mode talks to TickTick's internal API, which needs your account password. " +
				"The password is used once to obtain a session token and is not stored.",
			cls: "mod-warning",
		});

		new Setting(contentEl).setName("Email").addText((text) => {
			// Trimmed because an address pasted from a password manager often
			// carries a trailing space, and TickTick reports that as a password
			// mismatch rather than an unknown account. Passwords are left exactly
			// as typed, since whitespace can be part of one.
			text.onChange((value) => (this.username = value.trim()));
		});

		new Setting(contentEl).setName("Password").addText((text) => {
			text.inputEl.type = "password";
			text.onChange((value) => (this.password = value));
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Sign in")
					.setCta()
					.onClick(() => {
						this.onSubmit({ username: this.username, password: this.password });
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
