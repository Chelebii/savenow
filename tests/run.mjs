#!/usr/bin/env node
// Zero-dependency test runner for savenow scripts.
//
// Each test:
//   - sets up a temp working directory with optional input memory + entries
//   - spawns the target script as a subprocess
//   - asserts on stdout JSON, file contents, or stderr
//
// Run: node tests/run.mjs
// Filter: node tests/run.mjs <substring>

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MERGE = path.join(REPO, "scripts", "merge-daily-memory.mjs");
const PREVIEW = path.join(REPO, "scripts", "preview-diff.mjs");

let _tmpCount = 0;
async function makeTmp() {
  _tmpCount += 1;
  const dir = path.join(os.tmpdir(), `savenow-test-${process.pid}-${Date.now()}-${_tmpCount}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function rmrf(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

function runScript(scriptPath, args, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [scriptPath, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

class AssertionError extends Error {}

function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
function assertContains(haystack, needle, msg) {
  if (!String(haystack).includes(needle)) {
    throw new AssertionError(`${msg}\n  expected to contain: ${JSON.stringify(needle)}\n  actual: ${JSON.stringify(haystack)}`);
  }
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------
// merge-daily-memory tests
// ---------------------------------------------------------------------------

test("add into empty memory creates file with header", async () => {
  const cwd = await makeTmp();
  try {
    const entries = [{ title: "Test note", bullets: ["A bullet"], action: "add" }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const result = parseJson(stdout);
    assertEqual(result.added, 1, "added count");
    assertEqual(result.addedTitles, ["Test note"], "added titles");
    assertEqual(result.merged, 0, "merged count");
    assertEqual(result.createdFile, true, "createdFile");
    const memory = await fs.readFile(path.join(cwd, "memory.md"), "utf8");
    assertContains(memory, "# 2026-05-15", "header");
    assertContains(memory, "- Test note", "title in section");
    assertContains(memory, "- A bullet", "bullet");
  } finally { await rmrf(cwd); }
});

test("backward compat: bare {title,bullets} treated as add", async () => {
  const cwd = await makeTmp();
  try {
    const entries = [{ title: "Bare", bullets: ["b1"] }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const result = parseJson(stdout);
    assertEqual(result.added, 1, "added");
    assertEqual(result.addedTitles, ["Bare"], "title");
  } finally { await rmrf(cwd); }
});

test("jaccard fallback demotes add to skip on near-duplicate title", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "memory.md"),
      `# 2026-05-15\n\n## 14:02 - Gateway token mismatch fix\n- Token mismatch resolved by updating env.\n`);
    const entries = [{
      title: "Gateway token mismatch fix",
      bullets: ["Token mismatch resolved by updating env."],
      action: "add",
    }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const result = parseJson(stdout);
    assertEqual(result.added, 0, "added");
    assertEqual(result.fallbackSkipped, ["Gateway token mismatch fix"], "fallbackSkipped");
  } finally { await rmrf(cwd); }
});

test("skip action does not write", async () => {
  const cwd = await makeTmp();
  try {
    const entries = [{ title: "Temporary plan", bullets: ["temporary"], action: "skip", reason: "x" }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const result = parseJson(stdout);
    assertEqual(result.added, 0, "added");
    assertEqual(result.skipped, 1, "skipped");
    assertEqual(result.skippedTitles, ["Temporary plan"], "skippedTitles");
    let exists = true;
    try { await fs.stat(path.join(cwd, "memory.md")); } catch { exists = false; }
    assert(!exists, "memory file should not be created");
  } finally { await rmrf(cwd); }
});

test("merge with valid target appends bullets + marker in place", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "memory.md"),
      `# 2026-05-15\n\n## 14:02 - Telegram UI conventions\n- Single-row 3-button layout.\n\n## 14:30 - Unrelated section\n- foo bar baz qux.\n`);
    const entries = [{
      title: "Telegram button additions",
      bullets: ["Cancel button always on the right.", "Apply button on the left."],
      action: "merge",
      merge_target_title: "Telegram UI conventions",
    }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const result = parseJson(stdout);
    assertEqual(result.merged, 1, "merged count");
    assertEqual(result.mergedBullets, 2, "mergedBullets count");
    const memory = await fs.readFile(path.join(cwd, "memory.md"), "utf8");
    assertContains(memory, "## 14:02 - Telegram UI conventions", "heading preserved");
    assertContains(memory, "- Cancel button always on the right.", "new bullet 1");
    assertContains(memory, "- Apply button on the left.", "new bullet 2");
    assert(/- \(merged \d{2}:\d{2}\)/.test(memory), "marker bullet present");
    assertContains(memory, "## 14:30 - Unrelated section", "unrelated section preserved");
    // Bullets must be inside the target section, not after the unrelated one.
    const targetIdx = memory.indexOf("Telegram UI conventions");
    const unrelatedIdx = memory.indexOf("Unrelated section");
    const newBulletIdx = memory.indexOf("Cancel button");
    assert(targetIdx < newBulletIdx && newBulletIdx < unrelatedIdx, "new bullet is in target section, before unrelated");
  } finally { await rmrf(cwd); }
});

test("merge with missing target falls back to add", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "memory.md"),
      `# 2026-05-15\n\n## 14:02 - Some other section\n- a bullet.\n`);
    const entries = [{
      title: "Standalone",
      bullets: ["alone bullet"],
      action: "merge",
      merge_target_title: "Nope, does not exist",
    }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const result = parseJson(stdout);
    assertEqual(result.added, 1, "fallback added");
    assertEqual(result.fallbackAdded, ["Standalone"], "fallbackAdded list");
    assertEqual(result.reasonByTitle["Standalone"], "merge-target-missing", "reason");
  } finally { await rmrf(cwd); }
});

test("merge with all-duplicate bullets is skipped", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "memory.md"),
      `# 2026-05-15\n\n## 14:02 - Target\n- bullet a\n- bullet b\n`);
    const entries = [{
      title: "Add to target",
      bullets: ["bullet a", "bullet b"],
      action: "merge",
      merge_target_title: "Target",
    }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const result = parseJson(stdout);
    assertEqual(result.merged, 0, "no merge");
    assertEqual(result.skipped, 1, "skipped 1");
    assertEqual(result.reasonByTitle["Add to target"], "all-bullets-duplicate", "reason");
  } finally { await rmrf(cwd); }
});

test("merge marker is replaced rather than stacked on second merge", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "memory.md"),
      `# 2026-05-15\n\n## 14:02 - Target\n- bullet a\n- (merged 14:05)\n`);
    const entries = [{
      title: "Second merge",
      bullets: ["bullet b"],
      action: "merge",
      merge_target_title: "Target",
    }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const memory = await fs.readFile(path.join(cwd, "memory.md"), "utf8");
    const markerMatches = memory.match(/- \(merged \d{2}:\d{2}\)/g) || [];
    assertEqual(markerMatches.length, 1, "exactly one marker after second merge");
    assertContains(memory, "- bullet b", "new bullet present");
    assert(!memory.includes("(merged 14:05)"), "old marker replaced");
  } finally { await rmrf(cwd); }
});

test("mixed batch: add + merge + skip in one run", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "memory.md"),
      `# 2026-05-15\n\n## 10:00 - Existing topic\n- old bullet\n`);
    const entries = [
      { title: "New thing", bullets: ["new bullet"], action: "add" },
      { title: "Append here", bullets: ["additional"], action: "merge", merge_target_title: "Existing topic" },
      { title: "Throwaway", bullets: ["temp"], action: "skip", reason: "temp" },
    ];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(MERGE, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--date", "2026-05-15",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    const result = parseJson(stdout);
    assertEqual(result.added, 1, "added");
    assertEqual(result.merged, 1, "merged");
    assertEqual(result.skipped, 1, "skipped");
    const memory = await fs.readFile(path.join(cwd, "memory.md"), "utf8");
    assertContains(memory, "- new bullet", "add bullet");
    assertContains(memory, "- additional", "merged bullet");
    assert(!memory.includes("Throwaway"), "skip title not in file");
  } finally { await rmrf(cwd); }
});

// ---------------------------------------------------------------------------
// preview-diff tests
// ---------------------------------------------------------------------------

test("preview: 0 candidates message", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify([]));
    const { code, stdout } = await runScript(PREVIEW, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    assertContains(stdout, "0 candidates", "empty preview message");
    let exists = true;
    try { await fs.stat(path.join(cwd, "pending.json")); } catch { exists = false; }
    assert(!exists, "no pending file should be written for 0 candidates");
  } finally { await rmrf(cwd); }
});

test("preview: full output + pending file", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "memory.md"),
      `# 2026-05-15\n\n## 14:02 - Telegram UI conventions\n- existing rule.\n`);
    const entries = [
      { title: "Gateway fix", bullets: ["resolved by env update"], action: "add" },
      { title: "Button additions", bullets: ["new rule"], action: "merge", merge_target_title: "Telegram UI conventions", reason: "extra rule" },
      { title: "Temp", bullets: ["nope"], action: "skip", reason: "temporary" },
    ];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(PREVIEW, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
      "--pending-file", "pending.json",
      "--session-key", "telegram:topic:42:abc",
      "--message-thread-id", "42",
      "--ttl-minutes", "30",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    assertContains(stdout, "3 candidates", "candidate count");
    assertContains(stdout, "ADD — Gateway fix", "add label");
    assertContains(stdout, "MERGE — Button additions → existing", "merge label");
    assertContains(stdout, "SKIP — Temp", "skip label");
    assertContains(stdout, "Buttons expire in 30 min", "ttl footer");
    const pendingRaw = await fs.readFile(path.join(cwd, "pending.json"), "utf8");
    const pending = JSON.parse(pendingRaw);
    assertEqual(pending.version, 1, "version");
    assertEqual(pending.sessionKey, "telegram:topic:42:abc", "sessionKey");
    assertEqual(pending.messageThreadId, "42", "messageThreadId");
    assert(typeof pending.expiresAt === "string", "expiresAt is string");
    assertEqual(pending.entries.length, 3, "entries copied");
  } finally { await rmrf(cwd); }
});

test("preview: merge with missing target shows fallback note", async () => {
  const cwd = await makeTmp();
  try {
    await fs.writeFile(path.join(cwd, "memory.md"),
      `# 2026-05-15\n\n## 10:00 - Other\n- bullet\n`);
    const entries = [{
      title: "Orphan merge",
      bullets: ["lonely bullet"],
      action: "merge",
      merge_target_title: "Does not exist",
    }];
    await fs.writeFile(path.join(cwd, "entries.json"), JSON.stringify(entries));
    const { code, stdout } = await runScript(PREVIEW, [
      "--entries-file", "entries.json",
      "--memory-path", "memory.md",
    ], cwd);
    assert(code === 0, `exit ${code}`);
    assertContains(stdout, "MERGE → ADD (fallback)", "fallback label");
    assertContains(stdout, "not found in today's memory", "explanation");
  } finally { await rmrf(cwd); }
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function run() {
  const filter = process.argv[2] || "";
  const filtered = filter ? tests.filter((t) => t.name.includes(filter)) : tests;
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const t of filtered) {
    process.stdout.write(`• ${t.name} ... `);
    try {
      await t.fn();
      process.stdout.write("OK\n");
      passed += 1;
    } catch (err) {
      process.stdout.write("FAIL\n");
      failed += 1;
      failures.push({ name: t.name, err });
    }
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed, ${filtered.length} total\n`);
  if (failures.length > 0) {
    for (const f of failures) {
      process.stdout.write(`\n— ${f.name} —\n`);
      process.stdout.write(`${f.err instanceof Error ? f.err.message : String(f.err)}\n`);
    }
    process.exit(1);
  }
}

run().catch((e) => {
  process.stderr.write(`runner crashed: ${e instanceof Error ? e.stack : e}\n`);
  process.exit(2);
});
