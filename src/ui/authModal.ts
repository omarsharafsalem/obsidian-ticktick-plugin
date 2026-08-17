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
/**
 * Below any real account password, so this only ever catches a field that was
 * not filled in properly — not a short but genuine one.
 */
const IMPLAUSIBLY_SHORT_PASSWORD = 4;

export class V2LoginModal extends Modal {
	private usernameEl?: HTMLInputElement;
	private passwordEl?: HTMLInputElement;
	private errorEl?: HTMLElement;

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
			this.usernameEl = text.inputEl;
			text.inputEl.autocomplete = "username";
			text.inputEl.addEventListener("keydown", (event) => this.onKeyDown(event));
		});

		new Setting(contentEl).setName("Password").addText((text) => {
			text.inputEl.type = "password";
			this.passwordEl = text.inputEl;
			text.inputEl.autocomplete = "current-password";
			text.inputEl.addEventListener("keydown", (event) => this.onKeyDown(event));
		});

		this.errorEl = contentEl.createEl("p", { cls: "mod-warning" });
		this.errorEl.hide();

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Sign in").setCta().onClick(() => this.submit()))
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.onSubmit(null);
					this.close();
				}),
			);
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.key !== "Enter") return;
		// A password manager's suggestion list also takes Enter, and its keydown
		// reaches us before the value lands in the field. Submitting here would
		// send whatever had been typed so far — one character, in the case that
		// prompted this guard. Let the validation in submit() catch it.
		event.preventDefault();
		this.submit();
	}

	private showError(message: string): void {
		if (!this.errorEl) return;
		this.errorEl.setText(message);
		this.errorEl.show();
	}

	/**
	 * Reads the fields at submit time rather than tracking `onChange`.
	 *
	 * A password filled in by a password manager is often set on the element
	 * directly and never fires an `input` event, so an `onChange` handler would
	 * still hold an empty string. TickTick reports that as
	 * `username_password_not_match`, which looks exactly like a wrong password
	 * and sends you looking in the wrong place.
	 *
	 * The email is trimmed because a pasted address often carries a trailing
	 * space. The password is not, since whitespace can legitimately be part of
	 * one.
	 */
	private submit(): void {
		const username = this.usernameEl?.value.trim() ?? "";
		const password = this.passwordEl?.value ?? "";

		// Never spend a sign-in attempt on a form that cannot succeed. TickTick
		// counts every rejection against the account and locks it after a
		// handful, so a half-filled field must not reach the network.
		if (!username || !password) {
			this.showError("Enter both your email and password before signing in.");
			return;
		}

		if (password.length < IMPLAUSIBLY_SHORT_PASSWORD) {
			this.showError(
				`That password is only ${password.length} character${password.length === 1 ? "" : "s"} — ` +
					"it looks like it was not fully entered. Type it in and press Sign in.",
			);
			return;
		}

		this.onSubmit({ username, password });
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
