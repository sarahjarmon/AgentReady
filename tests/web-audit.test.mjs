import assert from "node:assert/strict";
import test from "node:test";

import { auditPublicPage, createRendererFromEnv, EvidenceState, inspectHtml, isBlockedHostname, isPrivateIp, validatePublicUrl } from "../netlify/functions/lib/audit-core.mjs";
import auditHandler from "../netlify/functions/audit.mjs";
import leadHandler from "../netlify/functions/capture-lead.mjs";
import entitlementHandler from "../netlify/functions/entitlement-status.mjs";
import { currentEntitlement, entitlementCookie, entitlementCookieHeader } from "../netlify/functions/lib/billing.mjs";
import { aiReadinessScore, buildLeadPayload, primaryFinding, reportAccessState, submitLead } from "../web/commercial.js";
import { isMonitoringComparable, nextMonitoringState } from "../web/monitoring.js";
import { toWebMcpResult } from "../web/webmcp.js";

const commercialPage = `<!doctype html><html><head><title>Acme Workshop</title><meta name="description" content="Custom furniture for homes and offices"><link rel="canonical" href="https://example.test/services"></head><body><header><h1>Custom furniture service</h1></header><main><h2>Furniture consultation</h2><p>We design and build furniture. From 90 € with delivery in Europe. Visa accepted.</p><a href="/quote">Request a quote</a><h2>How we work</h2><p>Tell us about your project and we will respond with a tailored proposal.</p></main></body></html>`;
const thinShell = `<!doctype html><html><head><title>App</title><script src="/runtime.js"></script><script src="/main.js"></script><script src="/vendor.js"></script><script src="/chunk-a.js"></script><script src="/chunk-b.js"></script></head><body><div id="root"></div></body></html>`;
const javascriptRequired = `<!doctype html><html><head><title>JavaScript is disabled</title></head><body><p>JavaScript is disabled. Please enable JavaScript to continue.</p></body></html>`;
const incompleteRenderedPage = `<!doctype html><html><head><title>Acme</title><meta name="description" content="A long enough description of the company and the work it does for its customers."></head><body><h1>Acme</h1><h2>About our company</h2><p>We help customers with carefully designed work and thoughtful advice across a range of projects.</p><h2>Contact</h2><p>Send a message to our team for more information.</p><a href="mailto:hello@example.test">Email us</a></body></html>`;
const changedCommercialPage = commercialPage.replace("Visa accepted.", "");
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const htmlResponse = (html) => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
const successfulRenderer = (html = commercialPage, finalUrl = "https://example.test/rendered") => ({ renderPage: async () => ({ status: "success", rendered: true, html, finalUrl, metadata: { provider: "test-renderer", timing_ms: 12 } }) });
const supabaseTestEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "server-only-test-value" };
const entitlementTestEnv = { ...supabaseTestEnv, AGENTREADY_ENTITLEMENT_SECRET: "01234567890123456789012345678901" };
const validLead = (overrides = {}) => ({
  email: "Sarah@example.test ",
  website_url: "https://example.test/services",
  readiness_score: 72,
  visibility_score: 80,
  understanding_score: 70,
  buyability_score: 66,
  audit_status: "complete",
  ...overrides,
});
const leadRequest = (payload) => new Request("https://demo.test/.netlify/functions/capture-lead", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
});

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

test("commercial summary uses only the final observed audit result", () => {
  const audit = inspectHtml(commercialPage, "https://example.test/services");
  const finding = primaryFinding(audit);
  assert.equal(aiReadinessScore(audit), audit.readiness.observed_readiness);
  assert.equal(finding.title, "No urgent issue observed on this page");
  assert.match(finding.reason, /bounded audit/i);
});

test("commercial summary preserves unknown readiness when evidence is insufficient", () => {
  const audit = inspectHtml(thinShell, "https://example.test/app");
  assert.equal(aiReadinessScore(audit), null);
  assert.equal(primaryFinding(audit).title, audit.actions[0].title);
});

test("Founder Plan and the full report remain hidden before email submission", () => {
  const state = reportAccessState(false);
  assert.equal(state.fullReportHidden, true);
  assert.equal(state.founderOfferHidden, true);
});

test("valid email submission unlocks the full report and Founder Plan", () => {
  const state = reportAccessState(true);
  assert.equal(state.fullReportHidden, false);
  assert.equal(state.founderOfferHidden, false);
});

test("a new audit resets previously unlocked commercial report access", () => {
  assert.equal(reportAccessState(true).founderOfferHidden, false);
  const stateForNewAudit = reportAccessState(false);
  assert.equal(stateForNewAudit.fullReportHidden, true);
  assert.equal(stateForNewAudit.founderOfferHidden, true);
});

test("paid entitlement cookie is signed, HttpOnly, and website-bound", async () => {
  const lead = { id: "lead_paid", website_url: "https://example.test/services", stripe_subscription_id: "sub_paid", subscription_status: "active", founder_price_locked: true };
  const token = entitlementCookie(lead, lead.website_url, entitlementTestEnv);
  const request = new Request("https://demo.test/.netlify/functions/entitlement-status", { headers: { cookie: `agentready_entitlement=${token}` } });
  const state = await currentEntitlement(request, { env: entitlementTestEnv, fetchImpl: async (url) => { assert.match(String(url), /id=eq\.lead_paid/); return new Response(JSON.stringify([lead]), { status: 200 }); } });
  assert.equal(state.active, true);
  assert.match(entitlementCookieHeader(token), /HttpOnly/);
  const endpointResponse = await entitlementHandler(request, { env: entitlementTestEnv, fetchImpl: async () => new Response(JSON.stringify([lead]), { status: 200 }) });
  assert.deepEqual(await endpointResponse.json(), { ok: true, active: true, website_url: lead.website_url });
});

test("entitlement endpoint rechecks active subscription state server-side", async () => {
  const lead = { id: "lead_paid", website_url: "https://example.test/services", stripe_subscription_id: "sub_paid", subscription_status: "canceled", founder_price_locked: true };
  const token = entitlementCookie({ id: lead.id }, lead.website_url, entitlementTestEnv);
  const response = await entitlementHandler(new Request("https://demo.test/.netlify/functions/entitlement-status", { headers: { cookie: `agentready_entitlement=${token}` } }), { env: entitlementTestEnv, fetchImpl: async () => new Response(JSON.stringify([lead]), { status: 200 }) });
  assert.deepEqual(await response.json(), { ok: true, active: false });
});

test("forged, expired, and website-mismatched entitlements fail closed", async () => {
  const lead = { id: "lead_paid", website_url: "https://example.test/services", stripe_subscription_id: "sub_paid", subscription_status: "active", founder_price_locked: true };
  const valid = entitlementCookie(lead, lead.website_url, entitlementTestEnv);
  const forged = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
  const expired = entitlementCookie(lead, lead.website_url, entitlementTestEnv, 1_000);
  const requestFor = (token) => new Request("https://demo.test/.netlify/functions/entitlement-status", { headers: { cookie: `agentready_entitlement=${token}` } });
  for (const request of [requestFor(forged), requestFor(expired)]) {
    const response = await entitlementHandler(request, { env: entitlementTestEnv, fetchImpl: async () => { throw new Error("invalid entitlement must not query lead"); } });
    assert.deepEqual(await response.json(), { ok: true, active: false });
  }
  const mismatchedLead = { ...lead, website_url: "https://other.test/" };
  const response = await entitlementHandler(requestFor(valid), { env: entitlementTestEnv, fetchImpl: async () => new Response(JSON.stringify([mismatchedLead]), { status: 200 }) });
  assert.deepEqual(await response.json(), { ok: true, active: false });
});

test("paid UI no longer uses the localStorage paid flag", async () => {
  const app = await (await import("node:fs/promises")).readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const success = await (await import("node:fs/promises")).readFile(new URL("../web/success.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /agentready\.paid-verified/);
  assert.doesNotMatch(success, /agentready\.paid-verified/);
  assert.match(app, /entitlement-status/);
});

test("valid lead submission is normalized and upserted only by the server-side Function", async () => {
  let received;
  const response = await leadHandler(leadRequest(validLead()), {
    env: supabaseTestEnv,
    fetchImpl: async (url, init) => {
      received = { url: String(url), init, payload: JSON.parse(init.body) };
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(received.url, "https://project.supabase.co/rest/v1/leads?on_conflict=email%2Cwebsite_url");
  assert.equal(received.init.headers.apikey, "server-only-test-value");
  assert.equal("authorization" in received.init.headers, false);
  assert.equal(received.init.headers.prefer, "resolution=merge-duplicates,return=minimal");
  assert.equal(received.payload[0].email, "sarah@example.test");
  assert.equal(received.payload[0].website_url, "https://example.test/services");
});

test("legacy server-only variable remains a backend-only fallback", async () => {
  let receivedKey;
  const response = await leadHandler(leadRequest(validLead()), {
    env: { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "legacy-server-only-test-value" },
    fetchImpl: async (_url, init) => {
      receivedKey = init.headers.apikey;
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(response.status, 201);
  assert.equal(receivedKey, "legacy-server-only-test-value");
});

test("Supabase authentication failures are logged safely while the browser gets a generic error", async () => {
  const warnings = [];
  const response = await leadHandler(leadRequest(validLead()), {
    env: supabaseTestEnv,
    fetchImpl: async () => new Response(null, { status: 401 }),
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "We couldn't save your details. Please try again." });
  assert.deepEqual(warnings, [["lead_capture_failure", { kind: "authentication", status: 502 }]]);
});

test("request setup failures are classified without logging request values", async () => {
  const warnings = [];
  const response = await leadHandler(leadRequest(validLead()), {
    env: supabaseTestEnv,
    fetchImpl: async () => { throw new TypeError("request setup failed"); },
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(warnings, [["lead_capture_failure", { kind: "request_setup", status: 502 }]]);
});

test("invalid lead email and URL are rejected before any Supabase request", async () => {
  let calls = 0;
  const dependencies = { env: supabaseTestEnv, fetchImpl: async () => { calls += 1; return new Response(null, { status: 201 }); } };
  const badEmail = await leadHandler(leadRequest(validLead({ email: "not-an-email" })), dependencies);
  const badUrl = await leadHandler(leadRequest(validLead({ website_url: "ftp://example.test" })), dependencies);
  assert.equal(badEmail.status, 400);
  assert.equal(badUrl.status, 400);
  assert.equal(calls, 0);
});

test("invalid scores are rejected while null unknown scores are retained", async () => {
  const invalid = await leadHandler(leadRequest(validLead({ visibility_score: 101 })), { env: supabaseTestEnv, fetchImpl: async () => new Response(null, { status: 201 }) });
  assert.equal(invalid.status, 400);
  let saved;
  const accepted = await leadHandler(leadRequest(validLead({ readiness_score: null, visibility_score: null, understanding_score: null, buyability_score: null })), {
    env: supabaseTestEnv,
    fetchImpl: async (_url, init) => { saved = JSON.parse(init.body)[0]; return new Response(null, { status: 201 }); },
  });
  assert.equal(accepted.status, 201);
  assert.deepEqual([saved.readiness_score, saved.visibility_score, saved.understanding_score, saved.buyability_score], [null, null, null, null]);
});

test("backend failure does not unlock the full report or Founder Plan", async () => {
  await assert.rejects(() => submitLead(validLead(), async () => new Response(JSON.stringify({ ok: false, error: "Please retry." }), { status: 502, headers: { "content-type": "application/json" } })), /Please retry/);
  const state = reportAccessState(false);
  assert.equal(state.fullReportHidden, true);
  assert.equal(state.founderOfferHidden, true);
});

test("successful backend capture unlocks the report and Founder Plan for the current audit", async () => {
  const audit = inspectHtml(commercialPage, "https://example.test/services");
  const payload = buildLeadPayload(" Owner@Example.Test ", audit);
  await submitLead(payload, async (url, init) => {
    assert.equal(url, "/.netlify/functions/capture-lead");
    assert.equal(JSON.parse(init.body).email, "owner@example.test");
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } });
  });
  const state = reportAccessState(true);
  assert.equal(state.fullReportHidden, false);
  assert.equal(state.founderOfferHidden, false);
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
  assert.equal(JSON.parse(request.init.body).gotoOptions.waitUntil, "networkidle2");
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

test("a static-limited then successful rendered audit is stored as the comparable final score", async () => {
  const finalAudit = await auditPublicPage("https://example.test/app", {
    fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver,
    renderer: successfulRenderer(),
  });
  const priorScored = { current: { url: "https://example.test/app", score: 62, acquisition: "full", readiness_state: "observed", monitoring_eligible: true, at: "2026-01-01T00:00:00.000Z" } };
  const state = nextMonitoringState(priorScored, finalAudit, "2026-01-02T00:00:00.000Z");
  assert.equal(finalAudit.acquisition.method, "rendered");
  assert.equal(finalAudit.readiness.state, "observed");
  assert.equal(state.current.acquisition, "full");
  assert.equal(state.current.readiness_state, "observed");
  assert.equal(state.current.monitoring_eligible, true);
  assert.ok(Number.isFinite(state.current.score));
  assert.equal(state.previous.score, 62);
});

test("equivalent rendered acquisitions are equally scored and monitoring-comparable", async () => {
  const dependencies = { fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver, renderer: successfulRenderer() };
  const first = await auditPublicPage("https://example.test/app", dependencies);
  const second = await auditPublicPage("https://example.test/app", dependencies);
  const firstState = nextMonitoringState(null, first, "2026-01-01T00:00:00.000Z");
  const secondState = nextMonitoringState(firstState, second, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(second.scores, first.scores);
  assert.equal(first.acquisition.monitoring_eligible, true);
  assert.equal(second.acquisition.monitoring_eligible, true);
  assert.equal(isMonitoringComparable(secondState.current, secondState.previous), true);
});

test("thin rendered evidence is scored but cannot create a false monitoring degradation", async () => {
  const strongAudit = await auditPublicPage("https://example.test/app", { fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver, renderer: successfulRenderer() });
  const thinAudit = await auditPublicPage("https://example.test/app", { fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver, renderer: successfulRenderer(incompleteRenderedPage) });
  const strongState = nextMonitoringState(null, strongAudit, "2026-01-01T00:00:00.000Z");
  const thinState = nextMonitoringState(strongState, thinAudit, "2026-01-02T00:00:00.000Z");
  assert.ok(thinState.current.score < strongState.current.score);
  assert.equal(thinAudit.acquisition.monitoring_eligible, false);
  assert.equal(isMonitoringComparable(thinState.current, thinState.previous), false);
});

test("changed but sufficiently complete rendered evidence still produces a real monitoring delta", async () => {
  const firstAudit = await auditPublicPage("https://example.test/app", { fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver, renderer: successfulRenderer(commercialPage) });
  const changedAudit = await auditPublicPage("https://example.test/app", { fetchImpl: async () => htmlResponse(thinShell), resolver: publicResolver, renderer: successfulRenderer(changedCommercialPage) });
  const firstState = nextMonitoringState(null, firstAudit, "2026-01-01T00:00:00.000Z");
  const changedState = nextMonitoringState(firstState, changedAudit, "2026-01-02T00:00:00.000Z");
  assert.equal(firstAudit.acquisition.monitoring_eligible, true);
  assert.equal(changedAudit.acquisition.monitoring_eligible, true);
  assert.equal(isMonitoringComparable(changedState.current, changedState.previous), true);
  assert.ok(changedState.current.score < changedState.previous.score);
});

test("limited recommendation uses the agent-accessible wording and grounded context", () => {
  const result = inspectHtml(thinShell, "https://example.test/app");
  const action = result.actions[0];
  assert.equal(action.title, "Make key commercial information agent-accessible");
  assert.match(action.reason, /server-rendered HTML and\/or validated structured data/i);
});
