// HeaderForge background service worker.
//
// Responsibility: read the saved state from chrome.storage and keep the set of
// declarativeNetRequest *dynamic* rules in sync with it. Dynamic rules persist
// across browser restarts, so headers stay active even when the popup is closed.

import { STORAGE_KEY, ERROR_KEY, normalizeState, createDefaultState } from "./state.js";
import { compileRules, countActiveHeaders } from "./rules.js";

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(stored[STORAGE_KEY]);
}

// Validate a user-supplied regex against the declarativeNetRequest engine (RE2).
async function isRegexOk(pattern) {
  try {
    const res = await chrome.declarativeNetRequest.isRegexSupported({
      regex: pattern,
    });
    return res.isSupported;
  } catch {
    return false;
  }
}

// Validate every enabled URL pattern, grouped by profile. Invalid patterns are
// skipped (and reported) rather than failing the whole rule set.
async function validatePatterns(state) {
  const byProfile = {};
  const errors = [];
  for (const profile of state.profiles) {
    if (!profile.enabled) continue;
    const valid = [];
    for (const f of profile.urlFilters) {
      if (!f.enabled) continue;
      const p = (f.pattern || "").trim();
      if (!p) continue;
      if (await isRegexOk(p)) {
        valid.push(p);
      } else {
        errors.push({
          profile: profile.name,
          pattern: p,
          message: "Invalid URL regex — skipped",
        });
      }
    }
    byProfile[profile.id] = valid;
  }
  return { byProfile, errors };
}

async function updateBadge(state) {
  const count = countActiveHeaders(state);
  const paused = state.paused;
  await chrome.action.setBadgeBackgroundColor({
    color: paused ? "#9ca3af" : "#6366f1",
  });
  await chrome.action.setBadgeText({
    text: paused ? "off" : count > 0 ? String(count) : "",
  });
  await chrome.action.setTitle({
    title: paused
      ? "HeaderForge — paused"
      : count > 0
        ? `HeaderForge — ${count} active header${count === 1 ? "" : "s"}`
        : "HeaderForge",
  });
}

let syncing = Promise.resolve();

// Serialize rule updates so rapid edits from the popup don't race each other.
function syncRules() {
  syncing = syncing.then(doSyncRules).catch((e) => console.error(e));
  return syncing;
}

async function doSyncRules() {
  const state = await loadState();
  const { byProfile, errors } = await validatePatterns(state);
  const rules = compileRules(state, byProfile);

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: rules,
    });
    await chrome.storage.local.set({ [ERROR_KEY]: errors });
  } catch (e) {
    // If the batch is rejected, clear rules so we fail safe (no headers) and
    // surface the reason to the popup.
    console.error("Failed to apply rules:", e);
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    } catch (_) {
      /* ignore */
    }
    await chrome.storage.local.set({
      [ERROR_KEY]: [
        ...errors,
        { profile: "—", pattern: "", message: String(e.message || e) },
      ],
    });
  }

  await updateBadge(state);
}

// --- Lifecycle wiring -------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: createDefaultState() });
  }
  await syncRules();
});

chrome.runtime.onStartup.addListener(() => {
  syncRules();
});

// The popup persists edits to storage; rebuild rules whenever they change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    syncRules();
  }
});

// Allow the popup to force an immediate resync (e.g. right after import).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "resync") {
    syncRules().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});

// Rebuild once when the worker spins up.
syncRules();
