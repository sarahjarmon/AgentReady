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
