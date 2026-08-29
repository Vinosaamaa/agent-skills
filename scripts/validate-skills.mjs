#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repositoryRoot, "skills");
const entries = (await fsp.readdir(skillsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
if (!entries.length) throw new Error("At least one skill directory is required.");

for (const entry of entries) {
  if (!/^[a-z0-9-]{1,63}$/.test(entry.name)) throw new Error(`Invalid skill directory name: ${entry.name}`);
  const skillRoot = path.join(skillsRoot, entry.name);
  const skillText = await fsp.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = skillText.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) throw new Error(`${entry.name}/SKILL.md is missing YAML frontmatter.`);
  const keys = [...frontmatter[1].matchAll(/^([A-Za-z0-9_-]+):/gm)].map((match) => match[1]);
  const allowedKeys = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
  const unexpected = keys.filter((key) => !allowedKeys.has(key));
  if (unexpected.length) throw new Error(`${entry.name}/SKILL.md has unsupported frontmatter keys: ${unexpected.join(", ")}`);
  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== entry.name) throw new Error(`${entry.name}/SKILL.md name must match its directory.`);
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) throw new Error(`${entry.name}/SKILL.md has an invalid hyphen sequence.`);
  if (!description) throw new Error(`${entry.name}/SKILL.md requires a description.`);
  if (description.length > 1024 || description.includes("<") || description.includes(">")) throw new Error(`${entry.name}/SKILL.md description is invalid.`);
  if (/^\[TODO:/i.test(description) || /^\s{0,3}\[TODO:[^\n]*\]\s*$/m.test(skillText.slice(frontmatter[0].length))) {
    throw new Error(`${entry.name}/SKILL.md contains an unfinished placeholder.`);
  }

  const interfaceText = await fsp.readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  if (!interfaceText.includes(`$${entry.name}`)) throw new Error(`${entry.name}/agents/openai.yaml default prompt must name the skill.`);
}

console.log(JSON.stringify({ valid: true, skills: entries.map((entry) => entry.name).sort() }));
