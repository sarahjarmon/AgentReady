import { lookup } from "node:dns/promises";
import net from "node:net";

export const AUDIT_SCOPE = "One public HTML page; no JavaScript execution, form submission, checkout, or authenticated content.";
const MAX_BYTES = 750_000;
const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;

const COMMERCIAL_WORDS = /\b(product|products|shop|store|service|services|course|courses|booking|appointment|consultation|programme|program|formation|formations|produit|produits|service|services|cours|r[ée]servation|rendez[- ]vous|tarif|tarifs|offre|offres)\b/i;
const CTA_WORDS = /\b(add to cart|buy now|buy|order|checkout|book now|book|reserve|request a quote|contact us|ajouter au panier|acheter|commander|r[ée]server|prendre rendez[- ]vous|demander un devis|obtenir un devis|contactez[- ]nous)\b/i;
const QUOTE_WORDS = /\b(request a quote|quote|demander un devis|obtenir un devis|devis)\b/i;
const AVAILABILITY_WORDS = /\b(in stock|out of stock|available|availability|opening hours|open |en stock|rupture|disponible|disponibilit[ée]|horaires|ouvert)\b/i;
const PAYMENT_WORDS = /\b(visa|mastercard|paypal|payment|paiement|carte bancaire|apple pay)\b/i;
const AREA_WORDS = /\b(shipping|delivery|deliver|service area|address|livraison|livrons|zone desservie|adresse|retrait)\b/i;
const PRICE_RE = /(?:€\s*\d+(?:[\s\u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?|\d+(?:[\s\u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?\s*(?:€|EUR|\$|USD|£|GBP))/gi;

export function validatePublicUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("Enter a valid absolute URL.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Only unauthenticated http/https URLs are allowed.");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error("Local, private, and internal destinations are not allowed.");
  }
  return url;
}

export function isBlockedHostname(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
}

export function isPrivateIp(ip) {
  if (net.isIP(ip) === 6) {
    const value = ip.toLowerCase();
    if (value.startsWith("::ffff:")) return isPrivateIp(value.slice(7));
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
  }
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function assertPublicResolution(hostname, resolver = lookup) {
  if (net.isIP(hostname)) return;
  let addresses;
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("The destination hostname could not be resolved safely.");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("The destination resolves to a local, private, or internal address.");
  }
}

async function readLimited(response, maxBytes = MAX_BYTES) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("The page response is larger than the demo safety limit.");
  if (!response.body?.getReader) return String(await response.text()).slice(0, maxBytes + 1);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The page response is larger than the demo safety limit.");
    }
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
      response = await fetchImpl(url, {
        method: "GET", redirect: "manual", signal: controller.signal,
        headers: { "User-Agent": "AgentReady-WebMCP-Demo/0.1 (+public-page-audit)", "Accept": "text/html,application/xhtml+xml" },
      });
    } catch (error) {
      throw new Error(error?.name === "AbortError" ? "The public page timed out." : "The public page could not be fetched.");
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The page returned an invalid redirect.");
      if (redirectCount === MAX_REDIRECTS) throw new Error("Too many redirects.");
      url = validatePublicUrl(new URL(location, url));
      continue;
    }
    if (!response.ok) throw new Error(`The public page returned HTTP ${response.status}.`);
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) throw new Error("The destination is not an HTML page.");
    return { html: await readLimited(response), finalUrl: url.toString(), status: response.status };
  }
  throw new Error("The page could not be fetched safely.");
}

function decode(value = "") {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function firstMatch(html, expression) {
  const match = html.match(expression);
  return match ? decode(match[1]) : "";
}

function collectMatches(html, expression, limit = 6) {
  return [...html.matchAll(expression)].map((match) => decode(match[1] || match[0])).filter(Boolean).slice(0, limit);
}

function compactEvidence(label, excerpt) {
  return { label, excerpt: decode(excerpt).slice(0, 220) };
}

export function inspectHtml(html, targetUrl) {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = firstMatch(html, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);
  const canonical = firstMatch(html, /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/i);
  const headings = collectMatches(html, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi);
  const actions = collectMatches(html, /<(?:a|button)[^>]*>([\s\S]*?)<\/(?:a|button)>/gi, 30).filter((value) => CTA_WORDS.test(value));
  const schemaBlocks = collectMatches(html, /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, 8);
  const visible = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<template[\s\S]*?<\/template>|<noscript[\s\S]*?<\/noscript>/gi, " "));
  const prices = (visible.match(PRICE_RE) || []).map((value) => value.trim()).slice(0, 6);
  const textSnippet = visible.slice(0, 5_000);
  const commercialHeadings = headings.filter((heading) => COMMERCIAL_WORDS.test(heading));
  const schemaCommerce = schemaBlocks.some((block) => /"@type"\s*:\s*"(?:Product|Service|Offer|Course|Event)"/i.test(block));
  const sameHostCanonical = (() => { try { return canonical && new URL(canonical, targetUrl).hostname === new URL(targetUrl).hostname; } catch { return false; } })();
  const facts = {
    identity: title || headings[0] ? "observed" : "unknown",
    offer: commercialHeadings.length || schemaCommerce ? "observed" : "unknown",
    pricing: prices.length ? "observed" : "unknown",
    conversion: actions.length ? "observed" : "unknown",
    availability: AVAILABILITY_WORDS.test(textSnippet) ? "observed" : "unknown",
    payment: PAYMENT_WORDS.test(textSnippet) ? "observed" : "unknown",
    geography: AREA_WORDS.test(textSnippet) ? "observed" : "unknown",
  };
  const evidence = {
    visibility: [
      compactEvidence("HTML page fetched", `HTTP page fetched from ${targetUrl}`),
      ...(title ? [compactEvidence("Page title", title)] : []),
      ...(description ? [compactEvidence("Meta description", description)] : []),
      ...(sameHostCanonical ? [compactEvidence("Same-host canonical URL", canonical)] : []),
    ],
    understanding: [
      ...(title || headings[0] ? [compactEvidence("Identity", title || headings[0])] : []),
      ...commercialHeadings.map((heading) => compactEvidence("Commercial heading", heading)),
      ...(schemaCommerce ? [compactEvidence("Structured commercial data", "Product, Service, Offer, Course, or Event JSON-LD was observed.")] : []),
      ...prices.map((price) => compactEvidence("Visible price", price)),
    ],
    buyability: [
      ...actions.slice(0, 5).map((action) => compactEvidence("Commercial action", action)),
      ...(facts.availability === "observed" ? [compactEvidence("Availability signal", "Availability, stock, opening-hours, or similar wording was observed.")] : []),
      ...(facts.payment === "observed" ? [compactEvidence("Payment signal", "A payment method or payment wording was observed.")] : []),
      ...(facts.geography === "observed" ? [compactEvidence("Geographic signal", "Delivery, service-area, address, or collection wording was observed.")] : []),
    ],
  };
  const visibility = 35 + (title ? 20 : 0) + (description ? 15 : 0) + (sameHostCanonical ? 15 : 0) + (headings.length >= 2 ? 15 : 0);
  const understanding = (facts.identity === "observed" ? 25 : 0) + (facts.offer === "observed" ? 35 : 0) + (facts.pricing === "observed" ? 15 : 0) + (description ? 10 : 0) + (schemaCommerce ? 15 : 0);
  const buyability = (facts.conversion === "observed" ? 40 : 0) + (facts.pricing === "observed" || QUOTE_WORDS.test(textSnippet) ? 25 : 0) + (facts.availability === "observed" ? 15 : 0) + (facts.payment === "observed" ? 10 : 0) + (facts.geography === "observed" ? 10 : 0);
  const actionsOut = [];
  if (facts.offer === "unknown") actionsOut.push({ priority: "high", title: "Make the main offer explicit", reason: "No commercial offer heading or supported structured-data signal was observed on this page." });
  if (facts.conversion === "unknown") actionsOut.push({ priority: "high", title: "Add a clear commercial next step", reason: "No purchase, booking, quote, or contact action was observed on this page." });
  if (facts.pricing === "unknown" && !QUOTE_WORDS.test(textSnippet)) actionsOut.push({ priority: "high", title: "Explain price or the quote process", reason: "No visible price or explicit quote mechanism was observed on this page." });
  if (facts.availability === "unknown") actionsOut.push({ priority: "medium", title: "State availability or timing", reason: "No stock, availability, opening-hours, or comparable signal was observed on this page." });
  if (facts.geography === "unknown") actionsOut.push({ priority: "medium", title: "Clarify delivery or service area", reason: "No delivery, service-area, address, or collection signal was observed on this page." });
  return {
    status: "complete", target_url: targetUrl, audit_scope: AUDIT_SCOPE,
    scores: { visibility, understanding, buyability }, facts, evidence,
    actions: actionsOut.slice(0, 5), summary: { title: title || "unknown", headings: headings.slice(0, 5), prices, commercial_actions: actions.slice(0, 5) },
  };
}

export async function auditPublicPage(url, dependencies = {}) {
  const page = await fetchPublicHtml(url, dependencies);
  return { ...inspectHtml(page.html, page.finalUrl), http_status: page.status, final_url: page.finalUrl };
}
