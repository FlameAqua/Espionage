# Espionage — working on this codebase

Espionage is an Electron desktop app that signs into a **3CX phone system**, pulls its
configuration over the `xapi` REST API, and draws the whole call flow as an interactive
graph: trunks and DIDs → inbound rules → IVRs / route points → queues and ring groups →
the extensions that belong to each. On top of the graph it offers read-only analysis
(health check, extension status, DID table, office hours, deep configuration search),
call-activity **reports** built from the 3CX call log, and offline **snapshots**.

It is read-only by design. Nothing in this app ever writes to a PBX.

This document is the orientation for someone picking the project up. The `README.md` is
user-facing and its "Project layout" section is out of date — trust this file instead.

---

## 1. Getting started

```bash
npm install
```

```bash
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | electron-vite dev server with HMR for the renderer |
| `npm run typecheck` | `tsc --noEmit` for the node (main/preload/shared) and web (renderer/shared) projects |
| `npm run lint` | ESLint (cached — delete `.eslintcache` if it goes stale) |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run build` | typecheck + electron-vite build into `out/` |
| `npm run build:win` \| `:mac` \| `:linux` | full installer via electron-builder into `dist/` |

CI (`.github/workflows/ci.yml`) runs typecheck → lint → test → build on Node 22 for every
push to `master` and every PR. Match that locally before pushing.

You do **not** need a live 3CX to work on most of this: open a saved snapshot
(`Open snapshot` in the burger menu) and the whole graph, health check, deep search and
diff run offline against it. Only reports and live status need a real session.

---

## 2. Process architecture

Three processes, standard electron-vite layout, with `src/shared` compiled into both ends.

```
┌─ main ─────────────────────────────────────────────────────┐
│ index.ts      window creation, app:* IPC, snapshot save/open│
│ threecx/      client.ts  auth + paginated xapi + call log   │
│               ipc.ts     threecx:* handlers                 │
│               switchboard.ts  (dormant) Switchboard scrape  │
│ reports.ts    reports folder, background jobs, report:* IPC │
│ updater.ts    electron-updater wiring, updates:* IPC        │
└─────────────────────────┬──────────────────────────────────┘
                          │ contextBridge (preload/index.ts → window.api)
┌─────────────────────────┴──────────────────────────────────┐
│ renderer  (vanilla TS + Tailwind, no framework)            │
│ renderer.ts     login ⇄ app bootstrap, session/view state  │
│ graph/          build.ts → TopologyGraph → view.ts (cytoscape)│
│ ui/             app.ts shell + panels, details, reports…   │
└────────────────────────────────────────────────────────────┘
```

**All HTTP happens in the main process.** That is deliberate and load-bearing: it avoids
renderer CORS entirely, and it is the only place the self-signed-certificate toggle can be
honoured. Never add a `fetch()` to a PBX from the renderer.

**The renderer never sees credentials.** Passwords live in main-process memory only
(`Session.req` in `client.ts`) so a Reload can re-authenticate, and are never written to
disk. `ui/systems.ts` remembers URL + username only — keep it that way.

### The data path

1. `ui/login.ts` collects a `ConnectRequest` → `threecx:connect` → `client.connect()`
   POSTs to `/webclient/api/Login/GetAccessToken` for a bearer token.
2. `renderer.ts` calls `threecx:fetchTopology` → `client.fetchTopology()` fetches every
   collection in parallel, redacts secrets, returns a `Topology` (plain JSON, `shared/types.ts`).
3. `graph/build.ts` `buildTopology()` turns raw entities into a `TopologyGraph`
   (`graph/model.ts`: `GraphNode[]`, `GraphEdge[]`, `warnings[]`).
4. `ui/app.ts` `renderApp()` builds the whole shell and hands the graph to
   `graph/view.ts` `GraphView` (cytoscape + dagre).

Several systems can be connected at once (`sessions` map in `client.ts`); the renderer
keeps a per-system `ViewState` in memory so switching back lands you where you left off.

---

## 3. Where things live

### `src/shared/` — crosses the IPC boundary, imported by both ends

| File | Purpose |
| --- | --- |
| `types.ts` | Every IPC payload type. Heavily commented — **read this first**; it is the closest thing to a domain glossary. |
| `phone.ts` | Calling-code table + pure number/direction/scope classification. Used by the report engine (main) and the report UI's live re-classification (renderer). |
| `redact.ts` | `redactSecrets()` (credential fields → `[redacted]`) and `stripScriptSource()` (route-point script source withheld from snapshots). |

### `src/main/`

| File | Purpose |
| --- | --- |
| `index.ts` | Window creation, navigation guards, `app:*` IPC (snapshot save/open, external links, clipboard, folder picker). |
| `threecx/client.ts` | The big one (~1.5k lines): auth, paged `getCollection`, `fetchTopology`, route-point script reads, call-log normalisation, `fetchCallReport`, `fetchActiveCalls`. |
| `threecx/ipc.ts` | Thin `threecx:*` handlers over `client`. |
| `threecx/switchboard.ts` | Hidden BrowserWindow that scrapes the web client's Switchboard for per-queue agent login state. **Works, but is off the refresh path** — see §6. |
| `reports.ts` | Managed reports folder in `userData/reports`, background generation jobs with progress broadcast, all `report:*` IPC. |
| `updater.ts` | electron-updater; `OWNER`/`REPO` must stay in step with `electron-builder.yml`. |

### `src/renderer/src/graph/` — pure-ish logic, mostly unit-tested

| File | Purpose |
| --- | --- |
| `model.ts` | Node/edge kinds, colours, presence and queue-login interpretation, department bucketing helpers, `routeGroupOf`. |
| `build.ts` | Raw 3CX entities → `TopologyGraph`. Tolerant destination resolution; the heart of the app. |
| `view.ts` | Cytoscape view: styling, layouts (flow / department / compact), focus, hiding, search, zoom/pan, edge-label overlay. |
| `routing.ts` | Where a link turns so it doesn't disappear under a node. Pure geometry + one applier. |
| `search.ts` | `rankSearchHits()` — the ranking both the search box and the command palette use. |
| `audit.ts` | Health-check findings from a built graph (no extra fetches). |
| `deep-search.ts` | Flattens every raw record to leaves and searches those; field-query parsing (`Number: 8006`). |
| `diff.ts` | Snapshot-to-snapshot comparison, deliberately blind to live state. |
| `office-hours.ts` | Department schedules, breaks, holidays, overrides → "is it open at this moment". |
| `script-refs.ts` | Scans Call Flow Designer source for DNs the system actually has. Leads, not facts. |

### `src/renderer/src/ui/`

`app.ts` (~3.6k lines) is the shell: toolbar, legend, department filter, context menu,
command palette, burger menu, all the analysis panels, keyboard shortcuts, panel layout.
Everything else is a focused module — `details.ts` (right-hand panel), `egomap.ts`
(mini-graph in that panel), `minimap.ts`, `login.ts`, `settings.ts`, `zones.ts`,
`palette.ts`, `report*.ts` (see §5), `prefs.ts` / `systems.ts` (localStorage),
`motion.ts`, `panel-chrome.ts`, `icons.ts`, `logo.ts`, `history.ts` (undo/redo),
`updates.ts`.

`app.ts` is large because it owns cross-cutting state. When adding to it, prefer a new
module that takes what it needs as arguments (the way `report-*.ts` and `zones.ts` do)
over another section inside it.

---

## 4. 3CX domain knowledge you need

This is the part that makes the code look strange until you know it.

- **`$top` is capped at 100.** A larger value is rejected with HTTP 400, so every
  collection is a run of `$skip` pages. `getCollection` issues those in parallel batches.
- **`$skip` is quadratic on the call log.** The server generates and discards N rows
  first, so a month read as one paged run gets slower as it goes and eventually times
  out. That is why reports are split into **day-sized windows** (`CHUNK_MS`), read a few
  at a time against one shared `RequestBudget`, then de-duplicated across the seams.
- **`$count` is not trustworthy.** Some builds reject it; some answer it with an empty
  set; some echo `$top` back as the count. `getCollection` distrusts a count that is
  smaller than the page in hand or exactly equal to `PAGE_SIZE`.
- **Field names and shapes vary by version.** Nothing hard-codes one schema:
  `pickField` / `pick` take a list of candidate keys, and `build.ts` discovers routing
  targets by scanning destination-shaped sub-objects. When you add a field, add
  alternatives rather than the one name your test PBX uses.
- **`$expand` is not universally supported.** `fetchTopology` retries bare (and, for
  Users, retries with just the known-good `Groups` expand) when an expanded request fails.
- **Endpoints are licence-gated.** 404 / 401 on call log or active calls is normal on
  free/standard editions. `fetchSet` swallows errors into the `EntitySet` so one failure
  never costs the whole topology; the UI surfaces them under "warnings".
- **A trunk's "route unmatched calls to…" is a hidden `ForwardAll` inbound rule** that
  never appears in the portal's rule list (`isTrunkDefaultRule`, `attachTrunkDefaultRoutes`).
- **Route points** (`CallFlowApps`) run a Call Flow Designer script that decides routing at
  runtime. The collection omits `ScriptCode`, so `withScriptSources` probes which OData
  shape this build answers and uses it for the rest. Script-derived links are their own
  `script` edge kind and are presented as evidence with a line number — never as routing.
- **Per-queue agent login is not in the config API.** `Queues?$expand=Agents` returns only
  Number / Name / SkillGroup / Tags / Id. `agentLoggedIn()` usually returns `null`;
  callers must fall back to `queueLoginState()` on the extension — which itself is not
  just `QueueStatus`, because a status profile with `OfficeHoursAutoQueueLogOut` logs the
  agent out of queues while it is active.
- **Anything unresolved stays visible.** An unresolvable destination becomes a red
  `unknown` node plus a warning. Silently dropping it is the one thing this app must not do.

---

## 5. The report subsystem

Reports are the most involved feature and span both processes.

- **Fetching** — `client.fetchCallReport()`. It probes the candidate call-log endpoints
  (`CALL_LOG_ENDPOINTS`) with one page each, checks the returned rows actually land inside
  the requested window, then reads the whole period. It reads a day wider than asked
  (`PERIOD_PAD_MS`) and trims back, because timezone handling differs by build.
  If rows come back dated outside the period, the report is **left empty with an
  explanation** rather than showing the wrong month under the right heading.
- **Jobs** — `main/reports.ts` runs generation as a background job so dismissing the
  dialog doesn't throw the work away. Progress broadcasts to every window on
  `report:jobs`; the toolbar chip (`ui/report-tray.ts`) is the view over it.
- **Storage** — JSON in `userData/reports`, written compact. `readReportInfo` reads only
  the first 8 KB header rather than parsing a file that may be tens of MB.
- **Classification runs in the renderer**, from the saved entries, so changing home
  country / direction / scope / grouping re-slices the view without re-fetching
  (`ui/report.ts` `classify`, `collapseToCalls`, `perExtension`).
- **A report carries its own `directory`** (who each DN was when it was generated) so it
  reads correctly when opened while connected to a different system.
- **Counting rules matter and were derived from real leg data.** 3CX writes one row per
  routing leg; a call is counted once per extension and direction, not once per leg.
  `toVoicemail` is set on *both* segments of a call that rang out — only the answered one
  is voicemail taking the message. Don't "simplify" these without re-checking against
  3CX's own Extension Statistics.
- **Call zones** (`ui/zones.ts` + `report/tariff.ts`) classify an external number by
  longest-prefix match against a bundled carrier CSV, giving country **and** line type
  (landline / mobile / other) plus a per-minute rate. Zone config lives in localStorage
  and is exportable.
- Modules: `report.ts` (renderer + classification + export), `report-setup.ts` (generate
  dialog), `report-tray.ts` (jobs chip), `report-context.ts` (directory / scope targets
  from the graph), `report-customize.ts` (persisted section layout).

---

## 6. Rules that exist for a reason

Each of these was a real bug. Changing them needs a conversation, not a refactor.

**Security posture (accepted risks — don't "fix" silently):**
- `allowInsecure: true` is hardcoded at login (`ui/login.ts`; the old checkbox the README
  still describes is gone). TLS certs are never verified, because 3CX ships self-signed
  certs and validating would break nearly every install. Known trade-off, no MITM protection.
- `sandbox: false` on the main window. `contextIsolation` is on, so the bridge is sound;
  flipping sandbox risks `@electron-toolkit/preload`.
- `report:load` / `report:reveal` are confined to the managed reports folder
  (`inReportsDir`, resolved first so `..` can't escape). Arbitrary paths from the renderer
  would be a read-any-file primitive. Reports elsewhere go through `report:open`, which the
  user drives with a file dialog.
- `setWindowOpenHandler`, `will-navigate` and `app:openExternal` all check for `http(s)`
  before handing a URL to the OS. Keep all three checks.
- `redact.ts`'s `SENSITIVE` pattern is deliberately broad and unanchored — the narrow
  version leaked a trunk's `SeparateAuthId` and a messaging API key into shared snapshots.
  Over-redaction costs a field nobody reads; under-redaction ships a secret.
- Snapshots are files people email each other, so `stripScriptSource` withholds route-point
  source from them (a CFD script routinely embeds an API key) while the app still shows it
  on screen. "No script deployed" and "script not in this file" stay tellable apart.
- The deep-search index deliberately excludes reporting endpoints and `MyTokens` /
  `SecurityTokens`. Don't add token-bearing collections to `EXTRA_COLLECTIONS`.

**Rendering:**
- `#graph` must declare `position: absolute` **in `index.css`**, not via a Tailwind
  utility. Cytoscape injects an unlayered rule for its container, and any unlayered rule
  beats a layered one — the container fell back to `position: relative`, resolved to zero
  height, and the canvas went blank.
- The canvas spans the whole window with the side panels floating over it. Resizing
  cytoscape is a full re-render, which is what made panels flicker.
- The minimap fits to node **positions**, not `cy.fit()`. `fit()` measures the styled
  bounding box, which includes node sizes that are themselves derived from the zoom — a
  feedback loop that produced "sometimes massive dots, sometimes empty".
- The details mini-view (`egomap.ts`) shares palette, opaque-fill blend, status classes and
  link routing with the main canvas via exports from `view.ts`. `test/style.test.ts` guards
  that contract; they drifted apart once already.
- Motion: keyframes live in `index.css`, JS only plays exits and tweens numbers that CSS
  can't. Everything collapses to an instant change under `prefers-reduced-motion` or the
  Interface setting. Don't replace the panel-collapse tween with a CSS transition on
  `grid-template-columns`.

**Behaviour:**
- The Switchboard scrape (`switchboard.ts`) is **not on the refresh path** and shouldn't
  go back on it: the Switchboard shows one queue at a time and each costs a PBX
  round-trip, which reached ~60 s per queue on a 40-queue system. It stays because it is
  the only known source of per-queue login state and remains usable for one queue on
  demand. `applyQueueAgentLogins` has an outer timeout on top of the scrape's own budget
  because a stalled navigation once left the app spinning on the loading screen forever.
- The auto-updater keeps `allowPrerelease = false`. With prereleases allowed,
  electron-updater picks the newest release *flagged* prerelease rather than the highest
  version, pinning clients to the last beta forever.
- Older builds shipped an embedded read-only GitHub token (the release repo used to be
  private). That token must stay alive until those builds have updated past the public
  updater, or they get 401 and are stranded on manual downloads.
- `migrateLegacyPrefs()` copies settings from the old `3cx-spy.` localStorage prefix to
  `espionage.`. It runs before anything reads a pref, and copies rather than moves.

---

## 7. Conventions

- **TypeScript, strict, no `any` reaching across a boundary.** Raw 3CX data is
  `Record<string, unknown>` and narrowed with local `isObj` / `pick` helpers.
- **No UI framework.** Views are template strings assigned to `innerHTML`, then wired with
  `addEventListener`. Every interpolated value goes through the local `esc()`.
  Tailwind v4 via PostCSS; class-based dark mode (`.dark` on `<html>`).
- **Prettier**: single quotes, no semicolons, 100 columns, no trailing commas. Run
  `npm run format` or let the editor do it — CI lints with `eslint-config-prettier`.
- **Comments explain *why*, at length.** This codebase's comments carry the institutional
  memory of which 3CX quirk forced which shape. Match that register: when you work around
  something surprising, write down what you observed and what the alternative did wrong.
  A comment saying what the next line does is noise; one saying why it isn't the obvious
  thing is the point.
- **Persisted UI state** is localStorage under the `espionage.` prefix, read/written
  through the small modules that own it (`prefs.ts`, `settings.ts`, `systems.ts`,
  `zones.ts`, `report-customize.ts`) — not scattered `localStorage` calls.
- **Icons** are inline SVG in `ui/icons.ts`, drawn in `currentColor`. Don't reintroduce
  emoji: they render in the platform's palette and clash with the app's.
- **Fail soft, and say why.** Every fetch failure becomes a visible warning with the
  endpoint and status, never a silent empty result. Error strings are written for a phone
  administrator, not a developer — see `describeReportFailure` for the tone.

---

## 8. Testing

`npm test` runs Vitest in a **plain Node environment** — no Electron, no DOM, no live PBX.
That constrains what is testable and shapes the code: pure logic is pulled out of the
Electron and cytoscape layers specifically so it can be tested.

Current suites (`test/`): `attribution`, `audit`, `build`, `deep-search`,
`department-layout`, `diff`, `history`, `model`, `office-hours`, `phone`, `redact`,
`report`, `route-point`, `routing`, `script-refs`, `search`, `style`, `switchboard`,
`tariff`, `zones`.

When adding a feature, the testable seam is usually already there:

- Graph behaviour → build a minimal `Topology` literal and assert on the
  `TopologyGraph` (see `test/build.test.ts` for the pattern — `empty()` helper plus one
  or two records).
- Call-log behaviour → `normalizeCallEntry`, `trimToPeriod`, `filterEntriesByDn`,
  `callDirection`, `splitIntoWindows`, `dedupeEntries` are all exported from `client.ts`
  explicitly for this.
- View/style contracts → export the helper from `view.ts` and assert on it
  (`themePalette`, `statusClasses`, `blendToBackground`, `idsWithMembers`).

If something is only reachable through a `BrowserWindow` or a `Core`, extract the decision
into a pure function first.

---

## 9. Releases

Version comes **entirely from the git tag** — there is no `npm version` bump:

```bash
git tag v1.3.0 && git push origin v1.3.0
```

`.github/workflows/release.yml` then lints, tests, builds Windows installers with
`-c.extraMetadata.version="$VERSION"`, and uploads the `.exe`, `.exe.blockmap` and
`latest.yml` with the `gh` CLI. electron-builder's own uploader is deliberately bypassed
(`--publish never`): it races release creation in CI and can drop the large `.exe` while
still exiting 0.

A tag with a `-beta` / `-rc` suffix ships as a GitHub pre-release; a bare `vX.Y.Z` ships as
a normal release. The installed app only ever picks up the latter.

`electron-builder.yml`'s `publish.owner`/`repo` and `updater.ts`'s `OWNER`/`REPO` must
match. `sbom.cdx.json` is checked in at the repo root.

---

## 10. Common tasks

**Add a 3CX collection to the topology.** Add the field to `Topology` in `shared/types.ts`
(optional, so older snapshots stay readable), add the path to `EXTRA_COLLECTIONS` (or a
`fetchSet` call in `fetchTopology` if the graph needs it), and add it to `DEEP_COLLECTIONS`
in `deep-search.ts` so it becomes searchable. A missing endpoint 404s into an empty set —
that costs one request and nothing else.

**Add a node or edge kind.** `NodeKind` / `EdgeKind` + `NODE_KIND_META` / `EDGE_KIND_META`
in `model.ts` (colour and label), then emit it from `build.ts`. The legend, settings
link-type list, details panel and egomap all read from the meta records, so they pick it up
for free.

**Add a menu action.** Add a `Shortcut` entry in the `shortcuts` array in `app.ts` (that
gives it a Ctrl accelerator *and* a command-palette entry), then a `menuEl.append(item(...))`
line in `buildMenu()` under the right section. The accelerator hint in the menu is looked up
from the shortcut by label, so keep the labels identical.

**Add a report section.** `SectionId` + `REPORT_SECTIONS` in `report-customize.ts`, a
renderer branch in `renderSection` in `report.ts`, and a matching block in
`buildPrintHtml` — the PDF export must draw each section in the style it has on screen.

**Add a setting.** A reader/writer pair in `prefs.ts` (or the module that owns the domain),
a control in `showSettings` in `settings.ts`. Settings apply live; there is no OK/Cancel.

---

## 11. Glossary

| Term | Meaning |
| --- | --- |
| **DN** | Directory Number — an extension, queue, ring group, IVR or trunk pseudo-number. The call log gives no hint which; `DnKind` resolves it from the topology. |
| **DID** | The external number dialled. Owned by a trunk, matched by an inbound rule. |
| **Inbound rule** | Maps a DID (and time of day) to a destination. |
| **Route point** | A DN running a Call Flow Designer script (`CallFlowApps`). |
| **Bridge** | A trunk whose gateway links two 3CX systems; drawn with a `system` node for the remote host. |
| **Snapshot** | A saved `Topology` JSON — offline, credential-free, script-free. |
| **Report** | A saved `CallReport` JSON — call log for a period, or a live active-calls snapshot. |
| **Department** | A 3CX `Group`. Rendered as badges on members and as boxes in Department view, never as a node. `DEFAULT` and `___FAVORITES___*` are filtered out (`isRealDepartment`). |
| **Zone** | A user-defined tariff band grouping (country, line-type) pairs, for report cost totals. |
