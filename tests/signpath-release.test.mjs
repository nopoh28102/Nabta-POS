import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const script = resolve("scripts/windows/finalize-signpath-release.mjs");

function fixture(extra = "") {
  const temp = mkdtempSync(join(tmpdir(), "nabta-signpath-"));
  const version = "1.2.3";
  const name = "Nabta-POS-" + version + "-x64.exe";
  mkdirSync(join(temp, "apps/desktop"), { recursive: true });
  writeFileSync(join(temp, "apps/desktop/package.json"), JSON.stringify({ version }));
  const installer = join(temp, name);
  const bytes = Buffer.from("Signed fixture for tests, not a real executable.");
  writeFileSync(installer, bytes);
  const manifest = join(temp, "latest.yml");
  writeFileSync(manifest, [
    "version: " + version,
    "files:",
    "  - url: " + name,
    "    sha512: OLD_HASH",
    "    size: 10",
    "path: " + name,
    "sha512: OLD_HASH",
    "releaseDate: 2026-10-16T00:00:00Z",
    extra,
    "",
  ].join("\n"));
  return { temp, installer, manifest, bytes };
}

test("finalizer hashes the final EXE and updates both updater hashes and the size", () => {
  const f = fixture();
  try {
    execFileSync(process.execPath, [script, f.installer, f.manifest], { cwd: f.temp });
    const output = readFileSync(f.manifest, "utf8");
    const hash = createHash("sha512").update(f.bytes).digest("base64");
    assert.equal([...output.matchAll(/sha512:\s*(\S+)/g)].length, 2);
    assert.equal([...output.matchAll(/sha512:\s*(\S+)/g)].every(m => m[1] === hash), true);
    assert.match(output, new RegExp("size: " + f.bytes.length));
    assert.match(output, /path: Nabta-POS-1\.2\.3-x64\.exe/);
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test("finalizer refuses stale differential blockmaps", () => {
  const f = fixture("    blockMapSize: 1234");
  try {
    assert.throws(() => execFileSync(process.execPath, [script, f.installer, f.manifest], { cwd: f.temp, stdio: "pipe" }));
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});
