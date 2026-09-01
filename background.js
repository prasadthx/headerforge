// HeaderForge background service worker.
//
// Responsibility: read the saved state from chrome.storage and keep the set of
// declarativeNetRequest *dynamic* rules in sync with it. Dynamic rules persist
// across browser restarts, so headers stay active even when the popup is closed.

import {
  STORAGE_KEY,
  ERROR_KEY,
  UPDATE_KEY,
  RESOLVED_THEME_KEY,
  ICON_PATHS,
  normalizeState,
  createDefaultState,
  migrate,
} from "./state.js";
import { compileRuleGroups, countActiveHeaders } from "./rules.js";

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(migrate(stored[STORAGE_KEY]));
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
  const active = state.profiles.filter((p) => p.enabled);

  // Check every pattern concurrently. This was one sequential round-trip per
  // filter, which scaled badly across many profiles and widened the window in
  // which the worker could be torn down partway through a sync.
  const checked = await Promise.all(
    active.map(async (profile) => {
      const candidates = profile.urlFilters
        .filter((f) => f.enabled && (f.pattern || "").trim())
        .map((f) => (f.pattern || "").trim());
      const ok = await Promise.all(candidates.map(isRegexOk));
      return { profile, candidates, ok };
    }),
  );

  // Fold back in profile order so the reported errors stay deterministic.
  for (const { profile, candidates, ok } of checked) {
    const valid = [];
    candidates.forEach((pattern, i) => {
      if (ok[i]) valid.push(pattern);
      else
        errors.push({
          profile: profile.name,
          pattern,
          message: "Invalid URL regex — skipped",
        });
    });
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

// Theme-aware toolbar icon. Service workers have no matchMedia, so "system"
// cannot be resolved here; the UI records what it resolved to under
// RESOLVED_THEME_KEY and we reuse that. Previously the worker simply gave up on
// "system" (the default), leaving the manifest's light icon in place — and
// because setIcon does not survive a browser restart, dark-mode users got the
// light icon on every restart until they happened to open the popup.
async function setIconForTheme(state) {
  let theme = state.theme;
  if (theme === "system") {
    const stored = await chrome.storage.local.get(RESOLVED_THEME_KEY);
    theme = stored[RESOLVED_THEME_KEY] === "dark" ? "dark" : "light";
  }
  await chrome.action.setIcon({ path: ICON_PATHS[theme] }).catch(() => {});
}

let syncing = Promise.resolve();
let queued = false;

// Serialize rule updates so rapid edits from the popup don't race each other.
// Coalesce them too: every state change now arrives twice (once via
// storage.onChanged, once via the popup's explicit "resync" nudge), and
// doSyncRules always re-reads the latest state, so a sync that has not started
// yet will already pick up whatever landed after it was queued.
function syncRules() {
  if (queued) return syncing;
  queued = true;
  syncing = syncing
    .then(() => {
      queued = false;
      return doSyncRules();
    })
    .catch((e) => {
      queued = false;
      console.error(e);
    });
  return syncing;
}

// declarativeNetRequest caps dynamic rules. Going over rejects the entire
// batch, which previously meant every profile lost its headers at once, so trim
// deterministically in profile order and say exactly what was dropped.
function ruleCap() {
  const dnr = chrome.declarativeNetRequest;
  return (
    dnr.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ||
    dnr.MAX_NUMBER_OF_DYNAMIC_RULES ||
    5000
  );
}

// Apply rules, degrading gracefully instead of failing closed. A rejected batch
// used to clear every rule — one bad entry anywhere cost every profile its
// headers. Retry profile by profile so a rule Chrome dislikes only costs the
// profile that owns it.
async function applyRuleGroups(groups, removeRuleIds) {
  const errors = [];
  const addRules = groups.flatMap((g) => g.rules);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules,
    });
    return errors;
  } catch (e) {
    console.error("Batch rule update rejected; isolating per profile:", e);
  }

  // Clear once, then contribute whatever each profile can.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  } catch (_) {
    /* ignore */
  }

  for (const g of groups) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: g.rules,
      });
    } catch (e) {
      errors.push({
        profile: g.profileName,
        pattern: "",
        message: `Rules rejected, headers not applied — ${String(e.message || e)}`,
      });
    }
  }
  return errors;
}

async function doSyncRules() {
  const state = await loadState();

  // Paint the badge and icon FIRST. Both derive purely from `state`, so they
  // have no reason to wait on the declarativeNetRequest round-trips below.
  // Doing them last meant that if the worker was torn down mid-sync, the rules
  // had already been applied while the badge still showed the previous count —
  // and nothing repainted it until the extension was restarted.
  await updateBadge(state);
  await setIconForTheme(state);

  const { byProfile, errors } = await validatePatterns(state);
  const allGroups = compileRuleGroups(state, byProfile, (profile, name, reason) => {
    errors.push({
      profile: profile.name,
      pattern: "",
      message: `${reason}: "${name}"`,
    });
  });

  const cap = ruleCap();
  const groups = [];
  let count = 0;
  for (const g of allGroups) {
    if (count + g.rules.length > cap) {
      errors.push({
        profile: g.profileName,
        pattern: "",
        message: `Dynamic-rule limit (${cap}) reached — headers not applied`,
      });
      continue;
    }
    count += g.rules.length;
    groups.push(g);
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const applyErrors = await applyRuleGroups(groups, removeRuleIds);

  await chrome.storage.local.set({ [ERROR_KEY]: [...errors, ...applyErrors] });
}

// --- Lifecycle wiring -------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    // Fresh install — seed a default profile.
    await chrome.storage.local.set({ [STORAGE_KEY]: createDefaultState() });
  } else if (details.reason === "update") {
    // Existing user updating — migrate saved data forward, never drop it.
    await chrome.storage.local.set({
      [STORAGE_KEY]: normalizeState(migrate(stored[STORAGE_KEY])),
    });
    await chrome.storage.local.remove(UPDATE_KEY); // update now applied
  }
  await syncRules();
});

chrome.runtime.onStartup.addListener(() => syncRules());

// When Chrome has a newer version staged, record it so the UI can offer a
// one-click reload instead of waiting for the next browser restart.
chrome.runtime.onUpdateAvailable.addListener((details) => {
  chrome.storage.local.set({ [UPDATE_KEY]: details.version || true });
});

// The popup persists edits to storage; rebuild rules whenever they change.
// Returning the promise matters: a fire-and-forget call left Chrome unaware that
// async work was still pending, so the worker's idle timer could expire partway
// through the sync and strand the badge on a stale count.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    await syncRules();
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
