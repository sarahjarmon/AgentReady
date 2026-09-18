export function aiReadinessScore(result) {
  const observed = result?.readiness?.observed_readiness;
  if (displayableScore(observed) !== null) return displayableScore(observed);
  const scores = result?.scores || {};
  const values = [scores.visibility, scores.understanding, scores.buyability];
  const numeric = values.map(displayableScore);
  return numeric.every((value) => value !== null) ? Math.round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length) : null;
}

export function displayableScore(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function normalizeAuditUrl(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

const attributionStorageKey = "apt4ai.attribution.v1";
const attributionNames = ["oppref", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

export function captureAttribution(locationLike = window.location, storage = window.localStorage) {
  const params = new URLSearchParams(locationLike.search || "");
  const captured = Object.fromEntries(attributionNames.filter((name) => params.get(name)).map((name) => [name, params.get(name)]));
  try {
    if (Object.keys(captured).length) storage.setItem(attributionStorageKey, JSON.stringify(captured));
    return JSON.parse(storage.getItem(attributionStorageKey) || "{}");
  } catch { return captured; }
}

export function trackConversion(eventName, details = {}, target = window) {
  const payload = { event: eventName, attribution: captureAttribution(), ...details };
  target.dispatchEvent(new CustomEvent("apt4ai_conversion", { detail: payload }));
  if (typeof target.apt4aiConversion === "function") target.apt4aiConversion(payload);
  if (typeof target.oaiq === "function") {
    if (eventName === "audit_completed") target.oaiq("measure", "custom", { type: "custom" }, { custom_event_name: "audit_completed" });
    if (eventName === "checkout_started") target.oaiq("measure", "checkout_started", { type: "contents" });
  }
  return payload;
}

export function primaryFinding(result) {
  const action = (result?.actions || []).find((item) => item.priority === "high") || result?.actions?.[0];
  if (action) return { title: action.title, reason: action.reason, priority: action.priority || "medium" };
  if (result?.score_status === "insufficient_evidence") {
    return { title: "More observable evidence is needed", reason: "This page could not be assessed reliably enough to identify a commercial priority.", priority: "high" };
  }
  return { title: "No urgent issue observed on this page", reason: "The bounded audit did not identify a higher-priority gap from the evidence it observed.", priority: "medium" };
}

export function reportAccessState(emailSubmitted) {
  const unlocked = emailSubmitted === true;
  return {
    fullReportHidden: !unlocked,
    founderOfferHidden: !unlocked,
  };
}

export function buildLeadPayload(email, audit) {
  return {
    email: String(email || "").trim().toLowerCase(),
    website_url: String(audit?.final_url || audit?.target_url || "").trim(),
    readiness_score: Number.isFinite(audit?.readiness?.observed_readiness) ? audit.readiness.observed_readiness : null,
    visibility_score: audit?.scores?.visibility ?? null,
    understanding_score: audit?.scores?.understanding ?? null,
    buyability_score: audit?.scores?.buyability ?? null,
    audit_status: audit?.status || "",
  };
}

export async function submitLead(payload, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl("/.netlify/functions/capture-lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("We couldn't save your details. Please try again.");
  }
  let result = null;
  try { result = await response.json(); } catch { /* Use the safe fallback below. */ }
  if (!response.ok || result?.ok !== true) throw new Error(result?.error || "We couldn't save your details. Please try again.");
  return result;
}

export async function createFounderCheckout(identity, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl("/.netlify/functions/create-checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: identity?.email, website_url: identity?.website_url }),
    });
  } catch {
    throw new Error("Checkout is temporarily unavailable. Please try again.");
  }
  let result = null;
  try { result = await response.json(); } catch { /* Use the safe fallback below. */ }
  if (!response.ok || result?.ok !== true || typeof result.url !== "string") {
    throw new Error(result?.error || "Checkout is temporarily unavailable. Please try again.");
  }
  return result.url;
}

export function createCheckoutGate(openCheckout) {
  let inFlight = false;
  return async (identity) => {
    if (inFlight) return null;
    inFlight = true;
    try { return await openCheckout(identity); }
    finally { inFlight = false; }
  };
}

export function checkoutConfirmationState(result) {
  return result?.ok === true && result.active === true
    ? { title: "Welcome to AgentReady", message: "Your Founder Plan is active. Your $39/month Founder price is locked while your subscription remains active.", confirmed: true }
    : { title: "Confirming your subscription…", message: "We’re confirming your verified Stripe subscription. This usually takes a moment.", confirmed: false };
}
