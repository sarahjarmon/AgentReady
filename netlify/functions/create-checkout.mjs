import { BillingError, checkoutOrigin, createFounderCheckout, jsonResponse, logBillingFailure, normalizeLeadIdentity, parseJsonRequest } from "./lib/billing.mjs";

export default async (request, dependencies = {}) => {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed." }, 405, { allow: "POST" });
  try {
    const identity = normalizeLeadIdentity(await parseJsonRequest(request));
    const result = await createFounderCheckout(identity, checkoutOrigin(request), dependencies);
    if (result.state === "checkout") return jsonResponse({ ok: true, url: result.url }, 201);
    if (result.state === "founder_exhausted") return jsonResponse({ ok: false, code: result.state, error: "The Founder offer is fully allocated." }, 409);
    if (result.state === "already_active") return jsonResponse({ ok: false, code: result.state, error: "Your Founder Plan is already active." }, 409);
    return jsonResponse({ ok: false, code: result.state, error: "This Founder offer is no longer available for this subscription." }, 409);
  } catch (error) {
    logBillingFailure(error, dependencies);
    if (error instanceof BillingError) return jsonResponse({ ok: false, error: error.message }, error.status);
    return jsonResponse({ ok: false, error: "Checkout is temporarily unavailable. Please try again." }, 502);
  }
};
