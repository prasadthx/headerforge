# Publishing HeaderForge to the Chrome Web Store

## Feasibility: ✅ Yes, this is publishable

HeaderForge already meets the hard technical requirements:

- **Manifest V3** — required for all new items. ✅
- **No remote code** — all JS ships in the package; nothing is fetched/eval'd. ✅
- **Single purpose** — modifying HTTP headers. ✅ (a clear, allowed purpose)
- **Minimal permissions** — `declarativeNetRequest` + `storage` + host access. ✅
- **No data collection** — nothing leaves the device. ✅ (easy privacy disclosure)
- **Icons** — 16/48/128 present. ✅

Header-modifier extensions are an established, allowed category on the store, so
there's no policy blocker. The one thing that draws **extra review scrutiny** is
the broad host permission (`<all_urls>`), which is inherent to a header tool —
you just have to justify it clearly (copy below). Expect review to take from a
day up to ~2 weeks for a first submission with broad host access.

## One-time setup

1. Create a **Chrome Web Store developer account** (one-time **$5** fee):
   <https://chrome.google.com/webstore/devconsole>
2. Host the privacy policy somewhere public — the repo's
   [`PRIVACY.md`](PRIVACY.md) works; use its GitHub URL as the policy link.

## Build the upload package

Zip only the files the extension needs (exclude dev/tooling/docs):

```bash
cd /Users/prasadzore/tasks/scam-repo/headerforge
zip -r ../headerforge-1.1.0.zip \
  manifest.json background.js state.js rules.js \
  popup.html popup.css popup.js \
  options.html options.css options.js \
  icons
```

Upload `headerforge-1.1.0.zip` in the developer console.

## Listing content (ready to paste)

**Name:** HeaderForge: ModHeader Alternative

**Summary (≤132 chars):**
> A fast, private alternative to ModHeader — add, modify, and remove HTTP request & response headers with profiles, URL filters, and JSON import/export.

**Category:** Developer Tools

**Description:**
> HeaderForge is a fast, private alternative to ModHeader for modifying HTTP
> request and response headers while you develop and test.
>
> • Add, modify, or remove request & response headers (set / append / remove)
> • Organise rules into colour-coded profiles you can toggle on/off
> • Scope profiles to specific sites with URL regex filters
> • Annotate each header with a description
> • Import/export as JSON; pause everything with one click
> • Light / dark / system themes; resizable popup
>
> Private by design: no accounts, no analytics, no network requests. Everything
> is stored locally on your device.

## Privacy tab answers

- **Single purpose:** "Modify HTTP request and response headers on sites the
  user chooses, organised into profiles."
- **Data collection:** Select **does not collect** for every category (true —
  nothing is transmitted).
- **Privacy policy URL:** `https://github.com/prasadthx/headerforge/blob/main/PRIVACY.md`

### Permission justifications (paste into the console)

- **`declarativeNetRequest`** — "Core function: add, modify, and remove HTTP
  headers via declarative rules the user configures."
- **`storage`** — "Save the user's header profiles and preferences locally."
- **Host permission `<all_urls>`** — "Required by declarativeNetRequest so the
  user's header rules can apply to whichever sites they target. The extension
  does not read page content; it only applies the user's header rules."

## Assets still needed (not code — you create these)

- **Screenshots:** 1280×800 or 640×400 PNG/JPG, 1–5 of them (open the popup +
  the About page and capture). **Required.**
- **Small promo tile:** 440×280 (optional but recommended).
- **Store icon:** 128×128 — already in `icons/icon128.png` (the light variant).
  ✅ — the dark variant `icon128-dark.png` is used by the extension's own UI,
  not required by the store.

## After publishing — updates

- Bump `"version"` in `manifest.json` (e.g. `1.0.1`), re-zip, upload a new
  version. Chrome auto-updates installed users.
- **User data is preserved across updates** (see the migration note in the
  README): `chrome.storage.local` persists, `STORAGE_KEY` never changes, and
  `migrate()` upgrades the shape when it evolves.
- The About page's "Check for updates" button calls
  `chrome.runtime.requestUpdateCheck()`, which only works for the published
  store build (it's a no-op for unpacked/dev installs).

## Notes / gotchas

- Keep the word "ModHeader" out of the store listing (trademark / keyword-spam
  rules). Comparisons are fine in the GitHub README, not the store copy.
- `minimum_chrome_version` is set to 111 (for CSS `color-mix`).
- If you ever want to reduce review friction, an alternative is
  `activeTab` + optional host permissions, but that changes UX (per-site opt-in)
  — `<all_urls>` is the right call for a general header tool.
