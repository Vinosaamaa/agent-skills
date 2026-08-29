---
name: lavish-transcript
description: Render a local Codex, Cursor, or Pi agent transcript into a pixel-terminal Lavish review surface with bounded byte-cursor paging, date and genuine-prompt navigation, near-live append availability, collapsed command and tool results, viewed-image records, and code diffs. Use when the user asks to read, mirror, export, or follow an agent CLI transcript in Lavish.
---

# Lavish Transcript

Render the owning local transcript with `scripts/render-transcript.mjs`.

## Rules

- Start the initial page at the newest exact quoted bookmark match or chronological timestamp boundary; keep earlier paging available back to byte zero. If neither is supplied, start at byte zero.
- Include user and assistant messages plus visible command/tool activity.
- Group each stage's commands/tools into one collapsed card and its code changes into one collapsed card; keep nested commands, outputs, viewed-image records, and per-file diffs collapsed too.
- Show each diff's file path and exact added/removed line totals in its summary.
- Never emit injected plugin recommendations, system/developer instructions, hooks, goals, environment/internal context, mirrored tool envelopes, hidden reasoning, secrets, cookies, or binary/base64 payloads. Keep genuine user text when an internal envelope is an adjacent part of the same source event.
- Output under `/private/tmp`; preserve or export only when the user asks.
- Let the browser request at most 40 formatted blocks by byte cursor. The generated HTML is a UI shell with zero transcript records.
- Keep every explicitly loaded page in browser data and the DOM without eviction. Scrolling never loads, removes, or replaces pages. Search only loaded content.
- Support Today, Yesterday, a timezone-explicit calendar date, and Entire transcript. Locate local-day bounds with timestamp binary seeks, scan only the selected day for a metadata-only index of genuine user-message envelopes, and label them `Prompt N of M` without splitting one source message into guessed questions.
- Prompt navigation may retain a bounded preview, timestamp, byte range, ordinal, and stable local locator only. Selecting an unloaded prompt fetches one anchored neighborhood of at most 40 formatted blocks, retains every loaded page, and persists the selected date and locator in local URL state.
- For a live follow, use `--watch`. Append events announce available source bytes; they do not rescan the source, rewrite the HTML, or reload the page.
- A review that never connects stops after five minutes. After a connected review closes, allow five minutes for reload/reconnect, then end only its Lavish session, stop its watcher, and delete its generated HTML; never delete the source transcript or another Lavish session.
- Start Lavish with `LAVISH_AXI_NO_OPEN=1`, focus Agent Chrome with `~/.local/bin/launch-agent-chrome --focus`, then open the exact returned URL with `~/.local/bin/agent-chrome-axi newpage <url>`. Run `newpage` asynchronously so the same process can continue serving the artifact, but require both its successful exit and the artifact's first-render acknowledgement before reporting ready. Never launch a Lavish review through Work Chrome, the default browser, `open`, `open -a`, the inner Chrome executable, or `chrome-devtools-axi` directly.

## Command

```bash
node scripts/render-transcript.mjs \
  --source /path/to/transcript.jsonl \
  --from "exact quoted bookmark" \
  --out /private/tmp/lavish-transcript/index.html \
  --watch
```

`--source` is the owning JSONL transcript. `--from` searches newest-to-oldest in fixed byte chunks; use `--since <timestamp>` for chronological binary seeking instead. `--out` is the temporary UI shell. `--watch` adds availability notifications for appended bytes. The renderer supports Codex, Cursor CLI, and Pi JSONL message/tool normalization directly.

The renderer stays attached while the review is usable because browser pages are generated on demand. The lifecycle rules above stop it automatically.

The command launches the generated review automatically: it suppresses Lavish's default-browser behavior, reads the exact local session URL, focuses Agent Chrome through its supported launcher, opens a fresh tab through the supported `newpage` adapter, and waits for the initial transcript page to acknowledge rendering.

## Focused verification

```bash
node --test tests/render-transcript.test.mjs
node benchmarks/benchmark-render-transcript.mjs
```

The test entrypoint uses only generated fixtures, including a sparse file with a logical size above 3 GiB. The benchmark reports timestamp and quoted-boundary location separately from the first and repeated 40-block page-generation paths; report observed measurements without inventing a target.
