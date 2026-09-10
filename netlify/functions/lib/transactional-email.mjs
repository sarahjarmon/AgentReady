import { supabaseRequest } from "./billing.mjs";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function resendConfig(env) {
  const apiKey = typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY.trim() : "";
  const from = typeof env.RESEND_FROM_EMAIL === "string" ? env.RESEND_FROM_EMAIL.trim() : "";
  return apiKey && from ? { apiKey, from } : null;
}

async function reserveDelivery({ deliveryKey, kind, leadId, readinessHistoryId = null }, dependencies = {}) {
  const body = [{ delivery_key: deliveryKey, kind, lead_id: leadId, readiness_history_id: readinessHistoryId }];
  const inserted = await supabaseRequest("/rest/v1/transactional_email_deliveries", {
    method: "POST", body, prefer: "resolution=ignore-duplicates,return=representation",
  }, dependencies);
  if (Array.isArray(inserted) && inserted[0]) return true;

  const query = new URLSearchParams({ select: "status", delivery_key: `eq.${deliveryKey}`, limit: "1" });
  const existing = await supabaseRequest(`/rest/v1/transactional_email_deliveries?${query}`, {}, dependencies);
  if (!Array.isArray(existing) || existing[0]?.status !== "failed") return false;

  const retryQuery = new URLSearchParams({ delivery_key: `eq.${deliveryKey}`, status: "eq.failed" });
  const retried = await supabaseRequest(`/rest/v1/transactional_email_deliveries?${retryQuery}`, {
    method: "PATCH", body: { status: "pending", failed_at: null }, prefer: "return=representation",
  }, dependencies);
  return Array.isArray(retried) && retried.length === 1;
}

async function setDeliveryStatus(deliveryKey, patch, dependencies = {}) {
  const query = new URLSearchParams({ delivery_key: `eq.${deliveryKey}` });
  await supabaseRequest(`/rest/v1/transactional_email_deliveries?${query}`, {
    method: "PATCH", body: patch, prefer: "return=minimal",
  }, dependencies);
}

async function sendResendEmail({ to, subject, text }, dependencies = {}) {
  const env = dependencies.env || process.env;
  const config = resendConfig(env);
  if (!config) return { skipped: true };
  const fetchImpl = dependencies.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.from, to: [to], subject, text }),
    });
  } catch {
    return { sent: false };
  }
  if (!response.ok) return { sent: false };
  try {
    const data = await response.json();
    return { sent: true, id: typeof data?.id === "string" ? data.id : null };
  } catch {
    return { sent: true, id: null };
  }
}

async function deliver(message, delivery, dependencies = {}) {
  const env = dependencies.env || process.env;
  if (!resendConfig(env)) return { sent: false, skipped: true };
  if (!await reserveDelivery(delivery, dependencies)) return { sent: false, duplicate: true };
  const result = await sendResendEmail(message, dependencies);
  if (result.sent) {
    await setDeliveryStatus(delivery.deliveryKey, { status: "sent", resend_email_id: result.id, sent_at: new Date().toISOString() }, dependencies);
    return { sent: true };
  }
  await setDeliveryStatus(delivery.deliveryKey, { status: "failed", failed_at: new Date().toISOString() }, dependencies);
  return { sent: false };
}

export async function sendFounderWelcome(lead, dependencies = {}) {
  if (!lead?.id || !lead?.email || !lead?.website_url || !lead?.stripe_subscription_id) return { sent: false, skipped: true };
  return deliver({
    to: lead.email,
    subject: "Welcome to AgentReady — Founder Plan",
    text: `Welcome to AgentReady. Your $39/month Founder Plan is active for ${lead.website_url}. Your Founder price stays locked while your subscription remains continuously active. AgentReady will re-audit this website each week and keep a readiness history so meaningful changes can be reviewed. You can cancel anytime.`,
  }, {
    deliveryKey: `founder_welcome:${lead.id}:${lead.stripe_subscription_id}`,
    kind: "founder_welcome",
    leadId: lead.id,
  }, dependencies);
}

export async function sendReadinessDropAlert({ lead, auditId, previousScore, currentScore, delta }, dependencies = {}) {
  if (!lead?.id || !lead?.email || !lead?.website_url || !auditId) return { sent: false, skipped: true };
  const appUrl = typeof (dependencies.env || process.env).AGENTREADY_APP_URL === "string" ? (dependencies.env || process.env).AGENTREADY_APP_URL.trim() : "";
  return deliver({
    to: lead.email,
    subject: "Your AgentReady score changed",
    text: `AgentReady observed a readiness change for ${lead.website_url}. Previous readiness score: ${previousScore}. New readiness score: ${currentScore}. Change: ${delta}. The public signals available to AI agents have changed enough to warrant a review. Review your website in AgentReady${appUrl ? `: ${appUrl}` : "."}`,
  }, {
    deliveryKey: `readiness_drop:${auditId}`,
    kind: "readiness_drop_alert",
    leadId: lead.id,
    readinessHistoryId: auditId,
  }, dependencies);
}
