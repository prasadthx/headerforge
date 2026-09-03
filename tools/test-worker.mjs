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

// background.js races doSyncRules against a 15s timer. Compress every timer so
// that path is exercisable in a test without waiting on wall clock.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) =>
  realSetTimeout(fn, Math.min(typeof ms === "number" ? ms : 0, 30), ...rest);

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
      onMessage: { addListener(f) { globalThis.__onMessage = f; } },
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
function syncViaMessage() {
  return new Promise((resolve) => {
    if (!globalThis.__onMessage) return resolve();
    const handled = globalThis.__onMessage({ type: "resync" }, null, () => resolve());
    if (!handled) resolve();
  });
}

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

await test("a chrome call that never settles does not wedge the worker", async () => {
  // THE INTERMITTENT ONE. Chrome abandons in-flight promises when it tears a
  // worker down under memory pressure — they neither resolve nor reject. The
  // sync chain used to stall on one of those permanently: `queued` latched true
  // and every later syncRules() short-circuited, so the rules already applied
  // stayed in force for the rest of the worker's life. Restarting the extension
  // was the only way out. Reproduced before the fix as five resync requests
  // with zero effect.
  const env = makeEnv({ paused: false });
  // Model a genuinely abandoned promise, not a rejection: that is what Chrome
  // leaves behind when it stops a worker mid-await.
  const dnr = globalThis.chrome.declarativeNetRequest;
  const realGet = dnr.getDynamicRules;
  let hangOnce = true;
  dnr.getDynamicRules = async () => {
    if (hangOnce) { hangOnce = false; return new Promise(() => {}); }
    return realGet.call(dnr);
  };

  await quiet(async () => {
    await boot(env);
    // The user pauses after the hang. This must still take the rules down.
    env.store["headerforge:v1"] = { ...env.store["headerforge:v1"], paused: true };
    for (let i = 0; i < 4; i++) {
      await syncViaMessage();
      await new Promise((r) => realSetTimeout(r, 60));
    }
    await new Promise((r) => realSetTimeout(r, 250));
  });

  assert.deepEqual(
    env.appliedHeaders(),
    [],
    "a single abandoned promise must not stop every later sync",
  );
});

await test("a failed sync retries on its own", async () => {
  // After a failure the applied rules are unverified and the user may not touch
  // anything for hours, so recovery cannot depend on them acting.
  let failures = 2;
  const env = makeEnv({ paused: true, hooks: {} });
  const dnr = globalThis.chrome.declarativeNetRequest;
  const realGet = dnr.getDynamicRules;
  dnr.getDynamicRules = async () => {
    if (failures-- > 0) throw new Error("engine busy");
    return realGet.call(dnr);
  };
  await quiet(async () => {
    await boot(env);
    await new Promise((r) => realSetTimeout(r, 400));
  });
  assert.deepEqual(env.appliedHeaders(), [], "the retry must eventually apply the paused state");
});

// Guard against a test silently not running: a hang exits 13, but a skipped
// test would otherwise let the suite report success with fewer tests.
const EXPECTED = 8;
assert.equal(passed, EXPECTED, `expected ${EXPECTED} worker tests, ran ${passed}`);
console.log(`\n${passed} worker tests passed`);
