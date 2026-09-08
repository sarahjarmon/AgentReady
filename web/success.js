import { checkoutConfirmationState } from "./commercial.js";

const title = document.querySelector("#confirmation-title");
const message = document.querySelector("#confirmation-message");
const detail = document.querySelector("#confirmation-detail");
const heading = document.querySelector("#confirmation-heading");
const viewPlan = document.querySelector("#view-plan");
const sessionId = new URL(window.location.href).searchParams.get("session_id");
let attempts = 0;

function render(result) {
  const state = checkoutConfirmationState(result);
  title.textContent = state.title;
  heading.textContent = state.confirmed ? "Your full apt4ai Fix Plan is unlocked." : "Your full apt4ai Fix Plan is being unlocked…";
  message.textContent = state.confirmed ? "Your subscription is confirmed. Your complete AI Readiness report, prioritized fixes and continuous monitoring are ready." : "Your subscription is confirmed. We’re preparing your complete AI Readiness report, prioritized fixes and continuous monitoring.";
  detail.textContent = state.confirmed ? "" : attempts >= 10 ? "Confirmation is still pending. Please refresh this page in a moment." : "";
  if (state.confirmed) {
    localStorage.setItem("agentready.paid-verified.v1", "1");
    viewPlan.outerHTML = '<a id="view-plan" class="founder-cta" href="/">View My Full Fix Plan →</a>';
  } else viewPlan.textContent = "We’re verifying your subscription...";
  return state.confirmed;
}

async function confirmSubscription() {
  if (!sessionId) { title.textContent = "We couldn't confirm your subscription yet."; heading.textContent = "A checkout session is required."; message.textContent = "Please return to the checkout and try again."; viewPlan.textContent = "Return to apt4ai"; return; }
  attempts += 1;
  try {
    const response = await fetch(`/.netlify/functions/checkout-status?session_id=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
    const result = await response.json();
    if (render(result) || attempts >= 10) return;
  } catch {
    if (attempts >= 10) { title.textContent = "We couldn't confirm your subscription yet."; heading.textContent = "Please try again in a moment."; message.textContent = "If you just completed payment, your subscription may still be processing."; viewPlan.textContent = "Return to apt4ai"; }
    else render(null);
  }
  window.setTimeout(confirmSubscription, 2_000);
}

confirmSubscription();
