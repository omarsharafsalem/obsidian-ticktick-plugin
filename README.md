# TickTick Task Notes for Obsidian

Two-way sync between TickTick and an Obsidian vault, where **every task is its own note** and
**every TickTick field is a real Obsidian property**.

Built because the existing plugins put tasks inline as `- [ ]` checkboxes in the Tasks-plugin emoji
format, which means a task cannot carry backlinks, its own body, or typed properties — and because
their tag parsing silently drops emoji.

## What makes this different

### One note per task

Each task is a markdown file. That means a task can be linked to, embedded, tagged, and can hold as
much written context as you like — the note *is* the task, not a line inside someone else's note.

```markdown
---
ticktick_id: 6247ee29c0dbb1f2a3c4d5e6
list: 6226ff9877acee1234567890
status: todo
priority: high
due: 2026-08-20
tags:
  - errands🛒
  - home
recurrence: RRULE:FREQ=WEEKLY;BYDAY=MO
---

Semi-skimmed, two litres. Ask about the oat one.

## Subtasks

- [x] Check the fridge
- [ ] Bring a bag
```

### Real Obsidian properties, not text in the body

`priority`, `due`, `start`, `tags`, `recurrence`, `reminders` and `completed` are frontmatter
properties. They appear in the Properties panel, they are editable there, and they are queryable
from Dataview and Bases without parsing prose.

The plugin also registers property *types* with Obsidian, so `due` renders as a date picker and
`tags` renders as tag chips rather than plain text. Every property name is configurable in settings,
so they can match conventions your vault already uses.

### Tag parsing that understands emoji

The tag pattern used by other TickTick plugins is:

```js
/(^|\s)#[\p{L}\p{N}_/-]+/gu
```

`\p{L}` is letters and `\p{N}` is numbers. Neither matches emoji, so `#work🔥` silently truncates to
`work` and `#🛒` does not match at all.

Emoji live in `\p{Extended_Pictographic}`, and a single visible emoji is often a *sequence* — a base
character plus skin-tone modifiers, variation selectors, zero-width joiners, keycap marks, regional
indicator pairs, or tag characters for subdivision flags. All of them have to be in the character
class or the tag is cut short at the first one. This plugin handles all of those cases, with tests
covering each:

| Input | Other plugins | This plugin |
| --- | --- | --- |
| `#pets🐕` | `pets` | `pets🐕` |
| `#🛒` | *(no match)* | `🛒` |
| `#🔥urgent` | *(no match)* | `🔥urgent` |
| `#love❤️` | `love` | `love❤️` |
| `#ok👍🏽` | `ok` | `ok👍🏽` |
| `#priority1️⃣` | `priority1` | `priority1️⃣` |
| `#trip🇩🇪` | `trip` | `trip🇩🇪` |

Headings, URL fragments, inline code and fenced code blocks are correctly excluded.

### Per-field direction control

Like Notion's TickTick integration, each field can be set independently to two-way,
TickTick → Obsidian, Obsidian → TickTick, or off. A field set to one-way never overwrites the other
side.

## How sync correctness works

TickTick has **no webhooks**, so changes are found by polling on a timer. The interval is
configurable; instant sync is not possible with this API.

The part that matters is what happens when both sides have changed. This plugin keeps a record of
the state both sides agreed on at the end of the last sync (the *base*) and does a **three-way
merge, field by field**:

| Local vs base | Remote vs base | Result |
| --- | --- | --- |
| changed | unchanged | push local |
| unchanged | changed | pull remote |
| changed | changed, same value | nothing to do |
| changed | changed, different value | conflict → resolved by policy |

Without a base, a two-way sync can only guess — which is how a task completed on your phone quietly
reopens itself because the vault still held a stale `todo`. There is a regression test for exactly
that case.

Edits to *different* fields of the same task merge cleanly instead of one side clobbering the other.

### Deletions

A task that disappears from a listing may have been deleted, completed, or moved. The plugin fetches
it directly to tell the difference: a 404 means deleted, anything else means it still exists. A
task that fails to fetch is treated as still present, so a transient network error never deletes a
note.

When one side was deleted while the other was edited, the default is to **restore** rather than
delete, so an edit is never silently thrown away. This is configurable.

Deliberate deletions are recorded as tombstones so a deleted task is not re-created by the next pull
before the delete has propagated.

## Which API this uses

The **official Open API**, and only that. An earlier version also offered an "advanced mode" that
spoke TickTick's internal `/api/v2`; it has been removed. Reading the Open API documentation
properly showed that it already covers almost everything advanced mode was there for:

| | Open API |
| --- | --- |
| List completed tasks | `POST /open/v1/task/completed` |
| Search | `POST /open/v1/task/search` |
| Tag vocabulary | `GET /open/v1/tag` |
| Inbox | `POST /open/v1/task/filter` with `projectIds: ["inbox"]` |
| Per-task modification time | **not available** |

That last row is the only genuine gap, and it affects one thing: when both sides changed the *same*
field of the same task between syncs, "most recently edited wins" has nothing to compare. Everything
else — the three-way merge, per-field direction control, deletion detection — is unaffected.

Against that, the internal API is unofficial, outside TickTick's developer terms, can break without
notice, and its sign-on endpoint rate-limits by IP aggressively enough to lock an account out after
a handful of attempts. Not a trade worth making for one tie-break rule.

## Setup

### Personal API token (recommended)

1. Open the [TickTick web app](https://ticktick.com/webapp/).
2. Click your avatar (top left) → **Settings** → **Account** → **API Token**.
3. Create a token and paste it into **Personal API token** in the plugin settings.

That is the whole setup — no app registration, no client ID or secret, no redirect URI, and no
password. Treat the token like a password: it grants access to your account.

### Nothing syncs until you start it

Pasting the token **connects only**. No task note is read or written — no scheduled sync, no sync on
startup, no manual sync — until you press **Start syncing** on the Connection tab.

That is deliberate. What a sync actually does to a vault is decided by the property names, the value
labels, the task marker, which lists and which folders, and all of them are empty when the token
goes in. A sync that runs first writes notes across the vault that then have to be undone by hand.

Loading your lists still works while syncing is stopped, because choosing them is part of the setup
this is protecting. Upgrading an install that has already been syncing does not switch it off: its
own sync state says it has synced before, and it stays started.

**Pause syncing** stops everything again and changes nothing on either side.

### Checking a configuration before it runs

| Command | What it does |
| --- | --- |
| **Preview sync** | Reports what the next sync would do, note by note — created, updated, moved, orphaned, deleted — and writes it to `TickTick sync preview.md`. Changes nothing, and works before syncing has been started |
| **Export settings to a note** | Writes your configuration to `TickTick sync settings.md`, so it can be read in one screen rather than clicked through in eight tabs. Credentials are left out, so the note is safe to paste anywhere |
| **Import settings from the note** | Applies that note, and says which settings changed. It can never set credentials or start syncing — those come from what is already installed |
| **Reload settings from disk** | Re-reads `data.json`, so settings edited outside Obsidian take effect without restarting it |

A preview is not trusted to behave: it is handed a client that refuses every write, a note
repository that refuses every write, and a throwaway copy of the sync state. A write it attempted
anyway would appear in the report's problem list instead of in your vault.

### OAuth

Only needed to authorise accounts other than your own.

1. Register an app at [developer.ticktick.com](https://developer.ticktick.com).
2. Set its redirect URI to `http://localhost:8484/callback` (the port is configurable in settings).
3. Paste the client ID and secret into the plugin settings and press **Connect**.

On desktop the plugin listens on the loopback port and completes the handshake automatically. On
mobile, or if the port is taken, it falls back to pasting the redirected URL.

## Development

```bash
npm install
npm run dev        # watch build
npm run build      # typecheck + production bundle
npm test           # unit tests
```

To try it in a vault, symlink or copy `main.js`, `manifest.json` and `styles.css` (if present) into
`<vault>/.obsidian/plugins/ticktick-sync/`.

### Layout

| Path | Responsibility |
| --- | --- |
| `src/api/` | The TickTick client — `openApi.ts`, wire-format normalisation, and a rate-limiting request queue. All timezone handling lives here, so nothing above it needs to know about zones |
| `src/auth/` | OAuth2 authorisation-code flow, token refresh, loopback listener |
| `src/sync/reconcile.ts` | Three-way merge. All "who wins" policy lives here, as pure functions |
| `src/sync/fieldModes.ts` | Per-field direction rules, applied by rewriting the merge inputs |
| `src/sync/mapper.ts` | Task ↔ note translation. Pure: no Obsidian imports, no filesystem |
| `src/sync/engine.ts` | Orchestration and I/O only — it holds no policy of its own |
| `src/sync/state.ts` | The agreed-state store, ID map and tombstones |
| `src/sync/preview.ts` | The dry run's read-only client, vault and store, and the report it writes |
| `src/settingsDocument.ts` | Settings to and from a readable note. Pure: no Obsidian, no vault |
| `src/util/tags.ts` | Unicode-aware tag parsing |
| `src/vault/` | Vault I/O, YAML frontmatter, property type registration |

The policy modules are pure by design, so conflict behaviour is testable without a vault or a
network. 235 unit tests cover tag parsing, the mapper round-trip, merge decisions, direction rules,
wire-format normalisation, all-day dates across timezones, the request queue's retry rules, the
upgrade path for an install that was already syncing, and the dry run's inability to write.

## Status and limitations

This is a working implementation with a tested core, but it has **not yet been run against a live
TickTick account** — the API surface is implemented from TickTick's documented behaviour. Treat the
first run as a trial: point it at a test vault and a spare TickTick list before trusting it with real
data.

Known constraints, all stemming from the API rather than the plugin:

- **Polling only.** No webhooks exist; sync latency is bound by the poll interval.
- **No per-task modification time.** "Most recently edited wins" cannot be evaluated on a field both
  sides changed, so those conflicts fall back to the configured policy.
- **The Inbox is capped at 200 tasks per sync.** `GET /project` omits the Inbox entirely, so it is
  read through the filter endpoint, which returns at most 200 records.
- **Completed-task history reaches back 90 days** and returns at most 200 tasks per call.
- **Attachments and comments are not synced.**
- Non-checkbox lines written under the `## Subtasks` heading are dropped on the next write — that
  heading is plugin-owned.

## License

MIT
