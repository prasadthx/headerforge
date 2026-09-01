// Pure, browser-free logic for turning saved state into declarativeNetRequest
// rules. Kept free of any chrome.* calls so it can be unit-tested in Node.

import { RESOURCE_TYPES } from "./state.js";

// A header name must be an RFC 7230 token. declarativeNetRequest rejects the
// whole updateDynamicRules batch if any name is malformed, so a single typo used
// to take down every profile's headers at once. Screen them here instead and
// report them like invalid URL patterns: skipped, named, non-fatal.
const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidHeaderName(name) {
  return HEADER_TOKEN_RE.test(name);
}

// Convert a list of header entries into declarativeNetRequest header actions.
// Disabled, unnamed and malformed entries are dropped; "remove" carries no
// value. `onSkip(name, reason)` is called for anything dropped as invalid.
export function headerActions(headers, onSkip) {
  const out = [];
  for (const h of headers) {
    if (!h.enabled) continue;
    const name = (h.name || "").trim();
    if (!name) continue;
    if (!isValidHeaderName(name)) {
      if (onSkip) onSkip(name, "Invalid header name — skipped");
      continue;
    }
    if (h.operation === "remove") {
      out.push({ header: name, operation: "remove" });
    } else {
      out.push({ header: name, operation: h.operation, value: h.value ?? "" });
    }
  }
  return out;
}

// Build dynamic rules grouped by profile. `validPatternsByProfileId` maps a
// profile id to the list of URL regexes that already passed engine validation
// (done by the caller, which has access to isRegexSupported).
//
// Grouping exists so the caller can fall back to applying one profile at a time
// if the combined batch is rejected: whatever Chrome objects to then costs that
// one profile instead of silently wiping everybody's headers.
export function compileRuleGroups(state, validPatternsByProfileId = {}, onSkip) {
  const groups = [];
  if (!state || state.paused) return groups;

  let id = 1;
  for (const profile of state.profiles) {
    if (!profile.enabled) continue;

    const report = onSkip
      ? (name, reason) => onSkip(profile, name, reason)
      : undefined;
    const requestHeaders = headerActions(profile.requestHeaders, report);
    const responseHeaders = headerActions(profile.responseHeaders, report);
    if (requestHeaders.length === 0 && responseHeaders.length === 0) continue;

    const action = { type: "modifyHeaders" };
    if (requestHeaders.length) action.requestHeaders = requestHeaders;
    if (responseHeaders.length) action.responseHeaders = responseHeaders;

    const patterns = validPatternsByProfileId[profile.id] || [];
    const rules =
      patterns.length === 0
        ? [
            {
              id: id++,
              priority: 1,
              action,
              condition: { resourceTypes: RESOURCE_TYPES },
            },
          ]
        : patterns.map((regexFilter) => ({
            id: id++,
            priority: 1,
            action,
            condition: { regexFilter, resourceTypes: RESOURCE_TYPES },
          }));

    groups.push({ profileId: profile.id, profileName: profile.name, rules });
  }
  return groups;
}

// Flat rule array — the shape updateDynamicRules wants.
export function compileRules(state, validPatternsByProfileId = {}, onSkip) {
  return compileRuleGroups(state, validPatternsByProfileId, onSkip).flatMap(
    (g) => g.rules,
  );
}

// How many headers are actively applied (for the toolbar badge).
export function countActiveHeaders(state) {
  if (!state || state.paused) return 0;
  let n = 0;
  for (const p of state.profiles) {
    if (!p.enabled) continue;
    for (const h of [...p.requestHeaders, ...p.responseHeaders])
      if (h.enabled && isValidHeaderName((h.name || "").trim())) n++;
  }
  return n;
}
