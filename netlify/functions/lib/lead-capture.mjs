import { validatePublicUrl } from "./audit-core.mjs";

const MAX_BODY_BYTES = 8_192;
const MAX_EMAIL_LENGTH = 254;
const MAX_URL_LENGTH = 2_048;
const VALID_AUDIT_STATUSES = new Set(["complete", "limited", "blocked"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

class LeadCaptureError extends Error {
  constructor(message, status = 400, kind = "invalid") {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

function response(body, status, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function requiredString(value, field, maximumLength) {
  if (typeof value !== "string") throw new LeadCaptureError(`Enter a valid ${field}.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) throw new LeadCaptureError(`Enter a valid ${field}.`);
  return normalized;
}

function normalizedScore(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new LeadCaptureError(`Enter a valid ${field}.`);
  }
  return value;
}

export function validateLeadPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LeadCaptureError("Enter valid lead details.");
  const email = requiredString(input.email, "email address", MAX_EMAIL_LENGTH).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new LeadCaptureError("Enter a valid email address.");

  const rawWebsiteUrl = requiredString(input.website_url, "website URL", MAX_URL_LENGTH);
  let websiteUrl;
  try { websiteUrl = validatePublicUrl(rawWebsiteUrl).toString(); }
  catch { throw new LeadCaptureError("Enter a valid public website URL."); }

  const auditStatus = requiredString(input.audit_status, "audit status", 32).toLowerCase();
  if (!VALID_AUDIT_STATUSES.has(auditStatus)) throw new LeadCaptureError("Enter a valid audit status.");

  return {
    email,
    website_url: websiteUrl,
    readiness_score: normalizedScore(input.readiness_score, "readiness score"),
    visibility_score: normalizedScore(input.visibility_score, "visibility score"),
    understanding_score: normalizedScore(input.understanding_score, "understanding score"),
    buyability_score: normalizedScore(input.buyability_score, "buyability score"),
    audit_status: auditStatus,
  };
}

function supabaseLeadsUrl(env) {
  const value = env.SUPABASE_URL;
  // New Supabase secret keys are opaque `sb_secret_*` values. Keep the
  // legacy variable as a server-only migration fallback.
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value || !key) throw new LeadCaptureError("Lead capture is not configured yet. Please try again later.", 503, "configuration");
  let url;
  try { url = new URL(value); }
  catch { throw new LeadCaptureError("Lead capture is not configured yet. Please try again later.", 503, "configuration"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new LeadCaptureError("Lead capture is not configured yet. Please try again later.", 503, "configuration");
  }
  return { url: new URL("/rest/v1/leads?on_conflict=email%2Cwebsite_url", url), key };
}

function supabaseFailureKind(status) {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status >= 400 && status < 500) return "validation";
  return "upstream";
}

function fetchFailureKind(error) {
  // A TypeError without an underlying network cause is raised before a
  // request is sent (for example, an invalid request header). Do not log the
  // error text because it can include request values.
  if (error instanceof TypeError && !error.cause) return "request_setup";
  return "network";
}

function logFailure(error, dependencies) {
  const logger = dependencies.logger || console;
  if (typeof logger?.warn !== "function") return;
  if (error instanceof LeadCaptureError) {
    if (error.status < 500) return;
    logger.warn("lead_capture_failure", { kind: error.kind, status: error.status });
    return;
  }
  logger.warn("lead_capture_failure", { kind: "upstream", status: 502 });
}

export async function saveLead(payload, dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const { url, key } = supabaseLeadsUrl(env);
  let result;
  try {
    result = await fetchImpl(url, {
      method: "POST",
      headers: {
        apikey: key,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([payload]),
    });
  } catch (error) {
    throw new LeadCaptureError("We couldn't save your details. Please try again.", 502, fetchFailureKind(error));
  }
  if (!result.ok) throw new LeadCaptureError("We couldn't save your details. Please try again.", 502, supabaseFailureKind(result.status));
}

async function parseRequestBody(request) {
  const declaredSize = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) throw new LeadCaptureError("Lead details are too large.", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new LeadCaptureError("Lead details are too large.", 413);
  try { return JSON.parse(text); }
  catch { throw new LeadCaptureError("Enter valid lead details."); }
}

export async function handleLeadCapture(request, dependencies = {}) {
  if (request.method !== "POST") return response({ ok: false, error: "Method not allowed." }, 405, { allow: "POST" });
  try {
    const payload = validateLeadPayload(await parseRequestBody(request));
    await saveLead(payload, dependencies);
    return response({ ok: true }, 201);
  } catch (error) {
    logFailure(error, dependencies);
    if (error instanceof LeadCaptureError) return response({ ok: false, error: error.message }, error.status);
    return response({ ok: false, error: "We couldn't save your details. Please try again." }, 502);
  }
}
