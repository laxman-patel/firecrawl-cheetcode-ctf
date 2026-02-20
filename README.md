# Firecrawl CTF Sub-3s Extension Strategy

This project contains a Chrome Manifest V3 extension that automates the Firecrawl CTF flow with a speed-first architecture.

The extension directory is:

- `extension/`

Load that folder in Chrome using **Load unpacked**.

## Demo recording



https://github.com/user-attachments/assets/b5bbfbc2-9b75-46d0-9c3f-94a46c63759c



## What this is optimized for

- Manual trigger from extension popup (`Run Now`)
- Works from either:
  - Entry page (clicks `START`, then continues automatically after navigation)
  - Challenge board page (runs immediately)
- Maximize solved count under strict timer pressure

## Why sub-3s is feasible

### 1) Model/provider pairing for extreme throughput

- Model: `openai/gpt-oss-120b`
- Routing: OpenRouter with provider order pinned to `cerebras`
- Provider config:
  - `order: ["cerebras"]`
  - `allow_fallbacks: false`
  - `require_parameters: true`
  - `sort: "throughput"`

Reason: this setup prioritizes very high tokens/sec and avoids multi-provider fallback overhead during time-critical runs.

### 2) Single batched inference call

- Extract all 10 problems from DOM
- Send one solve request (not 10 separate requests)
- Return `solutions[]` in index order

Reason: one network round-trip dominates less than multiple request/response handshakes.

### 3) Prompt + token budget minimization

- Compact payload (`JSON.stringify(...)` without pretty formatting)
- Lower output budget (`max_tokens` tuned down)
- `temperature: 0` for deterministic code generation

Reason: fewer output tokens and smaller request body reduce total latency.

### 4) Aggressive client-side concurrency

- Fill all 10 textareas quickly
- Fire all per-problem `SUBMIT` clicks in a wave
- Wait for solved counter, retry one additional submit wave if needed
- Click `FINISH & SUBMIT` immediately after success/threshold

Reason: avoids serial waiting per card and reduces risk of 9/10 outcomes.

### 5) Navigation handoff optimization

- If run from entry page:
  - set a short-lived armed-run flag in storage
  - click `START`
  - on challenge page load, content script auto-resumes that armed run

Reason: no manual pause between START and execution.

## Reliability protections

- Structured output request first (`json_schema`)
- Automatic fallback to `json_object` if provider rejects schema fields
- Strict local validation still enforces expected solution count
- Function signature normalization before injecting code into each textarea

## Debugging and observability

Popup includes:

- `Run Now`
- `Refresh Logs`
- `Clear Logs`

Logs include content + background traces for:

- board detection state
- message flow
- OpenRouter call lifecycle
- submit wave behavior

## Extension structure

- `extension/manifest.json`
- `extension/src/background/service-worker.js`
- `extension/src/content/runner.js`
- `extension/src/popup/popup.html`
- `extension/src/popup/popup.js`
- `extension/src/options/options.html`
- `extension/src/options/options.js`

## Quick use

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked -> select `extension/`
4. Open extension Options and set your OpenRouter API key
5. Open CTF entry/challenge page and click `Run Now`
