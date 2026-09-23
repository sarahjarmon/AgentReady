import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { validatePublicUrl } from "./audit-core.mjs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOUNDER_OFFER = "founder_39";
const MAX_BODY_BYTES = 8_192;
const ENTITLEMENT_COOKIE = "agentready_entitlement";
const ENTITLEMENT_TTL_SECONDS = 60 * 60 * 24 * 30;

export class BillingError extends Error {
  constructor(message, status = 400, code = "invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function entitlementSecret(env) {
  const secret = env.AGENTREADY_ENTITLEMENT_SECRET;
  if (!secret || secret.length < 32) throw new BillingError("Subscription confirmation is not configured yet. Please try again later.", 503, "configuration");
  return secret;
}

function encodeEntitlement(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signEntitlement(value, env) {
  return createHmac("sha256", entitlementSecret(env)).update(value, "utf8").digest("base64url");
}

export function entitlementCookie(lead, websiteUrl, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = encodeEntitlement({ lead_id: lead.id, website_url: websiteUrl, exp: nowSeconds + ENTITLEMENT_TTL_SECONDS });
  return `${payload}.${signEntitlement(payload, env)}`;
}

function readCookie(request, name) {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

export function parseEntitlementCookie(request, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const value = readCookie(request, ENTITLEMENT_COOKIE);
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = signEntitlement(payload, env);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed?.lead_id && parsed?.website_url && Number(parsed.exp) > nowSeconds ? parsed : null;
  } catch { return null; }
}

export function entitlementCookieHeader(value, maxAge = ENTITLEMENT_TTL_SECONDS) {
  return `${ENTITLEMENT_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearEntitlementCookieHeader() {
  return `${ENTITLEMENT_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function normalizeLeadIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BillingError("Enter valid checkout details.");
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) throw new BillingError("Enter a valid email address.");
  const rawUrl = typeof input.website_url === "string" ? input.website_url.trim() : "";
  if (!rawUrl || rawUrl.length > 2_048) throw new BillingError("Enter a valid public website URL.");
  try { return { email, website_url: validatePublicUrl(rawUrl).toString() }; }
  catch { throw new BillingError("Enter a valid public website URL."); }
}

export async function parseJsonRequest(request) {
  const declaredSize = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) throw new BillingError("Request is too large.", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new BillingError("Request is too large.", 413);
  try { return JSON.parse(text); }
  catch { throw new BillingError("Enter valid checkout details."); }
}

function supabaseConfig(env) {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  let url;
  try { url = new URL(env.SUPABASE_URL); }
  catch { throw new BillingError("Checkout is not configured yet. Please try again later.", 503, "configuration"); }
  if (!key || url.protocol !== "https:" || url.username || url.password) {
    throw new BillingError("Checkout is not configured yet. Please try again later.", 503, "configuration");
  }
  return { url, key };
}

function stripeKey(env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_FOUNDER_PRICE_ID) {
    throw new BillingError("Checkout is not configured yet. Please try again later.", 503, "configuration");
  }
  return env.STRIPE_SECRET_KEY;
}

async function safeJson(result) {
  try { return await result.json(); }
  catch { return null; }
}

export async function supabaseRequest(path, options, dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const { url, key } = supabaseConfig(env);
  const requestUrl = new URL(path, url);
  let result;
  try {
    result = await fetchImpl(requestUrl, {
      method: options.method || "GET",
      headers: {
        apikey: key,
        "content-type": "application/json",
        ...(options.prefer ? { prefer: options.prefer } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    throw new BillingError("Billing storage is temporarily unavailable. Please try again.", 502, error instanceof TypeError && !error.cause ? "request_setup" : "network");
  }
  if (!result.ok) throw new BillingError("Billing storage is temporarily unavailable. Please try again.", 502, result.status === 401 ? "authentication" : result.status === 403 ? "authorization" : "upstream");
  return safeJson(result);
}

export async function findLead(identity, dependencies) {
  const query = new URLSearchParams({
    select: "id,email,website_url,stripe_customer_id,stripe_subscription_id,subscription_status,founder_price_locked",
    email: `eq.${identity.email}`,
    website_url: `eq.${identity.website_url}`,
    limit: "1",
  });
  const rows = await supabaseRequest(`/rest/v1/leads?${query}`, {}, dependencies);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function findLeadById(leadId, dependencies) {
  const query = new URLSearchParams({ select: "id,email,website_url,stripe_customer_id,stripe_subscription_id,subscription_status,founder_price_locked", id: `eq.${leadId}`, limit: "1" });
  const rows = await supabaseRequest(`/rest/v1/leads?${query}`, {}, dependencies);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function findUniqueLeadByEmail(email, dependencies) {
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email)) return null;
  const query = new URLSearchParams({
    select: "id,email,website_url,stripe_customer_id,stripe_subscription_id,subscription_status,founder_price_locked",
    email: `eq.${email.trim().toLowerCase()}`,
    limit: "2",
  });
  const rows = await supabaseRequest(`/rest/v1/leads?${query}`, {}, dependencies);
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

export async function findLeadBySubscription(subscriptionId, dependencies) {
  if (typeof subscriptionId !== "string" || !subscriptionId) return null;
  const query = new URLSearchParams({
    select: "id,email,website_url,stripe_customer_id,stripe_subscription_id,subscription_status,founder_price_locked",
    stripe_subscription_id: `eq.${subscriptionId}`,
    limit: "1",
  });
  const rows = await supabaseRequest(`/rest/v1/leads?${query}`, {}, dependencies);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function updateLead(leadId, patch, dependencies) {
  const query = new URLSearchParams({ id: `eq.${leadId}` });
  await supabaseRequest(`/rest/v1/leads?${query}`, { method: "PATCH", body: patch, prefer: "return=minimal" }, dependencies);
}

export async function reserveFounderCheckout(leadId, dependencies) {
  const rows = await supabaseRequest("/rest/v1/rpc/reserve_founder_checkout", {
    method: "POST", body: { p_lead_id: leadId }, prefer: "return=representation",
  }, dependencies);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function saveCheckoutSession(reservationId, sessionId, dependencies) {
  const query = new URLSearchParams({ id: `eq.${reservationId}` });
  await supabaseRequest(`/rest/v1/founder_checkout_reservations?${query}`, {
    method: "PATCH", body: { stripe_checkout_session_id: sessionId }, prefer: "return=minimal",
  }, dependencies);
}

function stripeHeaders(secretKey) {
  return {
    authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
    "content-type": "application/x-www-form-urlencoded",
    "stripe-version": "2026-07-29.dahlia",
  };
}

export async function stripeRequest(path, options, dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const secretKey = stripeKey(env);
  let result;
  try {
    result = await fetchImpl(new URL(path, "https://api.stripe.com"), {
      method: options.method || "GET",
      headers: stripeHeaders(secretKey),
      ...(options.form ? { body: new URLSearchParams(options.form).toString() } : {}),
    });
  } catch (error) {
    throw new BillingError("Checkout is temporarily unavailable. Please try again.", 502, error instanceof TypeError && !error.cause ? "request_setup" : "network");
  }
  const data = await safeJson(result);
  if (!result.ok) throw new BillingError("Checkout is temporarily unavailable. Please try again.", 502, result.status === 401 ? "authentication" : "upstream");
  return data;
}

function checkoutForm({ lead, reservationId, origin, priceId }) {
  const metadata = {
    "metadata[agentready_lead_id]": lead.id,
    "metadata[agentready_offer]": FOUNDER_OFFER,
    "metadata[agentready_reservation_id]": reservationId,
    "subscription_data[metadata][agentready_lead_id]": lead.id,
    "subscription_data[metadata][agentready_offer]": FOUNDER_OFFER,
    "subscription_data[metadata][agentready_reservation_id]": reservationId,
  };
  return {
    mode: "subscription",
    customer_email: lead.email,
    client_reference_id: lead.id,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?checkout=cancelled`,
    integration_identifier: `agentready_founder_${randomBytes(4).toString("hex")}`,
    ...metadata,
  };
}

export async function createFounderCheckout(identity, origin, dependencies = {}) {
  const env = dependencies.env || process.env;
  // Validate all Stripe configuration before reserving one of the limited slots.
  stripeKey(env);
  const lead = await findLead(identity, dependencies);
  if (!lead) throw new BillingError("Save your audit details before starting checkout.", 409, "lead_missing");
  if (lead.subscription_status === "active") return { state: "already_active" };
  if (lead.founder_price_locked) return { state: "founder_ineligible" };
  const reservation = await reserveFounderCheckout(lead.id, dependencies);
  if (!reservation?.eligible) return { state: "founder_exhausted" };
  const session = await stripeRequest("/v1/checkout/sessions", {
    method: "POST",
    form: checkoutForm({ lead, reservationId: reservation.reservation_id, origin, priceId: env.STRIPE_FOUNDER_PRICE_ID }),
  }, dependencies);
  if (!session?.id || !session?.url) throw new BillingError("Checkout is temporarily unavailable. Please try again.", 502, "upstream");
  await saveCheckoutSession(reservation.reservation_id, session.id, dependencies);
  return { state: "checkout", url: session.url };
}

export function verifyStripeSignature(payload, signature, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || !signature) return false;
  const parts = signature.split(",");
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^[0-9]+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300 || !signatures.length) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return signatures.some((candidate) => {
    if (!/^[0-9a-f]+$/i.test(candidate) || candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
  });
}

export async function webhookAlreadyProcessed(eventId, dependencies) {
  const query = new URLSearchParams({ select: "id", id: `eq.${eventId}`, limit: "1" });
  const rows = await supabaseRequest(`/rest/v1/stripe_webhook_events?${query}`, {}, dependencies);
  return Array.isArray(rows) && rows.length > 0;
}

export async function recordWebhook(event, dependencies) {
  await supabaseRequest("/rest/v1/stripe_webhook_events", {
    method: "POST", body: [{ id: event.id, event_type: event.type }], prefer: "resolution=ignore-duplicates,return=minimal",
  }, dependencies);
}

export async function activateFounderSubscription(leadId, subscription, dependencies) {
  const rows = await supabaseRequest("/rest/v1/rpc/activate_founder_subscription", {
    method: "POST",
    body: { p_lead_id: leadId, p_customer_id: subscription.customer, p_subscription_id: subscription.id, p_subscription_status: subscription.status },
    prefer: "return=representation",
  }, dependencies);
  return Array.isArray(rows) ? rows[0] || null : null;
}

function founderLeadId(subscription, env) {
  if (subscription?.metadata?.agentready_offer === FOUNDER_OFFER) return subscription.metadata.agentready_lead_id || null;
  const expectedPrice = typeof env.STRIPE_FOUNDER_PRICE_ID === "string" ? env.STRIPE_FOUNDER_PRICE_ID : "";
  const prices = subscription?.items?.data?.map((item) => item?.price?.id).filter(Boolean) || [];
  return expectedPrice && prices.includes(expectedPrice) ? subscription.metadata?.agentready_lead_id || null : null;
}

function paymentLinkFounderSession(session, env) {
  const expectedLink = typeof env.STRIPE_FOUNDER_PAYMENT_LINK_ID === "string" ? env.STRIPE_FOUNDER_PAYMENT_LINK_ID.trim() : "";
  return Boolean(expectedLink && session?.mode === "subscription" && session?.payment_link === expectedLink);
}

function sessionEmail(session) {
  const email = session?.customer_details?.email || session?.customer_email;
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export async function recordSubscriptionState(subscription, dependencies) {
  if (!subscription?.id) return;
  await supabaseRequest("/rest/v1/stripe_subscription_state?on_conflict=stripe_subscription_id", {
    method: "POST",
    body: [{
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer || null,
      subscription_status: subscription.status || null,
      customer_email: subscription.customer_email || null,
      updated_at: new Date().toISOString(),
    }],
    prefer: "resolution=merge-duplicates,return=minimal",
  }, dependencies);
}

export async function subscriptionState(subscriptionId, dependencies) {
  const query = new URLSearchParams({
    select: "stripe_subscription_id,stripe_customer_id,subscription_status",
    stripe_subscription_id: `eq.${subscriptionId}`,
    limit: "1",
  });
  const rows = await supabaseRequest(`/rest/v1/stripe_subscription_state?${query}`, {}, dependencies);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function linkFounderPaymentLinkSession(session, dependencies) {
  const env = dependencies.env || process.env;
  if (!paymentLinkFounderSession(session, env) || !session?.subscription || !session?.customer) return { onboarding: false };
  const lead = await findUniqueLeadByEmail(sessionEmail(session), dependencies);
  // Matching only a single normalized lead protects customers with multiple
  // audited sites from an arbitrary subscription-to-site association.
  if (!lead || (lead.stripe_subscription_id && lead.stripe_subscription_id !== session.subscription)) return { onboarding: false };
  await updateLead(lead.id, {
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    subscription_status: lead.subscription_status || "pending",
  }, dependencies);
  const state = await subscriptionState(session.subscription, dependencies);
  if (state?.subscription_status === "active") {
    const activation = await activateFounderSubscription(lead.id, {
      id: session.subscription,
      customer: state.stripe_customer_id || session.customer,
      status: "active",
    }, dependencies);
    return { onboarding: activation?.onboarding_ready === true };
  }
  return { onboarding: false };
}

export async function processStripeEvent(event, dependencies = {}) {
  if (await webhookAlreadyProcessed(event.id, dependencies)) return { duplicate: true, onboarding: false };
  const object = event.data?.object;
  const env = dependencies.env || process.env;
  let onboarding = false;
  if (event.type === "checkout.session.completed" && object?.metadata?.agentready_offer === FOUNDER_OFFER) {
    const leadId = object.metadata.agentready_lead_id;
    if (leadId && object.customer && object.subscription) {
      await updateLead(leadId, { stripe_customer_id: object.customer, stripe_subscription_id: object.subscription }, dependencies);
    }
  } else if (event.type === "checkout.session.completed") {
    const linked = await linkFounderPaymentLinkSession(object, dependencies);
    onboarding = linked.onboarding;
  } else if (event.type === "invoice.paid" && object?.subscription) {
    const mappedLead = await findLeadBySubscription(object.subscription, dependencies);
    if (mappedLead) {
      await recordSubscriptionState({ id: object.subscription, customer: object.customer || mappedLead.stripe_customer_id, status: "active" }, dependencies);
      const result = await activateFounderSubscription(mappedLead.id, { id: object.subscription, customer: object.customer || mappedLead.stripe_customer_id, status: "active" }, dependencies);
      onboarding = result?.onboarding_ready === true;
    } else {
      const subscription = await stripeRequest(`/v1/subscriptions/${encodeURIComponent(object.subscription)}`, {}, dependencies);
      const leadId = founderLeadId(subscription, env);
      if (leadId && subscription.status === "active") {
        const result = await activateFounderSubscription(leadId, subscription, dependencies);
        onboarding = result?.onboarding_ready === true;
      }
    }
  } else if (event.type === "invoice.payment_failed" && object?.subscription) {
    // Resolve the subscription server-side so a failed invoice cannot leave a
    // previously active lead looking active indefinitely.
    const mappedLead = await findLeadBySubscription(object.subscription, dependencies);
    const subscription = await stripeRequest(`/v1/subscriptions/${encodeURIComponent(object.subscription)}`, {}, dependencies);
    const status = typeof subscription?.status === "string" && subscription.status ? subscription.status : null;
    if (!status) throw new BillingError("Subscription status unavailable.", 502, "upstream");
    const customer = subscription?.customer || object.customer || mappedLead?.stripe_customer_id || null;
    await recordSubscriptionState({ id: object.subscription, customer, status }, dependencies);
    const leadId = mappedLead?.id || founderLeadId(subscription, env);
    if (leadId) {
      await updateLead(leadId, {
        stripe_customer_id: customer,
        stripe_subscription_id: object.subscription,
        subscription_status: status,
      }, dependencies);
    }
  } else if (["customer.subscription.created", "customer.subscription.updated"].includes(event.type)) {
    await recordSubscriptionState(object, dependencies);
    const mappedLead = await findLeadBySubscription(object?.id, dependencies);
    const leadId = mappedLead?.id || founderLeadId(object, env);
    if (leadId) {
      if (object.status === "active") {
        const result = await activateFounderSubscription(leadId, object, dependencies);
        onboarding = result?.onboarding_ready === true;
      } else await updateLead(leadId, {
        stripe_customer_id: object.customer,
        stripe_subscription_id: object.id,
        subscription_status: object.status,
      }, dependencies);
    }
  } else if (event.type === "customer.subscription.deleted") {
    await recordSubscriptionState(object, dependencies);
    const mappedLead = await findLeadBySubscription(object?.id, dependencies);
    const leadId = mappedLead?.id || founderLeadId(object, env);
    if (leadId) await updateLead(leadId, {
      stripe_customer_id: object.customer,
      stripe_subscription_id: object.id,
      subscription_status: object.status || "canceled",
    }, dependencies);
  }
  await recordWebhook(event, dependencies);
  return { duplicate: false, onboarding };
}

export async function checkoutActivationState(sessionId, dependencies = {}) {
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new BillingError("Enter a valid checkout session.");
  const session = await stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, {}, dependencies);
  const subscription = session?.subscription;
  const leadId = session?.metadata?.agentready_lead_id;
  if (!leadId || !subscription || typeof subscription === "string") return { active: false, pending: true };
  const lead = await findLeadById(leadId, dependencies);
  const active = session.mode === "subscription" && session.payment_status === "paid" && subscription.status === "active"
    && lead?.stripe_subscription_id === subscription.id && lead?.subscription_status === "active" && lead?.founder_price_locked === true;
  return { active, pending: !active, lead: active ? lead : null };
}

export async function currentEntitlement(request, websiteUrl, dependencies = {}) {
  const env = dependencies.env || process.env;
  const token = parseEntitlementCookie(request, env);
  if (!token || typeof websiteUrl !== "string") return { active: false };
  let normalized;
  try { normalized = validatePublicUrl(websiteUrl).toString(); } catch { return { active: false }; }
  if (token.website_url !== normalized) return { active: false };
  const lead = await findLeadById(token.lead_id, dependencies);
  const active = Boolean(lead && lead.website_url === normalized && lead.subscription_status === "active" && lead.founder_price_locked === true && lead.stripe_subscription_id);
  return { active, website_url: active ? normalized : null };
}

export { ENTITLEMENT_COOKIE };

export function checkoutOrigin(request) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new BillingError("Checkout is not available from this origin.", 400);
  return url.origin;
}

export function logBillingFailure(error, dependencies = {}) {
  const logger = dependencies.logger || console;
  if (typeof logger?.warn !== "function" || !(error instanceof BillingError) || error.status < 500) return;
  logger.warn("billing_failure", { code: error.code, status: error.status });
}
