# Espionage

> Codebase / package name: `espionage`. The GitHub repository is still `FlameAqua/3cx-spy`, which is what the updater points at.

An Electron + Vite desktop app that connects to a 3CX phone system and draws an
interactive graph of its call flow — trunks and DIDs into inbound rules, into
IVRs, splitting into queues / ring groups, down to the extensions that belong to
each. Click any node to inspect its details and relationships.

## Controls

- **Click a node** → highlights its neighbourhood and opens the details panel.
- **Focus mode** (toolbar) → clicking a node collapses the graph to just that
  node + its direct connections; click a neighbour to walk outward. "Show all"
  exits. Great for untangling a large system.
- **Layout** selector → Flow (hierarchical call flow), Force (compact blob),
  Breadthfirst.
- **Zoom** with the +/− buttons, the slider, or the scroll wheel.
- **Pan** by holding **Space** and dragging (disabled otherwise so clicks/drags
  on nodes stay precise).
- **Dark mode** toggle (☾/☀), remembered between sessions.
- **Details panel** has Back (selection history) and Hide buttons; reopen via the
  "Details ›" button on the graph.

## How it works

- **Login screen** — enter the 3CX web-client URL (e.g. `https://pbx.example.com`),
  username (usually `0000`), password, and optional security code. "Allow
  self-signed certificates" is on by default because most 3CX boxes ship a
  self-signed cert. The URL / username / cert choice are remembered between runs
  (the password is not stored).
- **Main process** authenticates against `/webclient/api/Login/GetAccessToken`,
  then pulls the relevant `/xapi/v1/*` collections (Users, Queues, RingGroups,
  Receptionists/IVRs, InboundRules, DidNumbers, Trunks, Groups), following OData
  pagination. All HTTP happens in the main process so there are no CORS issues
  and the self-signed-cert toggle can be honoured.
- **Renderer** builds a topology graph and renders it with Cytoscape.js (dagre
  left-to-right layout). Routing edges are resolved tolerantly from each
  entity's destination/forwarding fields, since the exact shapes vary by 3CX
  version. Anything that can't be resolved is kept as a red "Unresolved" node and
  listed under the toolbar's "unresolved" button so it's visible, not silently
  dropped. Per-endpoint fetch failures appear under "warnings".

## Using the graph

- **Click a node** → details panel on the right: key facts, who/what it routes
  to, who routes to it (each clickable to jump there), and the raw JSON.
- **Categories** (left) toggle each entity type on/off.
- **Search** (top) jumps to any node by name or extension number.
- **Fit** re-frames the graph; **Reload** re-fetches; **Disconnect** returns to login.

## Project layout

```
src/
  shared/types.ts          IPC payload types shared by all processes
  main/threecx/client.ts   auth + paginated xapi fetch (Node https, TLS toggle)
  main/threecx/ipc.ts       ipcMain handlers
  preload/index.ts          window.api.threecx bridge
  renderer/src/
    graph/model.ts          node/edge types + category colours
    graph/build.ts          raw 3CX entities -> topology graph
    graph/view.ts           Cytoscape view (layout, filter, focus, search)
    ui/login.ts             connection screen
    ui/app.ts               toolbar + legend + graph + details shell
    ui/details.ts           selected-node detail panel
    renderer.ts             bootstrap / login <-> app
```

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
$ npm run build:win    # Windows
$ npm run build:mac    # macOS
$ npm run build:linux  # Linux
```
