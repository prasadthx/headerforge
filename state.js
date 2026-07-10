// Shared state model, constants, and helpers used by both the popup and the
// background service worker. Kept dependency-free so it can be imported from
// either an ES-module popup or an ES-module service worker.

export const STORAGE_KEY = "headerforge:v1";
export const ERROR_KEY = "headerforge:errors";

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

export const OPERATIONS = ["set", "append", "remove"];

// Popup resize bounds. Chrome caps extension popups at ~800x600, so we stay
// under that to avoid the browser clipping or adding its own scrollbar.
export const SIZE_LIMITS = {
  minWidth: 320,
  maxWidth: 780,
  minHeight: 320,
  maxHeight: 590,
  defaultWidth: 400,
  defaultHeight: 520,
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
    version: 1,
    paused: false,
    theme: "system", // "system" | "light" | "dark"
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
    version: 1,
    paused: Boolean(raw.paused),
    theme: ["system", "light", "dark"].includes(raw.theme) ? raw.theme : "system",
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
