import {
  STORAGE_KEY,
  UPDATE_KEY,
  normalizeState,
  migrate,
  createDefaultState,
  uid,
  ICON_PATHS,
  RESOLVED_THEME_KEY,
} from "./state.js";

const REPO = "https://github.com/prasadthx/headerforge";
const $ = (id) => document.getElementById(id);
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
let state;

// ---------------------------------------------------------------------------
// Theme (mirrors the popup so both surfaces look consistent).
// ---------------------------------------------------------------------------
function effectiveTheme(t) {
  if (t === "system") return darkMedia.matches ? "dark" : "light";
  return t;
}
function applyTheme() {
  const theme = effectiveTheme(state.theme);
  document.documentElement.setAttribute("data-theme", theme);
  $("pageLogo").src = `icons/icon${theme === "dark" ? "128-dark" : "128"}.png`;
  document
    .querySelectorAll("[data-theme-opt]")
    .forEach((b) => b.classList.toggle("is-active", b.dataset.themeOpt === state.theme));
  chrome.action?.setIcon?.({ path: ICON_PATHS[theme] }).catch?.(() => {});
  chrome.storage?.local?.set?.({ [RESOLVED_THEME_KEY]: theme });
}

// ---------------------------------------------------------------------------
// Header-row layout settings.
// ---------------------------------------------------------------------------
function applySettings() {
  document
    .querySelectorAll("[data-desc-opt]")
    .forEach((b) =>
      b.classList.toggle("is-active", b.dataset.descOpt === state.settings.descriptionPlacement),
    );
  $("showOpChk").checked = state.settings.showOperation;
}

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------
// Read-modify-write, never blind-write.
//
// This page lives in a tab, so its `state` can be minutes stale. Writing that
// snapshot wholesale silently reverted anything the popup had changed in the
// meantime: a paused extension resumed itself (headers started flowing again on
// sites the user had explicitly paused) and newly added profiles vanished.
// `mutate` receives freshly-read state and returns the version to persist, so
// each caller only ever overwrites the fields it actually owns.
async function save(mutate) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const base = normalizeState(migrate(stored[STORAGE_KEY]));
  state = normalizeState(mutate ? mutate(base) : base);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  try {
    // storage.onChanged is not a reliable wake-up for a dormant MV3 worker.
    await chrome.runtime.sendMessage({ type: "resync" });
  } catch {
    /* no receiver; the worker syncs on spin-up */
  }
}

function download(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Updates.
// ---------------------------------------------------------------------------
async function checkForUpdates() {
  const status = $("updateStatus");
  status.textContent = "Checking…";
  try {
    if (!chrome.runtime.requestUpdateCheck) {
      status.textContent =
        "Update checks are available once installed from the Chrome Web Store.";
      return;
    }
    const res = await chrome.runtime.requestUpdateCheck();
    const code = res && res.status ? res.status : res;
    if (code === "update_available") {
      status.textContent = `Update available${res.version ? ` (v${res.version})` : ""} — reloading…`;
      chrome.runtime.reload();
    } else if (code === "throttled") {
      status.textContent = "Chrome is throttling update checks — try again shortly.";
    } else {
      status.textContent = "You’re on the latest version.";
    }
  } catch (_) {
    // Unpacked/dev builds can't check the store.
    status.textContent =
      "Update checks are available once installed from the Chrome Web Store.";
  }
}

// ---------------------------------------------------------------------------
// Data management.
// ---------------------------------------------------------------------------
function exportProfiles() {
  download(
    "headerforge-profiles.json",
    JSON.stringify(
      { app: "HeaderForge", version: 1, exportedAt: new Date().toISOString(), profiles: state.profiles },
      null,
      2,
    ),
  );
  $("dataStatus").textContent = "Exported all profiles.";
}

async function importProfiles(file) {
  const status = $("dataStatus");
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    status.textContent = "Invalid JSON file.";
    return;
  }
  const incoming = Array.isArray(data) ? data : data && data.profiles;
  if (!Array.isArray(incoming) || incoming.length === 0) {
    status.textContent = "No profiles found in that file.";
    return;
  }
  const cleaned = normalizeState({ profiles: incoming }).profiles.map((p) => ({
    ...p,
    id: uid(),
  }));
  await save((s) => ({ ...s, profiles: [...s.profiles, ...cleaned] }));
  status.textContent = `Imported ${cleaned.length} profile${cleaned.length === 1 ? "" : "s"}.`;
}

async function resetAll() {
  if (
    !confirm(
      "Reset all data? This deletes every profile and header and cannot be undone.",
    )
  ) {
    return;
  }
  await save(() => createDefaultState());
  applyTheme();
  applySettings();
  $("dataStatus").textContent = "All data reset to defaults.";
}

// ---------------------------------------------------------------------------
// Init.
// ---------------------------------------------------------------------------
async function init() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, UPDATE_KEY]);
  state = normalizeState(migrate(stored[STORAGE_KEY]));
  applyTheme();
  applySettings();

  const version = chrome.runtime.getManifest().version;
  $("version").textContent = `v${version}`;
  $("version2").textContent = version;
  $("footVersion").textContent = `HeaderForge v${version}`;

  $("repoLink").href = REPO;
  $("issuesLink").href = `${REPO}/issues`;
  $("privacyLink").href = `${REPO}/blob/main/PRIVACY.md`;
  $("footRepo").href = REPO;

  // Staged update banner.
  const staged = stored[UPDATE_KEY];
  if (staged) {
    $("updateReady").hidden = false;
    $("updateReadyVer").textContent =
      typeof staged === "string" ? `v${staged} is ready.` : "A new version is ready.";
    $("applyUpdateBtn").addEventListener("click", () => chrome.runtime.reload());
  }

  $("checkUpdateBtn").addEventListener("click", checkForUpdates);

  document.querySelectorAll("[data-theme-opt]").forEach((b) => {
    b.addEventListener("click", async () => {
      await save((s) => ({ ...s, theme: b.dataset.themeOpt }));
      applyTheme();
    });
  });

  document.querySelectorAll("[data-desc-opt]").forEach((b) => {
    b.addEventListener("click", async () => {
      await save((s) => ({
        ...s,
        settings: { ...s.settings, descriptionPlacement: b.dataset.descOpt },
      }));
      applySettings();
    });
  });
  $("showOpChk").addEventListener("change", async () => {
    const showOperation = $("showOpChk").checked;
    await save((s) => ({ ...s, settings: { ...s.settings, showOperation } }));
  });

  $("exportBtn").addEventListener("click", exportProfiles);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async () => {
    const file = $("importFile").files[0];
    if (file) await importProfiles(file);
    $("importFile").value = "";
  });
  $("resetBtn").addEventListener("click", resetAll);

  darkMedia.addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  // The popup can change the shared state while this tab sits open. Adopt it so
  // the page never displays values it no longer owns.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    state = normalizeState(migrate(changes[STORAGE_KEY].newValue));
    applyTheme();
    applySettings();
  });
}

init();
