#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PAGE_BLOCK_LIMIT = 40;
export const IO_CHUNK_BYTES = 64 * 1024;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
export const FIRST_RENDER_TIMEOUT_MS = 15_000;
export const AGENT_CHROME_NAVIGATION_TIMEOUT_MS = 30_000;
export const AGENT_CHROME_LAUNCHER_RELATIVE_PATH = path.join(".local", "bin", "launch-agent-chrome");
export const AGENT_CHROME_AXI_RELATIVE_PATH = path.join(".local", "bin", "agent-chrome-axi");
export const PROMPT_INDEX_PAGE_LIMIT = 200;
export const PROMPT_PREVIEW_LIMIT = 160;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--watch") parsed.watch = true;
    else if (key.startsWith("--")) parsed[key.slice(2)] = argv[++index];
  }
  return parsed;
}

function assertTemporaryOutput(output) {
  const resolved = path.resolve(output);
  const roots = [path.resolve("/private/tmp"), path.resolve(os.tmpdir())];
  if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error("Transcript output must be temporary under /private/tmp or the system temporary directory.");
  }
}

async function readAt(handle, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function findLineStart(handle, position) {
  if (position <= 0) return 0;
  let cursor = position;
  while (cursor > 0) {
    const start = Math.max(0, cursor - IO_CHUNK_BYTES);
    const chunk = await readAt(handle, start, cursor - start);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    cursor = start;
  }
  return 0;
}

async function findLineStartAtOrAfter(handle, position, size) {
  if (position <= 0) return 0;
  if (position >= size) return size;
  const previous = await readAt(handle, position - 1, 1);
  if (previous[0] === 0x0a) return position;
  let cursor = position;
  while (cursor < size) {
    const chunk = await readAt(handle, cursor, Math.min(IO_CHUNK_BYTES, size - cursor));
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) return cursor + newline + 1;
    cursor += chunk.length;
  }
  return size;
}

async function readLine(handle, start, size) {
  if (start >= size) return null;
  const chunks = [];
  let stored = 0;
  let scanned = 0;
  let cursor = start;
  let tooLong = false;
  while (cursor < size) {
    const chunk = await readAt(handle, cursor, Math.min(IO_CHUNK_BYTES, size - cursor));
    if (!chunk.length) break;
    const newline = chunk.indexOf(0x0a);
    const useful = newline >= 0 ? chunk.subarray(0, newline) : chunk;
    scanned += useful.length + (newline >= 0 ? 1 : 0);
    if (!tooLong && stored + useful.length <= MAX_LINE_BYTES) {
      chunks.push(useful);
      stored += useful.length;
    } else {
      tooLong = true;
      chunks.length = 0;
      stored = 0;
    }
    cursor += useful.length + (newline >= 0 ? 1 : 0);
    if (newline >= 0) {
      const bytes = tooLong ? Buffer.alloc(0) : Buffer.concat(chunks, stored);
      const content = bytes.length && bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
      return { start, end: cursor, text: content.toString("utf8"), terminated: true, tooLong, bytesRead: scanned };
    }
  }
  const bytes = tooLong ? Buffer.alloc(0) : Buffer.concat(chunks, stored);
  const content = bytes.length && bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
  return { start, end: size, text: content.toString("utf8"), terminated: false, tooLong, bytesRead: scanned };
}

function parseJsonLine(line) {
  if (!line || !line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function timestampOf(row) {
  const value = row?.timestamp ?? row?.ts ?? row?.created_at ?? row?.createdAt;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function locateTimestampBoundary(source, since) {
  const threshold = Date.parse(since);
  if (Number.isNaN(threshold)) throw new Error(`Invalid timestamp boundary: ${since}`);
  const handle = await fsp.open(source, "r");
  let bytesRead = 0;
  try {
    const { size } = await handle.stat();
    let low = 0;
    let high = size;
    while (low < high) {
      const midpoint = low + Math.floor((high - low) / 2);
      const start = await findLineStartAtOrAfter(handle, midpoint, size);
      if (start >= high || start >= size) {
        high = midpoint;
        continue;
      }
      const line = await readLine(handle, start, size);
      bytesRead += line?.bytesRead || 0;
      if (!line || line.tooLong) {
        low = line?.end ?? size;
        continue;
      }
      const time = timestampOf(parseJsonLine(line.text));
      if (time == null || time < threshold) low = line.end;
      else high = start;
    }
    const offset = await findLineStartAtOrAfter(handle, low, size);
    return { offset, bytesRead };
  } finally {
    await handle.close();
  }
}

function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function zonedMidnightInstant(date, timeZone) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid local date: ${date}`);
  const desired = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let guess = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = zonedParts(guess, timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = desired - (represented - guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function nextCalendarDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function dateInZone(value, timeZone) {
  const parts = zonedParts(Date.parse(value), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function zonedDayBounds(date, timeZone) {
  try {
    const start = zonedMidnightInstant(date, timeZone);
    const end = zonedMidnightInstant(nextCalendarDate(date), timeZone);
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  } catch (error) {
    if (error instanceof RangeError) throw new Error(`Invalid timezone: ${timeZone}`);
    throw error;
  }
}

export async function locateLocalDayBounds(source, date, timeZone) {
  const bounds = zonedDayBounds(date, timeZone);
  const [start, end] = await Promise.all([
    locateTimestampBoundary(source, bounds.start),
    locateTimestampBoundary(source, bounds.end),
  ]);
  return {
    ...bounds,
    startOffset: start.offset,
    endOffset: end.offset,
    bytesRead: start.bytesRead + end.bytesRead,
  };
}

export async function locateQuotedBoundary(source, quote) {
  const exactQuote = String(quote);
  const rawNeedle = Buffer.from(exactQuote, "utf8");
  if (!rawNeedle.length) return { offset: 0, bytesRead: 0 };
  const escapedNeedle = Buffer.from(JSON.stringify(exactQuote).slice(1, -1), "utf8");
  const needles = [rawNeedle, escapedNeedle].filter((needle, index, all) => all.findIndex((item) => item.equals(needle)) === index);
  const overlapSize = Math.max(...needles.map((needle) => needle.length)) - 1;
  const handle = await fsp.open(source, "r");
  let bytesRead = 0;
  try {
    const { size } = await handle.stat();
    let right = size;
    let overlap = Buffer.alloc(0);
    while (right > 0) {
      const left = Math.max(0, right - IO_CHUNK_BYTES);
      const chunk = await readAt(handle, left, right - left);
      bytesRead += chunk.length;
      const searchable = overlap.length ? Buffer.concat([chunk, overlap]) : chunk;
      const matches = [];
      for (const needle of needles) {
        let index = searchable.lastIndexOf(needle);
        while (index >= 0) {
          if (index < chunk.length) matches.push(left + index);
          index = searchable.lastIndexOf(needle, index - 1);
        }
      }
      const lineStarts = new Set();
      for (const match of matches.sort((a, b) => b - a)) lineStarts.add(await findLineStart(handle, match));
      for (const offset of lineStarts) {
        const line = await readLine(handle, offset, size);
        bytesRead += line?.bytesRead || 0;
        if (!line || line.tooLong) continue;
        const userText = quotedUserText(parseJsonLine(line.text));
        if (userText.includes(exactQuote)) return { offset, bytesRead };
      }
      overlap = overlapSize > 0 ? chunk.subarray(0, Math.min(overlapSize, chunk.length)) : Buffer.alloc(0);
      right = left;
    }
    return { offset: 0, bytesRead };
  } finally {
    await handle.close();
  }
}

function quotedUserText(row) {
  if (!row) return "";
  if (row.type === "response_item" && row.payload?.type === "message" && row.payload.role === "user") {
    return visibleUserText(row.payload.content);
  }
  if (row.type === "message" && row.message?.role === "user") return visibleUserText(row.message.content);
  const role = row.role || row.message?.role || row.data?.role;
  if (role !== "user") return "";
  return visibleCursorUserText(row.content ?? row.message?.content ?? row.data?.content);
}

function detectFormat(row) {
  if (row.type === "session" || (row.type === "message" && row.message)) return "pi";
  if (["session_meta", "turn_context", "response_item", "event_msg"].includes(row.type)) return "codex";
  return "cursor";
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) {
    return value
      .filter((item) => item?.type !== "input_image" && item?.type !== "image")
      .map((item) => contentText(item?.text ?? item?.input_text ?? item?.output_text ?? item))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") return contentText(value.text ?? value.input_text ?? value.output_text ?? value.content ?? "");
  return String(value);
}

function safeToolText(value) {
  if (value == null) return "";
  const raw = typeof value === "string"
    ? value
    : JSON.stringify(value, (_key, item) => typeof item === "string" && item.startsWith("data:") ? "[binary image omitted]" : item, 2);
  return raw.replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, "[binary image omitted]");
}

function isInternalEnvelope(text) {
  const value = String(text).trimStart();
  return /^# AGENTS\.md instructions(?:\s+for\b|[ \t]*\n)/.test(value)
    || /^<(?:codex_internal_context|environment_context|permissions|skills_instructions|apps_instructions|plugins_instructions|recommended_plugins|collaboration_mode)(?:\s|>)/.test(value)
    || /^<(?:mcp_meta_tools|mcp_meta_tool_servers|mcp_meta_tool_server)(?:\s|>)/.test(value)
    || /^<(?:system|developer|goal|hook|hook_context|tool|tool_call|tool_result|function_call|function_result)(?:\s|>)/.test(value);
}

function visibleUserText(content) {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((part) => contentText(part))
    .filter((text) => text && !isInternalEnvelope(text))
    .join("\n");
}

function visibleCursorUserText(content) {
  const visible = visibleUserText(content);
  const queries = [...visible.matchAll(/<user_query(?:\s[^>]*)?>([\s\S]*?)<\/user_query>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  return queries.length ? queries.join("\n") : visible;
}

function consumeCodex(row, state, meta) {
  const time = row.timestamp || row.ts || "";
  const payload = row.payload || {};
  if (row.type === "response_item" && payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
    const text = payload.role === "user" ? visibleUserText(payload.content) : contentText(payload.content);
    return text ? [{ kind: "message", role: payload.role, text, time, ...meta }] : [];
  }
  if (row.type === "response_item" && ["custom_tool_call", "function_call"].includes(payload.type)) {
    const call = { kind: "tool", id: payload.call_id || payload.id || `tool-${meta.start}`, name: payload.name || "tool", input: safeToolText(payload.input ?? payload.arguments), output: "", time, ...meta };
    state.calls.set(call.id, call);
    return [call];
  }
  if (row.type === "response_item" && ["custom_tool_call_output", "function_call_output"].includes(payload.type)) {
    const call = state.calls.get(payload.call_id);
    const output = safeToolText(contentText(payload.output));
    if (call) { call.output = output; call.end = meta.end; return []; }
    return output ? [{ kind: "tool", name: "tool result", input: "", output, time, ...meta }] : [];
  }
  if (row.type === "event_msg" && payload.type === "patch_apply_end" && payload.changes) {
    return Object.entries(payload.changes)
      .filter(([, change]) => change?.unified_diff)
      .map(([file, change]) => ({ kind: "diff", file, diff: change.unified_diff, time, ...meta }));
  }
  return [];
}

function consumePi(row, state, meta) {
  if (row.type !== "message" || !row.message) return [];
  const message = row.message;
  const time = row.timestamp || "";
  if (["user", "assistant"].includes(message.role)) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const textBlocks = blocks.filter((block) => typeof block === "string" || block?.type === "text");
    const text = message.role === "user" ? visibleUserText(textBlocks) : contentText(textBlocks);
    const entries = text ? [{ kind: "message", role: message.role, text, time, ...meta }] : [];
    for (const block of blocks) {
      if (block?.type !== "toolCall") continue;
      const call = { kind: "tool", id: block.id, name: block.name || "tool", input: safeToolText(block.arguments), output: "", time, ...meta };
      state.calls.set(call.id, call);
      entries.push(call);
    }
    return entries;
  }
  if (message.role === "toolResult") {
    const call = state.calls.get(message.toolCallId);
    const output = safeToolText(contentText(message.content));
    if (call) { call.output = output; call.end = meta.end; return []; }
    return [{ kind: "tool", name: message.toolName || "tool result", input: "", output, time, ...meta }];
  }
  return [];
}

function consumeCursor(row, _state, meta) {
  const time = row.timestamp || row.ts || "";
  const role = row.role || row.message?.role || row.data?.role;
  const content = row.content ?? row.message?.content ?? row.data?.content;
  if (["user", "assistant"].includes(role)) {
    const blocks = Array.isArray(content) ? content : [content];
    const textBlocks = blocks.filter((block) => typeof block === "string" || block?.type === "text");
    const text = role === "user" ? visibleCursorUserText(textBlocks) : contentText(textBlocks);
    const entries = text ? [{ kind: "message", role, text, time, ...meta }] : [];
    blocks.forEach((block, index) => {
      if (block?.type !== "tool_use") return;
      entries.push({ kind: "tool", id: block.id || `cursor-tool-${meta.start}-${index}`, name: block.name || "tool", input: safeToolText(block.input), output: safeToolText(block.output), time, ...meta });
    });
    return entries;
  }
  const name = row.name || row.tool_name || row.tool?.name;
  return name ? [{ kind: "tool", name, input: safeToolText(row.input ?? row.arguments ?? row.tool?.input), output: safeToolText(row.output ?? row.result), time, ...meta }] : [];
}

function normalizeRow(row, state, meta, requestedFormat) {
  if (state.format === "auto") state.format = detectFormat(row);
  const format = requestedFormat === "auto" ? state.format : requestedFormat;
  if (format === "pi") return consumePi(row, state, meta);
  if (format === "cursor") return consumeCursor(row, state, meta);
  return consumeCodex(row, state, meta);
}

function userPromptEnvelope(row, requestedFormat = "auto") {
  if (!row) return null;
  const format = requestedFormat === "auto" ? detectFormat(row) : requestedFormat;
  let text = "";
  if (format === "codex") {
    if (row.type !== "response_item" || row.payload?.type !== "message" || row.payload.role !== "user") return null;
    text = visibleUserText(row.payload.content);
  } else if (format === "pi") {
    if (row.type !== "message" || row.message?.role !== "user") return null;
    text = visibleUserText(row.message.content);
  } else {
    const role = row.role || row.message?.role || row.data?.role;
    if (role !== "user") return null;
    text = visibleCursorUserText(row.content ?? row.message?.content ?? row.data?.content);
  }
  if (!text) return null;
  let timestamp = timestampOf(row);
  if (timestamp == null && format === "cursor") {
    const raw = contentText(row.content ?? row.message?.content ?? row.data?.content);
    const embedded = raw.match(/<timestamp(?:\s[^>]*)?>([\s\S]*?)<\/timestamp>/)?.[1]?.trim();
    timestamp = embedded ? Date.parse(embedded) : null;
    if (Number.isNaN(timestamp)) timestamp = null;
  }
  if (timestamp == null) return null;
  return { text, timestamp };
}

function promptPreview(text) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  return compact.length <= PROMPT_PREVIEW_LIMIT ? compact : `${compact.slice(0, PROMPT_PREVIEW_LIMIT - 1)}…`;
}

async function scanPromptEnvelopes(source, options) {
  const handle = await fsp.open(source, "r");
  const items = [];
  let cursor = options.start;
  let bytesRead = 0;
  try {
    while (cursor < options.end) {
      const line = await readLine(handle, cursor, options.end);
      if (!line) break;
      bytesRead += line.bytesRead;
      if (!line.terminated && options.requireTerminatedLine) break;
      cursor = line.end;
      if (line.tooLong) continue;
      const prompt = userPromptEnvelope(parseJsonLine(line.text), options.format || "auto");
      if (!prompt) continue;
      items.push({
        locator: `byte:${line.start}:${line.end}`,
        timestamp: new Date(prompt.timestamp).toISOString(),
        preview: promptPreview(prompt.text),
        start: line.start,
        end: line.end,
      });
    }
    return { items, scannedThrough: cursor, bytesRead };
  } finally {
    await handle.close();
  }
}

export async function buildDailyPromptIndex(source, options) {
  const date = String(options.date || "");
  const timeZone = String(options.timeZone || "");
  const format = options.format || "auto";
  const cache = options.cache || new Map();
  const stat = await fsp.stat(source);
  const realSource = await fsp.realpath(source);
  const identity = `${realSource}:${stat.dev}:${stat.ino}`;
  const cacheKey = `${identity}:${format}:${timeZone}:${date}`;
  const today = dateInZone(options.now || new Date().toISOString(), timeZone);
  const cached = cache.get(cacheKey);

  if (cached && date < today) return { ...cached, cacheHit: true, scanStart: cached.scannedThrough, bytesRead: 0 };

  const bounds = await locateLocalDayBounds(source, date, timeZone);
  const canAppend = cached
    && date === today
    && stat.size >= cached.sourceSize
    && bounds.startOffset === cached.startOffset
    && bounds.endOffset >= cached.scannedThrough;
  const scanStart = canAppend ? cached.scannedThrough : bounds.startOffset;
  const scanned = await scanPromptEnvelopes(source, {
    start: scanStart,
    end: bounds.endOffset,
    format,
    requireTerminatedLine: Boolean(options.requireTerminatedLine),
  });
  const rawItems = canAppend ? [...cached.items, ...scanned.items] : scanned.items;
  const items = rawItems.map((item, index) => ({ ...item, ordinal: index + 1 }));
  const result = {
    date,
    timeZone,
    start: bounds.start,
    end: bounds.end,
    startOffset: bounds.startOffset,
    endOffset: bounds.endOffset,
    scannedThrough: scanned.scannedThrough,
    scanStart,
    bytesRead: bounds.bytesRead + scanned.bytesRead,
    sourceIdentity: identity,
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    items,
  };
  cache.set(cacheKey, result);
  return result;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(date) + " PT";
}

function extractCommand(input) {
  const match = String(input || "").match(/\bcmd\s*:\s*"((?:\\.|[^"\\])*)"/s);
  if (!match) return "";
  try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
}

function toolLabel(entry) {
  const command = extractCommand(entry.input);
  if (command) return command.length > 120 ? command.slice(0, 117) + "…" : command;
  if (/view_image/i.test(entry.name)) {
    try { return "Viewed image · " + (JSON.parse(entry.input).path || "image"); } catch { return "Viewed image"; }
  }
  return entry.name.replace(/^.*__/, "").replace(/^functions\./, "");
}

function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function diffRows(diff) {
  let oldLine = null;
  let newLine = null;
  return String(diff).split("\n").map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return `<div class="diff-row hunk"><span></span><span></span><code>${escapeHtml(line)}</code></div>`;
    }
    let kind = "context";
    let oldNumber = oldLine;
    let newNumber = newLine;
    if (line.startsWith("+") && !line.startsWith("+++")) { kind = "add"; oldNumber = ""; if (newLine != null) newLine += 1; }
    else if (line.startsWith("-") && !line.startsWith("---")) { kind = "remove"; newNumber = ""; if (oldLine != null) oldLine += 1; }
    else if (!line.startsWith("\\")) { if (oldLine != null) oldLine += 1; if (newLine != null) newLine += 1; }
    return `<div class="diff-row ${kind}"><span>${oldNumber ?? ""}</span><span>${newNumber ?? ""}</span><code>${escapeHtml(line)}</code></div>`;
  }).join("");
}

function renderNestedTool(entry) {
  return `<details class="nested"><summary><span class="nested-kind">${/view_image/i.test(entry.name) ? "IMAGE" : "RUN"}</span><strong>${escapeHtml(toolLabel(entry))}</strong></summary><div class="activity-body">${entry.input ? `<section><h3>Input</h3><pre>${escapeHtml(entry.input)}</pre></section>` : ""}${entry.output ? `<section><h3>Output</h3><pre>${escapeHtml(entry.output)}</pre></section>` : ""}</div></details>`;
}

function renderNestedDiff(entry) {
  const stats = diffStats(entry.diff);
  return `<details class="nested diff"><summary><span class="nested-kind">FILE</span><strong>${escapeHtml(entry.file)}</strong><span class="plus">+${stats.added}</span><span class="minus">−${stats.removed}</span></summary><div class="diff-table">${diffRows(entry.diff)}</div></details>`;
}

function renderBlock(entry, sequence) {
  if (entry.kind === "message") {
    const label = entry.role === "user" ? "User" : "Agent";
    return `<article class="message ${entry.role}" data-role="${entry.role}" data-start="${entry.start}"><header><span class="avatar">${label[0]}</span><div><strong>${label}</strong><time>${escapeHtml(formatTime(entry.time))} · ${sequence}</time></div></header><div class="message-body">${escapeHtml(entry.text)}</div></article>`;
  }
  if (entry.kind === "diff-group") {
    const totals = entry.items.reduce((sum, item) => {
      const stats = diffStats(item.diff);
      return { added: sum.added + stats.added, removed: sum.removed + stats.removed };
    }, { added: 0, removed: 0 });
    return `<details class="activity group"><summary><span class="activity-kind">DIFF</span><strong>Code changes</strong><span class="activity-count">${entry.items.length} ${entry.items.length === 1 ? "file" : "files"}<span class="change-total"><b class="plus">+${totals.added}</b><b class="minus">−${totals.removed}</b></span></span></summary><div class="activity-list">${entry.items.map(renderNestedDiff).join("")}</div></details>`;
  }
  return `<details class="activity group"><summary><span class="activity-kind">RUN</span><strong>Commands &amp; tools</strong><span class="activity-count">${entry.items.length} ${entry.items.length === 1 ? "item" : "items"}</span></summary><div class="activity-list">${entry.items.map(renderNestedTool).join("")}</div></details>`;
}

function activityGroups(entries) {
  if (!entries.length) return [];
  const tools = entries.filter((entry) => entry.kind === "tool");
  const diffs = entries.filter((entry) => entry.kind === "diff");
  const start = Math.min(...entries.map((entry) => entry.start));
  const end = Math.max(...entries.map((entry) => entry.end));
  const groups = [];
  if (tools.length) groups.push({ kind: "tool-group", items: tools, start, end });
  if (diffs.length) groups.push({ kind: "diff-group", items: diffs, start, end });
  return groups;
}

function browserBlock(entry, sequence) {
  return { start: entry.start, end: entry.end, kind: entry.kind === "message" ? "message" : "activity", html: renderBlock(entry, sequence) };
}

class BlockCollector {
  constructor(limit = Infinity, ringLimit = null) {
    this.limit = limit;
    this.ringLimit = ringLimit;
    this.blocks = [];
    this.pending = [];
    this.calls = new Map();
    this.format = "auto";
    this.totalBlocks = 0;
    this.stopCursor = null;
  }

  addBlocks(entries) {
    if (!entries.length) return true;
    if (this.blocks.length + entries.length > this.limit) {
      this.stopCursor = entries[0].start;
      return false;
    }
    for (const entry of entries) {
      this.totalBlocks += 1;
      this.blocks.push(browserBlock(entry, `@${entry.start}`));
    }
    if (this.ringLimit && this.blocks.length > this.ringLimit) this.blocks.splice(0, this.blocks.length - this.ringLimit);
    return true;
  }

  flushPending() {
    const groups = activityGroups(this.pending);
    if (!this.addBlocks(groups)) return false;
    this.pending = [];
    this.calls.clear();
    return true;
  }

  consume(entries) {
    for (const entry of entries) {
      if (entry.kind === "message") {
        if (!this.flushPending()) return false;
        if (this.blocks.length >= this.limit) { this.stopCursor = entry.start; return false; }
        if (!this.addBlocks([entry])) return false;
        if (this.blocks.length >= this.limit) this.stopCursor = entry.end;
      } else {
        this.pending.push(entry);
        if (entry.id) this.calls.set(entry.id, entry);
      }
    }
    return this.stopCursor == null;
  }
}

async function scanRange(source, options) {
  const handle = await fsp.open(source, "r");
  const collector = new BlockCollector(options.limit ?? Infinity, options.ringLimit ?? null);
  let cursor = options.start;
  let bytesRead = 0;
  try {
    while (cursor < options.end) {
      const line = await readLine(handle, cursor, options.end);
      if (!line) break;
      bytesRead += line.bytesRead;
      if (!line.terminated && options.requireTerminatedLine) break;
      cursor = line.end;
      if (line.tooLong) continue;
      const row = parseJsonLine(line.text);
      if (!row) continue;
      const entries = normalizeRow(row, collector, { start: line.start, end: line.end }, options.format || "auto");
      if (!collector.consume(entries) || collector.stopCursor != null) break;
    }
    if (collector.stopCursor == null) collector.flushPending();
    const nextCursor = collector.stopCursor ?? cursor;
    return { blocks: collector.blocks, nextCursor, bytesRead, totalBlocks: collector.totalBlocks };
  } finally {
    await handle.close();
  }
}

export async function readForwardPage(source, options = {}) {
  const { size } = await fsp.stat(source);
  const floor = Math.max(0, Number(options.boundaryStart || 0));
  const start = Math.min(size, Math.max(floor, Number(options.cursor ?? floor)));
  const limit = Math.min(PAGE_BLOCK_LIMIT, Math.max(1, Number(options.limit || PAGE_BLOCK_LIMIT)));
  const result = await scanRange(source, { start, end: size, limit, format: options.format || "auto", requireTerminatedLine: Boolean(options.requireTerminatedLine) });
  const pageStart = result.blocks[0]?.start ?? start;
  const pageEnd = Math.max(start, result.nextCursor);
  return { direction: "forward", groups: result.blocks, pageStart, pageEnd, hasBefore: pageStart > floor, hasAfter: pageEnd < size, availableBytes: size, bytesRead: result.bytesRead };
}

function selectLastClusters(blocks, limit) {
  const clusters = [];
  for (const block of blocks) {
    const current = clusters.at(-1);
    if (current && current[0].start === block.start) current.push(block);
    else clusters.push([block]);
  }
  const selected = [];
  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    if (selected.length + clusters[index].length > limit) break;
    selected.unshift(...clusters[index]);
  }
  return selected;
}

export async function readBackwardPage(source, options = {}) {
  const stat = await fsp.stat(source);
  const floor = Math.max(0, Number(options.boundaryStart || 0));
  const end = Math.min(stat.size, Math.max(floor, Number(options.cursor ?? stat.size)));
  const limit = Math.min(PAGE_BLOCK_LIMIT, Math.max(1, Number(options.limit || PAGE_BLOCK_LIMIT)));
  let candidate = end;
  let result = { blocks: [], totalBlocks: 0, bytesRead: 0 };
  let bytesRead = 0;
  const alignment = await fsp.open(source, "r");
  try {
    while (candidate > floor) {
      const raw = Math.max(floor, candidate - IO_CHUNK_BYTES);
      candidate = raw === floor ? floor : await findLineStart(alignment, raw);
      result = await scanRange(source, { start: candidate, end, ringLimit: limit + 6, format: options.format || "auto", requireTerminatedLine: Boolean(options.requireTerminatedLine) });
      bytesRead += result.bytesRead;
      if (result.totalBlocks > limit || candidate === floor) break;
    }
  } finally {
    await alignment.close();
  }
  const groups = selectLastClusters(result.blocks, limit);
  const pageStart = groups[0]?.start ?? end;
  return { direction: "backward", groups, pageStart, pageEnd: end, hasBefore: pageStart > floor, hasAfter: end < stat.size, availableBytes: stat.size, bytesRead };
}

export async function readAnchoredPage(source, options = {}) {
  const stat = await fsp.stat(source);
  const floor = Math.max(0, Number(options.boundaryStart || 0));
  const cursor = Math.min(stat.size, Math.max(floor, Number(options.cursor ?? floor)));
  const before = await readBackwardPage(source, { ...options, cursor, limit: 20 });
  const after = await readForwardPage(source, { ...options, cursor, limit: PAGE_BLOCK_LIMIT - before.groups.length });
  const groups = [...before.groups, ...after.groups].slice(0, PAGE_BLOCK_LIMIT);
  const pageStart = groups[0]?.start ?? cursor;
  const pageEnd = groups.at(-1)?.end ?? cursor;
  return {
    direction: "anchor",
    anchor: cursor,
    groups,
    pageStart,
    pageEnd,
    hasBefore: pageStart > floor,
    hasAfter: pageEnd < stat.size,
    availableBytes: stat.size,
    bytesRead: before.bytesRead + after.bytesRead,
  };
}

function jsonForScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

export function mergeCumulativePage(pages, page, direction) {
  const key = `${page.pageStart}:${page.pageEnd}`;
  if (pages.some((item) => `${item.pageStart}:${item.pageEnd}` === key)) return pages;
  if (direction === "backward") return [page, ...pages];
  if (direction === "forward") return [...pages, page];
  return [...pages, page].sort((left, right) => left.pageStart - right.pageStart || left.pageEnd - right.pageEnd);
}

export function pageShell(options, client) {
  const title = options.title || "Agent Transcript";
  const boundary = options.from ? `From newest match for “${options.from}”` : options.since ? `Since ${options.since}` : "From transcript beginning";
  return `<!doctype html>
<html lang="en" data-lavish-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400;500;600;700&family=Silkscreen:wght@400;700&display=swap');
:root{--canvas:#f4f5f3;--panel:#fafbf9;--panel-strong:#fff;--ink:#08090b;--muted:#676b6d;--grid:#daddda;--blue:#2824ff;--blue-soft:#e7e6ff;--green:#008f66;--red:#d13245;--magenta:#d51bb8;--pixel:"Pixelify Sans",Menlo,monospace;--label:"Silkscreen",Menlo,monospace;color-scheme:light}
html[data-lavish-theme="dark"]{--canvas:#070910;--panel:#0c111d;--panel-strong:#111827;--ink:#f4f7ff;--muted:#aeb8c8;--grid:#252d3d;--blue:#827aff;--blue-soft:#191b42;--green:#58e6ac;--red:#ff6c82;--magenta:#ff5cd8;color-scheme:dark}
*,*::before,*::after{box-sizing:border-box;min-width:0}html{background:var(--canvas);scrollbar-color:var(--blue) #151b29}body{margin:0;min-width:320px;background-color:var(--canvas);background-image:linear-gradient(to right,var(--grid) 1px,transparent 1px),linear-gradient(to bottom,var(--grid) 1px,transparent 1px);background-size:25% 100%,100% 128px;color:var(--ink);font:500 18px/1.55 var(--pixel)}
*::-webkit-scrollbar{width:18px;height:18px}*::-webkit-scrollbar-track{background:var(--panel);border-left:1px solid var(--ink)}*::-webkit-scrollbar-thumb{min-height:56px;background:var(--blue);border:3px solid var(--panel)}
button,input,textarea{font:inherit}button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--magenta);outline-offset:2px}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--panel) 96%,transparent);border-bottom:1px solid var(--ink)}.top-inner{min-height:110px;padding:20px 32px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center;border-bottom:1px solid var(--grid)}.eyebrow{color:var(--blue);font:400 12px/1.4 var(--label);letter-spacing:.08em}.top h1{margin:8px 0 0;font:500 clamp(38px,5vw,72px)/.92 var(--pixel);letter-spacing:-.035em}.stats{display:flex;border:1px solid var(--ink)}.stat{padding:9px 12px;border-left:1px solid var(--ink);font:400 9px/1 var(--label);color:var(--blue)}.stat:first-child{border:0}.toolbar{padding:10px 32px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}.toolbar input{width:100%;padding:9px 12px;background:var(--panel);border:1px solid var(--ink);border-radius:0;color:var(--ink);font:500 16px/1.2 var(--pixel)}.passive{display:flex;align-items:center;padding:0 12px;border:1px solid var(--ink);background:var(--panel);color:var(--green);font:400 9px/1 var(--label);white-space:nowrap}.day-nav{position:relative;padding:8px 32px;display:grid;grid-template-columns:auto auto minmax(132px,auto) auto auto minmax(100px,1fr);gap:7px;align-items:center;border-top:1px solid var(--grid)}.nav-button,.date-picker,.prompt-counter{min-height:28px;padding:4px 9px;border:1px solid var(--ink);border-radius:0;background:var(--panel-strong);color:var(--ink);font:400 9px/1 var(--label);cursor:pointer}.timezone{color:var(--muted);font:400 8px/1.2 var(--label);white-space:nowrap}.prompt-nav{display:grid;grid-template-columns:auto minmax(90px,1fr);gap:8px;align-items:center}.prompt-counter{color:var(--blue);white-space:nowrap}.prompt-scrubber{width:100%;accent-color:var(--blue)}.prompt-popover{position:absolute;z-index:9;right:32px;top:calc(100% - 2px);width:min(620px,calc(100vw - 32px));max-height:55vh;overflow:auto;padding:8px;background:var(--panel-strong);border:2px solid var(--ink);box-shadow:5px 5px 0 var(--ink)}.prompt-popover input{position:sticky;top:0;z-index:1;width:100%;padding:8px;border:1px solid var(--ink);background:var(--panel);color:var(--ink)}.prompt-list{display:grid;margin-top:7px}.prompt-item{display:grid;grid-template-columns:58px minmax(0,1fr);gap:8px;padding:7px;border:0;border-bottom:1px solid var(--grid);background:transparent;color:var(--ink);text-align:left;cursor:pointer}.prompt-item:hover{background:var(--blue-soft)}.prompt-item time{color:var(--blue);font:400 7px/1.4 var(--label)}.prompt-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.render-error{margin:0 0 12px;padding:12px 18px;border-block:2px solid var(--red);border-left:8px solid var(--red);background:var(--panel-strong);color:var(--red)}.render-error strong{display:block;font:400 10px/1.4 var(--label)}.render-error span{display:block;margin-top:4px;color:var(--ink)}.message.prompt-highlight{animation:prompt-flash 1.8s steps(2,end);outline:4px solid var(--magenta);outline-offset:-4px}@keyframes prompt-flash{0%,70%{background:var(--blue-soft)}100%{background:var(--panel)}}
main{width:100%;margin:0;padding:22px 0 72px}.notice{margin:0 0 12px;padding:10px 18px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:baseline;background:var(--panel);border:0;border-block:1px solid var(--ink);border-left:8px solid var(--blue)}.notice strong{font:400 10px/1.4 var(--label)}.notice span{color:var(--muted);font-size:15px}.stream{display:flex;flex-direction:column;gap:10px}.page{display:contents}.message{position:relative;background:var(--panel);border:0;border-block:1px solid var(--ink)}.message::before{position:absolute;inset:-1px auto -1px 0;width:7px;background:var(--blue);content:""}.message.assistant::before{background:var(--ink)}.message header{display:flex;gap:10px;align-items:center;padding:9px 18px 9px 24px;border-bottom:1px solid var(--grid)}.avatar{width:26px;height:26px;display:grid;place-items:center;background:var(--blue);color:#fff;font:400 9px/1 var(--label)}.assistant .avatar{background:var(--ink);color:var(--panel)}.message header strong{font:400 10px/1.2 var(--label);letter-spacing:.06em}.message header time{display:block;margin-top:2px;color:var(--muted);font:400 8px/1.2 var(--label)}.message-body{padding:14px 24px 16px;white-space:pre-wrap;overflow-wrap:anywhere}.user .message-body{color:var(--blue)}mark{background:color-mix(in srgb,var(--magenta) 20%,transparent);color:inherit}
.pager{min-height:42px;padding:6px 18px;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:12px;align-items:center;border-block:1px solid var(--ink);background:var(--panel-strong)}.pager-status,.range-status{color:var(--muted);font:400 9px/1.3 var(--label)}.range-status{justify-self:end;text-align:right}.load-button{min-height:28px;padding:5px 12px;border:1px solid var(--ink);border-radius:0;background:var(--blue);color:#fff;cursor:pointer;font:400 10px/1 var(--label);box-shadow:3px 3px 0 var(--ink)}.load-button:hover:not(:disabled){transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--ink)}.load-button:active:not(:disabled){transform:translate(2px,2px);box-shadow:1px 1px 0 var(--ink)}.load-button:disabled{background:var(--grid);color:var(--muted);cursor:not-allowed;box-shadow:none}.pager+.stream{margin-top:12px}.stream+.pager{margin-top:12px}
.stage-stack{display:flex;flex-direction:column;gap:0;border-block:1px solid var(--grid);background:var(--panel)}.activity{margin:0;border:0;border-top:1px solid var(--grid);background:color-mix(in srgb,var(--panel) 82%,var(--canvas))}.activity:first-child{border-top:0}.activity>summary{min-height:18px;padding:0 18px;display:grid;grid-template-columns:9px auto minmax(0,1fr) auto;gap:5px;align-items:center;cursor:pointer;list-style:none}.activity>summary::-webkit-details-marker,.nested>summary::-webkit-details-marker{display:none}.activity>summary::before{content:"+";color:var(--muted);font:400 7px/1 var(--label)}.activity[open]>summary::before{content:"−"}.activity-kind,.nested-kind{color:var(--muted);font:400 6px/1 var(--label);letter-spacing:.04em}.activity summary strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font:400 10px/1 var(--pixel)}.activity-count{color:var(--muted);font:400 6px/1 var(--label)}.change-total{display:inline-flex;gap:7px;margin-left:8px}.plus{color:var(--green)}.minus{color:var(--red)}.activity-list{border-top:1px solid var(--grid)}.nested{border-bottom:1px solid var(--grid)}.nested:last-child{border-bottom:0}.nested>summary{min-height:20px;padding:1px 18px 1px 26px;display:grid;grid-template-columns:12px auto minmax(0,1fr) auto auto;gap:8px;align-items:center;cursor:pointer;list-style:none}.nested>summary::before{content:"+";color:var(--blue);font:400 9px/1 var(--label)}.nested[open]>summary::before{content:"−"}.nested strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 10px/1 var(--pixel)}.activity-body{display:grid;gap:0;border-top:1px solid var(--grid)}.activity-body section+section{border-top:1px solid var(--grid)}.activity-body h3{margin:0;padding:8px 34px;color:var(--muted);font:400 8px var(--label)}pre{max-height:520px;margin:0;padding:10px 34px;overflow:auto;background:#05070d;color:#d9faff;font:12px/1.45 Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.diff-table{overflow:auto;border-top:1px solid var(--grid);background:#080b12;color:#dbe9ef;font:12px/1.55 Menlo,monospace}.diff-row{display:grid;grid-template-columns:56px 56px minmax(max-content,1fr);min-width:max-content}.diff-row>span{padding:0 10px;color:#718093;text-align:right;border-right:1px solid #273142;user-select:none}.diff-row code{display:block;padding:0 12px;white-space:pre}.diff-row.add{background:rgba(0,143,102,.22)}.diff-row.add code{color:#aaffd5}.diff-row.remove{background:rgba(209,50,69,.22)}.diff-row.remove code{color:#ffc1c8}.diff-row.hunk{background:#171735;color:#bbb7ff}.diff-row.hunk code{padding-block:5px}
@media(max-width:720px){body{background-size:50% 100%,100% 96px}.top-inner{min-height:0;padding:16px;grid-template-columns:1fr}.top h1{font-size:42px}.stats{justify-self:start}.toolbar{padding:9px 16px;grid-template-columns:1fr auto}.toolbar input{grid-column:1/-1}.passive{min-height:30px;justify-content:center}.day-nav{padding:8px 16px;grid-template-columns:1fr 1fr}.date-picker,.timezone,.prompt-nav{grid-column:1/-1}.prompt-popover{right:16px}.nav-button{white-space:nowrap}main{padding-top:14px}.pager{grid-template-columns:1fr auto;padding-inline:12px}.range-status{grid-column:1/-1;justify-self:center;text-align:center}.message-body{padding:12px 18px}.activity>summary{grid-template-columns:14px auto minmax(0,1fr);padding-inline:12px}.activity-count{display:none}.nested>summary{grid-template-columns:12px auto minmax(0,1fr);padding-left:26px;padding-right:12px}.nested .plus,.nested .minus{display:none}.diff-row{grid-template-columns:42px 42px minmax(max-content,1fr)}}
@media(prefers-reduced-motion:no-preference){.load-button{transition:transform 80ms linear,box-shadow 80ms linear}}
</style></head><body><header class="top"><div class="top-inner"><div><div class="eyebrow">REVISED · EXPLICIT / CUMULATIVE TRANSCRIPT</div><h1>${escapeHtml(title)}</h1></div><div class="stats" aria-label="Loaded transcript statistics"><span class="stat" id="block-count">0 BLOCKS</span><span class="stat" id="page-count">0 PAGES</span></div></div><div class="toolbar"><input id="search" type="search" placeholder="Search loaded content…" aria-label="Search loaded transcript content"><div class="passive">SCROLL = PASSIVE</div></div><div class="day-nav"><button class="nav-button" id="today" type="button">Today</button><button class="nav-button" id="yesterday" type="button">Yesterday</button><input class="date-picker" id="date-picker" type="date" aria-label="Choose transcript date"><button class="nav-button" id="entire-transcript" type="button">Entire transcript</button><span class="timezone" id="timezone"></span><div class="prompt-nav"><button class="prompt-counter" id="prompt-counter" type="button" aria-expanded="false" aria-controls="prompt-popover">Prompt 0 of 0</button><input class="prompt-scrubber" id="prompt-scrubber" type="range" min="0" max="0" value="0" list="prompt-markers" aria-label="Prompt progress"><datalist id="prompt-markers"></datalist></div><div class="prompt-popover" id="prompt-popover" hidden><input id="prompt-search" type="search" placeholder="Search prompts in selected day…" aria-label="Search prompts in selected day"><div class="prompt-list" id="prompt-list"></div></div></div></header><main><div class="render-error" id="render-error" role="alert" hidden><strong>Transcript could not render</strong><span id="render-error-copy"></span></div><div class="notice"><strong>Temporary local transcript</strong><span>${escapeHtml(boundary)}. Only visible conversation content appears. Buttons add blocks; scrolling never loads, removes, or replaces them.</span></div><div class="pager" id="top-pager"><span class="pager-status" id="earlier-status">Checking earlier blocks…</span><button class="load-button" id="load-earlier" type="button">↑ See more · Load 40 earlier</button><span class="range-status" id="top-range">Loading first page…</span></div><section class="stream" id="stream" aria-live="polite"></section><div class="pager" id="bottom-pager"><span class="pager-status" id="later-status">Checking later blocks…</span><button class="load-button" id="load-later" type="button">↓ See more · Load 40 later</button><span class="range-status" id="bottom-range">Loading first page…</span></div></main>
<script>
addEventListener("message",function(event){if(event.data&&event.data.type==="lavish:setTheme")document.documentElement.dataset.lavishTheme=event.data.theme==="dark"?"dark":"light"});
const client=${jsonForScript(client)};
const mergeCumulativePage=${mergeCumulativePage.toString()};
let pages=[];
let loading=false;
let availableBytes=client.availableBytes;
let promptItems=[];
let selectedDate="";
let selectedPrompt="";
let firstRenderAcknowledged=false;
let scrollFrame=0;
const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";
const stream=document.getElementById("stream");
const search=document.getElementById("search");
const loadEarlier=document.getElementById("load-earlier");
const loadLater=document.getElementById("load-later");
const datePicker=document.getElementById("date-picker");
const promptCounter=document.getElementById("prompt-counter");
const promptScrubber=document.getElementById("prompt-scrubber");
const promptMarkers=document.getElementById("prompt-markers");
const promptPopover=document.getElementById("prompt-popover");
const promptSearch=document.getElementById("prompt-search");
const promptList=document.getElementById("prompt-list");
document.getElementById("timezone").textContent=timeZone;
function countLoaded(){const groups=pages.flatMap(function(page){return page.groups});document.getElementById("block-count").textContent=groups.length+" BLOCKS";document.getElementById("page-count").textContent=pages.length+" PAGE"+(pages.length===1?"":"S")}
function applySearch(){const query=search.value.trim().toLowerCase();for(const item of stream.querySelectorAll(".message,.activity"))item.hidden=Boolean(query&&!item.textContent.toLowerCase().includes(query))}
function updateControls(announcement){const head=pages[0];const tail=pages.at(-1);const groups=pages.reduce(function(sum,page){return sum+page.groups.length},0);loadEarlier.disabled=loading||!head||!head.hasBefore;loadLater.disabled=loading||!tail||(!tail.hasAfter&&tail.pageEnd>=availableBytes);document.getElementById("earlier-status").textContent=!head?"Loading…":head.hasBefore?"Earlier blocks available":"Start boundary reached";document.getElementById("later-status").textContent=!tail?"Loading…":tail.hasAfter||tail.pageEnd<availableBytes?"Later blocks available":"End boundary reached";document.getElementById("top-range").textContent=announcement||"LOADED "+groups+" BLOCKS · "+pages.length+" PAGE"+(pages.length===1?"":"S");document.getElementById("bottom-range").textContent="LOADED "+groups+" BLOCKS · "+pages.length+" PAGE"+(pages.length===1?"":"S")}
function pageMarkup(page){return '<div class="page" data-range="'+page.pageStart+':'+page.pageEnd+'">'+page.groups.map(function(group,index,groups){if(group.kind!=="activity")return group.html;const previous=groups[index-1];const next=groups[index+1];const opens=!previous||previous.kind!=="activity"||previous.start!==group.start;const closes=!next||next.kind!=="activity"||next.start!==group.start;return(opens?'<div class="stage-stack">':'')+group.html+(closes?'</div>':'')}).join("")+'</div>'}
function showRenderError(error){const box=document.getElementById("render-error");document.getElementById("render-error-copy").textContent=String(error&&error.message||error||"Unknown render failure").slice(0,240);box.hidden=false}
function loadedGroupKeys(){return new Set(pages.flatMap(function(page){return page.groups.map(function(group){return group.start+":"+group.end+":"+group.kind})}))}
function uniquePage(page){const keys=loadedGroupKeys();return{...page,groups:page.groups.filter(function(group){return!keys.has(group.start+":"+group.end+":"+group.kind)})}}
function insertPage(page,direction,announcement){const anchor=direction==="backward"?stream.firstElementChild:null;const anchorTop=anchor?anchor.getBoundingClientRect().top:null;const markup=pageMarkup(page);if(direction==="backward")stream.insertAdjacentHTML("afterbegin",markup);else if(direction==="forward")stream.insertAdjacentHTML("beforeend",markup);else{const next=[...stream.querySelectorAll(".page")].find(function(node){return Number(node.dataset.range.split(":")[0])>page.pageStart});if(next)next.insertAdjacentHTML("beforebegin",markup);else stream.insertAdjacentHTML("beforeend",markup)}countLoaded();applySearch();if(anchor){scrollBy(0,anchor.getBoundingClientRect().top-anchorTop)}updateControls(announcement)}
async function acknowledgeFirstRender(page){if(firstRenderAcknowledged)return;const response=await fetch(client.readyUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pageStart:page.pageStart,pageEnd:page.pageEnd,blocks:page.groups.length}),keepalive:true});if(!response.ok)throw new Error("First-render acknowledgement failed with HTTP "+response.status);firstRenderAcknowledged=true}
async function fetchPage(url,direction,announcement){const response=await fetch(url);if(!response.ok)throw new Error((await response.text())||("HTTP "+response.status));const raw=await response.json();const page=uniquePage(raw);const before=pages;if(page.groups.length)pages=mergeCumulativePage(pages,page,direction);if(pages!==before&&page.groups.length)insertPage(page,direction,announcement);return raw}
async function load(direction){if(loading)return;const edge=direction==="backward"?pages[0]:pages.at(-1);if(edge&&direction==="backward"&&!edge.hasBefore)return;if(edge&&direction==="forward"&&!edge.hasAfter&&edge.pageEnd>=availableBytes)return;loading=true;updateControls("LOADING "+direction.toUpperCase()+"…");try{const cursor=edge?(direction==="backward"?edge.pageStart:edge.pageEnd):(client.initialCursor??client.boundaryStart);const url=new URL(client.pageUrl);url.searchParams.set("direction",direction);url.searchParams.set("cursor",String(cursor));const page=await fetchPage(url,direction,"+40 MAX · VIEWPORT PINNED");if(!page.groups.length&&edge){if(direction==="backward")edge.hasBefore=false;else edge.hasAfter=false}await acknowledgeFirstRender(page)}catch(error){showRenderError(error);updateControls("PAGE ERROR · "+error.message)}finally{loading=false;updateControls()}}
function localDate(value){const date=new Date(value);return[date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-")}
function setViewState(){const state=new URLSearchParams(location.hash.slice(1));if(selectedDate)state.set("date",selectedDate);else state.delete("date");state.set("tz",timeZone);if(selectedPrompt)state.set("prompt",selectedPrompt);else state.delete("prompt");history.replaceState(null,"","#"+state.toString())}
function updatePromptControl(ordinal){const total=promptItems.length;const current=Math.min(total,Math.max(0,Number(ordinal||0)));promptCounter.textContent="Prompt "+current+" of "+total;promptScrubber.min=total?"1":"0";promptScrubber.max=String(total);promptScrubber.value=String(current);promptScrubber.disabled=!total;promptMarkers.innerHTML=promptItems.map(function(item){return'<option value="'+item.ordinal+'"></option>'}).join("")}
function renderPromptList(){const query=promptSearch.value.trim().toLowerCase();promptList.innerHTML=promptItems.filter(function(item){return!query||item.preview.toLowerCase().includes(query)}).map(function(item){return'<button class="prompt-item" type="button" data-locator="'+item.locator+'"><time>'+new Date(item.timestamp).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+'</time><span>'+item.preview.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")+'</span></button>'}).join("")||'<div class="prompt-item">No prompts match.</div>'}
async function fetchPromptIndex(date,offset){const url=new URL(client.indexUrl);url.searchParams.set("date",date);url.searchParams.set("timeZone",timeZone);url.searchParams.set("offset",String(offset||0));const response=await fetch(url);if(!response.ok)throw new Error(await response.text());return response.json()}
async function loadPromptIndex(date){let offset=0;let items=[];let first=null;do{const page=await fetchPromptIndex(date,offset);if(!first)first=page;items.push(...page.items);offset=page.nextOffset}while(offset!==null);promptItems=items;updatePromptControl(0);renderPromptList();return first}
async function appendPromptIndex(){if(!selectedDate||selectedDate!==localDate(new Date()))return;let offset=promptItems.length;do{const page=await fetchPromptIndex(selectedDate,offset);promptItems.push(...page.items);offset=page.nextOffset}while(offset!==null);updatePromptControl(selectedPrompt?(promptItems.find(function(item){return item.locator===selectedPrompt})?.ordinal||0):0);renderPromptList()}
async function loadCursor(cursor){const url=new URL(client.pageUrl);url.searchParams.set("direction","forward");url.searchParams.set("cursor",String(cursor));const page=await fetchPage(url,"anchor","DATE JUMP · LOADED CONTENT PRESERVED");await acknowledgeFirstRender(page);return page}
async function selectDate(date,promptLocator=""){if(!date)return;loading=true;updateControls("LOCATING "+date+"…");try{selectedDate=date;datePicker.value=date;const index=await loadPromptIndex(date);await loadCursor(index.startOffset);selectedPrompt=promptLocator;setViewState();if(promptLocator)await selectPrompt(promptLocator);else{const node=[...stream.querySelectorAll(".message,.activity")].find(function(item){return Number(item.dataset.start||-1)>=index.startOffset});node?.scrollIntoView({block:"start"})}}catch(error){showRenderError(error)}finally{loading=false;updateControls()}}
async function selectPrompt(locator){const item=promptItems.find(function(candidate){return candidate.locator===locator});if(!item)return;let target=stream.querySelector('.message.user[data-start="'+item.start+'"]');if(!target){const url=new URL(client.anchorUrl);url.searchParams.set("cursor",String(item.start));await fetchPage(url,"anchor","PROMPT NEIGHBORHOOD · 40 BLOCKS MAX");target=stream.querySelector('.message.user[data-start="'+item.start+'"]')}if(!target)throw new Error("The selected prompt could not be found in its anchored page.");selectedPrompt=item.locator;setViewState();updatePromptControl(item.ordinal);target.classList.remove("prompt-highlight");void target.offsetWidth;target.classList.add("prompt-highlight");target.scrollIntoView({block:"center",behavior:"smooth"});setTimeout(function(){target.classList.remove("prompt-highlight")},2000)}
function todayOffset(days){const date=new Date();date.setDate(date.getDate()+days);return localDate(date)}
function updateCurrentPromptFromScroll(){scrollFrame=0;const headerBottom=document.querySelector(".top").getBoundingClientRect().bottom;let best=null;for(const node of stream.querySelectorAll(".message.user[data-start]")){if(node.getBoundingClientRect().top<=headerBottom+8)best=node;else break}if(!best)return;const item=promptItems.find(function(candidate){return String(candidate.start)===best.dataset.start});if(item){selectedPrompt=item.locator;updatePromptControl(item.ordinal);setViewState()}}
search.addEventListener("input",applySearch);
loadEarlier.addEventListener("click",function(){load("backward")});
loadLater.addEventListener("click",function(){load("forward")});
document.getElementById("today").addEventListener("click",function(){selectDate(todayOffset(0))});
document.getElementById("yesterday").addEventListener("click",function(){selectDate(todayOffset(-1))});
datePicker.addEventListener("change",function(){selectDate(datePicker.value)});
document.getElementById("entire-transcript").addEventListener("click",async function(){selectedDate="";selectedPrompt="";datePicker.value="";promptItems=[];updatePromptControl(0);setViewState();await loadCursor(0)});
promptCounter.addEventListener("click",function(){promptPopover.hidden=!promptPopover.hidden;promptCounter.setAttribute("aria-expanded",String(!promptPopover.hidden));if(!promptPopover.hidden)promptSearch.focus()});
promptSearch.addEventListener("input",renderPromptList);
promptList.addEventListener("click",function(event){const button=event.target.closest("[data-locator]");if(button){promptPopover.hidden=true;promptCounter.setAttribute("aria-expanded","false");selectPrompt(button.dataset.locator)}});
promptScrubber.addEventListener("input",function(){const item=promptItems[Number(promptScrubber.value)-1];if(item)selectPrompt(item.locator)});
addEventListener("scroll",function(){if(!scrollFrame)scrollFrame=requestAnimationFrame(updateCurrentPromptFromScroll)},{passive:true});
const events=new EventSource(client.eventsUrl);events.onmessage=function(event){const data=JSON.parse(event.data);if(data.type!=="availability")return;availableBytes=data.availableBytes;const tail=pages.at(-1);if(tail&&availableBytes>tail.pageEnd)tail.hasAfter=true;appendPromptIndex().catch(showRenderError);updateControls()};events.onerror=function(){document.getElementById("bottom-range").textContent="RECONNECTING · "+pages.reduce(function(sum,page){return sum+page.groups.length},0)+" BLOCKS LOADED"};
addEventListener("pagehide",function(){navigator.sendBeacon(client.closeUrl,"closed")},{once:true});
window.__lavishTranscriptState=function(){return{pages:pages.map(function(page){return{pageStart:page.pageStart,pageEnd:page.pageEnd,groups:page.groups.length}}),blocks:pages.reduce(function(sum,page){return sum+page.groups.length},0),availableBytes:availableBytes,documentRecords:stream.querySelectorAll(".message,.activity").length,selectedDate:selectedDate,selectedPrompt:selectedPrompt,prompts:promptItems.length}};
const initialState=new URLSearchParams(location.hash.slice(1));const initialDate=initialState.get("date");const initialPrompt=initialState.get("prompt")||"";if(initialDate)selectDate(initialDate,initialPrompt);else load("forward");
</script></body></html>`;
}

async function locateBoundary(source, options) {
  if (options.from) return locateQuotedBoundary(source, options.from);
  if (options.since) return locateTimestampBoundary(source, options.since);
  return { offset: 0, bytesRead: 0 };
}

function removeGeneratedOutput(output) {
  try { fs.unlinkSync(output); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { fs.rmdirSync(path.dirname(output)); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
}

function defaultEndSession(output) {
  const result = spawnSync("lavish-axi", ["end", path.resolve(output)], { stdio: "ignore", timeout: 3000 });
  if (result.error && result.error.code !== "ENOENT") console.error(result.error.message);
}

function processFailure(label, result) {
  if (result.error) return `${label} failed: ${result.error.message}`;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return `${label} exited with status ${result.status}${detail ? `: ${detail}` : ""}`;
  }
  return "";
}

async function readJsonRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runAcknowledgedProcess(command, args, options = {}) {
  const start = options.spawn || spawn;
  const child = start(command, args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    child.once("error", (error) => finish({ status: null, error }));
    child.once("close", (status, signal) => finish({ status, signal }));
    const timeoutMs = Number(options.timeoutMs || AGENT_CHROME_NAVIGATION_TIMEOUT_MS);
    timer = setTimeout(() => {
      child.kill?.("SIGTERM");
      finish({
        status: null,
        error: Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" }),
      });
    }, timeoutMs);
  });
}

export async function launchLavishReview(output, options = {}) {
  const run = options.spawnSync || spawnSync;
  const lavishResult = run(options.lavishExecutable || "lavish-axi", [path.resolve(output)], {
    encoding: "utf8",
    env: { ...process.env, ...options.env, LAVISH_AXI_NO_OPEN: "1" },
    timeout: Number(options.timeoutMs || 15_000),
  });
  const lavishFailure = processFailure("lavish-axi", lavishResult);
  if (lavishFailure) throw new Error(lavishFailure);

  const transcript = `${lavishResult.stdout || ""}\n${lavishResult.stderr || ""}`;
  const urls = [...transcript.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/session\/[A-Za-z0-9]+/g)];
  const url = urls.at(-1)?.[0];
  if (!url) throw new Error("lavish-axi did not return a local review session URL.");

  const home = options.homeDirectory || os.homedir();
  const launcher = options.launcherPath || path.join(home, AGENT_CHROME_LAUNCHER_RELATIVE_PATH);
  const navigator = options.navigatorPath || path.join(home, AGENT_CHROME_AXI_RELATIVE_PATH);
  const commandOptions = {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    timeout: Number(options.timeoutMs || 15_000),
  };
  const launcherResult = run(launcher, ["--focus"], commandOptions);
  const launcherFailure = processFailure("Agent Chrome launcher", launcherResult);
  if (launcherFailure) throw new Error(launcherFailure);
  const navigationResult = await runAcknowledgedProcess(navigator, ["newpage", url], {
    spawn: options.spawn,
    env: commandOptions.env,
    timeoutMs: Number(options.navigationTimeoutMs || AGENT_CHROME_NAVIGATION_TIMEOUT_MS),
  });
  const navigationFailure = processFailure("Agent Chrome newpage", navigationResult);
  if (navigationFailure) throw new Error(navigationFailure);
  return { url, launcher, navigator };
}

export async function createReview(options, hooks = {}) {
  const source = path.resolve(options.source);
  const output = path.resolve(options.out);
  assertTemporaryOutput(output);
  const sourceStat = await fsp.stat(source);
  if (!sourceStat.isFile()) throw new Error(`Transcript source is not a file: ${source}`);
  const boundary = await locateBoundary(source, options);
  const token = randomUUID();
  const clients = new Set();
  const promptIndexCache = new Map();
  let watcher = null;
  let startupTimer = null;
  let reconnectTimer = null;
  let watchTimer = null;
  let hadBrowser = false;
  let firstRenderReceipt = null;
  let resolveFirstRender;
  const firstRender = new Promise((resolve) => { resolveFirstRender = resolve; });
  let finished = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });

  const cancelReconnect = () => { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; };
  const send = (response, payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
  const broadcastAvailability = async () => {
    const { size } = await fsp.stat(source);
    for (const client of clients) send(client, { type: "availability", availableBytes: size });
  };
  const acknowledgeFirstRender = (receipt) => {
    if (firstRenderReceipt) return;
    firstRenderReceipt = receipt;
    hadBrowser = true;
    clearTimeout(startupTimer);
    resolveFirstRender(receipt);
  };
  const waitForFirstRender = (timeoutMs = FIRST_RENDER_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Lavish artifact did not acknowledge its first rendered page within ${timeoutMs} ms.`)),
      Number(timeoutMs),
    );
    firstRender.then((receipt) => { clearTimeout(timer); resolve(receipt); });
  });

  let server;
  const stop = (reason) => {
    if (finished) return;
    finished = true;
    clearTimeout(startupTimer);
    clearTimeout(reconnectTimer);
    clearTimeout(watchTimer);
    watcher?.close();
    for (const client of clients) client.end();
    server.close(() => {
      (hooks.endSession || defaultEndSession)(output);
      removeGeneratedOutput(output);
      hooks.onStop?.(reason);
      console.log(JSON.stringify({ stopped: reason, removed: output }));
      finish(reason);
    });
  };

  const scheduleReconnectClose = () => {
    if (!hadBrowser || clients.size || finished) return;
    cancelReconnect();
    reconnectTimer = setTimeout(() => stop("browser-disconnected"), Number(options.reconnectTimeoutMs ?? 300_000));
  };

  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.searchParams.get("token") !== token) { response.writeHead(403).end("Forbidden"); return; }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
        }).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        cancelReconnect();
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
        clients.add(response);
        const { size } = await fsp.stat(source);
        send(response, { type: "availability", availableBytes: size });
        request.on("close", () => { clients.delete(response); scheduleReconnectClose(); });
        return;
      }
      if (request.method === "GET" && url.pathname === "/page") {
        const direction = url.searchParams.get("direction") === "backward" ? "backward" : "forward";
        const cursor = Number(url.searchParams.get("cursor") ?? boundary.offset);
        const page = direction === "backward"
          ? await readBackwardPage(source, { cursor, boundaryStart: 0, format: options.format || "auto", requireTerminatedLine: Boolean(options.watch) })
          : await readForwardPage(source, { cursor, boundaryStart: 0, format: options.format || "auto", requireTerminatedLine: Boolean(options.watch) });
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }).end(JSON.stringify(page));
        return;
      }
      if (request.method === "GET" && url.pathname === "/anchor") {
        const cursor = Number(url.searchParams.get("cursor") ?? boundary.offset);
        const page = await readAnchoredPage(source, { cursor, boundaryStart: 0, format: options.format || "auto", requireTerminatedLine: Boolean(options.watch) });
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }).end(JSON.stringify(page));
        return;
      }
      if (request.method === "GET" && url.pathname === "/prompts") {
        const date = String(url.searchParams.get("date") || "");
        const timeZone = String(url.searchParams.get("timeZone") || "");
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const limit = Math.min(PROMPT_INDEX_PAGE_LIMIT, Math.max(1, Number(url.searchParams.get("limit") || PROMPT_INDEX_PAGE_LIMIT)));
        const index = await buildDailyPromptIndex(source, {
          date,
          timeZone,
          format: options.format || "auto",
          cache: promptIndexCache,
          requireTerminatedLine: Boolean(options.watch),
        });
        const items = index.items.slice(offset, offset + limit);
        const nextOffset = offset + items.length < index.items.length ? offset + items.length : null;
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }).end(JSON.stringify({
          date: index.date,
          timeZone: index.timeZone,
          start: index.start,
          end: index.end,
          startOffset: index.startOffset,
          endOffset: index.endOffset,
          total: index.items.length,
          offset,
          nextOffset,
          items,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/ready") {
        const receipt = await readJsonRequest(request);
        acknowledgeFirstRender({
          pageStart: Math.max(0, Number(receipt.pageStart || 0)),
          pageEnd: Math.max(0, Number(receipt.pageEnd || 0)),
          blocks: Math.max(0, Number(receipt.blocks || 0)),
        });
        response.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/close") {
        response.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
        scheduleReconnectClose();
        return;
      }
      response.writeHead(404).end("Not found");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(error.stack || error.message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(options.streamPort || 0), "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = {
    anchorUrl: `${baseUrl}/anchor?token=${encodeURIComponent(token)}`,
    pageUrl: `${baseUrl}/page?token=${encodeURIComponent(token)}`,
    indexUrl: `${baseUrl}/prompts?token=${encodeURIComponent(token)}`,
    eventsUrl: `${baseUrl}/events?token=${encodeURIComponent(token)}`,
    readyUrl: `${baseUrl}/ready?token=${encodeURIComponent(token)}`,
    closeUrl: `${baseUrl}/close?token=${encodeURIComponent(token)}`,
    initialCursor: boundary.offset,
    boundaryStart: 0,
    availableBytes: sourceStat.size,
  };
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, pageShell(options, client), "utf8");

  if (options.watch) {
    watcher = fs.watch(source, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { broadcastAvailability().catch((error) => console.error(error.stack || error)); }, 100);
    });
  }
  startupTimer = setTimeout(() => { if (!hadBrowser) stop("browser-never-connected"); }, Number(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS));
  return { source, output, client, boundary, done, stop, server, firstRender, waitForFirstRender };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source || !args.out) {
    console.error("Usage: render-transcript.mjs --source <jsonl> --out <html> [--from <text>] [--since <date>] [--watch] [--format auto|codex|pi|cursor]");
    process.exitCode = 2;
    return;
  }
  const review = await createReview({ source: args.source, out: args.out, from: args.from, since: args.since, watch: Boolean(args.watch), format: args.format || "auto", title: args.title, streamPort: args["stream-port"] });
  let launch;
  try {
    launch = await launchLavishReview(review.output);
    await review.waitForFirstRender(FIRST_RENDER_TIMEOUT_MS);
  } catch (error) {
    review.stop(/first rendered page/.test(error.message) ? "first-render-timeout" : "launch-failed");
    await review.done;
    throw error;
  }
  console.log(JSON.stringify({ output: review.output, source: review.source, boundaryByte: review.boundary.offset, boundaryBytesRead: review.boundary.bytesRead, page: review.client.pageUrl, events: review.client.eventsUrl, lavishUrl: launch.url, launcher: launch.launcher, navigator: launch.navigator, initialTranscriptRecords: 0 }));
  const stop = () => review.stop("signal");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await review.done;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
