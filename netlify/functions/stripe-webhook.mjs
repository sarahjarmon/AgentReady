import { BillingError, findLeadById, findLeadBySubscription, jsonResponse, logBillingFailure, processStripeEvent, verifyStripeSignature } from "./lib/billing.mjs";
import { sendFounderWelcome } from "./lib/transactional-email.mjs";

export default async (request, dependencies = {}) => {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed." }, 405, { allow: "POST" });
  const env = dependencies.env || process.env;
  const payload = await request.text();
  if (!verifyStripeSignature(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET)) {
    return jsonResponse({ ok: false, error: "Invalid webhook signature." }, 400);
  }
  try {
    const event = JSON.parse(payload);
    if (!event?.id || !event?.type || !event?.data?.object) throw new BillingError("Invalid webhook payload.");
    const result = await processStripeEvent(event, dependencies);
    const welcomeEligibleEvent = result.onboarding || ["invoice.paid", "customer.subscription.created", "customer.subscription.updated"].includes(event.type);
    if (welcomeEligibleEvent) {
      try {
        const subscriptionId = event.data.object?.subscription || event.data.object?.id;
        const mappedLead = subscriptionId ? await findLeadBySubscription(subscriptionId, dependencies) : null;
        const leadId = event.data.object?.metadata?.agentready_lead_id || mappedLead?.id;
        const lead = leadId ? await findLeadById(leadId, dependencies) : null;
        if (result.onboarding || (lead?.subscription_status === "active" && lead?.founder_price_locked === true)) {
          await sendFounderWelcome(lead, dependencies);
        }
      } catch {
        // Email delivery is best-effort and cannot cause a verified Stripe webhook to fail.
        console.warn("founder_welcome_failure", { code: "delivery" });
      }
    }
    return jsonResponse({ ok: true, duplicate: result.duplicate, onboarding: result.onboarding }, 200);
  } catch (error) {
    logBillingFailure(error, dependencies);
    if (error instanceof BillingError) return jsonResponse({ ok: false, error: error.message }, error.status);
    return jsonResponse({ ok: false, error: "Webhook processing failed." }, 502);
  }
};
