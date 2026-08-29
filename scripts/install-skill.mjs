#!/usr/bin/env node
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [skillName, ...flags] = process.argv.slice(2);
if (!skillName || !/^[a-z0-9-]{1,63}$/.test(skillName)) {
  throw new Error("Usage: install-skill.mjs <skill-name> [--check]");
}
if (flags.some((flag) => flag !== "--check")) throw new Error(`Unsupported option: ${flags.join(" ")}`);

const source = path.join(repositoryRoot, "skills", skillName);
const codexRoot = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const skillsRoot = path.join(codexRoot, "skills");
const target = path.join(skillsRoot, skillName);
await fsp.access(path.join(source, "SKILL.md"));

async function filesUnder(root, current = root) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
    else throw new Error(`Unsupported filesystem entry: ${absolute}`);
  }
  return files.sort();
}

async function digest(file) {
  return createHash("sha256").update(await fsp.readFile(file)).digest("hex");
}

async function compareDirectories(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([filesUnder(left), filesUnder(right)]);
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  for (const relative of leftFiles) {
    if (await digest(path.join(left, relative)) !== await digest(path.join(right, relative))) return false;
  }
  return true;
}

if (flags.includes("--check")) {
  const identical = await compareDirectories(source, target).catch(() => false);
  console.log(JSON.stringify({ skill: skillName, source, target, identical }));
  if (!identical) process.exitCode = 1;
} else {
  await fsp.mkdir(skillsRoot, { recursive: true });
  const stagingRoot = await fsp.mkdtemp(path.join(skillsRoot, `.${skillName}.stage-`));
  const staged = path.join(stagingRoot, skillName);
  const backup = path.join(skillsRoot, `.${skillName}.backup-${process.pid}-${Date.now()}`);
  let backedUp = false;
  try {
    await fsp.cp(source, staged, { recursive: true, errorOnExist: true });
    try {
      await fsp.rename(target, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fsp.rename(staged, target);
    if (!await compareDirectories(source, target)) throw new Error("Installed skill does not match its source bytes.");
    if (backedUp) await fsp.rm(backup, { recursive: true });
    console.log(JSON.stringify({ skill: skillName, source, target, identical: true }));
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true });
    if (backedUp) await fsp.rename(backup, target);
    throw error;
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
  }
}
