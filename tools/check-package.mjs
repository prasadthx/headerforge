// Static package checks that need no browser. Run: npm test
//
// The unit suites cover state.js, rules.js and background.js. Nothing imports
// popup.js or options.js — they need a DOM — so roughly 1500 lines of shipped
// code have no automated cover at all. A parse check is cheap and catches the
// class of mistake that would otherwise reach the store: a syntax error in a
// file that only runs when a user opens the popup.
//
// The icon checks exist because setIcon failures are swallowed by design
// (`.catch(() => {})`), so a missing PNG would degrade silently rather than
// throw anywhere a human would see it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const at = (p) => fileURLToPath(new URL(p, ROOT));
const readJson = (p) => JSON.parse(readFileSync(at(p), "utf8"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("  ok  " + name);
}

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");

check("manifest.json and package.json parse", () => {
  assert.equal(manifest.manifest_version, 3, "must stay on Manifest V3");
});

check(`manifest and package versions agree (${manifest.version})`, () => {
  assert.equal(
    manifest.version,
    pkg.version,
    `manifest.json is ${manifest.version} but package.json is ${pkg.version}`,
  );
});

check("every script the manifest and pages reference parses", () => {
  const scripts = [
    ...readdirSync(at(".")).filter((f) => f.endsWith(".js")),
    ...readdirSync(at("tools")).filter((f) => f.endsWith(".mjs")).map((f) => `tools/${f}`),
  ].sort();
  assert.ok(scripts.length >= 5, `expected the shipped scripts, found ${scripts.length}`);
  for (const f of scripts) {
    // Throws with the parse error on stderr if the file is malformed.
    execFileSync(process.execPath, ["--check", at(f)], { stdio: ["ignore", "ignore", "pipe"] });
  }
});

// Imported after the parse check, so a syntax error in state.js is reported as
// a parse failure rather than as an unrelated import crash. Awaited at the top
// level: passing an async callback to check() would let its assertions resolve
// after the "ok" had already been printed and counted.
const { ICON_PATHS } = await import(new URL("state.js", ROOT));

check("every icon the code can ask for ships", () => {
  for (const [theme, sizes] of Object.entries(ICON_PATHS)) {
    for (const [size, p] of Object.entries(sizes)) {
      assert.ok(existsSync(at(p)), `ICON_PATHS.${theme}["${size}"] -> ${p} is missing`);
    }
  }
});

check("every icon the manifest declares ships", () => {
  const declared = {
    ...(manifest.icons || {}),
    ...((manifest.action && manifest.action.default_icon) || {}),
  };
  assert.ok(Object.keys(declared).length > 0, "manifest declares no icons");
  for (const [size, p] of Object.entries(declared)) {
    assert.ok(existsSync(at(p)), `manifest icon "${size}" -> ${p} is missing`);
  }
});

check("the manifest's entry points exist", () => {
  for (const p of [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
  ]) {
    assert.ok(existsSync(at(p)), `${p} is referenced by the manifest but missing`);
  }
});

console.log(`\n${passed} package checks passed`);
