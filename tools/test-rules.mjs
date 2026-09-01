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
} from "../state.js";
import {
  compileRules,
  compileRuleGroups,
  headerActions,
  countActiveHeaders,
  isValidHeaderName,
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
  assert.equal(rule.priority, 1);
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

console.log(`\n${passed} tests passed`);
