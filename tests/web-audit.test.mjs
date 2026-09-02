import assert from "node:assert/strict";
import test from "node:test";

import { auditPublicPage, inspectHtml, isBlockedHostname, isPrivateIp, validatePublicUrl } from "../netlify/functions/lib/audit-core.mjs";
import auditHandler from "../netlify/functions/audit.mjs";

test("rejects local, private, and non-web destinations", () => {
  for (const value of ["http://localhost:3000", "https://127.0.0.1", "http://10.0.0.8", "ftp://example.test", "http://[::1]"]) {
    assert.throws(() => validatePublicUrl(value));
  }
  assert.equal(isBlockedHostname("service.internal"), true);
  assert.equal(isPrivateIp("192.168.1.7"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("extracts only observed public-page signals and produces explainable actions", () => {
  const result = inspectHtml(`<!doctype html><html><head><title>Acme Workshop</title><meta name="description" content="Custom furniture for homes"><link rel="canonical" href="https://example.test/services"></head><body><h1>Custom furniture service</h1><h2>Furniture consultation</h2><p>From 90 € · delivery in Europe · Visa accepted.</p><a href="/quote">Request a quote</a></body></html>`, "https://example.test/services");
  assert.deepEqual(result.scores, { visibility: 100, understanding: 85, buyability: 85 });
  assert.equal(result.facts.pricing, "observed");
  assert.equal(result.facts.conversion, "observed");
  assert.equal(result.facts.availability, "unknown");
  assert.ok(result.actions.some((item) => item.title === "State availability or timing"));
  assert.ok(result.evidence.buyability.some((item) => item.label === "Commercial action"));
});

test("follows a bounded public redirect and returns the final audit", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url.toString());
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: "/final" } });
    return new Response("<title>Public page</title><h1>Useful service</h1><a>Contact us</a>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const result = await auditPublicPage("https://example.test/start", { fetchImpl, resolver });
  assert.equal(seen.length, 2);
  assert.equal(result.final_url, "https://example.test/final");
  assert.equal(result.status, "complete");
});

test("Netlify endpoint rejects unsupported methods and unsafe input", async () => {
  const methodResponse = await auditHandler(new Request("https://demo.test/.netlify/functions/audit", { method: "GET" }));
  assert.equal(methodResponse.status, 405);
  const unsafeResponse = await auditHandler(new Request("https://demo.test/.netlify/functions/audit", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1" }),
  }));
  assert.equal(unsafeResponse.status, 400);
  assert.match((await unsafeResponse.json()).error, /Local, private, and internal/);
});
