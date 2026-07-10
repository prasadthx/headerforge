// Pure, browser-free logic for turning saved state into declarativeNetRequest
// rules. Kept free of any chrome.* calls so it can be unit-tested in Node.

import { RESOURCE_TYPES } from "./state.js";

// Convert a list of header entries into declarativeNetRequest header actions.
// Disabled and unnamed entries are dropped; "remove" carries no value.
export function headerActions(headers) {
  const out = [];
  for (const h of headers) {
    if (!h.enabled) continue;
    const name = (h.name || "").trim();
    if (!name) continue;
    if (h.operation === "remove") {
      out.push({ header: name, operation: "remove" });
    } else {
      out.push({ header: name, operation: h.operation, value: h.value ?? "" });
    }
  }
  return out;
}

// Build the full dynamic-rule array. `validPatternsByProfileId` maps a profile
// id to the list of URL regexes that already passed engine validation (done by
// the caller, which has access to chrome.declarativeNetRequest.isRegexSupported).
export function compileRules(state, validPatternsByProfileId = {}) {
  const rules = [];
  if (!state || state.paused) return rules;

  let id = 1;
  for (const profile of state.profiles) {
    if (!profile.enabled) continue;

    const requestHeaders = headerActions(profile.requestHeaders);
    const responseHeaders = headerActions(profile.responseHeaders);
    if (requestHeaders.length === 0 && responseHeaders.length === 0) continue;

    const action = { type: "modifyHeaders" };
    if (requestHeaders.length) action.requestHeaders = requestHeaders;
    if (responseHeaders.length) action.responseHeaders = responseHeaders;

    const patterns = validPatternsByProfileId[profile.id] || [];
    if (patterns.length === 0) {
      rules.push({
        id: id++,
        priority: 1,
        action,
        condition: { resourceTypes: RESOURCE_TYPES },
      });
    } else {
      for (const regexFilter of patterns) {
        rules.push({
          id: id++,
          priority: 1,
          action,
          condition: { regexFilter, resourceTypes: RESOURCE_TYPES },
        });
      }
    }
  }
  return rules;
}

// How many headers are actively applied (for the toolbar badge).
export function countActiveHeaders(state) {
  if (!state || state.paused) return 0;
  let n = 0;
  for (const p of state.profiles) {
    if (!p.enabled) continue;
    for (const h of p.requestHeaders)
      if (h.enabled && (h.name || "").trim()) n++;
    for (const h of p.responseHeaders)
      if (h.enabled && (h.name || "").trim()) n++;
  }
  return n;
}
