// Tests for background.js against a stubbed MV3 environment. Run: npm test
//
// The pure logic is covered by test-rules.mjs; this file exists because the
// worst bug this extension has shipped twice lives here, not in the logic: the
// rules staying applied while the popup says paused. declarativeNetRequest
// dynamic rules persist by design, so anything that stops doSyncRules partway
// leaves them in force with nothing to take them down.
import assert from "node:assert/strict";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("  ok  " + name);
}

const BG = new URL("../background.js", import.meta.url).href;
let bust = 0;

// Build a worker environment. `hooks` lets a test make a specific chrome call
// fail, which is how the real bug manifested.
function makeEnv({ paused = false, headersEnabled = true, hooks = {} } = {}) {
  const state = {
    version: 2,
    paused,
    theme: "light",
    settings: { descriptionPlacement: "inline", showOperation: false },
    popupWidth: 620,
    popupHeight: null,
    selectedProfileId: "p1",
    profiles: [
      {
        id: "p1",
        name: "Auth",
        enabled: true,
        color: "#6366f1",
        requestHeaders: [
          { id: "h1", enabled: headersEnabled, name: "Authorization", value: "tok", operation: "set", description: "" },
          { id: "h2", enabled: headersEnabled, name: "X-Tenant", value: "acme", operation: "set", description: "" },
        ],
        responseHeaders: [],
        urlFilters: [],
      },
    ],
  };
  const store = { "headerforge:v1": state };
  // Pre-existing rules, as they would persist from an earlier unpaused sync.
  let dynamicRules = [
    { id: 1, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Authorization", operation: "set", value: "tok" }] }, condition: { resourceTypes: ["main_frame"] } },
    { id: 2, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "X-Tenant", operation: "set", value: "acme" }] }, condition: { resourceTypes: ["main_frame"] } },
  ];
  let badge = "2";

  globalThis.chrome = {
    storage: {
      local: {
        async get(k) {
          const a = k == null ? Object.keys(store) : Array.isArray(k) ? k : [k];
          const o = {};
          for (const x of a) if (x in store) o[x] = store[x];
          return o;
        },
        async set(o) { Object.assign(store, o); },
        async remove(k) { delete store[k]; },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onUpdateAvailable: { addListener() {} },
      onMessage: { addListener() {} },
    },
    action: {
      async setBadgeBackgroundColor() { if (hooks.setBadgeBackgroundColor) hooks.setBadgeBackgroundColor(); },
      async setBadgeText(o) { badge = o.text; },
      async setTitle() {},
      async setIcon() {},
    },
    declarativeNetRequest: {
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
      async getDynamicRules() {
        if (hooks.getDynamicRules) hooks.getDynamicRules();
        return dynamicRules;
      },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id));
        dynamicRules.push(...addRules);
      },
      async isRegexSupported() {
        if (hooks.isRegexSupported) hooks.isRegexSupported();
        return { isSupported: true };
      },
    },
  };
  return {
    store,
    appliedHeaders: () =>
      dynamicRules.flatMap((r) => (r.action.requestHeaders || []).map((h) => h.header)),
    badge: () => badge,
    errors: () => store["headerforge:errors"],
  };
}

// Each import needs a fresh module instance: background.js keeps worker state
// (the sync queue, the error cache) at module scope.
async function boot(env) {
  await import(`${BG}?t=${bust++}`);
  await new Promise((r) => setTimeout(r, 120));
  return env;
}

const quiet = (fn) => {
  const err = console.error;
  console.error = () => {};
  return Promise.resolve(fn()).finally(() => { console.error = err; });
};

await test("unpaused state applies the configured headers", async () => {
  const env = await boot(makeEnv({ paused: false }));
  assert.deepEqual(env.appliedHeaders().sort(), ["Authorization", "X-Tenant"]);
  assert.equal(env.badge(), "2");
});

await test("pausing takes every rule down and shows off", async () => {
  const env = await boot(makeEnv({ paused: true }));
  assert.deepEqual(env.appliedHeaders(), [], "paused must apply nothing");
  assert.equal(env.badge(), "off");
});

await test("pausing still takes rules down when the badge API fails", async () => {
  // THE REGRESSION. updateBadge ran before the rule update with no error
  // handling, so one throw aborted the sync and left the previous rules in
  // force — a paused extension that kept modifying headers, and a badge still
  // showing the old count. Only restarting the extension cleared it.
  let calls = 0;
  const env = await quiet(() =>
    boot(makeEnv({
      paused: true,
      hooks: { setBadgeBackgroundColor() { if (++calls === 1) throw new Error("transient"); } },
    })),
  );
  assert.deepEqual(env.appliedHeaders(), [], "a cosmetic failure must not keep rules alive");
  assert.equal(env.badge(), "off", "and the badge must be corrected on retry");
});

await test("disabling every header takes the rules down too", async () => {
  const env = await boot(makeEnv({ paused: false, headersEnabled: false }));
  assert.deepEqual(env.appliedHeaders(), []);
  assert.equal(env.badge(), "", "no active headers means an empty badge");
});

await test("a sync that throws is surfaced to the popup, not just logged", async () => {
  const env = await quiet(() =>
    boot(makeEnv({
      paused: false,
      hooks: { getDynamicRules() { throw new Error("engine unavailable"); } },
    })),
  );
  const errors = env.errors();
  assert.ok(Array.isArray(errors) && errors.length > 0, "must write an error the UI can render");
  assert.match(errors[0].message, /Could not update header rules/);
});

await test("pausing survives a failure in regex validation", async () => {
  // validatePatterns sits between reading `paused` and removing the rules on
  // the unpaused path; the paused path must not depend on it at all.
  const env = await quiet(() =>
    boot(makeEnv({
      paused: true,
      hooks: { isRegexSupported() { throw new Error("boom"); } },
    })),
  );
  assert.deepEqual(env.appliedHeaders(), []);
});

console.log(`\n${passed} worker tests passed`);
