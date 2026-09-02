import { registerAuditTool } from "./webmcp.js";
import { aiReadinessScore, primaryFinding, reportAccessState } from "./commercial.js";
import { isMonitoringComparable, nextMonitoringState } from "./monitoring.js";

const form = document.querySelector("#audit-form");
const urlInput = document.querySelector("#url");
const submit = document.querySelector("#submit");
const errorBox = document.querySelector("#error");
const results = document.querySelector("#results");
const emptyState = document.querySelector("#empty-state");
const reportCapture = document.querySelector("#report-capture");
const emailForm = document.querySelector("#email-form");
const emailInput = document.querySelector("#email");
const emailStatus = document.querySelector("#email-status");
const fullReport = document.querySelector("#full-report");
const founderOffer = document.querySelector("#founder-offer");
const founderCta = document.querySelector("#founder-cta");
const founderStatus = document.querySelector("#founder-status");
const storageKey = "agentready.webmcp.last-audit.v1";

function esc(value) {
  const node = document.createElement("span");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function setStatus(kind, message) {
  const dot = document.querySelector("#webmcp-dot");
  if (dot) dot.dataset.status = kind;
  const statusMessage = document.querySelector("#webmcp-message");
  if (statusMessage) statusMessage.textContent = message;
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function hideError() { errorBox.hidden = true; errorBox.textContent = ""; }

function setReportAccess(emailSubmitted) {
  const state = reportAccessState(emailSubmitted);
  fullReport.hidden = state.fullReportHidden;
  founderOffer.hidden = state.founderOfferHidden;
}

async function runAudit(url) {
  const response = await fetch("/.netlify/functions/audit", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }),
  });
  const result = await response.json();
  if (!response.ok || result.status === "error") throw new Error(result.error || "The audit could not be completed.");
  saveMonitoring(result);
  render(result);
  return result;
}

function render(result) {
  emptyState.hidden = true;
  results.hidden = false;
  reportCapture.hidden = false;
  setReportAccess(false);
  emailForm.reset();
  emailStatus.textContent = "Email delivery is a beta placeholder. Your address is not stored or sent yet.";
  founderStatus.textContent = "Founder checkout is a Stripe placeholder for this beta.";
  document.querySelector("#audited-url").textContent = result.final_url || result.target_url;
  document.querySelector("#audit-scope").textContent = result.audit_scope;
  document.querySelector("#acquisition-method").textContent = result.acquisition?.method === "rendered" ? "Rendered page analyzed" : "Public page analyzed";
  const readiness = aiReadinessScore(result);
  document.querySelector("#readiness-score").textContent = Number.isFinite(readiness) ? readiness : "—";
  const finding = primaryFinding(result);
  document.querySelector("#finding-title").textContent = finding.title;
  document.querySelector("#finding-reason").textContent = finding.reason;
  for (const name of ["visibility", "understanding", "buyability"]) {
    const value = result.scores[name];
    const score = document.querySelector(`#${name}-score`);
    score.textContent = Number.isFinite(value) ? value : "—";
    score.dataset.limited = Number.isFinite(value) ? "false" : "true";
  }
  const acquisition = document.querySelector("#acquisition-notice");
  const isFull = result.acquisition?.status === "full";
  acquisition.hidden = isFull;
  if (!isFull) {
    acquisition.innerHTML = `<p class="section-kicker">${esc(result.acquisition?.status || "limited")} evidence</p><h2>${esc(result.acquisition?.status === "blocked" ? "This response cannot be audited reliably" : "This page needs more observable evidence")}</h2><p>${esc(result.acquisition?.explanation || "The audit could not establish enough evidence.")}</p>${result.acquisition?.reasons?.length ? `<ul>${result.acquisition.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>` : ""}`;
  }
  const actions = result.actions.length ? result.actions.map((item) => `<li><span class="priority ${esc(item.priority)}">${esc(item.priority)}</span><strong>${esc(item.title)}</strong><p>${esc(item.reason)}</p></li>`).join("") : "<li><strong>No missing signal was prioritized in this bounded page audit.</strong></li>";
  document.querySelector("#actions-list").innerHTML = actions;
  const groups = Object.entries(result.evidence).map(([group, evidence]) => `<section><h3>${esc(group)}</h3>${evidence.length ? `<ul>${evidence.map((item) => `<li><strong>${esc(item.label)}</strong><span>${esc(item.excerpt)}</span></li>`).join("")}</ul>` : "<p class=\"muted\">No supporting signal observed.</p>"}</section>`).join("");
  document.querySelector("#evidence-list").innerHTML = groups;
  renderMonitoring();
}

function saveMonitoring(result) {
  const previous = JSON.parse(localStorage.getItem(storageKey) || "null");
  localStorage.setItem(storageKey, JSON.stringify(nextMonitoringState(previous, result)));
}

function renderMonitoring() {
  const data = JSON.parse(localStorage.getItem(storageKey) || "null");
  const mount = document.querySelector("#monitoring-content");
  if (!data?.current) { mount.innerHTML = "<p class=\"muted\">Your latest audit will be stored only in this browser.</p>"; return; }
  const current = data.current;
  const comparable = isMonitoringComparable(current, data.previous);
  const delta = comparable ? current.score - data.previous.score : null;
  const alert = current.monitoring_eligible && (current.score < 60 || (delta !== null && delta < 0));
  const message = current.score === null ? "Limited or blocked evidence: this audit is not compared as a readiness score." : !current.monitoring_eligible ? (current.monitoring_reason || "The rendered evidence is not sufficiently complete for monitoring comparison.") : alert ? "Attention: the score is below 60 or has declined since the prior audit." : "No local monitoring alert from the latest comparable audit.";
  mount.innerHTML = `<div class="monitor-grid"><div><span>Latest observed readiness</span><strong>${current.score ?? "—"}</strong></div><div><span>Previous score</span><strong>${comparable ? data.previous.score : "—"}</strong></div><div><span>Change</span><strong class="${delta !== null && delta < 0 ? "down" : ""}">${delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}`}</strong></div></div><p class="monitor-note ${alert || current.score === null || !current.monitoring_eligible ? "alert" : ""}">${message} Stored locally on ${esc(new Date(current.at).toLocaleString())}.</p>`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault(); hideError();
  submit.disabled = true; submit.textContent = "Auditing…";
  try { await runAudit(urlInput.value.trim()); }
  catch (error) { showError(error instanceof Error ? error.message : "The audit could not be completed."); }
  finally { submit.disabled = false; submit.innerHTML = "Run Free Audit <span aria-hidden=\"true\">→</span>"; }
});

// Placeholder only: no email is persisted or transmitted until a consented delivery service is connected.
emailForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!emailInput.validity.valid) { emailStatus.textContent = "Enter a valid email address to continue."; emailInput.focus(); return; }
  emailStatus.textContent = "Your report is unlocked below. Email delivery will be connected in a future beta update.";
  setReportAccess(true);
  fullReport.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Placeholder only: Stripe checkout is intentionally not connected in this branch.
founderCta.addEventListener("click", () => {
  founderStatus.textContent = "Founder checkout will be connected to Stripe before paid access opens.";
});

renderMonitoring();
registerAuditTool(runAudit, setStatus);
