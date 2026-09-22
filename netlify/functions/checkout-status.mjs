import { BillingError, checkoutActivationState, jsonResponse, logBillingFailure } from "./lib/billing.mjs";

export default async (request, dependencies = {}) => {
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "Method not allowed." }, 405, { allow: "GET" });
  try {
    const sessionId = new URL(request.url).searchParams.get("session_id");
    const state = await checkoutActivationState(sessionId, dependencies);
    return jsonResponse({ ok: true, active: state.active, pending: state.pending }, 200);
  } catch (error) {
    logBillingFailure(error, dependencies);
    if (error instanceof BillingError) return jsonResponse({ ok: false, error: error.message }, error.status);
    return jsonResponse({ ok: false, error: "Subscription confirmation is temporarily unavailable." }, 502);
  }
};
