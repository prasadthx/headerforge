import {
  STORAGE_KEY,
  UPDATE_KEY,
  normalizeState,
  migrate,
  createDefaultState,
  uid,
} from "./state.js";

const REPO = "https://github.com/prasadthx/headerforge";
const $ = (id) => document.getElementById(id);
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
let state;

// ---------------------------------------------------------------------------
// Theme (mirrors the popup so both surfaces look consistent).
// ---------------------------------------------------------------------------
// Toolbar icon variants (see popup.js for the same logic).
const ICON_PATHS = {
  light: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png",
  },
  dark: {
    "16": "icons/icon16-dark.png",
    "48": "icons/icon48-dark.png",
    "128": "icons/icon128-dark.png",
  },
};

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
  chrome.action?.setIcon?.({ path: ICON_PATHS[effectiveTheme(state.theme)] }).catch?.(() => {});
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
async function save() {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
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
  state.profiles.push(...cleaned);
  await save();
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
  state = createDefaultState();
  await save();
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
      state.theme = b.dataset.themeOpt;
      await save();
      applyTheme();
    });
  });

  document.querySelectorAll("[data-desc-opt]").forEach((b) => {
    b.addEventListener("click", async () => {
      state.settings.descriptionPlacement = b.dataset.descOpt;
      await save();
      applySettings();
    });
  });
  $("showOpChk").addEventListener("change", async () => {
    state.settings.showOperation = $("showOpChk").checked;
    await save();
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
}

init();
