export function aiReadinessScore(result) {
  const observed = result?.readiness?.observed_readiness;
  if (Number.isFinite(observed)) return observed;
  const scores = result?.scores || {};
  const values = [scores.visibility, scores.understanding, scores.buyability];
  return values.every(Number.isFinite) ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
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
