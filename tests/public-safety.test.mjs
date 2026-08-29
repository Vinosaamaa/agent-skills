import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedFiles = [
  ".github/workflows/ci.yml",
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "package.json",
  "scripts/install-skill.mjs",
  "scripts/validate-skills.mjs",
  "skills/lavish-transcript/SKILL.md",
  "skills/lavish-transcript/agents/openai.yaml",
  "skills/lavish-transcript/benchmarks/benchmark-render-transcript.mjs",
  "skills/lavish-transcript/scripts/render-transcript.mjs",
  "skills/lavish-transcript/tests/render-transcript.test.mjs",
  "tests/public-safety.test.mjs",
].sort();

async function filesUnder(current = repositoryRoot) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    else if (entry.isFile()) files.push(path.relative(repositoryRoot, absolute));
  }
  return files;
}

test("candidate contains only the approved minimal public manifest", async () => {
  assert.deepEqual((await filesUnder()).sort(), expectedFiles);
});

test("candidate contains no private artifacts, machine identity, credentials, or unrelated project data", async () => {
  const files = await filesUnder();
  assert.equal(files.some((file) => file.endsWith(".html") || file.endsWith(".jsonl") || file.includes(".lavish/")), false);

  const prohibited = [
    "/Users/",
    ["wen", "kxu"].join(""),
    ["Job", " Journey"].join(""),
    ["terminal-environment", "-toolkit"].join(""),
    [".codex", "/sessions"].join(""),
    ["Library/", "Application Support"].join(""),
    ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    ["gh", "p_"].join(""),
    ["sk", "-proj-"].join(""),
  ];
  for (const file of files) {
    if (file === "tests/public-safety.test.mjs") continue;
    const text = await fsp.readFile(path.join(repositoryRoot, file), "utf8");
    for (const marker of prohibited) assert.equal(text.includes(marker), false, `${file} contains prohibited marker ${marker}`);
  }
});
