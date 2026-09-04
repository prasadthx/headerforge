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
  const iconPaths = [];

  globalThis.chrome = {
    storage: {
      local: {
        async get(k) {
          const a = k == null ? Object.keys(store) : Array.isArray(k) ? k : [k];
          const o = {};
          for (const x of a) if (x in store) o[x] = store[x];
          return o;
        },
        async set(o) {
          if (hooks.storageSet) {
            const r = hooks.storageSet(o);
            if (r) return r;
          }
          Object.assign(store, o);
        },
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
      // Records what setIcon was asked for. Each call re-reads and decodes all
      // three PNGs from disk in the real browser.
      async setIcon(o) { iconPaths.push(o.path["16"]); },
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
    iconCalls: () => iconPaths.length,
    iconPaths: () => [...iconPaths],
  };
}

// Each import needs a fresh module instance: background.js keeps worker state
// (the sync queue, the error cache) at module scope.
// Wait for a condition rather than for a duration. setTimeout is compressed
// above, so a fixed sleep is both shorter than it reads and dependent on machine
// load; polling makes these deterministic.
function waitFor(predicate, { timeout = 3000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      realSetTimeout(tick, 10);
    };
    tick();
  });
}

function idle(ms = 60) {
  return new Promise((r) => realSetTimeout(r, ms));
}

function syncViaMessage() {
  return new Promise((resolve) => {
    if (!globalThis.__onMessage) return resolve();
    const handled = globalThis.__onMessage({ type: "resync" }, null, () => resolve());
    if (!handled) resolve();
  });
}

async function boot(env) {
  await import(`${BG}?t=${bust++}`);
  await idle(80);
  return env;
}

const quiet = (fn) => {
  const err = console.error;
  console.error = () => {};
  return Promise.resolve(fn()).finally(() => { console.error = err; });
};

await test("unpaused state applies the configured headers", async () => {
  const env = await boot(makeEnv({ paused: false }));
  await waitFor(() => env.appliedHeaders().length === 2, { label: "rules applied" });
  assert.deepEqual(env.appliedHeaders().sort(), ["Authorization", "X-Tenant"]);
  assert.equal(env.badge(), "2");
});

await test("pausing takes every rule down and shows off", async () => {
  const env = await boot(makeEnv({ paused: true }));
  await waitFor(() => env.appliedHeaders().length === 0, { label: "rules removed" });
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
  await waitFor(() => Array.isArray(env.errors()) && env.errors().length > 0, {
    label: "the failure to be surfaced",
  }).catch(() => {});
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
      await idle();
    }
    await waitFor(() => env.appliedHeaders().length === 0, {
      label: "rules removed after the abandoned promise",
    }).catch(() => {});
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
    await waitFor(() => env.appliedHeaders().length === 0, {
      label: "the self-retry to apply the paused state",
    }).catch(() => {});
  });
  assert.deepEqual(env.appliedHeaders(), [], "the retry must eventually apply the paused state");
});


await test("a hang in the error write does not wedge the chain either", async () => {
  // The timeout guards doSyncRules, but the catch handler must not be able to
  // stall the chain on its own account: an async catch awaiting the error write
  // reintroduced the identical wedge, in the code meant to report it.
  let failGet = true;
  let hangSet = true;
  const env = makeEnv({
    paused: false,
    hooks: {
      getDynamicRules() { if (failGet) { failGet = false; throw new Error("engine hiccup"); } },
      storageSet(o) {
        if (hangSet && "headerforge:errors" in o) { hangSet = false; return new Promise(() => {}); }
        return null;
      },
    },
  });
  await quiet(async () => {
    await boot(env);
    env.store["headerforge:v1"] = { ...env.store["headerforge:v1"], paused: true };
    for (let i = 0; i < 4; i++) {
      await syncViaMessage();
      await idle();
    }
    await waitFor(() => env.appliedHeaders().length === 0, {
      label: "rules removed after a hung error write",
    }).catch(() => {});
  });
  assert.deepEqual(
    env.appliedHeaders(),
    [],
    "reporting a failure must not stop the next sync from happening",
  );
});

await test("a timed-out sync must not re-apply headers after a pause", async () => {
  // THE ONE USERS REPORTED ON 1.2.1. The 15s race stops a stalled call from
  // wedging the chain, but it does not cancel the work: the call eventually
  // returns and the rest of doSyncRules writes rules it compiled from
  // *pre-pause* state. declarativeNetRequest rules persist, so the headers came
  // back after the user paused, with the badge still reading "off" and only an
  // extension restart clearing it. Distinct from the never-settling case above:
  // that promise is abandoned forever, this one comes back.
  const env = makeEnv({ paused: false });
  const dnr = globalThis.chrome.declarativeNetRequest;
  const realGet = dnr.getDynamicRules;
  let release = null;
  let stallNext = true;
  dnr.getDynamicRules = async () => {
    if (stallNext) {
      stallNext = false;
      await new Promise((r) => { release = r; });
    }
    return realGet.call(dnr);
  };

  await quiet(async () => {
    await boot(env); // sync A stalls, then loses the race
    await waitFor(() => release !== null, { label: "sync A to stall" });
    // The user pauses while A is still out there.
    env.store["headerforge:v1"] = { ...env.store["headerforge:v1"], paused: true };
    await syncViaMessage();
    await waitFor(() => env.appliedHeaders().length === 0, { label: "pause to take effect" });
    release(); // A's stalled call finally returns and A carries on
    await idle(200);
  });

  assert.deepEqual(
    env.appliedHeaders(),
    [],
    "an abandoned sync must not resurrect the headers the user paused",
  );
  assert.equal(env.badge(), "off");
});

await test("a timed-out paused sync must not wipe what a resume just applied", async () => {
  // Mirror image of the above: the stale sync is the paused one. Its read
  // returns after the user has resumed and a newer sync has applied the rules,
  // and removing them then leaves every header off with nothing to restore
  // them, because the sync that would have has already finished.
  const env = makeEnv({ paused: true });
  const dnr = globalThis.chrome.declarativeNetRequest;
  const realGet = dnr.getDynamicRules;
  let release = null;
  let stallNext = true;
  dnr.getDynamicRules = async () => {
    if (stallNext) {
      stallNext = false;
      await new Promise((r) => { release = r; });
    }
    return realGet.call(dnr);
  };

  await quiet(async () => {
    await boot(env); // sync A (paused) stalls inside removeAllRules
    await waitFor(() => release !== null, { label: "sync A to stall" });
    env.store["headerforge:v1"] = { ...env.store["headerforge:v1"], paused: false };
    await syncViaMessage();
    await waitFor(() => env.appliedHeaders().length === 2, { label: "resume to apply rules" });
    release();
    await idle(200);
  });

  assert.deepEqual(
    env.appliedHeaders().sort(),
    ["Authorization", "X-Tenant"],
    "an abandoned paused sync must not switch a resumed profile back off",
  );
  assert.equal(env.badge(), "2");
});

// Guard against a test silently not running: a hang exits 13, but a skipped
// test would otherwise let the suite report success with fewer tests.
await test("an unchanged icon is not re-read on every sync", async () => {
  // setIcon re-reads and decodes all three PNGs from disk, and paintAction runs
  // on every sync — every debounced keystroke — so re-pushing an unchanged icon
  // spent three file reads per edit for nothing. Measured over a 20-edit
  // session before this: 21 calls, 63 reads, one distinct theme.
  const env = await boot(makeEnv({ paused: false }));
  await waitFor(() => env.iconCalls() === 1, { label: "the cold-start paint" });
  for (let i = 0; i < 5; i++) {
    await syncViaMessage();
    await idle(20);
  }
  assert.equal(
    env.iconCalls(),
    1,
    "only the cold-start paint should touch the icon PNGs",
  );
});

await test("a theme change still repaints the icon", async () => {
  // The memo must not resurrect the bug it sits next to: setIcon does not
  // survive a browser restart, so a dark-mode user whose icon is never
  // repainted is left staring at the light one.
  const env = await boot(makeEnv({ paused: false }));
  await waitFor(() => env.iconCalls() === 1, { label: "the cold-start paint" });
  env.store["headerforge:v1"] = { ...env.store["headerforge:v1"], theme: "dark" };
  await syncViaMessage();
  await waitFor(() => env.iconCalls() === 2, { label: "the dark repaint" }).catch(() => {});
  assert.deepEqual(env.iconPaths(), [
    "icons/icon16.png",
    "icons/icon16-dark.png",
  ]);
});

const EXPECTED = 13;
assert.equal(passed, EXPECTED, `expected ${EXPECTED} worker tests, ran ${passed}`);
console.log(`\n${passed} worker tests passed`);
