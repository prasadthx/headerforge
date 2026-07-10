import {
  STORAGE_KEY,
  ERROR_KEY,
  PROFILE_COLORS,
  OPERATIONS,
  uid,
  makeHeader,
  makeUrlFilter,
  makeProfile,
  normalizeState,
  createDefaultState,
} from "./state.js";

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
  profileSelect: $("profileSelect"),
  profileDot: $("profileDot"),
  profileEnabled: $("profileEnabled"),
  profileMenu: $("profileMenu"),
  profileMenuBtn: $("profileMenuBtn"),
  colorPicker: $("colorPicker"),
  pauseBtn: $("pauseBtn"),
  pausedBanner: $("pausedBanner"),
  resumeBtn: $("resumeBtn"),
  errorBanner: $("errorBanner"),
  themeBtn: $("themeBtn"),
  requestRows: $("requestRows"),
  responseRows: $("responseRows"),
  filterRows: $("filterRows"),
  countRequest: $("countRequest"),
  countResponse: $("countResponse"),
  countFilters: $("countFilters"),
  addProfileBtn: $("addProfileBtn"),
  exportBtn: $("exportBtn"),
  importBtn: $("importBtn"),
  importFile: $("importFile"),
};

// ---------------------------------------------------------------------------
// State + persistence.
// ---------------------------------------------------------------------------
let state;
let activeTab = "request";
let saveTimer;

function currentProfile() {
  return (
    state.profiles.find((p) => p.id === state.selectedProfileId) ||
    state.profiles[0]
  );
}

function save({ immediate = false } = {}) {
  clearTimeout(saveTimer);
  const commit = () => chrome.storage.local.set({ [STORAGE_KEY]: state });
  if (immediate) commit();
  else saveTimer = setTimeout(commit, 200);
}

async function flush() {
  clearTimeout(saveTimer);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
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

function applyOpToPair(op, valueInput, pair) {
  const isRemove = op === "remove";
  valueInput.hidden = isRemove;
  pair.style.gridTemplateColumns = isRemove ? "1fr" : "";
}

function headerRow(list, h) {
  const row = el("div", { class: "row" + (h.enabled ? "" : " row--disabled") });
  row.dataset.id = h.id;

  const toggle = makeSwitch(h.enabled, (checked) => {
    h.enabled = checked;
    row.classList.toggle("row--disabled", !checked);
    save();
  });
  toggle.classList.add("row__toggle");

  const op = el("select", { class: "op-select", title: "Operation" });
  for (const o of OPERATIONS) op.append(el("option", { value: o, textContent: o }));
  op.value = h.operation;

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

  const pair = el("div", { class: "row__pair" }, [nameInput, valueInput]);
  applyOpToPair(h.operation, valueInput, pair);

  op.addEventListener("change", () => {
    h.operation = op.value;
    applyOpToPair(op.value, valueInput, pair);
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

  row.append(toggle, op, pair, del);
  return row;
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
  fillRows(
    dom.requestRows,
    p.requestHeaders,
    (h) => headerRow(p.requestHeaders, h),
    "No request headers yet.",
  );
  fillRows(
    dom.responseRows,
    p.responseHeaders,
    (h) => headerRow(p.responseHeaders, h),
    "No response headers yet.",
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

function renderProfileBar() {
  dom.profileSelect.textContent = "";
  for (const p of state.profiles) {
    dom.profileSelect.append(
      el("option", {
        value: p.id,
        textContent: p.name + (p.enabled ? "" : "  ·  off"),
      }),
    );
  }
  dom.profileSelect.value = state.selectedProfileId;
  const cur = currentProfile();
  dom.profileDot.style.background = cur.color;
  dom.profileDot.style.boxShadow = `0 0 0 3px color-mix(in srgb, ${cur.color} 25%, transparent)`;
  dom.profileEnabled.checked = cur.enabled;
}

function renderColors() {
  dom.colorPicker.textContent = "";
  const p = currentProfile();
  for (const c of PROFILE_COLORS) {
    const s = el("button", {
      class: "swatch" + (c === p.color ? " is-selected" : ""),
      title: c,
    });
    s.style.background = c;
    s.addEventListener("click", () => {
      p.color = c;
      save();
      renderProfileBar();
      renderColors();
    });
    dom.colorPicker.append(s);
  }
}

function renderPausedUI() {
  dom.pauseBtn.setAttribute("aria-pressed", String(state.paused));
  dom.pausedBanner.hidden = !state.paused;
}

function renderErrors(errors) {
  if (!errors || errors.length === 0) {
    dom.errorBanner.hidden = true;
    dom.errorBanner.textContent = "";
    return;
  }
  const lines = errors.map((e) =>
    e.pattern
      ? `${e.profile}: ${e.message}  ·  /${e.pattern}/`
      : String(e.message),
  );
  dom.errorBanner.hidden = false;
  dom.errorBanner.textContent = "⚠  " + lines.join("\n");
}

function renderAll() {
  renderProfileBar();
  renderPanels();
  renderColors();
  renderPausedUI();
}

// ---------------------------------------------------------------------------
// Theme.
// ---------------------------------------------------------------------------
const darkMedia = matchMedia("(prefers-color-scheme: dark)");

function effectiveTheme() {
  if (state.theme === "system") return darkMedia.matches ? "dark" : "light";
  return state.theme;
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", effectiveTheme());
  dom.themeBtn.title = `Theme: ${state.theme} (click to change)`;
}

function cycleTheme() {
  const order = ["system", "light", "dark"];
  state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
  save();
  applyTheme();
  toast(`Theme: ${state.theme}`);
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
}

function addItem(kind) {
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
  const n = state.profiles.length + 1;
  const p = makeProfile(`Profile ${n}`, n - 1);
  state.profiles.push(p);
  state.selectedProfileId = p.id;
  save({ immediate: true });
  renderAll();
  setActiveTab("request");
}

function cloneProfile() {
  closeMenu();
  const src = currentProfile();
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

function deleteCurrentProfile() {
  const idx = state.profiles.findIndex((p) => p.id === state.selectedProfileId);
  if (idx < 0) return;
  state.profiles.splice(idx, 1);
  state.selectedProfileId = state.profiles[Math.max(0, idx - 1)].id;
  save({ immediate: true });
  renderAll();
}

function startRename() {
  closeMenu();
  const p = currentProfile();
  const input = el("input", {
    class: "profile-select",
    value: p.name,
    spellcheck: false,
  });
  dom.profileSelect.style.display = "none";
  dom.profileSelect.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      p.name = input.value.trim() || p.name;
      save();
    }
    input.remove();
    dom.profileSelect.style.display = "";
    renderProfileBar();
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
function exportProfiles() {
  const payload = {
    app: "HeaderForge",
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: state.profiles,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: "headerforge-profiles.json" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  dom.pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    save({ immediate: true });
    renderPausedUI();
  });
  dom.resumeBtn.addEventListener("click", () => {
    state.paused = false;
    save({ immediate: true });
    renderPausedUI();
  });
  dom.themeBtn.addEventListener("click", cycleTheme);

  dom.profileSelect.addEventListener("change", () => {
    state.selectedProfileId = dom.profileSelect.value;
    save();
    renderAll();
    setActiveTab(activeTab);
  });
  dom.profileEnabled.addEventListener("change", () => {
    currentProfile().enabled = dom.profileEnabled.checked;
    save();
    renderProfileBar();
  });

  dom.profileMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.profileMenu.hidden = !dom.profileMenu.hidden;
    if (!dom.profileMenu.hidden) renderColors();
  });
  document.addEventListener("click", (e) => {
    if (
      !dom.profileMenu.hidden &&
      !dom.profileMenu.contains(e.target) &&
      e.target !== dom.profileMenuBtn
    ) {
      closeMenu();
    }
  });

  dom.profileMenu
    .querySelector('[data-action="rename"]')
    .addEventListener("click", startRename);
  dom.profileMenu
    .querySelector('[data-action="clone"]')
    .addEventListener("click", cloneProfile);

  const delBtn = dom.profileMenu.querySelector('[data-action="delete"]');
  let armed = false;
  let armTimer;
  const disarm = () => {
    armed = false;
    delBtn.textContent = "Delete profile";
  };
  delBtn.addEventListener("click", () => {
    if (state.profiles.length <= 1) {
      toast("Keep at least one profile");
      return;
    }
    if (!armed) {
      armed = true;
      delBtn.textContent = "Click again to confirm";
      clearTimeout(armTimer);
      armTimer = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armTimer);
    disarm();
    deleteCurrentProfile();
    closeMenu();
  });

  dom.addProfileBtn.addEventListener("click", addProfile);
  dom.exportBtn.addEventListener("click", exportProfiles);
  dom.importBtn.addEventListener("click", () => dom.importFile.click());
  dom.importFile.addEventListener("change", async () => {
    const file = dom.importFile.files[0];
    if (file) await importProfilesFromFile(file);
    dom.importFile.value = "";
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

  // Surface rule-build errors reported by the background worker.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[ERROR_KEY]) {
      renderErrors(changes[ERROR_KEY].newValue);
    }
  });

  // Flush any debounced edit before the popup goes away.
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
    state = normalizeState(stored[STORAGE_KEY]);
  } else {
    state = createDefaultState();
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }
  applyTheme();
  wire();
  renderAll();
  setActiveTab("request");
  renderErrors(stored[ERROR_KEY]);
}

init();
