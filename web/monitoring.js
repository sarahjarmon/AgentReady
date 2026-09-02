export function observedReadiness(result) {
  const scores = result?.scores || {};
  const values = [scores.visibility, scores.understanding, scores.buyability];
  return values.every(Number.isFinite) ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

/** A limited audit replaces, rather than inherits, the previous numeric score. */
export function nextMonitoringState(previous, result, now = new Date().toISOString()) {
  const score = observedReadiness(result);
  const current = {
    url: result?.target_url || result?.final_url || "unknown",
    score,
    scores: result?.scores || {},
    acquisition: result?.acquisition?.status || "unknown",
    readiness_state: result?.readiness?.state || "insufficient_evidence",
    at: now,
  };
  return { current, previous: previous?.current || null };
}
