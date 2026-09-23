import { BillingError, currentEntitlement, jsonResponse, logBillingFailure } from "./lib/billing.mjs";

export default async (request, dependencies = {}) => {
  if (request.method !== "GET") return jsonResponse({ ok: false, active: false, error: "Method not allowed." }, 405, { allow: "GET" });
  try {
    const state = await currentEntitlement(request, dependencies);
    return jsonResponse({ ok: true, active: state.active, ...(state.active ? { website_url: state.website_url } : {}) });
  } catch (error) {
    logBillingFailure(error, dependencies);
    if (error instanceof BillingError) return jsonResponse({ ok: false, active: false, error: error.message }, error.status);
    return jsonResponse({ ok: false, active: false, error: "Subscription status is temporarily unavailable." }, 502);
  }
};
