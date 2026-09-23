import { BillingError, currentEntitlement, jsonResponse, logBillingFailure } from "./lib/billing.mjs";

export default async (request, dependencies = {}) => {
  if (request.method !== "GET") return jsonResponse({ ok: false, active: false, error: "Method not allowed." }, 405, { allow: "GET" });
  try {
    const websiteUrl = new URL(request.url).searchParams.get("website_url") || "";
    const state = await currentEntitlement(request, websiteUrl, dependencies);
    return jsonResponse({ ok: true, active: state.active });
  } catch (error) {
    logBillingFailure(error, dependencies);
    if (error instanceof BillingError) return jsonResponse({ ok: false, active: false, error: error.message }, error.status);
    return jsonResponse({ ok: false, active: false, error: "Subscription status is temporarily unavailable." }, 502);
  }
};
