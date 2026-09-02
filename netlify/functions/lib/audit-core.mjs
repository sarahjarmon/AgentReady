import { lookup } from "node:dns/promises";
import net from "node:net";

export const AUDIT_SCOPE = "One public page; static HTML first, with an optional bounded rendered-DOM fallback. No form submission, checkout, or authenticated content.";
export const EvidenceState = Object.freeze({
  OBSERVED: "OBSERVED",
  NOT_OBSERVED: "NOT_OBSERVED",
  INSUFFICIENT: "INSUFFICIENT_EVIDENCE",
});

const MAX_BYTES = 750_000;
const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;
const RENDER_TIMEOUT_MS = 9_000;
const MAX_RENDERED_BYTES = 1_000_000;
const BLOCKED_STATUS = new Set([401, 403, 429, 451]);
const RENDERER_BLOCKED_STATUS = new Set([401, 403, 429, 451]);

const COMMERCIAL_WORDS = /\b(product|products|shop|store|service|services|course|courses|booking|appointment|appointments|consultation|consultations|programme|program|formation|formations|produit|produits|service|services|cours|r[ée]servation|rendez[- ]vous|tarif|tarifs|offre|offres|abonnement|subscription)\b/i;
const CTA_WORDS = /\b(add to cart|buy now|buy|order|checkout|book now|book|reserve|request a quote|contact us|sign up|subscribe|ajouter au panier|acheter|commander|r[ée]server|prendre rendez[- ]vous|demander un devis|obtenir un devis|contactez[- ]nous|nous contacter|s['’]inscrire|inscription|je m['’]inscris|appeler|appelez[- ]nous)\b/i;
const BOOKING_WORDS = /\b(book now|book|reserve|appointment|r[ée]server|r[ée]servation|prendre rendez[- ]vous|calendly)\b/i;
const QUOTE_WORDS = /\b(request a quote|quote|demander un devis|obtenir un devis|devis)\b/i;
const PURCHASE_WORDS = /\b(add to cart|buy now|buy|order|checkout|ajouter au panier|acheter|commander|panier|paiement)\b/i;
const CONTACT_WORDS = /\b(contact us|contactez[- ]nous|nous contacter|call us|appelez[- ]nous|appeler|whatsapp)\b/i;
const AVAILABILITY_WORDS = /\b(in stock|out of stock|available|availability|opening hours|open |en stock|rupture|disponible|disponibilit[ée]|horaires|ouvert|cr[ée]neau|places restantes)\b/i;
const PAYMENT_WORDS = /\b(visa|mastercard|paypal|payment|paiement|carte bancaire|apple pay|stripe)\b/i;
const AREA_WORDS = /\b(shipping|delivery|deliver|service area|address|livraison|livrons|zone desservie|adresse|retrait|click and collect)\b/i;
const JS_REQUIRED_WORDS = /\b(javascript is disabled|javascript required|enable javascript|please enable javascript|activez javascript|javascript d[ée]sactiv[ée]|requires javascript)\b/i;
const BOT_BLOCK_WORDS = /\b(verify you are human|security check|access denied|unusual traffic|captcha|cf-chl-|just a moment|checking your browser|robot check|v[ée]rifiez que vous [êe]tes humain)\b/i;
const PRICE_RE = /(?:(?:€|\$|£)\s*\d+(?:[\s\u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?|\d+(?:[\s\u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?\s*(?:€|EUR|\$|USD|£|GBP))/gi;

export function validatePublicUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("Enter a valid absolute URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Only unauthenticated http/https URLs are allowed.");
  if (isBlockedHostname(url.hostname)) throw new Error("Local, private, and internal destinations are not allowed.");
  return url;
}

export function isBlockedHostname(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  return net.isIP(host) ? isPrivateIp(host) : false;
}

export function isPrivateIp(ip) {
  if (net.isIP(ip) === 6) {
    const value = ip.toLowerCase();
    if (value.startsWith("::ffff:")) return isPrivateIp(value.slice(7));
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
  }
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((number) => !Number.isInteger(number) || number < 0 || number > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127) || first >= 224;
}

async function assertPublicResolution(hostname, resolver = lookup) {
  if (net.isIP(hostname)) return;
  let addresses;
  try { addresses = await resolver(hostname, { all: true, verbatim: true }); } catch { throw new Error("The destination hostname could not be resolved safely."); }
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error("The destination resolves to a local, private, or internal address.");
}

async function readLimited(response, maxBytes = MAX_BYTES) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("The page response is larger than the demo safety limit.");
  if (!response.body?.getReader) {
    const text = String(await response.text());
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("The page response is larger than the demo safety limit.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error("The page response is larger than the demo safety limit."); }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

export async function fetchPublicHtml(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const resolver = dependencies.resolver || lookup;
  let url = validatePublicUrl(input);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicResolution(url.hostname, resolver);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "User-Agent": "AgentReady-WebMCP-Demo/0.2 (+public-page-audit)", "Accept": "text/html,application/xhtml+xml" } });
    } catch (error) {
      throw new Error(error?.name === "AbortError" ? "The public page timed out." : "The public page could not be fetched.");
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The page returned an invalid redirect.");
      if (redirectCount === MAX_REDIRECTS) throw new Error("Too many redirects.");
      url = validatePublicUrl(new URL(location, url));
      continue;
    }
    if (BLOCKED_STATUS.has(response.status)) return { html: "", finalUrl: url.toString(), status: response.status, blocked: true };
    if (!response.ok) throw new Error(`The public page returned HTTP ${response.status}.`);
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) throw new Error("The destination is not an HTML page.");
    return { html: await readLimited(response), finalUrl: url.toString(), status: response.status, blocked: false };
  }
  throw new Error("The page could not be fetched safely.");
}

function rendererUnavailable(reason = "No rendered-page provider is configured for this deployment.") {
  return { status: "unavailable", rendered: false, reason, metadata: {} };
}

async function assertSafeRendererNavigation(urlValue, resolver) {
  const url = validatePublicUrl(urlValue);
  await assertPublicResolution(url.hostname, resolver);
  return url;
}

async function validateRenderedMetadata(metadata, fallbackUrl, resolver) {
  const chain = Array.isArray(metadata?.redirectChain) ? metadata.redirectChain : [];
  const candidates = [...chain.map((entry) => entry?.url).filter(Boolean), metadata?.finalUrl || fallbackUrl];
  let finalUrl = fallbackUrl;
  for (const candidate of candidates) {
    const safeUrl = await assertSafeRendererNavigation(candidate, resolver);
    finalUrl = safeUrl.toString();
  }
  return finalUrl;
}

/**
 * Cloudflare Browser Run's /content REST endpoint is deliberately kept behind
 * this small adapter. The audit engine only consumes the renderer contract,
 * so another isolated provider can replace it without changing scoring.
 */
export function createRendererFromEnv(env = process.env, dependencies = {}) {
  const provider = env.AGENTREADY_RENDERER_PROVIDER;
  if (!provider) return { provider: "none", renderPage: async () => rendererUnavailable() };
  if (provider !== "cloudflare-browser-run") {
    return { provider, renderPage: async () => rendererUnavailable("The configured rendered-page provider is not supported by this demo.") };
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    return { provider, renderPage: async () => rendererUnavailable("Rendered-page fallback is not configured with its required provider credentials.") };
  }
  const fetchImpl = dependencies.rendererFetchImpl || fetch;
  const resolver = dependencies.resolver || lookup;
  return {
    provider,
    async renderPage(input, options = {}) {
      const startedAt = Date.now();
      let target;
      try { target = await assertSafeRendererNavigation(input, resolver); }
      catch (error) { return { status: "blocked", rendered: false, reason: error instanceof Error ? error.message : "The renderer target could not be validated safely.", metadata: {} }; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || RENDER_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/content`, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            url: target.toString(),
            gotoOptions: { waitUntil: "domcontentloaded", timeout: Math.min(options.navigationTimeoutMs || 6_000, RENDER_TIMEOUT_MS) },
            rejectResourceTypes: ["image", "media", "font"],
          }),
        });
        if (RENDERER_BLOCKED_STATUS.has(response.status)) return { status: "blocked", rendered: false, reason: `The rendered-page provider returned HTTP ${response.status}.`, metadata: { provider, http_status: response.status, timing_ms: Date.now() - startedAt } };
        if (!response.ok) return { status: "failed", rendered: false, reason: `The rendered-page provider returned HTTP ${response.status}.`, metadata: { provider, http_status: response.status, timing_ms: Date.now() - startedAt } };
        const payload = JSON.parse(await readLimited(response, MAX_RENDERED_BYTES));
        if (!payload?.success || typeof payload.result !== "string" || !payload.result.trim()) {
          return { status: "failed", rendered: false, reason: payload?.errors?.[0]?.message || "The rendered-page provider returned no usable HTML.", metadata: { provider, timing_ms: Date.now() - startedAt } };
        }
        const finalUrl = await validateRenderedMetadata(payload.meta, target.toString(), resolver);
        return { status: "success", rendered: true, html: payload.result, finalUrl, reason: "Rendered public DOM acquired.", metadata: { provider, timing_ms: Date.now() - startedAt, http_status: payload.meta?.status || null, browser_ms: Number(response.headers.get("x-browser-ms-used")) || null } };
      } catch (error) {
        const timeout = error?.name === "AbortError";
        return { status: timeout ? "timeout" : "failed", rendered: false, reason: timeout ? "The rendered-page fallback timed out." : "The rendered-page fallback failed.", metadata: { provider, timing_ms: Date.now() - startedAt } };
      } finally { clearTimeout(timer); }
    },
  };
}

function decode(value = "") {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function firstMatch(html, expression) { const match = html.match(expression); return match ? decode(match[1]) : ""; }
function collectMatches(html, expression, limit = 8) { return [...html.matchAll(expression)].map((match) => decode(match[1] || match[0])).filter(Boolean).slice(0, limit); }
function compactEvidence(label, excerpt) { return { label, excerpt: decode(excerpt).slice(0, 220) }; }
function state(observed, acquisition) { return acquisition === "full" ? (observed ? EvidenceState.OBSERVED : EvidenceState.NOT_OBSERVED) : (observed ? EvidenceState.OBSERVED : EvidenceState.INSUFFICIENT); }

function actionSignals(html) {
  const source = [
    ...collectMatches(html, /<(?:a|button)[^>]*>([\s\S]*?)<\/(?:a|button)>/gi, 40),
    ...collectMatches(html, /<form[^>]*(?:action|name|id)=["']([^"']+)["'][^>]*>/gi, 12),
    ...collectMatches(html, /<(?:a|button)[^>]+(?:aria-label|title)=["']([^"']+)["'][^>]*>/gi, 20),
    ...collectMatches(html, /<a[^>]+href=["'](mailto:[^"']+|tel:[^"']+|https?:\/\/(?:wa\.me|api\.whatsapp\.com)[^"']*)["'][^>]*>/gi, 12),
  ];
  const actions = source.filter((value) => CTA_WORDS.test(value) || /mailto:|tel:|wa\.me|whatsapp/i.test(value));
  const joined = source.join(" ");
  return {
    values: actions.slice(0, 8),
    booking: BOOKING_WORDS.test(joined), quote: QUOTE_WORDS.test(joined), purchase: PURCHASE_WORDS.test(joined), contact: CONTACT_WORDS.test(joined) || /mailto:|tel:|wa\.me|whatsapp/i.test(joined),
  };
}

function assessAcquisition(html) {
  const visible = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<template[\s\S]*?<\/template>|<noscript[\s\S]*?<\/noscript>/gi, " "));
  const reason = [];
  if (BOT_BLOCK_WORDS.test(`${html} ${visible}`)) return { status: "blocked", visible, renderable: false, reasons: ["The public response appears to be an anti-bot, challenge, or access-control page rather than the business page."] };
  if (JS_REQUIRED_WORDS.test(`${html} ${visible}`)) return { status: "limited", hardLimited: true, renderable: true, visible, reasons: ["The response says that JavaScript is required or disabled."] };
  if (visible.length < 180) reason.push("The static HTML contains very little visible content.");
  const scriptSize = (html.match(/<script\b/gi) || []).length;
  if (visible.length < 500 && scriptSize >= 5) reason.push("The document looks like a thin application shell with many scripts.");
  return { status: reason.length ? "limited" : "full", hardLimited: false, renderable: visible.length < 500 && scriptSize >= 5, visible, reasons: reason };
}

function blockedResult(targetUrl, httpStatus, reason, acquisitionDetails = {}) {
  const capabilities = Object.fromEntries(["identity", "offer", "pricing", "conversion", "availability", "payment", "geography"].map((field) => [field, { state: EvidenceState.INSUFFICIENT, evidence: [] }]));
  return {
    status: "blocked", acquisition: { status: "blocked", method: acquisitionDetails.method || "static", renderer: acquisitionDetails.renderer || null, render_attempted: Boolean(acquisitionDetails.renderer), explanation: reason, reasons: [reason] }, target_url: targetUrl, final_url: targetUrl, http_status: httpStatus, audit_scope: AUDIT_SCOPE,
    scores: { visibility: null, understanding: null, buyability: null }, readiness: { observed_readiness: null, state: "insufficient_evidence" }, score_status: "insufficient_evidence", capabilities,
    evidence: { acquisition: [compactEvidence("Blocked public acquisition", reason)], visibility: [], understanding: [], buyability: [] },
    actions: [{ priority: "high", title: "Keep essential public information accessible to agents", reason: "AgentReady could not retrieve a representative public HTML page, so it cannot assess commercial readiness from this response." }],
    summary: { title: "unknown", headings: [], prices: [], commercial_actions: [], journey: "unknown" },
  };
}

export function inspectHtml(html, targetUrl, options = {}) {
  const acquisition = assessAcquisition(html);
  const method = options.method || "static";
  if (acquisition.status === "blocked") return blockedResult(targetUrl, 200, acquisition.reasons[0], { method, renderer: options.renderer || null });
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = firstMatch(html, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i) || firstMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);
  const canonical = firstMatch(html, /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/i);
  const headings = collectMatches(html, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi);
  const schemaBlocks = collectMatches(html, /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, 8);
  const prices = (acquisition.visible.match(PRICE_RE) || []).map((value) => value.trim()).slice(0, 6);
  const actions = actionSignals(html);
  const commercialHeadings = headings.filter((heading) => COMMERCIAL_WORDS.test(heading));
  const schemaCommerce = schemaBlocks.some((block) => /"@type"\s*:\s*"(?:Product|Service|Offer|Course|Event|LocalBusiness)"/i.test(block));
  const offerObserved = Boolean(commercialHeadings.length || schemaCommerce || (prices.length && actions.values.length));
  const sameHostCanonical = (() => { try { return canonical && new URL(canonical, targetUrl).hostname === new URL(targetUrl).hostname; } catch { return false; } })();
  const journey = actions.purchase ? "purchase" : actions.booking ? "booking" : actions.quote ? "quote" : actions.contact ? "contact" : "unknown";
  if (acquisition.status === "limited" && !acquisition.hardLimited && offerObserved && (journey !== "unknown" || prices.length > 0)) {
    acquisition.status = "full";
    acquisition.reasons = [];
  }
  const commercialContext = offerObserved || prices.length > 0 || journey !== "unknown";
  const capabilityValues = {
    identity: Boolean(title || headings[0]), offer: offerObserved, pricing: Boolean(prices.length), conversion: journey !== "unknown",
    availability: AVAILABILITY_WORDS.test(acquisition.visible), payment: PAYMENT_WORDS.test(acquisition.visible), geography: AREA_WORDS.test(acquisition.visible),
  };
  const evidence = {
    acquisition: acquisition.reasons.map((reason) => compactEvidence("Limited static acquisition", reason)),
    visibility: [compactEvidence("HTML page fetched", `HTTP page fetched from ${targetUrl}`), ...(title ? [compactEvidence("Page title", title)] : []), ...(description ? [compactEvidence("Meta description", description)] : []), ...(sameHostCanonical ? [compactEvidence("Same-host canonical URL", canonical)] : [])],
    understanding: [...(title || headings[0] ? [compactEvidence("Identity", title || headings[0])] : []), ...commercialHeadings.map((heading) => compactEvidence("Commercial heading", heading)), ...(schemaCommerce ? [compactEvidence("Structured commercial data", "Commercial JSON-LD was observed.")] : []), ...prices.map((price) => compactEvidence("Visible price", price))],
    buyability: [...actions.values.slice(0, 5).map((action) => compactEvidence("Commercial action", action)), ...(capabilityValues.availability ? [compactEvidence("Availability signal", "Availability, stock, opening-hours, or similar wording was observed.")] : []), ...(capabilityValues.payment ? [compactEvidence("Payment signal", "A payment method or payment wording was observed.")] : []), ...(capabilityValues.geography ? [compactEvidence("Geographic signal", "Delivery, service-area, address, or collection wording was observed.")] : []),],
  };
  const capabilities = Object.fromEntries(Object.entries(capabilityValues).map(([field, observed]) => [field, { state: state(observed, acquisition.status), evidence: observed ? (field === "conversion" ? evidence.buyability.filter((item) => item.label === "Commercial action") : field === "pricing" ? evidence.understanding.filter((item) => item.label === "Visible price") : field === "offer" ? evidence.understanding.filter((item) => /Commercial|Structured/.test(item.label)) : field === "identity" ? evidence.understanding.filter((item) => item.label === "Identity") : evidence.buyability) : [] }]));
  const visibility = 35 + (title ? 20 : 0) + (description ? 15 : 0) + (sameHostCanonical ? 15 : 0) + (headings.length >= 2 ? 15 : 0);
  const understanding = (capabilityValues.identity ? 25 : 0) + (capabilityValues.offer ? 35 : 0) + (capabilityValues.pricing ? 15 : 0) + (description ? 10 : 0) + (schemaCommerce ? 15 : 0);
  const buyability = (capabilityValues.conversion ? 40 : 0) + (capabilityValues.pricing || actions.quote ? 25 : 0) + (capabilityValues.availability ? 15 : 0) + (capabilityValues.payment ? 10 : 0) + (capabilityValues.geography ? 10 : 0);
  const limited = acquisition.status === "limited";
  const actionsOut = [];
  if (limited) {
    actionsOut.push({ priority: "high", title: "Make key commercial information agent-accessible", reason: "This audit received limited evidence. Expose essential offers, prices, and next steps in server-rendered HTML and/or validated structured data so agents can inspect them reliably." });
  } else if (commercialContext) {
    if (!capabilityValues.offer) actionsOut.push({ priority: "high", title: "Make the main offer explicit", reason: "No commercial offer heading, supported structured data, or corroborating price-and-action signal was observed on this page." });
    if (!capabilityValues.conversion) actionsOut.push({ priority: "high", title: "Add a clear commercial next step", reason: "No purchase, booking, quote, or contact action was observed on this page." });
    if (!capabilityValues.pricing && !actions.quote) actionsOut.push({ priority: "high", title: "Explain price or the quote process", reason: "A commercial context was observed, but no visible price or explicit quote mechanism was observed on this page." });
    if (["purchase", "booking"].includes(journey) && !capabilityValues.availability) actionsOut.push({ priority: "medium", title: "State availability or timing", reason: "The observed purchase or booking journey has no stock, timing, opening-hours, or availability signal on this page." });
  } else if (!capabilityValues.identity) {
    actionsOut.push({ priority: "medium", title: "Clarify the organization and its purpose", reason: "No clear title or primary heading was observed in the public HTML." });
  }
  const scores = { visibility, understanding: limited ? null : understanding, buyability: limited ? null : buyability };
  return {
    status: limited ? "limited" : "complete", acquisition: { status: acquisition.status, method, renderer: options.renderer || null, render_attempted: Boolean(options.renderer), rendering_recommended: Boolean(acquisition.renderable && limited), explanation: limited ? "The acquired response may not represent the user-visible page. Missing capabilities are marked as insufficient evidence, not absent." : method === "rendered" ? "A rendered public page was analyzed after static acquisition appeared incomplete." : "The static HTML contained enough visible content for this bounded public-page audit.", reasons: acquisition.reasons },
    target_url: targetUrl, audit_scope: AUDIT_SCOPE, scores, readiness: { observed_readiness: limited ? null : Math.round((visibility + understanding + buyability) / 3), state: limited ? "insufficient_evidence" : "observed" }, score_status: limited ? "insufficient_evidence" : "meaningful", capabilities, evidence, actions: actionsOut.slice(0, 4), summary: { title: title || "unknown", headings: headings.slice(0, 5), prices, commercial_actions: actions.values.slice(0, 5), journey },
  };
}

function limitedAfterRenderer(staticResult, rendererResult) {
  const reason = rendererResult.reason || "The rendered-page fallback did not return usable HTML.";
  return {
    ...staticResult,
    acquisition: {
      ...staticResult.acquisition,
      renderer: { status: rendererResult.status, rendered: false, ...(rendererResult.metadata || {}) },
      render_attempted: true,
      explanation: "The static response appeared incomplete and rendered acquisition did not produce sufficient public evidence. Missing capabilities remain unknown.",
      reasons: [...staticResult.acquisition.reasons, reason],
    },
    evidence: { ...staticResult.evidence, acquisition: [...staticResult.evidence.acquisition, compactEvidence("Rendered fallback", reason)] },
  };
}

export async function auditPublicPage(url, dependencies = {}) {
  const page = await fetchPublicHtml(url, dependencies);
  if (page.blocked) return blockedResult(page.finalUrl, page.status, `The public page returned HTTP ${page.status}, which commonly indicates access control or rate limiting.`);
  const staticResult = inspectHtml(page.html, page.finalUrl, { method: "static" });
  if (staticResult.status !== "limited" || !staticResult.acquisition.rendering_recommended) {
    return { ...staticResult, http_status: page.status, final_url: page.finalUrl };
  }
  const renderer = dependencies.renderer || createRendererFromEnv(dependencies.env || process.env, dependencies);
  const rendered = await renderer.renderPage(page.finalUrl, { timeoutMs: RENDER_TIMEOUT_MS, navigationTimeoutMs: 6_000 });
  if (rendered.status === "success" && rendered.rendered && typeof rendered.html === "string") {
    let finalUrl;
    try { finalUrl = (await assertSafeRendererNavigation(rendered.finalUrl || page.finalUrl, dependencies.resolver || lookup)).toString(); }
    catch (error) { return blockedResult(page.finalUrl, page.status, `The rendered-page fallback returned an unsafe destination: ${error instanceof Error ? error.message : "destination validation failed"}`, { method: "static", renderer: { status: "blocked", rendered: false, ...(rendered.metadata || {}) } }); }
    const renderedResult = inspectHtml(rendered.html, finalUrl, { method: "rendered", renderer: { status: "success", rendered: true, ...(rendered.metadata || {}) } });
    return { ...renderedResult, http_status: page.status, final_url: finalUrl };
  }
  if (rendered.status === "blocked") {
    return blockedResult(page.finalUrl, page.status, `The static response was incomplete and the rendered-page fallback was blocked: ${rendered.reason || "access was denied"}`, { method: "static", renderer: { status: "blocked", rendered: false, ...(rendered.metadata || {}) } });
  }
  return { ...limitedAfterRenderer(staticResult, rendered), http_status: page.status, final_url: page.finalUrl };
}
