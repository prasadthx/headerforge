# HeaderForge

A fast, modern, open-source browser extension to **add, modify, and remove HTTP
request and response headers** — a clean, open-source alternative to ModHeader.

Built on Manifest V3 (`declarativeNetRequest`), so it works on current Chrome,
Edge, Brave, and other Chromium browsers. No account, no telemetry, no paywall —
everything stays in your browser.

<p align="center">
  <img src="icons/icon128.png?v=1.1.0" width="96" alt="HeaderForge icon" />
</p>

## Features

- **Request & response headers** — set, append, or remove any header.
- **Simple rows** — name, value, and a per-header description in one row; an
  on/off switch on every row denotes set / unset. A `set` / `append` / `remove`
  selector is optional (off by default) and can be re-enabled in Settings.
- **Per-header descriptions** — annotate what each header is for. By default the
  description sits to the right of the value; move it below the row or hide it
  from Settings.
- **Fuzzy header search** — filter any profile's request/response headers by
  name, value, description, or operation as you type.
- **Profile sidebar** — profiles listed down the left; click to switch,
  double-click to rename, `+ New profile` to add. Each row has a hover **⋮ menu**
  to rename, duplicate, recolour, enable/disable, or delete that profile.
- **URL filters** — scope a profile to URLs matching a regular expression;
  invalid patterns are flagged instead of silently breaking everything.
- **Import headers from JSON** — per panel; accepts a headers array *or* a plain
  `{ "Header-Name": "value" }` object, appended to the current profile.
- **Resizable popup** — opens at a comfortable default width; drag the bottom-left
  grip to size it and the dimensions are remembered next time you open it.
- **In-popup settings** — the gear icon opens an inline panel: theme, description
  placement, operation selector, and data management (export / import / reset),
  plus an About card with version info and a "Check for updates" button.
- **One-tap pause** — disable all headers globally without losing your setup.
- **Import / export profiles** — JSON round-trips; import also understands
  ModHeader-style exports (request/response headers + URL filters).
- **Light / dark / system theme** — the toolbar icon and popup logo switch to a
  dedicated dark variant automatically, so they stay visible on dark toolbars.
- **Private by design** — no network calls, no analytics. Your headers never
  leave your machine.

## Install (load unpacked)

Because this isn't published to the Web Store, load it directly:

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).
5. Pin **HeaderForge** to your toolbar and click it to start.

To update later, `git pull` and hit the **Reload** button on the extension card.

> **Firefox note:** Firefox uses a slightly different MV3 dynamic-rules surface.
> This build targets Chromium; a Firefox port is a possible future addition.

## Preview the UI without installing

Just want a quick look? A dev preview stubs the browser APIs so the **real**
popup runs in a normal browser tab. From the repo root:

```bash
python3 -m http.server 8099
```

Then open <http://localhost:8099/dev/preview.html> (append `?theme=dark` for dark
mode). It's seeded with a demo profile and is fully interactive. This file lives
in `dev/` and is **not** part of the shipped extension. Header modification only
works for real once loaded as an extension (below) — the preview just renders the
interface.

## Usage

1. Click the toolbar icon.
2. On the **Request** tab, click **+ Add request header**, then type a name
   (e.g. `x-auth-override`) and value.
3. The header is applied immediately to matching requests. The toolbar badge
   shows how many headers are active.
4. Use **URL Filters** to limit a profile to specific sites, or leave it empty to
   apply everywhere.
5. Use the **⏸ pause** button to switch everything off temporarily.

## How it works

- `state.js` — the data model (profiles, headers, filters) plus defensive
  normalization, shared by the popup and the service worker.
- `rules.js` — pure functions that compile state into `declarativeNetRequest`
  dynamic rules (no browser APIs, fully unit-tested).
- `background.js` — the service worker: validates URL regexes with the DNR
  engine, compiles rules, and keeps the browser's dynamic rule set in sync
  whenever storage changes.
- `popup.html` / `popup.css` / `popup.js` — the UI.
- `options.html` / `options.css` / `options.js` — the About & settings page.
- `icons/` — light and dark icon variants (`icon*-dark.png`); the popup and
  options page swap them with the theme, and the toolbar icon follows via
  `chrome.action.setIcon`.

Headers are applied via dynamic rules, which persist across browser restarts, so
your headers keep working even when the popup is closed.

## Development

No build step. The only tooling is optional:

```bash
npm test          # run the rule-compiler unit tests (Node, no deps)
npm run icons     # regenerate PNG icons from tools/gen-icons.py (Python 3)
```

Edit any file, then click **Reload** on the extension card to see changes.

## Permissions

| Permission | Why |
|------------|-----|
| `declarativeNetRequest` | Add/modify/remove headers on network requests. |
| `storage` | Save your profiles locally. |
| `<all_urls>` (host) | Required by `declarativeNetRequest` to edit headers on the sites you choose. |

The extension makes **no** outbound network requests of its own.

## Data & updates

Your profiles live in `chrome.storage.local`, which the browser preserves across
extension updates. HeaderForge keeps `STORAGE_KEY` stable forever and runs a
`migrate()` step on update, so shipping a new version never wipes saved headers —
new optional fields fall back to defaults automatically.

## Publishing to the Chrome Web Store

See [STORE.md](STORE.md) for a feasibility check, the exact packaging command,
ready-to-paste listing copy, and permission justifications. The current release
package (`headerforge-1.1.0.zip`, containing only the files the extension needs)
is built and ready to upload.

## Privacy

No data ever leaves your device — see [PRIVACY.md](PRIVACY.md).

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with ModHeader. "ModHeader" is a trademark of its respective owner.
