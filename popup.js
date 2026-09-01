import {
  STORAGE_KEY,
  ERROR_KEY,
  PROFILE_COLORS,
  OPERATIONS,
  SIZE_LIMITS,
  uid,
  makeHeader,
  makeUrlFilter,
  makeProfile,
  normalizeState,
  migrate,
  createDefaultState,
  ICON_PATHS,
  RESOLVED_THEME_KEY,
} from "./state.js";

const REPO = "https://github.com/prasadthx/headerforge";

// ---------------------------------------------------------------------------
// Icons — inline SVGs applied as CSS masks so they inherit currentColor.
// ---------------------------------------------------------------------------
const ICONS = {
  pause:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>',
  theme:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0 0 18z"/><circle cx="12" cy="12" r="9" fill="none" stroke="#000" stroke-width="2"/></svg>',
  more: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>',
  plus: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  trash:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9z"/></svg>',
  // Pencil — "write a description for this header".
  note: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm2.92 1.83H5v-.92l9.06-9.06.92.92-9.06 9.06zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  // Gear — opens the About & settings page.
  settings:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.65 8.8a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.62-.06.94s.02.63.06.94L2.77 14.5a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>',
  // Magnifier — fuzzy header search.
  search:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>',
  // X — closes the in-popup settings panel.
  close:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18.3 5.71 12 12.01 5.7 5.71 4.29 7.12 10.59 13.4 4.29 19.7l1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.28z"/></svg>',
};

function svgMask(svg) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function injectIcons() {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(ICONS)) {
    root.style.setProperty(`--i-${k}`, svgMask(v));
  }
}

// ---------------------------------------------------------------------------
// Tiny DOM helper.
// ---------------------------------------------------------------------------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const $ = (id) => document.getElementById(id);
const dom = {
  app: $("app"),
  profileList: $("profileList"),
  addProfileBtn: $("addProfileBtn"),
  profileMenu: $("profileMenu"),
  pauseBtn: $("pauseBtn"),
  pausedBanner: $("pausedBanner"),
  resumeBtn: $("resumeBtn"),
  brandLogo: $("brandLogo"),
  errorBanner: $("errorBanner"),
  headerSearch: $("headerSearch"),
  themeBtn: $("themeBtn"),
  requestRows: $("requestRows"),
  responseRows: $("responseRows"),
  filterRows: $("filterRows"),
  countRequest: $("countRequest"),
  countResponse: $("countResponse"),
  countFilters: $("countFilters"),
  exportBtn: $("exportBtn"),
  importBtn: $("importBtn"),
  importFile: $("importFile"),
  importHeadersFile: $("importHeadersFile"),
  optionsBtn: $("optionsBtn"),
  settingsPanel: $("settingsPanel"),
  settingsCloseBtn: $("settingsCloseBtn"),
  settingsStatus: $("settingsStatus"),
  settingsVersion: $("settingsVersion"),
  fullOptionsBtn: $("fullOptionsBtn"),
  settingsExportBtn: $("settingsExportBtn"),
  settingsImportBtn: $("settingsImportBtn"),
  settingsResetBtn: $("settingsResetBtn"),
  settingsVersion2: $("settingsVersion2"),
  settingsCheckUpdateBtn: $("settingsCheckUpdateBtn"),
  settingsUpdateStatus: $("settingsUpdateStatus"),
  settingsRepoLink: $("settingsRepoLink"),
  settingsIssuesLink: $("settingsIssuesLink"),
  showOpChk: $("showOpChk"),
  resizeGrip: $("resizeGrip"),
};

// ---------------------------------------------------------------------------
// State + persistence.
// ---------------------------------------------------------------------------
let state;
let activeTab = "request";
let saveTimer;
let pendingHeaderKind = "request"; // which list a header-import targets
let menuProfileId = null; // profile the open action menu belongs to
let searchQuery = ""; // fuzzy header search term

function currentProfile() {
  return (
    state.profiles.find((p) => p.id === state.selectedProfileId) ||
    state.profiles[0]
  );
}

// Persist, then explicitly nudge the service worker.
//
// storage.onChanged is the background's only other trigger, and it is NOT a
// reliable wake-up for a *dormant* MV3 worker: after ~30s idle Chrome tears the
// worker down, and a storage write from the popup can be dropped without ever
// dispatching the event. When that happened, doSyncRules never ran at all — so
// pausing left the old rules applied and the badge showing the old count, and
// the only way out was restarting the extension (which re-runs syncRules at
// module scope). runtime.sendMessage does reliably wake the worker, so we send
// it after the write has landed.
async function commit() {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  try {
    await chrome.runtime.sendMessage({ type: "resync" });
  } catch {
    // No receiver (worker still starting, or the popup closed first). The
    // storage write is already durable and the worker syncs on spin-up.
  }
}

function save({ immediate = false } = {}) {
  clearTimeout(saveTimer);
  if (immediate) return commit();
  saveTimer = setTimeout(commit, 200);
  return Promise.resolve();
}

async function flush() {
  clearTimeout(saveTimer);
  await commit();
}

// ---------------------------------------------------------------------------
// Reusable widgets.
// ---------------------------------------------------------------------------
function makeSwitch(checked, onChange, extraClass = "switch--sm") {
  const input = el("input", { type: "checkbox", checked });
  input.addEventListener("change", () => onChange(input.checked));
  const track = el("span", { class: "switch__track" }, [
    el("span", { class: "switch__thumb" }),
  ]);
  return el("label", { class: `switch ${extraClass}` }, [input, track]);
}

function glyph(name) {
  const span = el("span", { class: "iconbtn__glyph" });
  span.dataset.icon = name;
  return span;
}

function headerRow(list, h) {
  const item = el("div", {
    class: "header-item" + (h.enabled ? "" : " is-disabled"),
  });
  const s = state.settings;
  const showOp = s.showOperation;
  const descInline = s.descriptionPlacement === "inline";

  const row = el("div", {
    class:
      "row" +
      (showOp ? " row--op" : "") +
      (descInline ? "" : " row--nodesc"),
  });
  row.dataset.id = h.id;

  const toggle = makeSwitch(h.enabled, (checked) => {
    h.enabled = checked;
    item.classList.toggle("is-disabled", !checked);
    save();
  });
  toggle.classList.add("row__toggle");
  toggle.title = "Enable / disable this header";

  const nameInput = el("input", {
    class: "field",
    value: h.name,
    placeholder: "Header name",
    spellcheck: false,
    autocomplete: "off",
  });
  const valueInput = el("input", {
    class: "field field--mono",
    value: h.value,
    placeholder: "Value",
    spellcheck: false,
    autocomplete: "off",
  });
  nameInput.addEventListener("input", () => {
    h.name = nameInput.value;
    save();
  });
  valueInput.addEventListener("input", () => {
    h.value = valueInput.value;
    save();
  });

  // Description (metadata only — never sent as a real header).
  const noteInput = el("input", {
    class: "field field--note",
    value: h.description || "",
    placeholder: "Description (optional)",
    spellcheck: false,
    autocomplete: "off",
  });
  noteInput.addEventListener("input", () => {
    h.description = noteInput.value;
    save();
  });

  const del = el("button", { class: "delbtn", title: "Remove header" }, [
    glyph("trash"),
  ]);
  del.addEventListener("click", () => {
    const i = list.indexOf(h);
    if (i >= 0) list.splice(i, 1);
    save();
    renderPanels();
  });

  if (showOp) {
    const op = el("select", { class: "op-select", title: "Operation" });
    for (const o of OPERATIONS) op.append(el("option", { value: o, textContent: o }));
    op.value = h.operation;
    op.addEventListener("change", () => {
      h.operation = op.value;
      save();
    });
    row.append(op);
  }

  row.append(toggle, nameInput, valueInput);
  if (descInline) row.append(noteInput);
  row.append(del);

  item.append(row);
  if (s.descriptionPlacement === "below") {
    item.append(el("div", { class: "row-note" }, [noteInput]));
  }
  return item;
}

function filterRow(list, f) {
  const row = el("div", {
    class: "row row--filter" + (f.enabled ? "" : " row--disabled"),
  });
  const toggle = makeSwitch(f.enabled, (checked) => {
    f.enabled = checked;
    row.classList.toggle("row--disabled", !checked);
    save();
  });
  toggle.classList.add("row__toggle");

  const input = el("input", {
    class: "field field--mono",
    value: f.pattern,
    placeholder: "e.g. .*\\.example\\.com/.*",
    spellcheck: false,
    autocomplete: "off",
  });
  input.addEventListener("input", () => {
    f.pattern = input.value;
    save();
  });

  const del = el("button", { class: "delbtn", title: "Remove filter" }, [
    glyph("trash"),
  ]);
  del.addEventListener("click", () => {
    const i = list.indexOf(f);
    if (i >= 0) list.splice(i, 1);
    save();
    renderPanels();
  });

  row.append(toggle, input, del);
  return row;
}

// ---------------------------------------------------------------------------
// Fuzzy header search.
// ---------------------------------------------------------------------------
function isSubsequence(token, text) {
  let i = 0;
  for (const ch of text) {
    if (ch === token[i]) i++;
    if (i === token.length) return true;
  }
  return i === token.length;
}

// Match a query against a lowercased header haystack: plain substring wins,
// otherwise every whitespace-separated token must appear as a subsequence
// (so "xau" matches "x-auth-override", "bear" matches "Bearer …", etc.).
function fuzzyMatch(query, text) {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  if (text.includes(q)) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.every((t) => t.length >= 2 && isSubsequence(t, text))
  );
}

function headerSearchText(h) {
  return [h.name, h.value, h.description, h.operation].join(" ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
function fillRows(container, list, make, emptyMsg) {
  container.textContent = "";
  if (list.length === 0) {
    container.append(el("div", { class: "empty", textContent: emptyMsg }));
    return;
  }
  for (const item of list) container.append(make(item));
}

function renderPanels() {
  const p = currentProfile();
  const q = searchQuery;
  const requestList = q
    ? p.requestHeaders.filter((h) => fuzzyMatch(q, headerSearchText(h)))
    : p.requestHeaders;
  const responseList = q
    ? p.responseHeaders.filter((h) => fuzzyMatch(q, headerSearchText(h)))
    : p.responseHeaders;

  fillRows(
    dom.requestRows,
    requestList,
    (h) => headerRow(p.requestHeaders, h),
    q ? `No request headers match "${q}".` : "No request headers yet.",
  );
  fillRows(
    dom.responseRows,
    responseList,
    (h) => headerRow(p.responseHeaders, h),
    q ? `No response headers match "${q}".` : "No response headers yet.",
  );
  fillRows(
    dom.filterRows,
    p.urlFilters,
    (f) => filterRow(p.urlFilters, f),
    "No URL filters — this profile applies to every request.",
  );
  dom.countRequest.textContent = p.requestHeaders.length;
  dom.countResponse.textContent = p.responseHeaders.length;
  dom.countFilters.textContent = p.urlFilters.length;
}

function renderSidebar() {
  dom.profileList.textContent = "";
  for (const p of state.profiles) {
    const active = p.id === state.selectedProfileId;
    const item = el("div", {
      class: "pf" + (active ? " is-active" : "") + (p.enabled ? "" : " pf--off"),
      title: p.enabled ? p.name : `${p.name} (disabled)`,
    });
    item.dataset.profileId = p.id;

    const bar = el("span", { class: "pf__bar" });
    if (active) bar.style.background = p.color;
    const dot = el("span", { class: "pf__dot" });
    dot.style.background = p.color;
    const name = el("span", { class: "pf__name", textContent: p.name });

    // Per-profile actions button (rename / duplicate / enable / colour / delete).
    const actions = el("button", { class: "pf__menu", title: "Profile actions" }, [
      glyph("more"),
    ]);
    actions.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!dom.profileMenu.hidden && menuProfileId === p.id) {
        closeMenu();
      } else {
        openProfileMenu(p, actions);
      }
    });

    item.append(bar, dot, name, actions);
    if (active) {
      item.style.background = `color-mix(in srgb, ${p.color} 12%, transparent)`;
    }
    item.addEventListener("click", () => selectProfile(p.id));
    item.addEventListener("dblclick", () => {
      if (p.id === state.selectedProfileId) startRename(p, item, name);
    });
    dom.profileList.append(item);
  }

  const activeItem = dom.profileList.querySelector(".pf.is-active");
  if (activeItem) activeItem.scrollIntoView({ block: "nearest" });
}

function renderPausedUI() {
  dom.pauseBtn.setAttribute("aria-pressed", String(state.paused));
  dom.pausedBanner.hidden = !state.paused;
  dom.pauseBtn.title = state.paused ? "Resume all headers" : "Pause all headers";
}

function renderErrors(errors) {
  if (!errors || errors.length === 0) {
    dom.errorBanner.hidden = true;
    dom.errorBanner.textContent = "";
    return;
  }
  // Keep the profile name even when there is no regex to show — without it, a
  // per-profile failure rendered as a bare message with no clue which profile
  // to go and fix.
  const lines = errors.map((e) => {
    const where = e.profile && e.profile !== "—" ? `${e.profile}: ` : "";
    return e.pattern
      ? `${where}${e.message}  ·  /${e.pattern}/`
      : `${where}${e.message}`;
  });
  dom.errorBanner.hidden = false;
  dom.errorBanner.textContent = "⚠  " + lines.join("\n");
}

function renderAll() {
  renderSidebar();
  renderPanels();
  renderPausedUI();
}

// ---------------------------------------------------------------------------
// Popup size (drag to resize).
// ---------------------------------------------------------------------------
function applySize() {
  dom.app.style.width = state.popupWidth + "px";
  dom.app.style.height = state.popupHeight ? state.popupHeight + "px" : "";
}

function wireResize() {
  const grip = dom.resizeGrip;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;

  const onMove = (e) => {
    // Popup is anchored top-right, so it grows down/left. Screen coords avoid a
    // feedback loop as the popup's own left edge moves during the drag.
    const w = clamp(
      startW + (startX - e.screenX),
      SIZE_LIMITS.minWidth,
      SIZE_LIMITS.maxWidth,
    );
    const h = clamp(
      startH + (e.screenY - startY),
      SIZE_LIMITS.minHeight,
      SIZE_LIMITS.maxHeight,
    );
    state.popupWidth = Math.round(w);
    state.popupHeight = Math.round(h);
    dom.app.style.width = w + "px";
    dom.app.style.height = h + "px";
  };
  const onUp = (e) => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.body.classList.remove("is-resizing");
    if (grip.releasePointerCapture) {
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
    save({ immediate: true });
  };

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.screenX;
    startY = e.screenY;
    const rect = dom.app.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    if (grip.setPointerCapture) {
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    document.body.classList.add("is-resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------------------
// Theme.
// ---------------------------------------------------------------------------
const darkMedia = matchMedia("(prefers-color-scheme: dark)");

// Toolbar icon variants. Chrome has no theme-aware icon support, so we swap
// paths manually: the light icon is the dark purple square (for light toolbars),
// the dark one is the light lavender variant (for dark toolbars).
function effectiveTheme() {
  if (state.theme === "system") return darkMedia.matches ? "dark" : "light";
  return state.theme;
}

function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.setAttribute("data-theme", theme);
  dom.brandLogo.src = `icons/icon${theme === "dark" ? "48-dark" : "48"}.png`;
  dom.themeBtn.title = `Theme: ${state.theme} (click to change)`;
  document
    .querySelectorAll("[data-theme-opt]")
    .forEach((b) => b.classList.toggle("is-active", b.dataset.themeOpt === state.theme));
  const resolved = effectiveTheme();
  chrome.action?.setIcon?.({ path: ICON_PATHS[resolved] }).catch?.(() => {});
  // Remember the resolution so the worker can pick the right icon on a cold
  // start, when it has no way to evaluate "system" itself.
  chrome.storage?.local?.set?.({ [RESOLVED_THEME_KEY]: resolved });
}

function cycleTheme() {
  const order = ["system", "light", "dark"];
  state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
  save();
  applyTheme();
  toast(`Theme: ${state.theme}`);
}

// ---------------------------------------------------------------------------
// In-popup settings panel.
// ---------------------------------------------------------------------------
function applySettingsUI() {
  document
    .querySelectorAll("[data-desc-opt]")
    .forEach((b) =>
      b.classList.toggle(
        "is-active",
        b.dataset.descOpt === state.settings.descriptionPlacement,
      ),
    );
  dom.showOpChk.checked = state.settings.showOperation;
}

function openSettings() {
  applyTheme();
  applySettingsUI();
  dom.settingsPanel.hidden = false;
}

function closeSettings() {
  dom.settingsPanel.hidden = true;
  dom.settingsStatus.textContent = "";
}

async function checkForUpdates() {
  const status = dom.settingsUpdateStatus;
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
    status.textContent =
      "Update checks are available once installed from the Chrome Web Store.";
  }
}

async function resetAllData() {
  if (
    !confirm(
      "Reset all data? This deletes every profile and header and cannot be undone.",
    )
  ) {
    return;
  }
  state = createDefaultState();
  save({ immediate: true });
  applyTheme();
  applySettingsUI();
  renderAll();
  closeSettings();
  toast("All data reset to defaults");
}

// ---------------------------------------------------------------------------
// Tabs.
// ---------------------------------------------------------------------------
function setActiveTab(name) {
  activeTab = name;
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  document
    .querySelectorAll(".panel")
    .forEach((pn) => pn.classList.toggle("is-active", pn.dataset.panel === name));
}

// ---------------------------------------------------------------------------
// Profile actions.
// ---------------------------------------------------------------------------
function closeMenu() {
  dom.profileMenu.hidden = true;
  menuProfileId = null;
}

function menuItem(label, onClick, cls = "") {
  const b = el("button", {
    class: "menu__item" + (cls ? " " + cls : ""),
    textContent: label,
  });
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

// Build + open the action menu for a specific profile, anchored to its button.
function openProfileMenu(p, anchorBtn) {
  const menu = dom.profileMenu;
  menuProfileId = p.id;
  menu.textContent = "";

  menu.append(
    menuItem("Rename profile", () => {
      closeMenu();
      renameProfile(p);
    }),
  );
  menu.append(
    menuItem("Duplicate profile", () => {
      closeMenu();
      cloneProfile(p);
    }),
  );
  menu.append(
    menuItem(p.enabled ? "Disable profile" : "Enable profile", () => {
      p.enabled = !p.enabled;
      save();
      renderSidebar();
      closeMenu();
    }),
  );

  const colors = el("div", { class: "menu__colors" });
  for (const c of PROFILE_COLORS) {
    const s = el("button", {
      class: "swatch" + (c === p.color ? " is-selected" : ""),
      title: c,
    });
    s.style.background = c;
    s.addEventListener("click", () => {
      p.color = c;
      save();
      colors
        .querySelectorAll(".swatch")
        .forEach((sw) => sw.classList.toggle("is-selected", sw.title === c));
      renderSidebar();
    });
    colors.append(s);
  }
  menu.append(colors);

  const del = menuItem("Delete profile", null, "menu__item--danger");
  let armed = false;
  let armTimer;
  del.addEventListener("click", () => {
    if (state.profiles.length <= 1) {
      toast("Keep at least one profile");
      return;
    }
    if (!armed) {
      armed = true;
      del.textContent = "Click again to confirm";
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = false;
        del.textContent = "Delete profile";
      }, 3000);
      return;
    }
    clearTimeout(armTimer);
    closeMenu();
    deleteProfile(p);
  });
  menu.append(del);

  positionMenu(menu, anchorBtn);
}

function positionMenu(menu, anchorBtn) {
  menu.hidden = false; // unhide so we can measure it
  const appRect = dom.app.getBoundingClientRect();
  const btnRect = anchorBtn.getBoundingClientRect();
  const mw = menu.offsetWidth || 190;
  const mh = menu.offsetHeight || 200;
  const left = clamp(btnRect.left - appRect.left, 6, appRect.width - mw - 6);
  let top = btnRect.bottom - appRect.top + 4;
  if (top + mh > appRect.height - 6) {
    top = btnRect.top - appRect.top - mh - 4; // flip above when near the bottom
    if (top < 6) top = 6;
  }
  menu.style.left = left + "px";
  menu.style.right = "auto";
  menu.style.top = top + "px";
}

function selectProfile(id) {
  closeMenu();
  // Skip re-selecting the active profile so the pill DOM node survives a
  // double-click (which we use to trigger inline rename).
  if (id === state.selectedProfileId) return;
  state.selectedProfileId = id;
  save();
  renderSidebar();
  renderPanels();
  setActiveTab(activeTab);
}

function addItem(kind) {
  // Drop an active search so the freshly added row is visible and focusable.
  if (searchQuery) {
    searchQuery = "";
    dom.headerSearch.value = "";
  }
  const p = currentProfile();
  if (kind === "request") p.requestHeaders.push(makeHeader());
  else if (kind === "response") p.responseHeaders.push(makeHeader());
  else if (kind === "filter") p.urlFilters.push(makeUrlFilter());
  save();
  renderPanels();
  setActiveTab(kind === "filter" ? "filters" : kind);
  const container =
    kind === "request"
      ? dom.requestRows
      : kind === "response"
        ? dom.responseRows
        : dom.filterRows;
  const rows = container.querySelectorAll(".row");
  const last = rows[rows.length - 1];
  if (last) {
    const f = last.querySelector("input.field");
    if (f) f.focus();
  }
}

function addProfile() {
  closeMenu();
  const n = state.profiles.length + 1;
  const p = makeProfile(`Profile ${n}`, n - 1);
  state.profiles.push(p);
  state.selectedProfileId = p.id;
  save({ immediate: true });
  renderAll();
  setActiveTab("request");
}

function cloneProfile(src) {
  const copy = normalizeState({ profiles: [{ ...src, name: `${src.name} copy` }] })
    .profiles[0];
  copy.id = uid();
  copy.requestHeaders.forEach((h) => (h.id = uid()));
  copy.responseHeaders.forEach((h) => (h.id = uid()));
  copy.urlFilters.forEach((f) => (f.id = uid()));
  const idx = state.profiles.findIndex((p) => p.id === src.id);
  state.profiles.splice(idx + 1, 0, copy);
  state.selectedProfileId = copy.id;
  save({ immediate: true });
  renderAll();
}

function deleteProfile(p) {
  if (state.profiles.length <= 1) return;
  const idx = state.profiles.findIndex((x) => x.id === p.id);
  if (idx < 0) return;
  state.profiles.splice(idx, 1);
  if (state.selectedProfileId === p.id) {
    state.selectedProfileId = state.profiles[Math.max(0, idx - 1)].id;
  }
  save({ immediate: true });
  renderAll();
}

function renameProfile(p) {
  const item = dom.profileList.querySelector(`[data-profile-id="${p.id}"]`);
  const label = item && item.querySelector(".pf__name");
  if (item && label) startRename(p, item, label);
}

function startRename(profile, pill, label) {
  const input = el("input", {
    class: "pf__rename",
    value: profile.name,
    spellcheck: false,
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      profile.name = input.value.trim() || profile.name;
      save();
    }
    renderSidebar();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

// ---------------------------------------------------------------------------
// Import / export.
// ---------------------------------------------------------------------------
function download(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportProfiles() {
  download(
    "headerforge-profiles.json",
    JSON.stringify(
      {
        app: "HeaderForge",
        version: 1,
        exportedAt: new Date().toISOString(),
        profiles: state.profiles,
      },
      null,
      2,
    ),
  );
  toast("Exported profiles");
}

// Accept HeaderForge exports as well as ModHeader-style profile blobs.
function adaptImportedProfile(p) {
  if (!p || typeof p !== "object") return null;
  const name = p.name || p.title || "Imported profile";
  const requestHeaders = p.requestHeaders || p.headers || [];
  const responseHeaders = p.responseHeaders || p.respHeaders || [];
  const rawFilters = p.urlFilters || p.filters || [];
  const urlFilters = (Array.isArray(rawFilters) ? rawFilters : [])
    .map((f) => ({
      enabled: f.enabled !== false,
      pattern: f.pattern || f.urlRegex || f.urlPattern || "",
    }))
    .filter((f) => f.pattern);
  return {
    name,
    enabled: p.enabled !== false,
    color: p.color,
    requestHeaders,
    responseHeaders,
    urlFilters,
  };
}

async function importProfilesFromFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("Invalid JSON file");
    return;
  }
  const incoming = Array.isArray(data) ? data : data.profiles;
  if (!Array.isArray(incoming) || incoming.length === 0) {
    toast("No profiles found in file");
    return;
  }
  const adapted = incoming.map(adaptImportedProfile).filter(Boolean);
  const cleaned = normalizeState({ profiles: adapted }).profiles.map((p) => ({
    ...p,
    id: uid(),
  }));
  state.profiles.push(...cleaned);
  state.selectedProfileId = cleaned[0].id;
  save({ immediate: true });
  renderAll();
  toast(`Imported ${cleaned.length} profile${cleaned.length === 1 ? "" : "s"}`);
}

// Parse a variety of "headers as JSON" shapes into normalized header objects:
//   - an array of { name, value, operation?, enabled?, description? }
//   - { headers: [...] } / { requestHeaders: [...] } / { responseHeaders: [...] }
//   - a plain object mapping header name -> value
function parseHeadersJson(data) {
  let arr = null;
  if (Array.isArray(data)) {
    arr = data;
  } else if (data && typeof data === "object") {
    if (Array.isArray(data.headers)) arr = data.headers;
    else if (Array.isArray(data.requestHeaders)) arr = data.requestHeaders;
    else if (Array.isArray(data.responseHeaders)) arr = data.responseHeaders;
    else {
      arr = Object.entries(data).map(([k, v]) => ({
        name: k,
        value: typeof v === "string" ? v : JSON.stringify(v),
      }));
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((h) => {
      if (!h || typeof h !== "object") return null;
      const name = String(h.name || h.header || "").trim();
      if (!name) return null;
      const hd = makeHeader(
        name,
        String(h.value ?? ""),
        OPERATIONS.includes(h.operation) ? h.operation : "set",
        String(h.description || h.comment || ""),
      );
      hd.enabled = h.enabled !== false;
      return hd;
    })
    .filter(Boolean);
}

async function importHeadersFromFile(file, kind) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("Invalid JSON file");
    return;
  }
  const headers = parseHeadersJson(data);
  if (headers.length === 0) {
    toast("No headers found in file");
    return;
  }
  const p = currentProfile();
  const list = kind === "response" ? p.responseHeaders : p.requestHeaders;
  list.push(...headers);
  save({ immediate: true });
  setActiveTab(kind);
  renderPanels();
  toast(`Imported ${headers.length} header${headers.length === 1 ? "" : "s"}`);
}

function exportHeaders(kind) {
  const p = currentProfile();
  const list = kind === "response" ? p.responseHeaders : p.requestHeaders;
  if (list.length === 0) {
    toast("No headers to export");
    return;
  }
  const payload = list.map((h) => ({
    enabled: h.enabled,
    name: h.name,
    value: h.value,
    operation: h.operation,
    description: h.description || "",
  }));
  download(`headerforge-${kind}-headers.json`, JSON.stringify(payload, null, 2));
  toast(`Exported ${list.length} header${list.length === 1 ? "" : "s"}`);
}

// ---------------------------------------------------------------------------
// Toast.
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = el("div", { class: "toast" });
    document.body.append(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add("is-visible"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-visible"), 1800);
}

// ---------------------------------------------------------------------------
// Wiring.
// ---------------------------------------------------------------------------
function wire() {
  // Render first, then await the write: pausing is the one action where the user
  // routinely closes the popup immediately afterwards, and the worker nudge in
  // commit() has to be dispatched before the document is torn down.
  dom.pauseBtn.addEventListener("click", async () => {
    state.paused = !state.paused;
    renderPausedUI();
    await save({ immediate: true });
  });
  dom.resumeBtn.addEventListener("click", async () => {
    state.paused = false;
    renderPausedUI();
    await save({ immediate: true });
  });
  dom.themeBtn.addEventListener("click", cycleTheme);
  dom.optionsBtn.addEventListener("click", openSettings);
  dom.settingsCloseBtn.addEventListener("click", closeSettings);
  dom.fullOptionsBtn.addEventListener("click", () =>
    chrome.runtime.openOptionsPage(),
  );
  dom.addProfileBtn.addEventListener("click", addProfile);

  // In-popup settings controls.
  document.querySelectorAll("[data-theme-opt]").forEach((b) => {
    b.addEventListener("click", () => {
      state.theme = b.dataset.themeOpt;
      save();
      applyTheme();
      toast(`Theme: ${state.theme}`);
    });
  });
  document.querySelectorAll("[data-desc-opt]").forEach((b) => {
    b.addEventListener("click", () => {
      state.settings.descriptionPlacement = b.dataset.descOpt;
      save();
      applySettingsUI();
      renderPanels();
    });
  });
  dom.showOpChk.addEventListener("change", () => {
    state.settings.showOperation = dom.showOpChk.checked;
    save();
    renderPanels();
  });
  dom.settingsExportBtn.addEventListener("click", exportProfiles);
  dom.settingsImportBtn.addEventListener("click", () => dom.importFile.click());
  dom.settingsResetBtn.addEventListener("click", resetAllData);
  dom.settingsCheckUpdateBtn.addEventListener("click", checkForUpdates);
  dom.settingsRepoLink.href = REPO;
  dom.settingsIssuesLink.href = `${REPO}/issues`;

  // Fuzzy header search.
  dom.headerSearch.addEventListener("input", () => {
    searchQuery = dom.headerSearch.value.trim();
    renderPanels();
  });
  dom.headerSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      dom.headerSearch.value = "";
      searchQuery = "";
      renderPanels();
    }
  });

  // Close the per-profile menu on any outside click.
  document.addEventListener("click", (e) => {
    if (!dom.profileMenu.hidden && !dom.profileMenu.contains(e.target)) {
      closeMenu();
    }
  });

  dom.exportBtn.addEventListener("click", exportProfiles);
  dom.importBtn.addEventListener("click", () => dom.importFile.click());
  dom.importFile.addEventListener("change", async () => {
    const file = dom.importFile.files[0];
    if (file) await importProfilesFromFile(file);
    dom.importFile.value = "";
  });

  // Per-panel header import / export.
  document.querySelectorAll("[data-himport]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingHeaderKind = btn.dataset.himport;
      dom.importHeadersFile.click();
    });
  });
  document.querySelectorAll("[data-hexport]").forEach((btn) => {
    btn.addEventListener("click", () => exportHeaders(btn.dataset.hexport));
  });
  dom.importHeadersFile.addEventListener("change", async () => {
    const file = dom.importHeadersFile.files[0];
    if (file) await importHeadersFromFile(file, pendingHeaderKind);
    dom.importHeadersFile.value = "";
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  });
  document.querySelectorAll(".addrow").forEach((btn) => {
    btn.addEventListener("click", () => addItem(btn.dataset.add));
  });

  darkMedia.addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[ERROR_KEY]) {
      renderErrors(changes[ERROR_KEY].newValue);
    }
    // The About & settings tab may have changed the shared state. Adopt it
    // rather than writing our own snapshot back over it on the next save.
    // Skipped while an edit is still queued, so an in-progress keystroke is
    // never yanked out from under the user.
    if (changes[STORAGE_KEY] && !saveTimer) {
      const incoming = normalizeState(migrate(changes[STORAGE_KEY].newValue));
      // Our own writes echo back here; ignore those.
      if (JSON.stringify(incoming) === JSON.stringify(state)) return;
      state = incoming;
      applyTheme();
      applySize();
      applySettingsUI();
      renderAll();
    }
  });

  wireResize();

  window.addEventListener("pagehide", flush);
  window.addEventListener("blur", () => save({ immediate: true }));
}

// ---------------------------------------------------------------------------
// Init.
// ---------------------------------------------------------------------------
async function init() {
  injectIcons();
  const stored = await chrome.storage.local.get([STORAGE_KEY, ERROR_KEY]);
  if (stored[STORAGE_KEY]) {
    state = normalizeState(migrate(stored[STORAGE_KEY]));
  } else {
    state = createDefaultState();
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }
  applyTheme();
  applySize();
  wire();
  renderAll();
  setActiveTab("request");
  renderErrors(stored[ERROR_KEY]);
  dom.settingsVersion.textContent = `v${chrome.runtime.getManifest().version}`;
  dom.settingsVersion2.textContent = chrome.runtime.getManifest().version;
}

init();
