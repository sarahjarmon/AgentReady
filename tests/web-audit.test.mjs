import assert from "node:assert/strict";
import test from "node:test";

import { auditPublicPage, createRendererFromEnv, EvidenceState, inspectHtml, isBlockedHostname, isPrivateIp, validatePublicUrl } from "../netlify/functions/lib/audit-core.mjs";
import auditHandler from "../netlify/functions/audit.mjs";
import { nextMonitoringState } from "../web/monitoring.js";
import { toWebMcpResult } from "../web/webmcp.js";

const commercialPage = `<!doctype html><html><head><title>Acme Workshop</title><meta name="description" content="Custom furniture for homes and offices"><link rel="canonical" href="https://example.test/services"></head><body><header><h1>Custom furniture service</h1></header><main><h2>Furniture consultation</h2><p>We design and build furniture. From 90 € with delivery in Europe. Visa accepted.</p><a href="/quote">Request a quote</a><h2>How we work</h2><p>Tell us about your project and we will respond with a tailored proposal.</p></main></body></html>`;
const thinShell = `<!doctype html><html><head><title>App</title><script src="/runtime.js"></script><script src="/main.js"></script><script src="/vendor.js"></script><script src="/chunk-a.js"></script><script src="/chunk-b.js"></script></head><body><div id="root"></div></body></html>`;
const javascriptRequired = `<!doctype html><html><head><title>JavaScript is disabled</title></head><body><p>JavaScript is disabled. Please enable JavaScript to continue.</p></body></html>`;
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const htmlResponse = (html) => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
const successfulRenderer = (html = commercialPage, finalUrl = "https://example.test/rendered") => ({ renderPage: async () => ({ status: "success", rendered: true, html, finalUrl, metadata: { provider: "test-renderer", timing_ms: 12 } }) });

test("rejects local, private, and non-web destinations", () => {
  for (const value of ["http://localhost:3000", "https://127.0.0.1", "http://10.0.0.8", "ftp://example.test", "http://[::1]"]) assert.throws(() => validatePublicUrl(value));
  assert.equal(isBlockedHostname("service.internal"), true);
  assert.equal(isPrivateIp("192.168.1.7"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("normal server-rendered commercial page receives meaningful evidence states", () => {
  const result = inspectHtml(commercialPage, "https://example.test/services");
  assert.equal(result.status, "complete");
  assert.equal(result.acquisition.status, "full");
  assert.equal(result.score_status, "meaningful");
  assert.equal(result.capabilities.offer.state, EvidenceState.OBSERVED);
  assert.equal(result.capabilities.pricing.state, EvidenceState.OBSERVED);
  assert.equal(result.capabilities.conversion.state, EvidenceState.OBSERVED);
  assert.ok(Number.isFinite(result.scores.buyability));
  assert.equal(result.readiness.state, "observed");
});

test("product price and purchase CTA are associated as observable commerce", () => {
  const result = inspectHtml(`<!doctype html><html><head><title>Tea shop</title><meta name="description" content="Loose leaf tea online"></head><body><h1>Green tea</h1><h2>Organic jasmine tea</h2><p>€ 12.90 — in stock.</p><button>Add to cart</button><p>Shipping across the country.</p><h2>More teas</h2><p>Browse our full selection of loose leaf tea.</p></body></html>`, "https://example.test/tea");
  assert.equal(result.summary.journey, "purchase");
  assert.equal(result.capabilities.pricing.state, EvidenceState.OBSERVED);
  assert.equal(result.capabilities.conversion.state, EvidenceState.OBSERVED);
  assert.equal(result.scores.buyability, 90);
});

test("service booking and contact signals are recognized without a product-specific rule", () => {
  const result = inspectHtml(`<!doctype html><html><head><title>Wellness studio</title><meta name="description" content="Private wellbeing appointments"></head><body><h1>Massage appointments</h1><p>Individual sessions for relaxation and recovery.</p><a href="https://calendly.example.test/book">Book an appointment</a><a href="mailto:hello@example.test">Email the studio</a><h2>Visit us</h2><p>Our team will help you choose a session.</p></body></html>`, "https://example.test/massage");
  assert.equal(result.summary.journey, "booking");
  assert.equal(result.capabilities.conversion.state, EvidenceState.OBSERVED);
  assert.ok(result.actions.some((action) => action.title === "State availability or timing"));
});

test("thin JavaScript shell is limited, not a definitive commercial absence", () => {
  const result = inspectHtml(`<!doctype html><html><head><title>App</title><script src="/runtime.js"></script><script src="/main.js"></script><script src="/vendor.js"></script><script src="/chunk-a.js"></script><script src="/chunk-b.js"></script></head><body><div id="root"></div></body></html>`, "https://example.test/app");
  assert.equal(result.status, "limited");
  assert.equal(result.acquisition.status, "limited");
  assert.equal(result.scores.buyability, null);
  assert.equal(result.readiness.observed_readiness, null);
  assert.equal(result.capabilities.conversion.state, EvidenceState.INSUFFICIENT);
  assert.ok(result.actions.some((action) => /server-rendered/i.test(action.reason)));
});

test("explicit JavaScript-required response is limited", () => {
  const result = inspectHtml(`<!doctype html><html><head><title>JavaScript is disabled</title></head><body><p>JavaScript is disabled. Please enable JavaScript to continue.</p></body></html>`, "https://example.test/");
  assert.equal(result.acquisition.status, "limited");
  assert.equal(result.scores.understanding, null);
  assert.equal(result.capabilities.offer.state, EvidenceState.INSUFFICIENT);
});

test("non-commercial informational page does not receive irrelevant delivery or availability advice", () => {
  const result = inspectHtml(`<!doctype html><html><head><title>Open research notes</title><meta name="description" content="Essays about urban history and archives"></head><body><h1>Urban history research notes</h1><h2>Latest essay</h2><p>This public archive publishes essays, sources, and reading notes for students and researchers.</p><h2>About this project</h2><p>We document local history through open educational material.</p></body></html>`, "https://example.test/notes");
  assert.equal(result.acquisition.status, "full");
  assert.equal(result.summary.journey, "unknown");
  assert.equal(result.actions.some((action) => /delivery|availability|timing/i.test(action.title)), false);
});

test("limited acquisition never creates a misleading Buyability zero", () => {
  const result = inspectHtml(`<!doctype html><html><head><title>Loading</title></head><body><div id="app"></div></body></html>`, "https://example.test/loading");
  assert.equal(result.status, "limited");
  assert.notEqual(result.scores.buyability, 0);
  assert.equal(result.scores.buyability, null);
});

test("blocked response is explicit and does not produce readiness scores", async () => {
  const fetchImpl = async () => new Response("Access denied", { status: 403, headers: { "content-type": "text/html" } });
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const result = await auditPublicPage("https://example.test/blocked", { fetchImpl, resolver });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.scores, { visibility: null, understanding: null, buyability: null });
  assert.equal(result.capabilities.offer.state, EvidenceState.INSUFFICIENT);
});

test("follows a bounded public redirect and returns the final audit", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url.toString());
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: "/final" } });
    return new Response(commercialPage, { status: 200, headers: { "content-type": "text/html" } });
  };
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const result = await auditPublicPage("https://example.test/start", { fetchImpl, resolver });
  assert.equal(seen.length, 2);
  assert.equal(result.final_url, "https://example.test/final");
  assert.equal(result.status, "complete");
});

test("WebMCP result keeps the audit status, acquisition, scores, evidence, and actions", () => {
  const audit = inspectHtml(commercialPage, "https://example.test/services");
  const toolResult = toWebMcpResult(audit);
  assert.equal(toolResult.status, audit.status);
  assert.deepEqual(toolResult.acquisition, audit.acquisition);
  assert.deepEqual(toolResult.scores, audit.scores);
  assert.deepEqual(toolResult.readiness, audit.readiness);
  assert.deepEqual(toolResult.actions, audit.actions);
  assert.deepEqual(toolResult.evidence, audit.evidence);
});

test("Netlify endpoint rejects unsupported methods and unsafe input", async () => {
  const methodResponse = await auditHandler(new Request("https://demo.test/.netlify/functions/audit", { method: "GET" }));
  assert.equal(methodResponse.status, 405);
  const unsafeResponse = await auditHandler(new Request("https://demo.test/.netlify/functions/audit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1" }) }));
  assert.equal(unsafeResponse.status, 400);
  assert.match((await unsafeResponse.json()).error, /Local, private, and internal/);
});

test("sufficient static HTML does not invoke the renderer", async () => {
  let rendererCalls = 0;
  const result = await auditPublicPage("https://example.test/services", {
    fetchImpl: async () => htmlResponse(commercialPage), resolver: publicResolver,
    renderer: { renderPage: async () => { rendererCalls += 1; return successfulRenderer().renderPage(); } },
  });
  assert.equal(result.acquisition.method, "static");
  assert.equal(rendererCalls, 0);
});

test("thin JavaScript shell invokes the bounded renderer and audits rendered commerce", async () => {
  let rendererCalls = 0;
  const result = await auditPublicPage("https://example.test/app", {
    fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver,
    renderer: { renderPage: async (url) => { rendererCalls += 1; assert.equal(url, "https://example.test/app"); return successfulRenderer().renderPage(); } },
  });
  assert.equal(rendererCalls, 1);
  assert.equal(result.status, "complete");
  assert.equal(result.acquisition.status, "full");
  assert.equal(result.acquisition.method, "rendered");
  assert.equal(result.capabilities.offer.state, EvidenceState.OBSERVED);
  assert.equal(result.capabilities.pricing.state, EvidenceState.OBSERVED);
  assert.equal(result.capabilities.conversion.state, EvidenceState.OBSERVED);
});

test("explicit JavaScript-required page invokes the renderer", async () => {
  let rendererCalls = 0;
  const result = await auditPublicPage("https://example.test/app", {
    fetchImpl: async () => htmlResponse(javascriptRequired), resolver: publicResolver,
    renderer: { renderPage: async () => { rendererCalls += 1; return successfulRenderer().renderPage(); } },
  });
  assert.equal(rendererCalls, 1);
  assert.equal(result.acquisition.method, "rendered");
  assert.equal(result.scores.buyability, 85);
});

test("renderer timeout preserves limited evidence and never emits a commercial zero", async () => {
  const result = await auditPublicPage("https://example.test/app", {
    fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver,
    renderer: { renderPage: async () => ({ status: "timeout", rendered: false, reason: "Timed out", metadata: { provider: "test-renderer" } }) },
  });
  assert.equal(result.status, "limited");
  assert.equal(result.acquisition.renderer.status, "timeout");
  assert.equal(result.scores.understanding, null);
  assert.equal(result.scores.buyability, null);
});

test("renderer failure preserves limited evidence", async () => {
  const result = await auditPublicPage("https://example.test/app", {
    fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver,
    renderer: { renderPage: async () => ({ status: "failed", rendered: false, reason: "Provider error", metadata: { provider: "test-renderer" } }) },
  });
  assert.equal(result.status, "limited");
  assert.equal(result.acquisition.renderer.status, "failed");
  assert.equal(result.readiness.observed_readiness, null);
});

test("a renderer block is reported as blocked rather than fabricated evidence", async () => {
  const result = await auditPublicPage("https://example.test/app", {
    fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver,
    renderer: { renderPage: async () => ({ status: "blocked", rendered: false, reason: "CAPTCHA", metadata: { provider: "test-renderer" } }) },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.acquisition.status, "blocked");
  assert.equal(result.scores.buyability, null);
});

test("unsafe static targets never invoke the renderer", async () => {
  let rendererCalls = 0;
  await assert.rejects(() => auditPublicPage("http://127.0.0.1", {
    renderer: { renderPage: async () => { rendererCalls += 1; return successfulRenderer().renderPage(); } },
  }));
  assert.equal(rendererCalls, 0);
});

test("renderer output cannot bypass final URL safety validation", async () => {
  const result = await auditPublicPage("https://example.test/app", {
    fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver,
    renderer: successfulRenderer(commercialPage, "http://127.0.0.1/private"),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.acquisition.explanation, /unsafe destination/i);
});

test("Cloudflare renderer adapter uses bounded content acquisition and validates its target", async () => {
  let request;
  const renderer = createRendererFromEnv({ AGENTREADY_RENDERER_PROVIDER: "cloudflare-browser-run", CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token" }, {
    resolver: publicResolver,
    rendererFetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ success: true, result: commercialPage, meta: { finalUrl: "https://example.test/rendered", status: 200, redirectChain: [] } }), { status: 200, headers: { "content-type": "application/json", "x-browser-ms-used": "42" } });
    },
  });
  const result = await renderer.renderPage("https://example.test/app");
  assert.equal(result.status, "success");
  assert.equal(result.finalUrl, "https://example.test/rendered");
  assert.match(request.url, /browser-rendering\/content$/);
  assert.deepEqual(JSON.parse(request.init.body).rejectResourceTypes, ["image", "media", "font"]);
  assert.equal(request.init.headers.authorization, "Bearer test-token");
});

test("a limited audit replaces stale local readiness rather than inheriting it", () => {
  const prior = { current: { url: "https://example.test/app", score: 88, at: "2026-01-01T00:00:00.000Z" } };
  const limited = inspectHtml(thinShell, "https://example.test/app");
  const state = nextMonitoringState(prior, limited, "2026-01-02T00:00:00.000Z");
  assert.equal(state.previous.score, 88);
  assert.equal(state.current.score, null);
  assert.equal(state.current.readiness_state, "insufficient_evidence");
});

test("limited recommendation uses the agent-accessible wording and grounded context", () => {
  const result = inspectHtml(thinShell, "https://example.test/app");
  const action = result.actions[0];
  assert.equal(action.title, "Make key commercial information agent-accessible");
  assert.match(action.reason, /server-rendered HTML and\/or validated structured data/i);
});
