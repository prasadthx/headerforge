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

// What the UI last resolved "system" to. Read alongside the state so the icon
// costs no extra round-trip on a path that runs on every keystroke.
let resolvedThemeHint = "light";

async function loadState() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, RESOLVED_THEME_KEY]);
  resolvedThemeHint = stored[RESOLVED_THEME_KEY] === "dark" ? "dark" : "light";
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
function setIconForTheme(state) {
  const theme = state.theme === "system" ? resolvedThemeHint : state.theme;
  return chrome.action.setIcon({ path: ICON_PATHS[theme] }).catch(() => {});
}

// Cosmetic, and strictly best-effort. Painting early means a worker teardown
// mid-sync cannot strand the badge, but this must never be able to prevent the
// rule update: an unguarded throw here aborted the whole sync, leaving the
// previous rules applied while the badge kept its old count — a paused
// extension that still modified headers, recoverable only by restarting it.
// declarativeNetRequest dynamic rules persist by design, so nothing else was
// going to take them down.
async function paintAction(state) {
  try {
    await updateBadge(state);
    await setIconForTheme(state);
    return true;
  } catch (e) {
    console.error("Badge/icon update failed (ignored):", e);
    return false;
  }
}

// Take every rule down. This is the whole job when paused, so keep it as short
// as possible: nothing between reading the state and removing the rules.
async function removeAllRules(isCurrent) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length === 0) return;
  // Mirror image of the stale-apply bug: this read can return after a newer
  // sync has already applied rules for a state the user has since resumed.
  // Removing them then switches every header off with nothing left to put them
  // back, because the sync that would have is already finished.
  if (isCurrent && !isCurrent()) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
  });
}

// Last error set written, so an unchanged one is not rewritten on every sync.
// Undefined after a worker restart, so the first sync always writes and stale
// errors can never survive.
let lastErrorsJson;

async function writeErrors(errors) {
  const json = JSON.stringify(errors);
  if (json === lastErrorsJson) return;
  lastErrorsJson = json;
  await chrome.storage.local.set({ [ERROR_KEY]: errors });
}

// A thrown sync used to be silent: the badge and the applied rules both kept
// their previous values with nothing telling the user that what the popup shows
// is no longer what the browser is doing.
async function reportSyncFailure(e) {
  try {
    await writeErrors([
      {
        profile: "",
        pattern: "",
        message: `Could not update header rules — ${String(e.message || e)}`,
      },
    ]);
  } catch (_) {
    /* nothing left to try */
  }
}

let syncing = Promise.resolve();
let queued = false;
let consecutiveFailures = 0;

// Generation guard.
//
// syncRules races doSyncRules against SYNC_TIMEOUT_MS so one stalled chrome
// call cannot wedge the chain. But losing that race does not *stop* the work:
// the call eventually returns and the rest of doSyncRules carries on, holding
// state it read before the user's most recent change. Because
// declarativeNetRequest dynamic rules persist by design, that late write
// re-applied headers the user had already paused — badge "off", rules live,
// clearable only by restarting the extension — and repainted the badge from a
// state that no longer existed, which is the badge showing a count that does
// not match what is actually applied.
//
// Every write below is therefore gated on this sync still being the current
// generation. Bailing out is always safe: the only thing that can supersede a
// sync is a newer one, and each one re-reads the latest state and does the
// whole job.
let syncEpoch = 0;

// A chrome API call that never settles must not be able to stall the chain.
// When Chrome tears a worker down mid-await, the in-flight promise is abandoned
// — it neither resolves nor rejects — and because every later syncRules()
// chained onto it, the worker silently stopped syncing for the rest of its
// life while the rules already applied stayed in force. That is the "paused but
// headers still applied, only fixed by restarting the extension" report, and it
// gets likelier the longer Chrome has been running and the more tabs compete
// for memory. Racing a timer guarantees the chain always moves on.
const SYNC_TIMEOUT_MS = 15000;
const MAX_SYNC_RETRIES = 3;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

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
      // Never chain onto a bare doSyncRules(): if it cannot settle, neither can
      // `syncing`, and then this callback never runs again — leaving `queued`
      // latched true so every future call short-circuits at the guard above.
      return withTimeout(doSyncRules(), SYNC_TIMEOUT_MS, "Rule sync");
    })
    .then(() => {
      consecutiveFailures = 0;
    })
    .catch((e) => {
      queued = false;
      // The sync we gave up on may still be running (a timeout abandons it, it
      // does not cancel it). Retire its generation now so it cannot write once
      // its stalled call finally returns.
      syncEpoch++;
      console.error(e);
      // Deliberately not awaited. Nothing in this chain may be capable of not
      // settling: if the error write became part of `syncing`, a hang in it
      // would stall every later sync exactly like the failure it is reporting.
      void reportSyncFailure(e);
      // The applied rules are now unverified, and the user may not touch
      // anything again for hours. Retry on a short backoff rather than leaving
      // the browser doing something the popup does not show. Bounded, so a
      // persistently broken engine cannot spin.
      if (++consecutiveFailures <= MAX_SYNC_RETRIES) {
        setTimeout(() => syncRules(), 1000 * consecutiveFailures);
      }
    });
  return syncing;
}

// declarativeNetRequest caps dynamic rules. Going over rejects the entire
// batch, which previously meant every profile lost its headers at once, so trim
// in precedence order (see doSyncRules) and say exactly what was dropped. The
// unsafe-rule cap is used when exposed: it is the lower of the two, so trimming
// against it is conservative.
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
  const failedProfileIds = new Set();
  const addRules = groups.flatMap((g) => g.rules);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules,
    });
    return { errors, failedProfileIds };
  } catch (e) {
    console.error("Batch rule update rejected; isolating per profile:", e);
  }

  // Clear once, then contribute whatever each profile can. This has to succeed:
  // the per-profile adds below reuse rule ids 1..n, so leaving the old rules in
  // place would make every single one collide and report a per-profile failure
  // that has nothing to do with the profile. Report the real cause instead.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  } catch (e) {
    for (const g of groups) failedProfileIds.add(g.profileId);
    errors.push({
      profile: "",
      pattern: "",
      message: `Could not clear existing rules, headers not applied — ${String(e.message || e)}`,
    });
    return { errors, failedProfileIds };
  }

  for (const g of groups) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: g.rules,
      });
    } catch (e) {
      failedProfileIds.add(g.profileId);
      errors.push({
        profile: g.profileName,
        pattern: "",
        message: `Rules rejected, headers not applied — ${String(e.message || e)}`,
      });
    }
  }
  return { errors, failedProfileIds };
}

async function doSyncRules() {
  const epoch = ++syncEpoch;
  const current = () => epoch === syncEpoch;

  const state = await loadState();
  if (!current()) return;

  const painted = await paintAction(state);
  if (!current()) return;

  // Paused is the safety-critical case: getting the rules off matters more than
  // anything else this function does, so go straight there. Skipping regex
  // validation and compilation also removes every step that could throw between
  // reading `paused` and acting on it.
  if (state.paused) {
    await removeAllRules(current);
    if (!painted) await paintAction(state);
    await writeErrors([]);
    return;
  }

  const { byProfile, errors } = await validatePatterns(state);
  if (!current()) return;
  const allGroups = compileRuleGroups(state, byProfile, (profile, name, reason) => {
    errors.push({
      profile: profile.name,
      pattern: "",
      message: `${reason}: "${name}"`,
    });
  });

  const cap = ruleCap();
  const groups = [];
  const dropped = new Set();
  let count = 0;
  // Admit in precedence order: all rules in a group share the profile's
  // priority, so sorting by it means a cap sheds the least important profiles
  // rather than whichever happened to sit last in the sidebar — which could
  // otherwise drop the selected profile, the one we just promoted to the top.
  const byPrecedence = [...allGroups].sort(
    (a, b) => b.rules[0].priority - a.rules[0].priority,
  );
  for (const g of byPrecedence) {
    if (count + g.rules.length > cap) {
      dropped.add(g.profileId);
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
  if (!current()) return;
  const removeRuleIds = existing.map((r) => r.id);
  const { errors: applyErrors, failedProfileIds } = await applyRuleGroups(
    groups,
    removeRuleIds,
  );
  if (!current()) return;

  // The optimistic badge above counted every locally-valid header. If a profile
  // was dropped at the cap or rejected by the engine, its headers are not
  // applied, so repaint from what actually landed.
  const notApplied = new Set([...dropped, ...failedProfileIds]);
  if (!painted || notApplied.size > 0) {
    await paintAction({
      ...state,
      profiles: state.profiles.filter((p) => !notApplied.has(p.id)),
    });
  }

  await writeErrors([...errors, ...applyErrors]);
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

// The popup calls this after every write, because storage.onChanged alone does
// not reliably wake a dormant worker.
//
// Do not "simplify" this to a synchronous sendResponse: holding the port open
// until the sync finishes is what keeps the worker alive long enough to finish
// it. Responding immediately and returning false would let Chrome reclaim the
// worker mid-sync, which is the failure this whole path exists to avoid. The
// caller ignores the response; the timeout in syncRules bounds how long the
// port can stay open.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "resync") {
    syncRules().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});

// Rebuild once when the worker spins up.
syncRules();
