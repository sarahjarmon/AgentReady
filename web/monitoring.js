export function observedReadiness(result) {
  const scores = result?.scores || {};
  const values = [scores.visibility, scores.understanding, scores.buyability];
  return values.every(Number.isFinite) ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

export function isMonitoringComparable(current, previous) {
  return Boolean(
    current?.monitoring_eligible === true
    && previous?.monitoring_eligible === true
    && current.url === previous.url
    && Number.isFinite(current.score)
    && Number.isFinite(previous.score),
  );
}

/** A limited audit replaces, rather than inherits, the previous numeric score. */
export function nextMonitoringState(previous, result, now = new Date().toISOString()) {
  const score = observedReadiness(result);
  const monitoringEligible = score !== null && result?.readiness?.state === "observed" && result?.acquisition?.monitoring_eligible !== false;
  const current = {
    url: result?.target_url || result?.final_url || "unknown",
    score,
    scores: result?.scores || {},
    acquisition: result?.acquisition?.status || "unknown",
    readiness_state: result?.readiness?.state || "insufficient_evidence",
    monitoring_eligible: monitoringEligible,
    monitoring_reason: result?.acquisition?.monitoring_reason || null,
    at: now,
  };
  return { current, previous: previous?.current || null };
}
