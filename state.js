// Shared state model, constants, and helpers used by both the popup and the
// background service worker. Kept dependency-free so it can be imported from
// either an ES-module popup or an ES-module service worker.

// IMPORTANT: never change STORAGE_KEY across releases, or existing users lose
// their saved profiles on update. Evolve the shape via the `version` field and
// migrate() below. chrome.storage.local already persists across extension
// updates, so keeping the key stable + migrating is all that's required.
export const STORAGE_KEY = "headerforge:v1";
export const ERROR_KEY = "headerforge:errors";
export const UPDATE_KEY = "headerforge:updateReady";
// Last theme the UI actually resolved "system" to. Service workers have no
// matchMedia, so the worker cannot work it out itself; the UI records it here so
// the worker can still pick the right icon on a cold start.
export const RESOLVED_THEME_KEY = "headerforge:resolvedTheme";

// Bump when the persisted shape changes, and add a matching step in migrate().
export const SCHEMA_VERSION = 2;

// Pleasant, distinguishable accent colors for profiles.
export const PROFILE_COLORS = [
  "#6366f1", // indigo
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // emerald
  "#3b82f6", // blue
  "#ef4444", // red
  "#8b5cf6", // violet
  "#14b8a6", // teal
];

// declarativeNetRequest applies header edits per resource type. Listing the
// long-stable set (including main_frame) guarantees the header is modified on
// every kind of request the page makes, matching ModHeader's "apply everywhere"
// behavior. We intentionally omit the newer webtransport/webbundle types: some
// Chromium builds reject unknown enum values, which would fail the whole batch.
export const RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "other",
];

// Toolbar icon variants. Chrome has no native light/dark action icon, so the
// path is swapped manually. Shared by the popup, options page and worker so the
// three cannot drift apart.
export const ICON_PATHS = {
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

export const OPERATIONS = ["set", "append", "remove"];

// Where the per-header description field sits in each header row.
export const DESCRIPTION_PLACEMENTS = ["inline", "below", "hidden"];

// Layout preferences for header rows, editable from the Settings page.
export const DEFAULT_SETTINGS = {
  // "inline" = to the right of the value field on the same row,
  // "below"  = on its own line under the row, "hidden" = not shown.
  descriptionPlacement: "inline",
  // Show the set/append/remove selector on every row. Off by default: the
  // row's on/off switch denotes whether the header is set or unset.
  showOperation: false,
};

// Popup resize bounds. Chrome caps extension popups at ~800x600, so we stay
// under that to avoid the browser clipping or adding its own scrollbar.
export const SIZE_LIMITS = {
  minWidth: 420,
  maxWidth: 780,
  minHeight: 320,
  maxHeight: 590,
  defaultWidth: 620,
  defaultHeight: 560,
};

export function uid() {
  // crypto.randomUUID is available in both popup and service-worker contexts.
  return crypto.randomUUID();
}

export function makeHeader(name = "", value = "", operation = "set", description = "") {
  return { id: uid(), enabled: true, name, value, operation, description };
}

export function makeUrlFilter(pattern = "") {
  return { id: uid(), enabled: true, pattern };
}

export function makeProfile(name, colorIndex = 0) {
  return {
    id: uid(),
    name: name || "Profile 1",
    enabled: true,
    color: PROFILE_COLORS[colorIndex % PROFILE_COLORS.length],
    requestHeaders: [makeHeader()],
    responseHeaders: [],
    urlFilters: [],
  };
}

export function createDefaultState() {
  const profile = makeProfile("Profile 1", 0);
  return {
    version: SCHEMA_VERSION,
    paused: false,
    theme: "system", // "system" | "light" | "dark"
    settings: { ...DEFAULT_SETTINGS },
    popupWidth: SIZE_LIMITS.defaultWidth,
    popupHeight: null, // null = auto-height until the user drags to resize
    selectedProfileId: profile.id,
    profiles: [profile],
  };
}

function clampSize(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Upgrade a stored blob to the current schema. Runs before normalizeState (which
// then fills defaults and coerces types). Add one forward-only step per breaking
// change so an update never drops a returning user's data.
export function migrate(raw) {
  if (!raw || typeof raw !== "object") return raw;
  let s = raw;
  const from = Number(s.version) || 1;
  if (from < 2) {
    // Header-row layout preferences introduced.
    s = { ...s, settings: { ...DEFAULT_SETTINGS } };
  }
  // Future migrations, e.g.:
  //   if (from < 3) { ... }
  void from;
  return s;
}

// Defensive normalization so older/partial/imported blobs never crash the UI.
export function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.profiles)) {
    return createDefaultState();
  }
  const profiles = raw.profiles
    .filter((p) => p && typeof p === "object")
    .map((p, i) => ({
      id: typeof p.id === "string" ? p.id : uid(),
      name: typeof p.name === "string" && p.name.trim() ? p.name : `Profile ${i + 1}`,
      enabled: p.enabled !== false,
      color:
        typeof p.color === "string"
          ? p.color
          : PROFILE_COLORS[i % PROFILE_COLORS.length],
      requestHeaders: normalizeHeaders(p.requestHeaders),
      responseHeaders: normalizeHeaders(p.responseHeaders),
      urlFilters: normalizeFilters(p.urlFilters),
    }));

  if (profiles.length === 0) profiles.push(makeProfile("Profile 1", 0));

  const selected = profiles.some((p) => p.id === raw.selectedProfileId)
    ? raw.selectedProfileId
    : profiles[0].id;

  return {
    version: SCHEMA_VERSION,
    paused: Boolean(raw.paused),
    theme: ["system", "light", "dark"].includes(raw.theme) ? raw.theme : "system",
    settings: normalizeSettings(raw.settings),
    popupWidth: clampSize(
      raw.popupWidth,
      SIZE_LIMITS.minWidth,
      SIZE_LIMITS.maxWidth,
      SIZE_LIMITS.defaultWidth,
    ),
    popupHeight:
      raw.popupHeight == null
        ? null
        : clampSize(
            raw.popupHeight,
            SIZE_LIMITS.minHeight,
            SIZE_LIMITS.maxHeight,
            SIZE_LIMITS.defaultHeight,
          ),
    selectedProfileId: selected,
    profiles,
  };
}

function normalizeHeaders(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((h) => h && typeof h === "object")
    .map((h) => ({
      id: typeof h.id === "string" ? h.id : uid(),
      enabled: h.enabled !== false,
      name: typeof h.name === "string" ? h.name : "",
      value: typeof h.value === "string" ? h.value : "",
      operation: OPERATIONS.includes(h.operation) ? h.operation : "set",
      description:
        typeof h.description === "string"
          ? h.description
          : typeof h.comment === "string"
            ? h.comment
            : "",
    }));
}

function normalizeSettings(s) {
  if (!s || typeof s !== "object") return { ...DEFAULT_SETTINGS };
  return {
    descriptionPlacement: DESCRIPTION_PLACEMENTS.includes(
      s.descriptionPlacement,
    )
      ? s.descriptionPlacement
      : DEFAULT_SETTINGS.descriptionPlacement,
    showOperation:
      typeof s.showOperation === "boolean"
        ? s.showOperation
        : DEFAULT_SETTINGS.showOperation,
  };
}

function normalizeFilters(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((f) => f && typeof f === "object")
    .map((f) => ({
      id: typeof f.id === "string" ? f.id : uid(),
      enabled: f.enabled !== false,
      pattern: typeof f.pattern === "string" ? f.pattern : "",
    }));
}
