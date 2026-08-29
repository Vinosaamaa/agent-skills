import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  AGENT_CHROME_AXI_RELATIVE_PATH,
  AGENT_CHROME_LAUNCHER_RELATIVE_PATH,
  AGENT_CHROME_NAVIGATION_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  FIRST_RENDER_TIMEOUT_MS,
  PAGE_BLOCK_LIMIT,
  buildDailyPromptIndex,
  createReview,
  launchLavishReview,
  locateLocalDayBounds,
  locateQuotedBoundary,
  locateTimestampBoundary,
  mergeCumulativePage,
  pageShell,
  readAnchoredPage,
  readBackwardPage,
  readForwardPage,
  zonedDayBounds,
} from "../scripts/render-transcript.mjs";

test("never-connected reviews default to a five-minute startup grace", () => {
  assert.equal(DEFAULT_STARTUP_TIMEOUT_MS, 300_000);
});

test("Lavish launch confirms the supported Agent Chrome newpage handoff", async () => {
  const syncCalls = [];
  const spawnCalls = [];
  const sessionUrl = "http://127.0.0.1:4387/session/abc123";
  const run = (command, args, options) => {
    syncCalls.push({ command, args, options });
    if (command === "lavish-axi") return { status: 0, stdout: `review ready ${sessionUrl}\n`, stderr: "" };
    return { status: 0, stdout: "Agent Chrome focused\n", stderr: "" };
  };
  const start = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", "new page opened\n");
      child.emit("close", 0, null);
    });
    return child;
  };

  const receipt = await launchLavishReview("/private/tmp/generated-review/index.html", {
    spawnSync: run,
    spawn: start,
    homeDirectory: "/safe/home",
    env: { GENERATED_FIXTURE: "1" },
  });

  assert.equal(syncCalls.length, 2);
  assert.equal(syncCalls[0].command, "lavish-axi");
  assert.deepEqual(syncCalls[0].args, ["/private/tmp/generated-review/index.html"]);
  assert.equal(syncCalls[0].options.env.LAVISH_AXI_NO_OPEN, "1");
  assert.equal(syncCalls[0].options.env.GENERATED_FIXTURE, "1");
  assert.equal(syncCalls[1].command, path.join("/safe/home", AGENT_CHROME_LAUNCHER_RELATIVE_PATH));
  assert.deepEqual(syncCalls[1].args, ["--focus"]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, path.join("/safe/home", AGENT_CHROME_AXI_RELATIVE_PATH));
  assert.deepEqual(spawnCalls[0].args, ["newpage", sessionUrl]);
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(AGENT_CHROME_NAVIGATION_TIMEOUT_MS, 30_000);
  assert.deepEqual(receipt, { url: sessionUrl, launcher: syncCalls[1].command, navigator: spawnCalls[0].command });
});

test("Lavish launch does not report ready when newpage exits unsuccessfully", async () => {
  const sessionUrl = "http://127.0.0.1:4387/session/failed123";
  const run = (command) => {
    if (command === "lavish-axi") return { status: 0, stdout: sessionUrl, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const start = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stderr.emit("data", "navigation failed");
      child.emit("close", 7, null);
    });
    return child;
  };
  await assert.rejects(
    launchLavishReview("/private/tmp/generated-review/index.html", { spawnSync: run, spawn: start, homeDirectory: "/safe/home" }),
    /Agent Chrome newpage exited with status 7: navigation failed/,
  );
});

test("the acknowledged newpage handoff leaves the transcript page server responsive", async (t) => {
  const { directory, source } = await fixture(t);
  await fsp.writeFile(source, codexMessage(0, "handoff-remains-responsive", "user") + "\n");
  const output = path.join(directory, "responsive-handoff", "index.html");
  const review = await createReview({ source, out: output, startupTimeoutMs: 1000 }, { endSession() {} });
  const run = (command) => command === "lavish-axi"
    ? { status: 0, stdout: "http://127.0.0.1:4387/session/responsive123", stderr: "" }
    : { status: 0, stdout: "", stderr: "" };
  const start = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(async () => {
      const page = await (await fetch(`${review.client.pageUrl}&direction=forward&cursor=0`)).json();
      await fetch(review.client.readyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageStart: page.pageStart, pageEnd: page.pageEnd, blocks: page.groups.length }),
      });
      child.emit("close", 0, null);
    });
    return child;
  };

  const [launch, receipt] = await Promise.all([
    launchLavishReview(output, { spawnSync: run, spawn: start, homeDirectory: "/safe/home" }),
    review.waitForFirstRender(500),
  ]);
  assert.equal(launch.url, "http://127.0.0.1:4387/session/responsive123");
  assert.equal(receipt.blocks, 1);
  review.stop("test-complete");
  assert.equal(await review.done, "test-complete");
});

function codexMessage(index, text = `message-${index}`, role = index % 2 ? "assistant" : "user") {
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "output_text", text }] },
  });
}

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "lavish-transcript-test-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return { directory, source: path.join(directory, "source.jsonl") };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function connectEvents(url) {
  let response;
  let buffer = "";
  const queued = [];
  const waiters = [];
  const request = http.get(url, (incoming) => {
    response = incoming;
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n\n")) {
        const boundary = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(event);
        else queued.push(event);
      }
    });
  });
  request.on("error", (error) => {
    while (waiters.length) waiters.shift().reject(error);
  });
  return {
    next() {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close() {
      response?.destroy();
      request.destroy();
    },
  };
}

test("UTF-8, CRLF, and an appended partial final line preserve byte cursors", async (t) => {
  const { source } = await fixture(t);
  const first = codexMessage(0, "zero 🧭") + "\r\n";
  const second = codexMessage(1, "one 漢字");
  await fsp.writeFile(source, first + second);

  const livePage = await readForwardPage(source, { requireTerminatedLine: true });
  assert.equal(livePage.groups.length, 1);
  assert.equal(livePage.pageEnd, Buffer.byteLength(first));
  assert.match(livePage.groups[0].html, /zero 🧭/);

  await fsp.appendFile(source, "\n");
  const appended = await readForwardPage(source, { cursor: livePage.pageEnd, requireTerminatedLine: true });
  assert.equal(appended.groups.length, 1);
  assert.match(appended.groups[0].html, /one 漢字/);
  assert.equal(appended.pageEnd, (await fsp.stat(source)).size);
});

test("chronological timestamp boundaries use a precise binary byte result", async (t) => {
  const { source } = await fixture(t);
  const lines = Array.from({ length: 512 }, (_, index) => codexMessage(index, `timestamp-${index}`));
  await fsp.writeFile(source, lines.join("\n") + "\n");
  const target = JSON.parse(lines[377]).timestamp;
  const expected = Buffer.byteLength(lines.slice(0, 377).join("\n") + "\n");

  const located = await locateTimestampBoundary(source, target);
  assert.equal(located.offset, expected);
  assert.ok(located.bytesRead < (await fsp.stat(source)).size / 5);
  const page = await readForwardPage(source, { cursor: located.offset });
  assert.match(page.groups[0].html, /timestamp-377/);
});

test("timezone day bounds preserve local midnight across daylight saving changes", () => {
  assert.deepEqual(zonedDayBounds("2026-03-08", "America/Los_Angeles"), {
    start: "2026-03-08T08:00:00.000Z",
    end: "2026-03-09T07:00:00.000Z",
  });
  assert.deepEqual(zonedDayBounds("2026-11-01", "America/Los_Angeles"), {
    start: "2026-11-01T07:00:00.000Z",
    end: "2026-11-02T08:00:00.000Z",
  });
});

test("local day bounds use two bounded binary seeks on a sparse transcript", async (t) => {
  const { source } = await fixture(t);
  const rows = Array.from({ length: 2400 }, (_, index) => JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 2, 7, 0, index, 0)).toISOString(),
    type: "response_item",
    payload: { type: "message", role: index % 5 === 0 ? "user" : "assistant", content: [{ type: "output_text", text: `sparse-day-${index}` }] },
  }));
  await fsp.writeFile(source, rows.join("\n") + "\n");
  const bounds = await locateLocalDayBounds(source, "2026-03-08", "America/Los_Angeles");
  assert.ok(bounds.startOffset > 0);
  assert.ok(bounds.endOffset > bounds.startOffset);
  assert.ok(bounds.bytesRead < (await fsp.stat(source)).size / 5);
});

test("daily prompt index keeps exact envelopes, excludes injected context, and increments today", async (t) => {
  const { source } = await fixture(t);
  const rows = [
    JSON.stringify({ timestamp: "2026-08-28T16:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first genuine prompt" }] } }),
    JSON.stringify({ timestamp: "2026-08-28T16:01:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>private catalog</recommended_plugins>" }] } }),
    JSON.stringify({ timestamp: "2026-08-28T16:02:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "assistant reply" }] } }),
    JSON.stringify({ timestamp: "2026-08-28T16:03:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second genuine prompt with a preview that is intentionally long ".repeat(8) }] } }),
  ];
  await fsp.writeFile(source, rows.join("\n") + "\n");
  const cache = new Map();
  const first = await buildDailyPromptIndex(source, {
    date: "2026-08-28",
    timeZone: "America/Los_Angeles",
    format: "codex",
    cache,
    now: "2026-08-28T18:00:00Z",
  });
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.items.map((item) => item.ordinal), [1, 2]);
  assert.ok(first.items.every((item) => item.preview.length <= 160));
  assert.ok(first.items.every((item) => item.locator === `byte:${item.start}:${item.end}`));
  assert.doesNotMatch(JSON.stringify(first), /private catalog|recommended_plugins/);

  await fsp.appendFile(source, JSON.stringify({ timestamp: "2026-08-28T16:04:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "appended genuine prompt" }] } }) + "\n");
  const second = await buildDailyPromptIndex(source, {
    date: "2026-08-28",
    timeZone: "America/Los_Angeles",
    format: "codex",
    cache,
    now: "2026-08-28T18:05:00Z",
  });
  assert.equal(second.items.length, 3);
  assert.equal(second.items[2].preview, "appended genuine prompt");
  assert.equal(second.scanStart, first.scannedThrough);
});

test("hundreds of prompts use metadata indexing while rendered and anchored pages stay bounded", async (t) => {
  const { source } = await fixture(t);
  const rows = Array.from({ length: 720 }, (_, index) => JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 7, 28, 8, 0, index)).toISOString(),
    type: "response_item",
    payload: { type: "message", role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "output_text", text: `high-volume-${index}` }] },
  }));
  await fsp.writeFile(source, rows.join("\n") + "\n");
  const index = await buildDailyPromptIndex(source, { date: "2026-08-28", timeZone: "America/Los_Angeles", format: "codex" });
  assert.equal(index.items.length, 360);
  const firstPage = await readForwardPage(source, { cursor: index.startOffset });
  assert.equal(firstPage.groups.length, PAGE_BLOCK_LIMIT);
  const target = index.items[287];
  const anchored = await readAnchoredPage(source, { cursor: target.start, format: "codex" });
  assert.ok(anchored.groups.length <= PAGE_BLOCK_LIMIT);
  assert.ok(anchored.groups.some((group) => group.start === target.start));
  assert.ok(anchored.pageStart > firstPage.pageStart);
});

test("quoted boundaries scan backward in fixed chunks and choose the newest exact match", async (t) => {
  const { source } = await fixture(t);
  const marker = "newest exact quoted boundary";
  const lines = Array.from({ length: 1200 }, (_, index) => codexMessage(index, index === 91 || index === 1103 ? marker : `filler-${index}`, index === 91 || index === 1103 ? "user" : "assistant"));
  await fsp.writeFile(source, lines.join("\n") + "\n");
  const expected = Buffer.byteLength(lines.slice(0, 1103).join("\n") + "\n");

  const located = await locateQuotedBoundary(source, marker);
  assert.equal(located.offset, expected);
  assert.ok(located.bytesRead <= 2 * 64 * 1024);
});

test("quoted boundaries ignore mirrored events, tools, assistants, and internal user envelopes", async (t) => {
  const { source } = await fixture(t);
  const marker = "real visible user bookmark";
  const rows = [
    codexMessage(0, marker, "user"),
    JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: marker } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: { type: "function_call", call_id: "call-quote", name: "functions.exec", arguments: JSON.stringify({ cmd: `printf ${marker}` }) } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:04Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<codex_internal_context source='goal'>${marker}</codex_internal_context>` }] } }),
  ];
  await fsp.writeFile(source, rows.join("\n") + "\n");

  const located = await locateQuotedBoundary(source, marker);
  assert.equal(located.offset, 0);
  const page = await readForwardPage(source, { cursor: located.offset });
  assert.match(page.groups[0].html, /real visible user bookmark/);
  assert.match(page.groups[0].html, /data-role="user"/);
});

test("forward and backward requests return no more than forty formatted blocks", async (t) => {
  const { source } = await fixture(t);
  const lines = Array.from({ length: 125 }, (_, index) => codexMessage(index));
  await fsp.writeFile(source, lines.join("\n") + "\n");

  const first = await readForwardPage(source);
  const second = await readForwardPage(source, { cursor: first.pageEnd });
  const previous = await readBackwardPage(source, { cursor: second.pageStart });
  assert.equal(first.groups.length, PAGE_BLOCK_LIMIT);
  assert.equal(second.groups.length, PAGE_BLOCK_LIMIT);
  assert.equal(previous.groups.length, PAGE_BLOCK_LIMIT);
  assert.equal(previous.pageStart, first.pageStart);
  assert.equal(previous.pageEnd, second.pageStart);
  assert.ok(first.bytesRead < (await fsp.stat(source)).size / 2);
});

test("a bookmark starts the first page without becoming the earlier-page boundary", async (t) => {
  const { directory, source } = await fixture(t);
  const marker = "bookmark-starts-here";
  const lines = Array.from({ length: 110 }, (_, index) => codexMessage(index, index === 55 ? marker : `bookmark-page-${index}`, index === 55 ? "user" : "assistant"));
  await fsp.writeFile(source, lines.join("\n") + "\n");
  const expectedCursor = Buffer.byteLength(lines.slice(0, 55).join("\n") + "\n");
  const output = path.join(directory, "bookmark-review", "index.html");
  const review = await createReview(
    { source, out: output, from: marker, startupTimeoutMs: 1000 },
    { endSession() {} },
  );

  assert.equal(review.boundary.offset, expectedCursor);
  assert.equal(review.client.initialCursor, expectedCursor);
  assert.equal(review.client.boundaryStart, 0);

  const firstUrl = new URL(review.client.pageUrl);
  firstUrl.searchParams.set("direction", "forward");
  firstUrl.searchParams.set("cursor", String(review.client.initialCursor));
  const first = await (await fetch(firstUrl)).json();
  assert.equal(first.pageStart, expectedCursor);
  assert.equal(first.hasBefore, true);

  const earlierUrl = new URL(review.client.pageUrl);
  earlierUrl.searchParams.set("direction", "backward");
  earlierUrl.searchParams.set("cursor", String(first.pageStart));
  const earlier = await (await fetch(earlierUrl)).json();
  assert.ok(earlier.groups.length > 0);
  assert.equal(earlier.pageEnd, first.pageStart);
  assert.ok(earlier.pageStart < first.pageStart);

  review.stop("test-complete");
  assert.equal(await review.done, "test-complete");
});

test("explicit cumulative paging retains every unique page in source order", () => {
  const page = (pageStart, pageEnd) => ({ pageStart, pageEnd, groups: [{ start: pageStart, end: pageEnd }] });
  let pages = [page(80, 120)];
  pages = mergeCumulativePage(pages, page(120, 160), "forward");
  pages = mergeCumulativePage(pages, page(160, 200), "forward");
  pages = mergeCumulativePage(pages, page(40, 80), "backward");
  pages = mergeCumulativePage(pages, page(0, 40), "backward");

  assert.deepEqual(pages.map(({ pageStart, pageEnd }) => [pageStart, pageEnd]), [
    [0, 40],
    [40, 80],
    [80, 120],
    [120, 160],
    [160, 200],
  ]);
  assert.strictEqual(mergeCumulativePage(pages, page(80, 120), "forward"), pages);

  const anchored = page(220, 260);
  const withAnchor = mergeCumulativePage(pages, anchored, "anchor");
  assert.deepEqual(withAnchor.map(({ pageStart, pageEnd }) => [pageStart, pageEnd]), [
    [0, 40],
    [40, 80],
    [80, 120],
    [120, 160],
    [160, 200],
    [220, 260],
  ]);
  assert.ok(pages.every((original) => withAnchor.includes(original)), "anchored navigation preserves every previously loaded page");
});

test("the generated review exposes only explicit cumulative paging controls", () => {
  const shell = pageShell({}, {
    anchorUrl: "http://127.0.0.1/anchor",
    availableBytes: 200,
    boundaryStart: 0,
    closeUrl: "http://127.0.0.1/close",
    indexUrl: "http://127.0.0.1/prompts",
    eventsUrl: "http://127.0.0.1/events",
    pageUrl: "http://127.0.0.1/page",
    readyUrl: "http://127.0.0.1/ready",
  });

  assert.match(shell, /id="load-earlier"[^>]*>[^<]*Load 40 earlier/);
  assert.match(shell, /id="load-later"[^>]*>[^<]*Load 40 later/);
  assert.doesNotMatch(shell, /IntersectionObserver|maxPages|pages\.shift\(|pages\.pop\(/);
  assert.doesNotMatch(shell, /scroll[^\n]*(?:fetch|load\()/);
  assert.match(shell, /loadEarlier\.addEventListener\("click"/);
  assert.match(shell, /loadLater\.addEventListener\("click"/);
  assert.doesNotMatch(shell, /stream\.innerHTML\s*=/);
  assert.match(shell, /if\(direction==="backward"\)stream\.insertAdjacentHTML\("afterbegin"/);
  assert.match(shell, /else if\(direction==="forward"\)stream\.insertAdjacentHTML\("beforeend"/);
  assert.match(shell, /getBoundingClientRect\(\)\.top/);
  assert.match(shell, /id="today"[^>]*>Today/);
  assert.match(shell, /id="yesterday"[^>]*>Yesterday/);
  assert.match(shell, /id="date-picker"[^>]*type="date"/);
  assert.match(shell, /id="entire-transcript"[^>]*>Entire transcript/);
  assert.match(shell, /id="prompt-counter"[^>]*>Prompt 0 of 0/);
  assert.match(shell, /id="prompt-scrubber"/);
  assert.match(shell, /client\.anchorUrl/);
  assert.match(shell, /client\.indexUrl/);
  assert.match(shell, /catch\(error\)\{showRenderError\(error\)/);
});

test("the generated review preserves the approved v3 compact activity rails", () => {
  const shell = pageShell({}, {
    anchorUrl: "http://127.0.0.1/anchor",
    availableBytes: 200,
    boundaryStart: 0,
    closeUrl: "http://127.0.0.1/close",
    indexUrl: "http://127.0.0.1/prompts",
    eventsUrl: "http://127.0.0.1/events",
    pageUrl: "http://127.0.0.1/page",
    readyUrl: "http://127.0.0.1/ready",
  });

  assert.match(shell, /SCROLL = PASSIVE/);
  assert.match(shell, /\.activity>summary\{min-height:18px/);
  assert.match(shell, /class="stage-stack"/);
  assert.match(shell, /previous\.start!==group\.start/);
  assert.match(shell, /next\.start!==group\.start/);
});

test("Codex user prompts map to exact source events while internal envelopes never render", async (t) => {
  const { source } = await fixture(t);
  const rows = [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "genuine-user-before" }] } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "developer-private" }] } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "message", role: "system", content: [{ type: "input_text", text: "system-private" }] } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context source='goal'>goal-private</codex_internal_context>" }] } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:04Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /private/repo\ninternal-guide" }, { type: "input_text", text: "<environment_context>internal-environment</environment_context>" }] } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:05Z", type: "event_msg", payload: { type: "hook_completed", message: "hook-private" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:06Z", type: "response_item", payload: { type: "function_call", call_id: "call-private", name: "functions.exec", arguments: JSON.stringify({ cmd: "printf tool-shaped-text" }) } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:07Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-private", output: "tool-result-shaped-text" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:08Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "genuine-assistant" }] } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:09Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "genuine-user-after" }] } }),
  ];
  const starts = [];
  let cursor = 0;
  for (const row of rows) {
    starts.push(cursor);
    cursor += Buffer.byteLength(row) + 1;
  }
  await fsp.writeFile(source, rows.join("\n") + "\n");

  const page = await readForwardPage(source);
  const html = page.groups.map((group) => group.html).join("\n");
  const users = page.groups.filter((group) => group.kind === "message" && /data-role="user"/.test(group.html));
  const assistants = page.groups.filter((group) => group.kind === "message" && /data-role="assistant"/.test(group.html));

  assert.deepEqual(users.map(({ start, end }) => ({ start, end })), [
    { start: starts[0], end: starts[1] },
    { start: starts[9], end: cursor },
  ]);
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].start, starts[8]);
  assert.match(html, /genuine-user-before/);
  assert.match(html, /genuine-assistant/);
  assert.match(html, /genuine-user-after/);
  assert.match(html, /Commands &amp; tools/);
  assert.doesNotMatch(html, /goal-private|developer-private|system-private|internal-guide|internal-environment|hook-private/);
  assert.ok(users.every((group) => !/tool-shaped-text|tool-result-shaped-text/.test(group.html)));
});

test("a real-shape recommended-plugins injection is removed without losing its adjacent genuine user prompt", async (t) => {
  const { source } = await fixture(t);
  const injectedRow = JSON.stringify({
    timestamp: "2026-01-01T00:00:00Z",
    type: "response_item",
    payload: {
      type: "message",
      id: "generated-user-item",
      role: "user",
      content: [
        { type: "input_text", text: "<recommended_plugins>generated-plugin-catalog</recommended_plugins>" },
        { type: "input_text", text: "genuine-user-request" },
        { type: "input_text", text: "<environment_context>generated-environment</environment_context>" },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: "generated-turn", create_time: 1 },
    },
  });
  const rows = [
    injectedRow,
    JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "genuine-user-request" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<hook>generated-hook-envelope</hook>" }, { type: "input_text", text: "<tool_result>generated-tool-envelope</tool_result>" }] } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "genuine-assistant-response" }] } }),
  ];
  await fsp.writeFile(source, rows.join("\n") + "\n");

  const page = await readForwardPage(source);
  const html = page.groups.map((group) => group.html).join("\n");
  const users = page.groups.filter((group) => group.kind === "message" && /data-role="user"/.test(group.html));
  assert.equal(users.length, 1);
  assert.deepEqual({ start: users[0].start, end: users[0].end }, { start: 0, end: Buffer.byteLength(injectedRow) + 1 });
  assert.match(html, /genuine-user-request/);
  assert.match(html, /genuine-assistant-response/);
  assert.doesNotMatch(html, /recommended_plugins|generated-plugin-catalog|generated-environment|generated-hook-envelope|generated-tool-envelope/);
});

test("Cursor CLI user queries and nested tool-use blocks retain exact source roles", async (t) => {
  const { source } = await fixture(t);
  const rows = [
    JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>real-cursor-user-prompt</user_query>\n<timestamp>2026-01-01T00:00:00Z</timestamp>" }] } }),
    JSON.stringify({ role: "assistant", message: { content: [
      { type: "text", text: "real-cursor-assistant-response" },
      { type: "tool_use", name: "Read", input: { path: "/safe/example.txt" } },
    ] } }),
    JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<mcp_meta_tools>cursor-internal-tool-context</mcp_meta_tools>" }] } }),
  ];
  await fsp.writeFile(source, rows.join("\n") + "\n");

  const page = await readForwardPage(source, { format: "cursor" });
  const html = page.groups.map((group) => group.html).join("\n");
  const users = page.groups.filter((group) => group.kind === "message" && /data-role="user"/.test(group.html));
  const assistants = page.groups.filter((group) => group.kind === "message" && /data-role="assistant"/.test(group.html));

  assert.equal(users.length, 1);
  assert.equal(users[0].start, 0);
  assert.equal(assistants.length, 1);
  assert.match(html, /real-cursor-user-prompt/);
  assert.match(html, /real-cursor-assistant-response/);
  assert.match(html, /Commands &amp; tools/);
  assert.match(html, /Read/);
  assert.doesNotMatch(html, /user_query|timestamp|cursor-internal-tool-context|mcp_meta_tools/);
});

test("grouped tools, diffs, line statistics, and Codex/Cursor/Pi adapters remain formatted", async (t) => {
  const { directory, source } = await fixture(t);
  const rows = [
    codexMessage(0, "before tools"),
    JSON.stringify({ timestamp: "2026-01-01T00:01:00Z", type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "functions.exec", arguments: JSON.stringify({ cmd: "printf hello" }) } }),
    JSON.stringify({ timestamp: "2026-01-01T00:01:01Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "hello" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:01:02Z", type: "event_msg", payload: { type: "patch_apply_end", changes: { "demo.txt": { unified_diff: "@@ -1 +1,2 @@\n-old\n+new\n+added" } } } }),
    codexMessage(2, "after tools"),
  ];
  await fsp.writeFile(source, rows.join("\n") + "\n");
  const codex = await readForwardPage(source);
  assert.equal(codex.groups.length, 4);
  assert.match(codex.groups[1].html, /Commands &amp; tools/);
  assert.match(codex.groups[1].html, /hello/);
  assert.match(codex.groups[2].html, /Code changes/);
  assert.match(codex.groups[2].html, /\+2/);
  assert.match(codex.groups[2].html, /−1/);

  const cursorSource = path.join(directory, "cursor.jsonl");
  await fsp.writeFile(cursorSource, JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", role: "assistant", content: "cursor-normalized" }) + "\n");
  assert.match((await readForwardPage(cursorSource)).groups[0].html, /cursor-normalized/);

  const piSource = path.join(directory, "pi.jsonl");
  const piRows = [
    { type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "<recommended_plugins>pi-generated-internal</recommended_plugins>" }] } },
    { type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "pi-visible-user" }] } },
    { type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "pi-normalized" }, { type: "toolCall", id: "pi-1", name: "shell", arguments: { command: "pwd" } }] } },
    { type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "toolResult", toolCallId: "pi-1", toolName: "shell", content: [{ type: "text", text: "/tmp" }] } },
  ];
  await fsp.writeFile(piSource, piRows.map(JSON.stringify).join("\n") + "\n");
  const pi = await readForwardPage(piSource);
  assert.equal(pi.groups.length, 3);
  assert.match(pi.groups[0].html, /pi-visible-user/);
  assert.match(pi.groups[2].html, /\/tmp/);
  assert.doesNotMatch(pi.groups.map((group) => group.html).join("\n"), /pi-generated-internal/);
});

test("a generated sparse multi-gigabyte failure shape pages with bounded reads and memory", { timeout: 20_000 }, async (t) => {
  const { source } = await fixture(t);
  const sparseOffset = 3 * 1024 * 1024 * 1024;
  const handle = await fsp.open(source, "w+");
  const head = codexMessage(0, "sparse-head") + "\n";
  await handle.write(head, 0, "utf8");
  await handle.truncate(sparseOffset);
  const tailLines = Array.from({ length: 55 }, (_, index) => codexMessage(index + 1, index === 0 ? "sparse-tail-boundary" : `sparse-tail-${index}`, index === 0 ? "user" : "assistant"));
  await handle.write("\n" + tailLines.join("\n") + "\n", sparseOffset, "utf8");
  await handle.close();

  const beforeRss = process.memoryUsage().rss;
  const boundary = await locateQuotedBoundary(source, "sparse-tail-boundary");
  const page = await readForwardPage(source, { cursor: boundary.offset });
  const rssGrowth = process.memoryUsage().rss - beforeRss;
  assert.ok((await fsp.stat(source)).size > 3 * 1024 * 1024 * 1024);
  assert.equal(page.groups.length, PAGE_BLOCK_LIMIT);
  assert.ok(boundary.bytesRead <= 2 * 64 * 1024);
  assert.ok(page.bytesRead < 1024 * 1024);
  assert.ok(rssGrowth < 128 * 1024 * 1024, `RSS grew by ${rssGrowth} bytes`);
});

test("a fast page response without a frame-ready acknowledgement is not a successful first render", async (t) => {
  const { directory, source } = await fixture(t);
  await fsp.writeFile(source, codexMessage(0, "fast-page-not-painted", "user") + "\n");
  const output = path.join(directory, "first-render-race", "index.html");
  const review = await createReview({ source, out: output, startupTimeoutMs: 1000 }, { endSession() {} });

  const pageResponse = await fetch(`${review.client.pageUrl}&direction=forward&cursor=0`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /fast-page-not-painted/);
  await assert.rejects(review.waitForFirstRender(20), /did not acknowledge its first rendered page within 20 ms/);

  const ready = await fetch(review.client.readyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageStart: 0, pageEnd: (await fsp.stat(source)).size, blocks: 1 }),
  });
  assert.equal(ready.status, 204);
  assert.deepEqual(await review.firstRender, { pageStart: 0, pageEnd: (await fsp.stat(source)).size, blocks: 1 });
  review.stop("test-complete");
  assert.equal(await review.done, "test-complete");
});

test("never-opened review stops, ends only its session, and removes only generated output", async (t) => {
  const { directory, source } = await fixture(t);
  await fsp.writeFile(source, codexMessage(0, "source-must-survive") + "\n");
  const output = path.join(directory, "never-opened", "index.html");
  let ended = 0;
  const review = await createReview({ source, out: output, startupTimeoutMs: 30 }, { endSession: () => { ended += 1; } });
  const shell = await fsp.readFile(output, "utf8");
  assert.doesNotMatch(shell, /source-must-survive/);
  assert.match(shell, /0 BLOCKS/);
  assert.match(shell, /id="render-error"/);
  assert.match(shell, /client\.readyUrl/);
  const browserScript = shell.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(browserScript);
  assert.doesNotThrow(() => new Function(browserScript));
  assert.equal(await review.done, "browser-never-connected");
  assert.equal(ended, 1);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(source), true);
});

test("append events announce bytes without HTML rewrites and reconnect delays cleanup", { timeout: 5000 }, async (t) => {
  const { directory, source } = await fixture(t);
  await fsp.writeFile(source, codexMessage(0, "initial") + "\n");
  const output = path.join(directory, "live", "index.html");
  let ended = 0;
  const review = await createReview(
    { source, out: output, watch: true, startupTimeoutMs: 1000, reconnectTimeoutMs: 120 },
    { endSession: () => { ended += 1; } },
  );
  const shellBefore = await fsp.readFile(output, "utf8");
  const modifiedBefore = (await fsp.stat(output)).mtimeMs;

  const first = connectEvents(review.client.eventsUrl);
  assert.equal((await first.next()).type, "availability");
  await fetch(review.client.readyUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageStart: 0, pageEnd: 1, blocks: 1 }) });
  first.close();
  await wait(40);
  assert.equal(fs.existsSync(output), true);

  const second = connectEvents(review.client.eventsUrl);
  await second.next();
  await fsp.appendFile(source, codexMessage(1, "append-without-reload") + "\n");
  const appendEvent = await second.next();
  assert.equal(appendEvent.type, "availability");
  assert.equal(appendEvent.availableBytes, (await fsp.stat(source)).size);
  assert.equal((await fsp.stat(output)).mtimeMs, modifiedBefore);
  assert.equal(await fsp.readFile(output, "utf8"), shellBefore);
  assert.doesNotMatch(shellBefore, /append-without-reload/);

  second.close();
  assert.equal(await review.done, "browser-disconnected");
  assert.equal(ended, 1);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(source), true);
});
