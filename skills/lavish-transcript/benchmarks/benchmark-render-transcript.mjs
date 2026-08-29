#!/usr/bin/env node
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildDailyPromptIndex,
  locateQuotedBoundary,
  locateTimestampBoundary,
  readAnchoredPage,
  readForwardPage,
} from "../scripts/render-transcript.mjs";

function message(index, text, role = index % 2 ? "assistant" : "user") {
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "output_text", text }] },
  });
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { milliseconds: performance.now() - started, value };
}

const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "lavish-transcript-benchmark-"));
try {
  const denseSource = path.join(directory, "dense.jsonl");
  const denseLines = Array.from({ length: 50_000 }, (_, index) => message(index, `generated-benchmark-${index}`));
  await fsp.writeFile(denseSource, denseLines.join("\n") + "\n");
  const denseStat = await fsp.stat(denseSource);

  const sparseSource = path.join(directory, "sparse-3gib.jsonl");
  const sparseOffset = 3 * 1024 * 1024 * 1024;
  const sparse = await fsp.open(sparseSource, "w+");
  await sparse.write(message(0, "generated-sparse-head") + "\n", 0, "utf8");
  await sparse.truncate(sparseOffset);
  const sparseTail = Array.from({ length: 80 }, (_, index) => message(index + 1, index === 0 ? "generated-sparse-boundary" : `generated-sparse-tail-${index}`, index === 0 ? "user" : "assistant"));
  await sparse.write("\n" + sparseTail.join("\n") + "\n", sparseOffset, "utf8");
  await sparse.close();
  const sparseStat = await fsp.stat(sparseSource);

  const timestampTarget = JSON.parse(denseLines[42_000]).timestamp;
  const timestampBoundary = await timed(() => locateTimestampBoundary(denseSource, timestampTarget));
  const quoteBoundary = await timed(() => locateQuotedBoundary(sparseSource, "generated-sparse-boundary"));

  const coldPage = await timed(() => readForwardPage(denseSource, { cursor: timestampBoundary.value.offset }));
  const dailyIndex = await timed(() => buildDailyPromptIndex(denseSource, {
    date: "2025-12-31",
    timeZone: "America/Los_Angeles",
    format: "codex",
    now: "2026-01-02T00:00:00Z",
  }));
  const anchoredPrompt = dailyIndex.value.items[Math.floor(dailyIndex.value.items.length * 0.8)];
  const anchoredPage = await timed(() => readAnchoredPage(denseSource, { cursor: anchoredPrompt.start, format: "codex" }));
  const warmRuns = [];
  for (let index = 0; index < 7; index += 1) {
    const run = await timed(() => readForwardPage(denseSource, { cursor: timestampBoundary.value.offset }));
    warmRuns.push(run.milliseconds);
  }

  console.log(JSON.stringify({
    fixtures: {
      denseBytes: denseStat.size,
      denseRecords: denseLines.length,
      sparseLogicalBytes: sparseStat.size,
      sparseTailRecords: sparseTail.length,
    },
    boundaryLocation: {
      timestampBinary: {
        milliseconds: Number(timestampBoundary.milliseconds.toFixed(3)),
        bytesRead: timestampBoundary.value.bytesRead,
        offset: timestampBoundary.value.offset,
      },
      quotedReverse: {
        milliseconds: Number(quoteBoundary.milliseconds.toFixed(3)),
        bytesRead: quoteBoundary.value.bytesRead,
        offset: quoteBoundary.value.offset,
      },
    },
    pageGeneration40Blocks: {
      coldFirstInvocationMilliseconds: Number(coldPage.milliseconds.toFixed(3)),
      coldBlocks: coldPage.value.groups.length,
      coldBytesRead: coldPage.value.bytesRead,
      warmRunsMilliseconds: warmRuns.map((value) => Number(value.toFixed(3))),
      warmMedianMilliseconds: Number(median(warmRuns).toFixed(3)),
    },
    dailyPromptNavigation: {
      date: dailyIndex.value.date,
      prompts: dailyIndex.value.items.length,
      indexMilliseconds: Number(dailyIndex.milliseconds.toFixed(3)),
      indexBytesRead: dailyIndex.value.bytesRead,
      anchoredPageMilliseconds: Number(anchoredPage.milliseconds.toFixed(3)),
      anchoredBlocks: anchoredPage.value.groups.length,
      anchoredBytesRead: anchoredPage.value.bytesRead,
    },
  }));
} finally {
  await fsp.rm(directory, { recursive: true, force: true });
}
