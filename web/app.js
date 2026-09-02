import { registerAuditTool } from "./webmcp.js";

const form = document.querySelector("#audit-form");
const urlInput = document.querySelector("#url");
const submit = document.querySelector("#submit");
const errorBox = document.querySelector("#error");
const results = document.querySelector("#results");
const emptyState = document.querySelector("#empty-state");
const storageKey = "agentready.webmcp.last-audit.v1";

function esc(value) {
  const node = document.createElement("span");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function totalScore(result) {
  const { visibility, understanding, buyability } = result.scores;
  return Math.round((visibility + understanding + buyability) / 3);
}

function setStatus(kind, message) {
  const dot = document.querySelector("#webmcp-dot");
  dot.dataset.status = kind;
  document.querySelector("#webmcp-message").textContent = message;
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function hideError() { errorBox.hidden = true; errorBox.textContent = ""; }

async function runAudit(url) {
  const response = await fetch("/.netlify/functions/audit", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }),
  });
  const result = await response.json();
  if (!response.ok || result.status === "error") throw new Error(result.error || "The audit could not be completed.");
  render(result);
  saveMonitoring(result);
  return result;
}

function render(result) {
  emptyState.hidden = true;
  results.hidden = false;
  document.querySelector("#audited-url").textContent = result.final_url || result.target_url;
  document.querySelector("#audit-scope").textContent = result.audit_scope;
  for (const name of ["visibility", "understanding", "buyability"]) document.querySelector(`#${name}-score`).textContent = result.scores[name];
  const actions = result.actions.length ? result.actions.map((item) => `<li><span class="priority ${esc(item.priority)}">${esc(item.priority)}</span><strong>${esc(item.title)}</strong><p>${esc(item.reason)}</p></li>`).join("") : "<li><strong>No missing signal was prioritized in this bounded page audit.</strong></li>";
  document.querySelector("#actions-list").innerHTML = actions;
  const groups = Object.entries(result.evidence).map(([group, evidence]) => `<section><h3>${esc(group)}</h3>${evidence.length ? `<ul>${evidence.map((item) => `<li><strong>${esc(item.label)}</strong><span>${esc(item.excerpt)}</span></li>`).join("")}</ul>` : "<p class=\"muted\">No supporting signal observed.</p>"}</section>`).join("");
  document.querySelector("#evidence-list").innerHTML = groups;
  renderMonitoring();
}

function saveMonitoring(result) {
  const now = new Date().toISOString();
  const current = { url: result.target_url, score: totalScore(result), scores: result.scores, at: now };
  const previous = JSON.parse(localStorage.getItem(storageKey) || "null");
  localStorage.setItem(storageKey, JSON.stringify({ current, previous: previous?.current || null }));
}

function renderMonitoring() {
  const data = JSON.parse(localStorage.getItem(storageKey) || "null");
  const mount = document.querySelector("#monitoring-content");
  if (!data?.current) { mount.innerHTML = "<p class=\"muted\">Your latest audit will be stored only in this browser.</p>"; return; }
  const current = data.current;
  const comparable = data.previous && data.previous.url === current.url;
  const delta = comparable ? current.score - data.previous.score : null;
  const alert = current.score < 60 || (delta !== null && delta < 0);
  mount.innerHTML = `<div class="monitor-grid"><div><span>Latest observed readiness</span><strong>${current.score}</strong></div><div><span>Previous score</span><strong>${comparable ? data.previous.score : "—"}</strong></div><div><span>Change</span><strong class="${delta !== null && delta < 0 ? "down" : ""}">${delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}`}</strong></div></div><p class="monitor-note ${alert ? "alert" : ""}">${alert ? "Attention: the score is below 60 or has declined since the prior audit." : "No local monitoring alert from the latest comparable audit."} Stored locally on ${esc(new Date(current.at).toLocaleString())}.</p>`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault(); hideError();
  submit.disabled = true; submit.textContent = "Auditing…";
  try { await runAudit(urlInput.value.trim()); }
  catch (error) { showError(error instanceof Error ? error.message : "The audit could not be completed."); }
  finally { submit.disabled = false; submit.innerHTML = "Run audit <span aria-hidden=\"true\">→</span>"; }
});

renderMonitoring();
registerAuditTool(runAudit, setStatus);
