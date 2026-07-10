# HeaderForge — Privacy Policy

_Last updated: 2026-07-10_

HeaderForge is a browser extension for modifying HTTP request and response
headers. Privacy is a core design goal.

## Summary

**HeaderForge does not collect, transmit, sell, or share any of your data.**
Everything the extension stores stays on your own device.

## What data the extension handles

The only data HeaderForge stores is the configuration **you** create:

- Header profiles (names, values, operations, and your optional descriptions)
- URL filter patterns
- Preferences (theme, popup size)

This is saved locally using the browser's `chrome.storage.local` API on your
device. It is never sent anywhere.

## What the extension does NOT do

- No analytics, telemetry, tracking, or usage reporting.
- No accounts, sign-in, or cloud sync.
- No network requests of its own — HeaderForge never contacts any server.
- No reading of page content, browsing history, cookies, or form data.
- No selling or sharing of data with third parties.

## How header rules work

HeaderForge applies your header rules using Chrome's `declarativeNetRequest`
API. The browser itself performs the header modifications according to the rules
you configure; the extension does not observe, log, or transmit the requests or
their contents.

## Permissions

| Permission | Why it's needed |
|------------|-----------------|
| `declarativeNetRequest` | To add, modify, or remove headers on network requests. |
| `storage` | To save your profiles and settings locally on your device. |
| Host access (`<all_urls>`) | Required by `declarativeNetRequest` so your rules can apply to the sites you choose. It is **not** used to read page content. |

## Data export

You can export your profiles to a JSON file. This is a manual action you
initiate, and the file is saved locally by your browser. HeaderForge does not
upload it anywhere.

## Changes

Any changes to this policy will be published in this file in the project
repository.

## Contact

Questions or concerns: open an issue at
<https://github.com/prasadthx/headerforge/issues>.
