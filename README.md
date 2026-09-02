# AgentReady

AgentReady is an evidence-first technical prototype for a future B2B SaaS that helps small and medium-sized businesses understand whether their public website is ready for a world where customers use AI assistants and agents to discover, understand, compare, recommend, and act.

It does **not** claim to measure a real ranking, citation rate, or recommendation frequency in ChatGPT, Gemini, Perplexity, or another AI product.

## The WebMCP Challenge demo

This repository now includes a deliberately small, deployable demo for the WebMCP Challenge:

```text
Public URL → bounded public-page audit → Visibility / Understanding / Buyability → priority actions → local monitoring
```

The interface has three future-SaaS building blocks:

- **Score** — deterministic, explainable public-page signals.
- **Actions** — the most important observed gaps, never invented business facts.
- **Monitoring** — the latest score, previous score, delta, and a local alert stored only in the browser.

### What humans can do

Humans can enter a public URL, run the audit, inspect the score cards, review the evidence supporting each score, and use the prioritized actions as a starting point for a content or technical improvement conversation.

### What AI agents can do

On a browser implementing WebMCP, the page registers the real native tool:

```text
agentready.run_audit
```

Its only input is a public `http` or `https` URL. Its execution calls the same live audit endpoint used by the interface and returns structured scores, evidence, priority actions, and audit status. The browser feature is detected at runtime: if `document.modelContext.registerTool()` is unavailable, the UI explicitly says that no agent tool is active.

This uses the WebMCP imperative registration model; it is not a simulated button or custom RPC wrapper. See the [WebMCP specification](https://github.com/webmachinelearning/webmcp/blob/main/README.md).

### What was added specifically for the challenge

- a lightweight static web interface in `web/`;
- a single Netlify Function at `/.netlify/functions/audit`;
- native WebMCP registration in `web/webmcp.js`;
- local-only monitoring through `localStorage`;
- Node tests for the bounded audit Function;
- Netlify deployment configuration.

The challenge Function is **not the complete historical Python AgentReady engine**. It is a separate, intentionally bounded one-page demo lane: it fetches one public HTML page, does not execute remote JavaScript, does not crawl, does not submit a form, and only returns facts supported by the observed page. The Python CLI remains the richer prototype engine.

### Acquisition and evidence semantics

Each audit labels page acquisition as one of:

- `full` — the static HTML contains enough visible material for this bounded page audit;
- `limited` — the response looks like a JavaScript shell, a JavaScript-required page, or otherwise lacks representative visible content;
- `blocked` — the response is an access-control, anti-bot, or rate-limit page.

Each capability is then `OBSERVED`, `NOT_OBSERVED`, or `INSUFFICIENT_EVIDENCE`. A missing signal is only treated as `NOT_OBSERVED` after full acquisition. With limited or blocked acquisition, the demo leaves commercial pillar scores blank rather than presenting a misleading zero, and recommends making key information available in server-rendered HTML or validated structured data.

## Safety boundaries of the demo endpoint

The Function accepts only unauthenticated `http`/`https` URLs. It rejects localhost, IP literals, common private/link-local ranges, and obvious internal hostnames; checks DNS resolution before each request; uses a six-second request timeout; limits the response to 750 KB; manually follows at most three redirects; accepts HTML only; and never runs the target site’s JavaScript.

Those checks reduce SSRF risk but do not replace production-grade network egress controls, DNS pinning, abuse prevention, rate limiting, or authentication.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by Netlify CLI. Enter a public HTTPS URL and select **Run audit**.

To run the challenge tests:

```bash
npm run test:web
```

## Deploy to Netlify

Create a new Netlify site from this repository. Netlify reads `netlify.toml` automatically:

- publish directory: `web`
- functions directory: `netlify/functions`

No environment variables, database, account, payment provider, or background job are required for the demo.

## Historical Python prototype

The original CLI remains available for local exploration:

```bash
python3 -m agentready audit https://example.com
python3 -m unittest discover -s tests -v
```

The CLI crawler is bounded, respects `robots.txt`, and starts with HTTP before using its optional headless fallback. It produces JSON and a local HTML report with evidence and deterministic score rules.

## Known MVP limitations

- The challenge audit reads only one public HTML page and is not a site-wide crawl.
- Its commercial extraction is conservative and intentionally marks unproven capabilities as `NOT_OBSERVED` or `INSUFFICIENT_EVIDENCE` according to acquisition quality.
- JavaScript-rendered content, authenticated content, checkout flows, PDFs, images, APIs, and third-party booking/payment flows are out of scope. A Chromium/Playwright fallback is deliberately deferred: it would add a large native browser dependency, cold-start and timeout risk, and a wider SSRF attack surface to this lightweight Netlify Function.
- The monitoring panel is browser-local, not shared, scheduled, or persistent across devices.
- WebMCP availability depends on the active browser implementation and agent integration.
- Neither audit lane measures real AI search ranking, citations, traffic, conversion, or agent purchase completion.

## Repository hygiene

Generated audits and historical benchmark artifacts remain ignored. The public V0.2 baseline commit is preserved; no benchmark output is required for the challenge demo.
