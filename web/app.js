import { registerAuditTool } from "./webmcp.js";
import { aiReadinessScore, buildLeadPayload, createCheckoutGate, createFounderCheckout, displayableScore, primaryFinding, reportAccessState, submitLead } from "./commercial.js";
import { isMonitoringComparable, nextMonitoringState } from "./monitoring.js";
import { remediationForAction, recheckState } from "./remediation.js";

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
const founderStatus = document.querySelector("#founder-status");
const remediationPanel = document.querySelector("#remediation-panel");
const storageKey = "agentready.webmcp.last-audit.v1";
const auditContextKey = "agentready.audit-context.v1";
let currentAudit = null;
let selectedAction = null;
let emailUnlocked = false;
let paidVerified = false;
const startFounderCheckout = createCheckoutGate(async (identity) => {
  const url = await createFounderCheckout(identity);
  window.location.assign(url);
  return url;
});

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
  fullReport.hidden = !paidVerified;
  founderOffer.hidden = !emailSubmitted;
}

async function runAudit(url) {
  paidVerified = false;
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
  currentAudit = result;
  localStorage.setItem(auditContextKey, JSON.stringify(result));
  emailUnlocked = false;
  emptyState.hidden = true;
  results.hidden = false;
  reportCapture.hidden = false;
  setReportAccess(false);
  emailForm.reset();
  emailStatus.textContent = "Your report unlocks on this page after you submit this form.";
  founderStatus.textContent = "Secure checkout opens with Stripe after your report is unlocked.";
  document.querySelector("#audited-url").textContent = result.final_url || result.target_url;
  document.querySelector("#audit-scope").textContent = result.audit_scope;
  document.querySelector("#acquisition-method").textContent = result.acquisition?.method === "rendered" ? "Rendered page analyzed" : "Public page analyzed";
  const readiness = aiReadinessScore(result);
  document.querySelector("#readiness-score").textContent = Number.isFinite(readiness) ? readiness : "—";
  document.querySelector("#readiness-confidence").textContent = `Confidence: ${result.confidence?.overall || "LOW"}${result.acquisition?.status === "limited" ? " — some commercial content could not be fully inspected." : ""}`;
  document.querySelector("#readiness-fix").textContent = `Fix potential: ${result.fix_potential || "LOW"}`;
  const finding = primaryFinding(result);
  document.querySelector("#finding-title").textContent = finding.title;
  document.querySelector("#finding-reason").textContent = finding.reason;
  for (const name of ["visibility", "understanding", "buyability"]) {
    const value = result.scores[name];
    const score = document.querySelector(`#${name}-score`);
    score.textContent = displayableScore(value) ?? "—";
    document.querySelector(`#${name}-confidence`).textContent = `Confidence: ${result.confidence?.dimensions?.[name] || "LOW"}`;
    score.dataset.limited = Number.isFinite(value) ? "false" : "true";
  }
  const acquisition = document.querySelector("#acquisition-notice");
  const isFull = result.acquisition?.status === "full";
  acquisition.hidden = isFull;
  if (!isFull) {
    acquisition.innerHTML = `<p class="section-kicker">${esc(result.acquisition?.status || "limited")} evidence</p><h2>${esc(result.acquisition?.status === "blocked" ? "This response cannot be audited reliably" : "This page needs more observable evidence")}</h2><p>${esc(result.acquisition?.explanation || "The audit could not establish enough evidence.")}</p>${result.acquisition?.reasons?.length ? `<ul>${result.acquisition.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>` : ""}`;
  }
  const actions = result.actions.length ? result.actions.map((item, index) => `<li><span class="priority ${esc(item.priority)}">${esc(item.priority)}</span><strong>${esc(item.title)}</strong><p>${esc(item.reason)}</p><button class="fix-it" type="button" data-action-index="${index}">FIX IT</button></li>`).join("") : "<li><strong>No missing signal was prioritized in this bounded page audit.</strong></li>";
  document.querySelector("#actions-list").innerHTML = paidVerified ? actions : "";
  if (paidVerified) document.querySelectorAll(".fix-it").forEach((button) => button.addEventListener("click", () => openRemediation(result.actions[Number(button.dataset.actionIndex)])));
  const groups = Object.entries(result.evidence).map(([group, evidence]) => `<section><h3>${esc(group)}</h3>${evidence.length ? `<ul>${evidence.map((item) => `<li><strong>${esc(item.label)}</strong><span>${esc(item.excerpt)}</span></li>`).join("")}</ul>` : "<p class=\"muted\">No supporting signal observed.</p>"}</section>`).join("");
  document.querySelector("#evidence-list").innerHTML = paidVerified ? groups : "";
  renderMonitoring();
}

async function handleFounderCheckout(event) {
  event.preventDefault();
  if (!currentAudit || !emailUnlocked || !emailInput.value.trim()) {
    founderStatus.textContent = "Submit your email to unlock checkout.";
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  founderStatus.textContent = "Opening secure Stripe checkout…";
  try {
    await startFounderCheckout({ email: emailInput.value, website_url: currentAudit.final_url || currentAudit.target_url });
  } catch (error) {
    founderStatus.textContent = error instanceof Error ? error.message : "Checkout is temporarily unavailable. Please try again.";
    button.disabled = false;
  }
}

function openRemediation(action) {
  selectedAction = action;
  const plan = remediationForAction(action, currentAudit);
  remediationPanel.hidden = false;
  const impact = plan.affected_dimensions?.length ? `Improves observable ${plan.affected_dimensions.join(", ")} signals. Fix potential: ${currentAudit.fix_potential || "unknown"}.` : `Addresses the observed gap. Fix potential: ${currentAudit.fix_potential || "unknown"}.`;
  const evidenceSummary = currentAudit.acquisition?.status === "limited" ? "Apt4AI could verify the evidence listed below, but could not reliably verify all commercial content on the page." : "Apt4AI verified the following evidence on the page:";
  remediationPanel.innerHTML = `<div class="remediation-head"><div><p class="section-kicker">Remediation plan</p><h2>Fix: ${esc(plan.title)}</h2></div><span class="fix-badge">Step-by-step fix</span></div><h3>Problem detected</h3><p>${esc(plan.title)}</p><h3>Evidence</h3><p>${evidenceSummary}</p>${plan.evidence.length ? `<ul>${plan.evidence.map((item) => `<li><strong>${esc(item.label || "Observed signal")}</strong><span>${esc(item.excerpt || "")}</span></li>`).join("")}</ul>` : "<p class=\"muted\">No directly relevant evidence could be reliably verified in the bounded public audit.</p>"}<h3>Why it matters</h3><p>${esc(plan.why_it_matters || "When the commercial path is unclear, visitors and agents may struggle to understand the offer, identify the next action, and become customers.")}</p><h3>Exact fix</h3><ol>${plan.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol><h3>Expected impact</h3><p>${esc(impact)}</p><h3>Where to apply it</h3><p>${esc(plan.where)}</p><p class="verification-hint">${esc(plan.verification_hint)}</p><button id="recheck-site" type="button">Recheck my site</button><p id="recheck-result" class="form-note" role="status"></p>`;
  remediationPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("#recheck-site").addEventListener("click", async (event) => {
    event.target.disabled = true;
    const status = document.querySelector("#recheck-result"); status.textContent = "Rechecking your site…";
    try { const next = await runAudit(currentAudit.final_url || currentAudit.target_url); status.textContent = recheckState(selectedAction, next); }
    catch { status.textContent = "INSUFFICIENT_EVIDENCE"; }
    finally { event.target.disabled = false; }
  });
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
  currentAudit = null;
  setReportAccess(false);
  submit.disabled = true; submit.textContent = "Auditing…";
  try { await runAudit(urlInput.value.trim()); results.scrollIntoView({ behavior: "smooth", block: "start" }); }
  catch (error) { showError(error instanceof Error ? error.message : "The audit could not be completed."); }
  finally { submit.disabled = false; submit.innerHTML = "Run Free Audit <span aria-hidden=\"true\">→</span>"; }
});

// Lead storage is server-side; capture unlocks this on-page report.
async function captureLeadFromForm(event) {
  event.preventDefault();
  emailInput.value = emailInput.value.trim().toLowerCase();
  if (!emailInput.validity.valid) { emailStatus.textContent = "Enter a valid email address to continue."; emailInput.focus(); return; }
  if (!currentAudit) { emailStatus.textContent = "Run an audit before unlocking your report."; return; }
  const captureButton = emailForm.querySelector("button[type=submit]");
  captureButton.disabled = true;
  emailStatus.textContent = "Saving your details…";
  try {
    await submitLead(buildLeadPayload(emailInput.value, currentAudit));
    emailUnlocked = true;
    emailStatus.textContent = "Your report is unlocked below.";
    setReportAccess(true);
    renderEmailPreview();
    fullReport.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    emailStatus.textContent = error instanceof Error ? error.message : "We couldn't save your details. Please try again.";
  } finally {
    captureButton.disabled = false;
  }
}

function renderEmailPreview() {
  const action = currentAudit?.actions?.[0];
  if (!action) return;
  const plan = remediationForAction(action, currentAudit);
  const preview = document.querySelector("#remediation-preview");
  preview.hidden = false;
  preview.innerHTML = `<p class="section-kicker">Preview of your fix plan</p><h3>${esc(plan.title)}</h3><p>${esc(plan.why_it_matters || "This finding affects how clearly visitors can understand the offer and take the next step.")}</p><p><strong>1. ${esc(plan.steps[0] || "Review the observed gap and apply a supported correction.")}</strong></p><p>We found ${currentAudit.actions.length} concrete fix${currentAudit.actions.length === 1 ? "" : "es"} for this issue.</p><button id="preview-founder-cta" class="founder-cta" type="button">Unlock Full Fix Plan — $39/month</button><p class="form-note">Get every prioritized fix, full evidence, rechecks and continuous monitoring.</p>`;
  document.querySelector("#preview-founder-cta").addEventListener("click", handleFounderCheckout);
}

emailForm.addEventListener("submit", captureLeadFromForm);
document.querySelector("#founder-cta")?.addEventListener("click", handleFounderCheckout);

renderMonitoring();
try {
  if (localStorage.getItem("agentready.paid-verified.v1") === "1") {
    const saved = JSON.parse(localStorage.getItem(auditContextKey) || "null");
    if (saved) { paidVerified = true; emailUnlocked = true; render(saved); setReportAccess(true); }
  }
} catch { /* Ignore unavailable local storage. */ }
registerAuditTool(runAudit, setStatus);
