// Unit tests for the pure rule-compilation logic. Run: npm test
import assert from "node:assert/strict";
import {
  createDefaultState,
  normalizeState,
  makeHeader,
  makeProfile,
  makeUrlFilter,
  migrate,
  SCHEMA_VERSION,
  SIZE_LIMITS,
  PROFILE_COLORS,
  DEFAULT_SETTINGS,
  uniqueProfileName,
} from "../state.js";
import {
  compileRules,
  compileRuleGroups,
  headerActions,
  countActiveHeaders,
  isValidHeaderName,
  isValidHeaderValue,
  precedenceOrder,
  hasApplicableHeaders,
} from "../rules.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ok  " + name);
}

// Assert a compiled rule is structurally valid for declarativeNetRequest.
function assertValidRule(rule) {
  assert.equal(typeof rule.id, "number");
  assert.ok(rule.id > 0, "rule id must be positive");
  // Priority now encodes profile precedence, so only the invariant holds:
  // a positive integer that declarativeNetRequest will accept.
  assert.ok(Number.isInteger(rule.priority) && rule.priority >= 1);
  assert.equal(rule.action.type, "modifyHeaders");
  assert.equal(typeof rule.condition, "object");
  assert.ok(Array.isArray(rule.condition.resourceTypes));
  assert.ok(rule.condition.resourceTypes.includes("main_frame"));
  const items = [
    ...(rule.action.requestHeaders || []),
    ...(rule.action.responseHeaders || []),
  ];
  assert.ok(items.length > 0, "rule must modify at least one header");
  for (const it of items) {
    assert.ok(typeof it.header === "string" && it.header.length > 0);
    assert.ok(["set", "append", "remove"].includes(it.operation));
    if (it.operation === "remove") {
      assert.ok(!("value" in it), "remove must not carry a value");
    } else {
      assert.equal(typeof it.value, "string");
    }
  }
}

function profileWith(overrides) {
  const p = makeProfile("Test", 0);
  return { ...p, ...overrides };
}

// ---------------------------------------------------------------------------

test("default state compiles to zero rules (empty header dropped)", () => {
  const rules = compileRules(createDefaultState(), {});
  assert.deepEqual(rules, []);
});

test("a single set request header yields one valid rule", () => {
  const state = {
    paused: false,
    selectedProfileId: "a",
    profiles: [
      profileWith({
        id: "a",
        requestHeaders: [makeHeader("X-Test", "1", "set")],
      }),
    ],
  };
  const rules = compileRules(state, {});
  assert.equal(rules.length, 1);
  assertValidRule(rules[0]);
  assert.deepEqual(rules[0].action.requestHeaders, [
    { header: "X-Test", operation: "set", value: "1" },
  ]);
  assert.ok(!("responseHeaders" in rules[0].action));
  assert.ok(!("regexFilter" in rules[0].condition));
});

test("remove operation carries no value", () => {
  const state = {
    profiles: [
      profileWith({
        id: "a",
        requestHeaders: [makeHeader("X-Remove-Me", "ignored", "remove")],
      }),
    ],
  };
  const rules = compileRules(state, {});
  assertValidRule(rules[0]);
  assert.deepEqual(rules[0].action.requestHeaders, [
    { header: "X-Remove-Me", operation: "remove" },
  ]);
});

test("disabled headers and empty names are dropped", () => {
  const disabled = makeHeader("X-Off", "v", "set");
  disabled.enabled = false;
  const state = {
    profiles: [
      profileWith({
        id: "a",
        requestHeaders: [disabled, makeHeader("", "orphan", "set")],
      }),
    ],
  };
  assert.deepEqual(compileRules(state, {}), []);
});

test("paused state produces no rules", () => {
  const state = {
    paused: true,
    profiles: [
      profileWith({ id: "a", requestHeaders: [makeHeader("X", "1", "set")] }),
    ],
  };
  assert.deepEqual(compileRules(state, {}), []);
});

test("disabled profile is skipped", () => {
  const state = {
    profiles: [
      profileWith({
        id: "a",
        enabled: false,
        requestHeaders: [makeHeader("X", "1", "set")],
      }),
    ],
  };
  assert.deepEqual(compileRules(state, {}), []);
});

test("response-only header sets responseHeaders and omits requestHeaders", () => {
  const state = {
    profiles: [
      profileWith({
        id: "a",
        requestHeaders: [],
        responseHeaders: [makeHeader("X-Frame-Options", "DENY", "set")],
      }),
    ],
  };
  const rules = compileRules(state, {});
  assertValidRule(rules[0]);
  assert.ok(!("requestHeaders" in rules[0].action));
  assert.deepEqual(rules[0].action.responseHeaders, [
    { header: "X-Frame-Options", operation: "set", value: "DENY" },
  ]);
});

test("URL patterns produce one rule per pattern with regexFilter", () => {
  const state = {
    profiles: [
      profileWith({
        id: "a",
        requestHeaders: [makeHeader("X", "1", "set")],
        urlFilters: [makeUrlFilter("a\\.com"), makeUrlFilter("b\\.com")],
      }),
    ],
  };
  const rules = compileRules(state, { a: ["a\\.com", "b\\.com"] });
  assert.equal(rules.length, 2);
  assert.equal(rules[0].condition.regexFilter, "a\\.com");
  assert.equal(rules[1].condition.regexFilter, "b\\.com");
  rules.forEach(assertValidRule);
});

test("rule ids are unique and sequential across profiles", () => {
  const state = {
    profiles: [
      profileWith({ id: "a", requestHeaders: [makeHeader("A", "1", "set")] }),
      profileWith({ id: "b", requestHeaders: [makeHeader("B", "2", "set")] }),
    ],
  };
  const rules = compileRules(state, {});
  const ids = rules.map((r) => r.id);
  assert.deepEqual(ids, [...new Set(ids)]);
  assert.deepEqual(ids, [1, 2]);
});

test("countActiveHeaders counts enabled+named across enabled profiles", () => {
  const state = {
    profiles: [
      profileWith({
        id: "a",
        requestHeaders: [makeHeader("A", "1", "set"), makeHeader("", "", "set")],
        responseHeaders: [makeHeader("B", "2", "set")],
      }),
    ],
  };
  assert.equal(countActiveHeaders(state), 2);
  assert.equal(countActiveHeaders({ ...state, paused: true }), 0);
});

test("headerActions handles append operation", () => {
  const actions = headerActions([makeHeader("Cookie", "a=b", "append")]);
  assert.deepEqual(actions, [
    { header: "Cookie", operation: "append", value: "a=b" },
  ]);
});

test("normalizeState repairs garbage input to a default", () => {
  const s = normalizeState({ nonsense: true });
  assert.ok(Array.isArray(s.profiles) && s.profiles.length === 1);
  assert.equal(s.paused, false);
  assert.ok(s.profiles[0].id === s.selectedProfileId);
});

test("normalizeState coerces partial profiles safely", () => {
  const s = normalizeState({
    profiles: [{ name: "P", requestHeaders: [{ name: "H", value: "v" }] }],
  });
  const h = s.profiles[0].requestHeaders[0];
  assert.equal(h.operation, "set"); // defaulted
  assert.equal(h.enabled, true); // defaulted
  assert.equal(h.description, ""); // defaulted
  assert.ok(typeof h.id === "string" && h.id.length > 0); // id assigned
});

test("normalizeState maps a ModHeader-style comment to description", () => {
  const s = normalizeState({
    profiles: [{ name: "P", requestHeaders: [{ name: "H", comment: "note" }] }],
  });
  assert.equal(s.profiles[0].requestHeaders[0].description, "note");
});

test("description metadata never leaks into the compiled DNR rule", () => {
  const state = {
    profiles: [
      profileWith({
        id: "a",
        requestHeaders: [makeHeader("X-Api", "1", "set", "my api key header")],
      }),
    ],
  };
  const rules = compileRules(state, {});
  assert.deepEqual(rules[0].action.requestHeaders, [
    { header: "X-Api", operation: "set", value: "1" },
  ]);
  assert.ok(!("description" in rules[0].action.requestHeaders[0]));
});

test("normalizeState clamps popup size and defaults height to null", () => {
  const s = normalizeState({ profiles: [], popupWidth: 99999 });
  assert.equal(s.popupWidth, SIZE_LIMITS.maxWidth);
  assert.equal(s.popupHeight, null);
  const s2 = normalizeState({ profiles: [], popupWidth: 10, popupHeight: 10 });
  assert.equal(s2.popupWidth, SIZE_LIMITS.minWidth);
  assert.equal(s2.popupHeight, SIZE_LIMITS.minHeight);
});

test("normalizeState defaults header-row settings and coerces bad values", () => {
  const s = normalizeState({ profiles: [] });
  assert.equal(s.settings.descriptionPlacement, "inline");
  assert.equal(s.settings.showOperation, false);
  const s2 = normalizeState({
    profiles: [],
    settings: { descriptionPlacement: "banana", showOperation: "yes" },
  });
  assert.equal(s2.settings.descriptionPlacement, "inline");
  assert.equal(s2.settings.showOperation, false);
  const s3 = normalizeState({
    profiles: [],
    settings: { descriptionPlacement: "below", showOperation: true },
  });
  assert.equal(s3.settings.descriptionPlacement, "below");
  assert.equal(s3.settings.showOperation, true);
});

test("migrate from v1 seeds default settings without touching user data", () => {
  const stored = {
    version: 1,
    paused: false,
    profiles: [
      { id: "p1", name: "Keep me", enabled: true, requestHeaders: [] },
    ],
  };
  const out = normalizeState(migrate(stored));
  assert.equal(out.version, SCHEMA_VERSION);
  assert.equal(out.profiles[0].name, "Keep me");
  assert.equal(out.settings.descriptionPlacement, "inline");
  assert.equal(out.settings.showOperation, false);
});

test("migrate + normalize preserves existing user data across an update", () => {
  const stored = {
    version: 1,
    paused: true,
    theme: "dark",
    popupWidth: 500,
    selectedProfileId: "p1",
    profiles: [
      {
        id: "p1",
        name: "Keep me",
        enabled: true,
        color: "#6366f1",
        requestHeaders: [
          { id: "h1", enabled: true, name: "X", value: "1", operation: "set", description: "d" },
        ],
        responseHeaders: [],
        urlFilters: [{ id: "f1", enabled: true, pattern: "a\\.com" }],
      },
    ],
  };
  const out = normalizeState(migrate(stored));
  assert.equal(out.profiles.length, 1);
  assert.equal(out.profiles[0].name, "Keep me");
  assert.equal(out.profiles[0].requestHeaders[0].value, "1");
  assert.equal(out.profiles[0].requestHeaders[0].description, "d");
  assert.equal(out.profiles[0].urlFilters[0].pattern, "a\\.com");
  assert.equal(out.paused, true);
  assert.equal(out.theme, "dark");
  assert.equal(out.popupWidth, 500);
  assert.equal(out.version, SCHEMA_VERSION);
});

test("migrate tolerates junk without throwing", () => {
  assert.doesNotThrow(() => migrate(undefined));
  assert.doesNotThrow(() => migrate({}));
  assert.doesNotThrow(() => migrate("nonsense"));
});

test("isValidHeaderName accepts RFC 7230 tokens and rejects the rest", () => {
  for (const ok of ["X-Auth", "authorization", "x_trace-id", "a1", "X-A.B", "If-None-Match"]) {
    assert.ok(isValidHeaderName(ok), `${ok} should be valid`);
  }
  for (const bad of ["X Auth", "X:Auth", "", "x\ty", "hdr\n", "a=b", "(x)", "a,b", "a/b"]) {
    assert.ok(!isValidHeaderName(bad), `${JSON.stringify(bad)} should be invalid`);
  }
});

test("a malformed header name is skipped and reported, not fatal", () => {
  const skipped = [];
  const actions = headerActions(
    [
      makeHeader("X-Good", "1"),
      makeHeader("X Bad Name", "2"),
      makeHeader("X-Also-Good", "3"),
    ],
    (name, reason) => skipped.push({ name, reason }),
  );
  // The good headers still compile — one typo must not cost the others.
  assert.deepEqual(
    actions.map((a) => a.header),
    ["X-Good", "X-Also-Good"],
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, "X Bad Name");
  assert.match(skipped[0].reason, /Invalid header name/);
});

test("compileRules reports malformed names per profile", () => {
  const p = makeProfile("Broken", 0);
  p.requestHeaders = [makeHeader("X Bad", "v"), makeHeader("X-Fine", "v")];
  const state = normalizeState({ profiles: [p] });
  const seen = [];
  const rules = compileRules(state, {}, (profile, name, reason) =>
    seen.push([profile.name, name, reason]),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "Broken");
  assert.equal(seen[0][1], "X Bad");
  assert.equal(rules.length, 1);
  assert.deepEqual(
    rules[0].action.requestHeaders.map((h) => h.header),
    ["X-Fine"],
  );
});

test("compileRuleGroups groups by profile with globally unique ids", () => {
  const a = makeProfile("A", 0);
  a.requestHeaders = [makeHeader("X-A", "1")];
  a.urlFilters = [makeUrlFilter("a\\.com"), makeUrlFilter("b\\.com")];
  const b = makeProfile("B", 1);
  b.requestHeaders = [makeHeader("X-B", "2")];
  const state = normalizeState({ profiles: [a, b] });
  const valid = { [state.profiles[0].id]: ["a\\.com", "b\\.com"] };

  const groups = compileRuleGroups(state, valid);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].profileName, "A");
  assert.equal(groups[0].rules.length, 2, "one rule per URL pattern");
  assert.equal(groups[1].profileName, "B");
  assert.equal(groups[1].rules.length, 1);

  const ids = groups.flatMap((g) => g.rules.map((r) => r.id));
  assert.equal(new Set(ids).size, ids.length, "ids must be unique across groups");

  // The flat helper must stay byte-identical to the flattened groups, since
  // updateDynamicRules consumes it directly.
  assert.deepEqual(compileRules(state, valid), groups.flatMap((g) => g.rules));
});

test("countActiveHeaders ignores headers that cannot compile", () => {
  const p = makeProfile("P", 0);
  p.requestHeaders = [makeHeader("X-Ok", "1"), makeHeader("X Bad", "2")];
  p.responseHeaders = [makeHeader("X-Ok-2", "3")];
  const state = normalizeState({ profiles: [p] });
  // Badge must match what is actually applied, not what was typed.
  assert.equal(countActiveHeaders(state), 2);
});

test("hasApplicableHeaders ignores disabled, unnamed and malformed entries", () => {
  const empty = makeProfile("Empty", 0);
  empty.requestHeaders = [makeHeader("", "")];
  assert.equal(hasApplicableHeaders(empty), false);

  const off = makeProfile("Off", 0);
  off.requestHeaders = [makeHeader("X-A", "1")];
  off.requestHeaders[0].enabled = false;
  assert.equal(hasApplicableHeaders(off), false);

  const bad = makeProfile("Bad", 0);
  bad.requestHeaders = [makeHeader("X Bad", "1")];
  assert.equal(hasApplicableHeaders(bad), false);

  const good = makeProfile("Good", 0);
  good.responseHeaders = [makeHeader("X-B", "1")];
  assert.equal(hasApplicableHeaders(good), true);
});

test("precedenceOrder promotes the selected profile to the front", () => {
  const a = makeProfile("A", 0);
  a.requestHeaders = [makeHeader("X-A", "1")];
  const b = makeProfile("B", 1);
  b.requestHeaders = [makeHeader("X-B", "2")];
  const c = makeProfile("C", 2);
  c.requestHeaders = [makeHeader("X-C", "3")];
  const state = normalizeState({ profiles: [a, b, c] });

  // Nothing selected -> plain sidebar order.
  assert.deepEqual(
    precedenceOrder({ ...state, selectedProfileId: null }).map((p) => p.name),
    ["A", "B", "C"],
  );
  // Selecting the last one moves it to the front; the rest keep their order.
  state.selectedProfileId = state.profiles[2].id;
  assert.deepEqual(precedenceOrder(state).map((p) => p.name), ["C", "A", "B"]);
  // Paused means nothing is live at all.
  assert.deepEqual(precedenceOrder({ ...state, paused: true }), []);
});

test("precedenceOrder excludes profiles that contribute nothing", () => {
  const live = makeProfile("Live", 0);
  live.requestHeaders = [makeHeader("X-Live", "1")];
  const dead = makeProfile("Dead", 1);
  dead.requestHeaders = [makeHeader("X Bad", "1")];
  const disabled = makeProfile("Disabled", 2);
  disabled.enabled = false;
  disabled.requestHeaders = [makeHeader("X-D", "1")];
  const state = normalizeState({ profiles: [live, dead, disabled] });
  assert.deepEqual(precedenceOrder(state).map((p) => p.name), ["Live"]);
});

test("the selected profile outranks the others in compiled priority", () => {
  const a = makeProfile("A", 0);
  a.requestHeaders = [makeHeader("X-Shared", "from-a")];
  const b = makeProfile("B", 1);
  b.requestHeaders = [makeHeader("X-Shared", "from-b")];
  const c = makeProfile("C", 2);
  c.requestHeaders = [makeHeader("X-Shared", "from-c")];
  const state = normalizeState({ profiles: [a, b, c] });
  state.selectedProfileId = state.profiles[1].id; // select B

  const groups = compileRuleGroups(state, {});
  const byName = Object.fromEntries(
    groups.map((g) => [g.profileName, g.rules[0].priority]),
  );
  // B is selected so it must win the X-Shared conflict outright.
  assert.ok(byName.B > byName.A, "selected profile must outrank A");
  assert.ok(byName.B > byName.C, "selected profile must outrank C");
  // Remaining profiles keep sidebar order relative to each other.
  assert.ok(byName.A > byName.C, "A precedes C in the sidebar");
  // Priorities must be distinct, so the engine never has to break a tie.
  const values = Object.values(byName);
  assert.equal(new Set(values).size, values.length, "priorities must be distinct");
  for (const v of values) assert.ok(Number.isInteger(v) && v >= 1);
});

test("a profile whose only header is malformed is still reported", () => {
  // It contributes no rules, so it is absent from precedenceOrder — the report
  // must not go missing with it.
  const bad = makeProfile("OnlyBad", 0);
  bad.requestHeaders = [makeHeader("X Bad", "1")];
  const state = normalizeState({ profiles: [bad] });
  const seen = [];
  const rules = compileRules(state, {}, (p, name) => seen.push([p.name, name]));
  assert.equal(rules.length, 0);
  assert.deepEqual(seen, [["OnlyBad", "X Bad"]]);
});

test("profile colours are restricted to hex literals", () => {
  // They are interpolated into inline styles, so a url() would make the popup
  // fetch a remote resource on behalf of an imported profile.
  const hostile = normalizeState({
    profiles: [
      { name: "Evil", color: "url(https://attacker.example/pixel.png)", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "Sneaky", color: "red; background-image: url(https://x/y)", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "Named", color: "red", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "Fine", color: "#ABCDEF", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "Short", color: "  #fff  ", requestHeaders: [], responseHeaders: [], urlFilters: [] },
    ],
  });
  for (const p of hostile.profiles) {
    assert.match(p.color, /^#[0-9a-fA-F]{3,8}$/, `${p.name} kept a non-hex colour`);
  }
  assert.equal(hostile.profiles[3].color, "#ABCDEF", "valid hex must survive");
  assert.equal(hostile.profiles[4].color, "#fff", "valid hex must be trimmed, not replaced");
  assert.ok(PROFILE_COLORS.includes(hostile.profiles[0].color), "hostile colour falls back to the palette");
});

test("group priority is uniform per profile, so a cap can sort by it", () => {
  // background.js admits groups under the rule cap by rules[0].priority; that is
  // only valid if every rule in a group carries the same priority.
  const a = makeProfile("Multi", 0);
  a.requestHeaders = [makeHeader("X-A", "1")];
  a.urlFilters = [makeUrlFilter("x\\.com"), makeUrlFilter("y\\.com"), makeUrlFilter("z\\.com")];
  const b = makeProfile("Single", 1);
  b.requestHeaders = [makeHeader("X-B", "2")];
  const state = normalizeState({ profiles: [a, b] });
  const valid = { [state.profiles[0].id]: ["x\\.com", "y\\.com", "z\\.com"] };
  const groups = compileRuleGroups(state, valid);
  for (const g of groups) {
    const prios = new Set(g.rules.map((r) => r.priority));
    assert.equal(prios.size, 1, `${g.profileName} spread across ${prios.size} priorities`);
  }
});

test("migrate merges settings instead of replacing them", () => {
  // Assigning DEFAULT_SETTINGS wholesale discarded whatever the blob already
  // carried, silently reverting the user's choices.
  const stored = {
    version: 1,
    profiles: [],
    settings: { descriptionPlacement: "below", showOperation: true },
  };
  const out = normalizeState(migrate(stored));
  assert.equal(out.settings.descriptionPlacement, "below");
  assert.equal(out.settings.showOperation, true);

  // A v1 blob with no settings still gets the defaults.
  const bare = normalizeState(migrate({ version: 1, profiles: [] }));
  assert.deepEqual(bare.settings, DEFAULT_SETTINGS);

  // Junk in the settings slot still falls back, via normalizeSettings.
  const junk = normalizeState(migrate({ version: 1, profiles: [], settings: "nope" }));
  assert.deepEqual(junk.settings, DEFAULT_SETTINGS);
});

test("header values carrying CR, LF or NUL are skipped and reported", () => {
  assert.ok(isValidHeaderValue("Bearer abc.def"));
  assert.ok(isValidHeaderValue(""));
  for (const bad of ["a\rb", "a\nb", "a\r\nb", "a\0b"]) {
    assert.ok(!isValidHeaderValue(bad), `${JSON.stringify(bad)} must be rejected`);
  }
  const skipped = [];
  const actions = headerActions(
    [
      makeHeader("X-Ok", "fine"),
      makeHeader("X-Split", "value\r\nX-Injected: evil"),
    ],
    (name, reason) => skipped.push([name, reason]),
  );
  assert.deepEqual(actions.map((a) => a.header), ["X-Ok"]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0][0], "X-Split");
  assert.match(skipped[0][1], /line break/);
});

test("a remove operation is unaffected by value screening", () => {
  // "remove" carries no value, so a stale one must not disqualify it.
  const h = makeHeader("X-Gone", "left\nover", "remove");
  const actions = headerActions([h]);
  assert.deepEqual(actions, [{ header: "X-Gone", operation: "remove" }]);
});

test("only real CSS hex forms are accepted as profile colours", () => {
  // 5- and 7-digit hex passed the old guard and then produced no colour at all.
  const out = normalizeState({
    profiles: [
      { name: "five", color: "#12345", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "seven", color: "#1234567", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "three", color: "#abc", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "four", color: "#abcd", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "six", color: "#abcdef", requestHeaders: [], responseHeaders: [], urlFilters: [] },
      { name: "eight", color: "#abcdef12", requestHeaders: [], responseHeaders: [], urlFilters: [] },
    ],
  }).profiles;
  const byName = Object.fromEntries(out.map((p) => [p.name, p.color]));
  assert.ok(PROFILE_COLORS.includes(byName.five), "5-digit hex must fall back");
  assert.ok(PROFILE_COLORS.includes(byName.seven), "7-digit hex must fall back");
  assert.equal(byName.three, "#abc");
  assert.equal(byName.four, "#abcd");
  assert.equal(byName.six, "#abcdef");
  assert.equal(byName.eight, "#abcdef12");
});

test("an array of junk yields no importable profiles", () => {
  // normalizeState backfills a default when it filters everything out, so the
  // import paths must decide emptiness from the input, not from its output.
  for (const junk of [[1, 2, 3], ["a"], [null], [true]]) {
    const usable = junk.filter((p) => p && typeof p === "object");
    assert.equal(usable.length, 0, `${JSON.stringify(junk)} should yield nothing`);
    // Demonstrates why the guard is needed at all:
    assert.equal(normalizeState({ profiles: junk }).profiles.length, 1);
  }
});

test("uniqueProfileName resolves collisions without stacking suffixes", () => {
  assert.equal(uniqueProfileName("Auth", []), "Auth");
  assert.equal(uniqueProfileName("Auth", ["Auth"]), "Auth 2");
  assert.equal(uniqueProfileName("Auth", ["Auth", "Auth 2"]), "Auth 3");
  // An existing numeric suffix counts up rather than gaining a second one.
  assert.equal(uniqueProfileName("Auth 2", ["Auth 2"]), "Auth 3");
  assert.equal(uniqueProfileName("Auth 2", ["Auth 2", "Auth 3"]), "Auth 4");
  // The case that actually bit: delete the middle profile, add a new one.
  assert.equal(uniqueProfileName("Profile 3", ["Profile 1", "Profile 3"]), "Profile 4");
  // Duplicating twice.
  assert.equal(uniqueProfileName("Auth copy", ["Auth", "Auth copy"]), "Auth copy 2");
  // Blank and non-string fall back rather than producing an unnamed profile.
  assert.equal(uniqueProfileName("   ", []), "Profile");
  assert.equal(uniqueProfileName(undefined, ["Profile"]), "Profile 2");
  // Accepts a Set as well as an array.
  assert.equal(uniqueProfileName("Auth", new Set(["Auth"])), "Auth 2");
  // Trailing digits that are part of the name, not a suffix.
  assert.equal(uniqueProfileName("v2", ["v2"]), "v2 2");
});

test("a run of additions never repeats a name", () => {
  // Mirrors addProfile: mint "Profile N", uniquify, insert; then delete from the
  // middle and add again, which is exactly what used to collide.
  const names = [];
  const add = () => {
    const n = uniqueProfileName(`Profile ${names.length + 1}`, new Set(names));
    names.push(n);
    return n;
  };
  add(); add(); add();
  assert.deepEqual(names, ["Profile 1", "Profile 2", "Profile 3"]);
  names.splice(1, 1); // delete "Profile 2"
  assert.equal(add(), "Profile 4");
  assert.equal(new Set(names).size, names.length, "names must stay unique");
});

// A frozen snapshot of what shipped 1.1 persisted, so a future change to
// normalizeState/migrate cannot silently drop a returning user's data. If this
// test starts failing, an upgrade would lose something — fix the code, do not
// "fix" the fixture.
const V11_STORED = Object.freeze({
  version: 2,
  paused: true,
  theme: "dark",
  settings: { descriptionPlacement: "below", showOperation: true },
  popupWidth: 700,
  popupHeight: 480,
  selectedProfileId: "keep-me",
  profiles: [
    {
      id: "keep-me",
      name: "Staging auth",
      enabled: true,
      color: "#6366f1",
      requestHeaders: [
        { id: "h1", enabled: true, name: "Authorization", value: "Bearer tok", operation: "set", description: "svc account" },
        { id: "h2", enabled: false, name: "X-Debug", value: "1", operation: "set", description: "" },
        { id: "h3", enabled: true, name: "Referer", value: "", operation: "remove", description: "" },
      ],
      responseHeaders: [
        { id: "h4", enabled: true, name: "Access-Control-Allow-Origin", value: "*", operation: "set", description: "" },
      ],
      urlFilters: [{ id: "f1", enabled: true, pattern: ".*\\.staging\\.example\\.com/.*" }],
    },
    {
      id: "dup-a",
      name: "Staging auth",
      enabled: true,
      color: "#ec4899",
      requestHeaders: [{ id: "h6", enabled: true, name: "X Bad Name", value: "v", operation: "set", description: "typo" }],
      responseHeaders: [],
      urlFilters: [],
    },
  ],
});

test("upgrading from 1.1 preserves every stored field", () => {
  const out = normalizeState(migrate(structuredClone(V11_STORED)));

  assert.equal(out.paused, true, "a paused extension must stay paused");
  assert.equal(out.theme, "dark");
  assert.deepEqual(out.settings, V11_STORED.settings, "layout settings must survive");
  assert.equal(out.popupWidth, 700);
  assert.equal(out.popupHeight, 480);
  assert.equal(out.selectedProfileId, "keep-me");
  assert.equal(out.profiles.length, V11_STORED.profiles.length);

  for (const [i, before] of V11_STORED.profiles.entries()) {
    const after = out.profiles[i];
    assert.equal(after.id, before.id, "profile ids are stable across upgrade");
    assert.equal(after.name, before.name, "names are not rewritten on load");
    assert.equal(after.enabled, before.enabled);
    assert.deepEqual(after.requestHeaders, before.requestHeaders, "request headers verbatim");
    assert.deepEqual(after.responseHeaders, before.responseHeaders, "response headers verbatim");
    assert.deepEqual(after.urlFilters, before.urlFilters, "url filters verbatim");
  }

  // Duplicate names are deliberately NOT renamed on load — uniqueness is
  // enforced when the user adds/clones/renames/imports, not behind their back.
  assert.equal(out.profiles[0].name, out.profiles[1].name);
});

test("entries the engine will not accept are kept in storage, only unapplied", () => {
  // The 1.1 fixture contains "X Bad Name". 1.2 refuses to send it, but must not
  // delete it: the user needs to see it to fix the typo.
  const out = normalizeState(migrate(structuredClone(V11_STORED)));
  const bad = out.profiles[1].requestHeaders[0];
  assert.equal(bad.name, "X Bad Name");
  assert.equal(bad.description, "typo");
  const applied = compileRules(out, {}).flatMap((r) =>
    (r.action.requestHeaders || []).map((h) => h.header),
  );
  assert.ok(!applied.includes("X Bad Name"), "must not be applied");
});

test("a pre-settings blob upgrades without losing anything", () => {
  const v10 = {
    version: 1,
    paused: false,
    theme: "system",
    popupWidth: 470,
    selectedProfileId: "p1",
    profiles: [{ id: "p1", name: "Auth", enabled: true, color: "#6366f1",
      requestHeaders: [{ id: "h1", enabled: true, name: "Authorization", value: "tok", operation: "set", description: "note" }],
      responseHeaders: [], urlFilters: [] }],
  };
  const out = normalizeState(migrate(v10));
  assert.deepEqual(out.settings, DEFAULT_SETTINGS, "settings backfilled");
  assert.equal(out.version, SCHEMA_VERSION);
  assert.equal(out.profiles[0].requestHeaders[0].description, "note");
  assert.equal(out.profiles[0].id, "p1");
  assert.equal(out.popupWidth, 470);
});

test("the badge does not count a header whose value cannot be applied", () => {
  // headerActions screens the name *and* the value; the badge used to screen
  // only the name. A newline in the value is dropped from the compiled rules,
  // so counting it made the toolbar advertise a header that was never applied.
  const p = makeProfile("P", 0);
  p.requestHeaders = [makeHeader("X-Ok", "1"), makeHeader("X-Bad", "a\nb")];
  const state = normalizeState({ profiles: [p] });
  assert.equal(headerActions(state.profiles[0].requestHeaders).length, 1);
  assert.equal(countActiveHeaders(state), 1, "badge must match the compiled rules");
  assert.equal(compileRules(state).length, 1);
});

test("a profile whose only header has an unusable value is not listed as live", () => {
  const p = makeProfile("Broken", 0);
  p.requestHeaders = [makeHeader("X-Bad", "a\r\nb")];
  const state = normalizeState({ profiles: [p] });
  assert.equal(hasApplicableHeaders(state.profiles[0]), false);
  assert.deepEqual(precedenceOrder(state), [], "live-order box must not name it");
  assert.equal(countActiveHeaders(state), 0);
});

test("a remove operation is still counted, since it carries no value", () => {
  // Value screening must not accidentally drop "remove", which never has one.
  const p = makeProfile("P", 0);
  p.requestHeaders = [makeHeader("X-Drop", "", "remove")];
  const state = normalizeState({ profiles: [p] });
  assert.equal(countActiveHeaders(state), 1);
  assert.equal(compileRules(state).length, 1);
});

console.log(`\n${passed} tests passed`);
