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

## Which API to use

**Official Open API (default).** OAuth2, sanctioned, stable. It is also narrow: two scopes, a
handful of endpoints, no search, no tag endpoint, no completed-task history, no per-task
modification time, and no way to list all tasks — you walk project by project.

**Advanced mode (opt-in).** TickTick's internal `/api/v2`, the one the web app uses. It adds
completed-task history, per-task modification times, tags, and a single-request full state fetch. It
authenticates with your account password to obtain a session token, is not covered by TickTick's
developer terms, and can break without notice.

The practical difference: on the official API, "most recently edited wins" cannot be evaluated
because there are no modification times, so conflicts fall back to preferring TickTick. Advanced
mode makes conflict resolution and deletion detection precise. Nothing in the plugin depends on it —
every call site degrades gracefully when it is off.

## Setup

### Official API

1. Register an app at [developer.ticktick.com](https://developer.ticktick.com).
2. Set its redirect URI to `http://localhost:8484/callback` (the port is configurable in settings).
3. Paste the client ID and secret into the plugin settings and press **Connect**.

On desktop the plugin listens on the loopback port and completes the handshake automatically. On
mobile, or if the port is taken, it falls back to pasting the redirected URL.

### Advanced mode

Toggle **Advanced mode** in settings and sign in with your TickTick email and password. The password
is used once to obtain a session token and is not stored.

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
| `src/api/` | TickTick clients — `openApi.ts` (official), `v2.ts` (unofficial), shared normalisation and a rate-limiting request queue |
| `src/auth/` | OAuth2 authorisation-code flow, token refresh, loopback listener |
| `src/sync/reconcile.ts` | Three-way merge. All "who wins" policy lives here, as pure functions |
| `src/sync/fieldModes.ts` | Per-field direction rules, applied by rewriting the merge inputs |
| `src/sync/mapper.ts` | Task ↔ note translation. Pure: no Obsidian imports, no filesystem |
| `src/sync/engine.ts` | Orchestration and I/O only — it holds no policy of its own |
| `src/sync/state.ts` | The agreed-state store, ID map and tombstones |
| `src/util/tags.ts` | Unicode-aware tag parsing |
| `src/vault/` | Vault I/O, YAML frontmatter, property type registration |

The policy modules are pure by design, so conflict behaviour is testable without a vault or a
network. 76 unit tests cover tag parsing, the mapper round-trip, merge decisions and direction rules.

## Status and limitations

This is a working implementation with a tested core, but it has **not yet been run against a live
TickTick account** — the API surface is implemented from TickTick's documented behaviour. Treat the
first run as a trial: point it at a test vault and a spare TickTick list before trusting it with real
data.

Known constraints, all stemming from the API rather than the plugin:

- **Polling only.** No webhooks exist; sync latency is bound by the poll interval.
- **Inbox.** The official API's project list does not include the Inbox, so Inbox tasks are not
  enumerated in default mode. Advanced mode does see them.
- **No completed history on the official API.** Completions are detected by direct fetch rather than
  by listing, which costs one request per task that left a listing.
- **Attachments and comments are not synced.**
- Non-checkbox lines written under the `## Subtasks` heading are dropped on the next write — that
  heading is plugin-owned.

## License

MIT
