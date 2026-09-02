# AgentReady

AgentReady is an evidence-first technical prototype for a future B2B SaaS that helps small and medium-sized businesses understand whether their public website is ready for a world where customers use AI assistants and agents to discover, understand, compare, recommend, and act.

It does **not** claim to measure a real ranking, citation rate, or recommendation frequency in ChatGPT, Gemini, Perplexity, or another AI product.

## The WebMCP Challenge demo

This repository now includes a deliberately small, deployable demo for the WebMCP Challenge:

```text
Public URL → static public-page audit → bounded rendered fallback when needed → Visibility / Understanding / Buyability → priority actions → local monitoring
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

The challenge Function is **not the complete historical Python AgentReady engine**. It is a separate, intentionally bounded one-page demo lane: it fetches one public page, uses static HTML first, and can optionally request a fully rendered DOM from an isolated browser service only when the static response looks incomplete. It does not crawl, submit a form, authenticate, or return facts unsupported by the observed page. The Python CLI remains the richer prototype engine.

### Acquisition and evidence semantics

Each audit labels page acquisition as one of:

- `full` — the static HTML, or a successful bounded rendered fallback, contains enough visible material for this bounded page audit;
- `limited` — the response looks like a JavaScript shell, a JavaScript-required page, or otherwise lacks representative visible content and rendering did not produce usable public evidence;
- `blocked` — the response is an access-control, anti-bot, or rate-limit page.

Each capability is then `OBSERVED`, `NOT_OBSERVED`, or `INSUFFICIENT_EVIDENCE`. A missing signal is only treated as `NOT_OBSERVED` after full acquisition. With limited or blocked acquisition, the demo leaves commercial pillar scores blank rather than presenting a misleading zero, and recommends making key information agent-accessible in server-rendered HTML and/or validated structured data.

### Optional JavaScript-rendered acquisition

The static fetch is always the fast path. A renderer is attempted only for an explicit JavaScript-required page or a thin application shell with very little visible content and many scripts. The current beta adapter supports [Cloudflare Browser Run's `/content` REST endpoint](https://developers.cloudflare.com/browser-run/quick-actions/content-endpoint/), which returns HTML after JavaScript execution. It requires a Cloudflare account plus a narrowly scoped API token with the **Browser Rendering — Edit** permission (called `Browser Rendering Write` in the API reference) and these Netlify environment variables:

```text
AGENTREADY_RENDERER_PROVIDER=cloudflare-browser-run
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

No renderer is configured by default; in that case a JavaScript-only page remains honestly `limited`. Cloudflare documents a Workers Free allowance of 10 browser minutes/day and 3 concurrent browsers; its published overage price for REST requests is $0.09/browser-hour. Verify current limits and billing before enabling it in a production beta. The renderer boundary is provider-agnostic, so the scoring engine does not depend on Cloudflare-specific fields.

## Safety boundaries of the demo endpoint

The Function accepts only unauthenticated `http`/`https` URLs. It rejects localhost, IP literals, common private/link-local ranges, and obvious internal hostnames; checks DNS resolution before each static request and before/after a renderer navigation; uses a six-second static timeout, a nine-second renderer timeout, bounded redirects, and HTML-size limits (750 KB static, 1 MB rendered). The renderer adapter blocks images, media, and fonts, and it never submits forms, logs in, clicks a checkout, or provides credentials to the target page.

Those checks reduce SSRF risk but do not replace production-grade network egress controls, DNS pinning, provider-side egress restrictions for subresources, abuse prevention, rate limiting, or authentication. A renderer is an additional attack surface: keep its token secret, restrict it to rendering only, and configure provider network controls if they are available.

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

No environment variables, database, account, payment provider, or background job are required for the static demo. The optional rendered fallback needs the Cloudflare variables above; keep them in Netlify environment settings, never in source control.

## Historical Python prototype

The original CLI remains available for local exploration:

```bash
python3 -m agentready audit https://example.com
python3 -m unittest discover -s tests -v
```

The CLI crawler is bounded, respects `robots.txt`, and starts with HTTP before using its optional headless fallback. It produces JSON and a local HTML report with evidence and deterministic score rules.

## Known MVP limitations

- The challenge audit reads only one public page and is not a site-wide crawl.
- Its commercial extraction is conservative and intentionally marks unproven capabilities as `NOT_OBSERVED` or `INSUFFICIENT_EVIDENCE` according to acquisition quality.
- JavaScript-rendered content can be audited only when the optional isolated renderer is configured and succeeds. CAPTCHA/anti-bot pages, authenticated content, checkout flows, PDFs, images, APIs, and third-party booking/payment flows remain out of scope. Chromium/Playwright inside the Netlify Function is deliberately deferred because it would add a large native browser dependency, cold-start and timeout risk, and a wider SSRF attack surface.
- The monitoring panel is browser-local, not shared, scheduled, or persistent across devices.
- WebMCP availability depends on the active browser implementation and agent integration.
- Neither audit lane measures real AI search ranking, citations, traffic, conversion, or agent purchase completion.

## Repository hygiene

Generated audits and historical benchmark artifacts remain ignored. The public V0.2 baseline commit is preserved; no benchmark output is required for the challenge demo.
