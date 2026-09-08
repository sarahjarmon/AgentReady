const TEMPLATES = [
  { id: "commercial_accessibility", category: "buyability", match: /$^/, why: "When visitors and agents cannot reliably follow the commercial journey, they may not understand the offer, identify the next action, or become customers.", steps: ["State the primary offer and what it includes in crawlable public content.", "Add a current price or price range when one is applicable and supported by the business.", "Add one clear CTA leading to the factual buy, book, contact, or quote path.", "Ensure that destination is publicly crawlable and describe the action plainly.", "Add structured data only for details that are also visible and verifiable on the page."], verify: "Recheck the site to see whether this recommendation remains prioritized." },
  { id: "pricing", category: "missing_or_unclear_pricing", match: /price|pricing|cost|fee|rate/i, why: "Clear pricing helps visitors understand the commercial fit and choose a next step.", steps: ["Add the current price or a clear pricing range to the relevant offer section.", "Label what is included and link to the next purchase or inquiry action."], verify: "Recheck that a price and a commercial next step are observable on the page." },
  { id: "cta", category: "weak_commercial_next_step", match: /cta|call.to.action|actionability|next step|buy|contact/i, why: "A visible next step makes it easier for an interested visitor or agent to act.", steps: ["Add one clearly labeled primary action near the offer.", "Point it to the verified purchase, booking, quote, or contact destination."], verify: "Recheck that the intended action is exposed as a usable link or button." },
  { id: "booking", category: "booking_path", match: /book|booking|appointment|schedule/i, why: "A clearly exposed booking path reduces friction for visitors ready to schedule.", steps: ["Place the booking link or button beside the relevant service or offer.", "Use a label that states the action, such as Book a consultation."], verify: "Recheck that a booking destination is observable." },
  { id: "quote", category: "quote_request_path", match: /quote|request|enquir|inquir/i, why: "A direct request path helps qualified visitors start a commercial conversation.", steps: ["Add a request-a-quote or inquiry action beside the relevant offer.", "Ensure the destination and expected response are described plainly."], verify: "Recheck that the quote or inquiry path is exposed." },
  { id: "identity", category: "business_identity_contact", match: /identity|contact|business name|location|address|phone/i, why: "Consistent identity and contact details help people and agents understand who is responsible for the offer.", steps: ["Place the business name and a verifiable contact method in the header or contact section.", "Keep the same identity details consistent across the page."], verify: "Recheck that identity and contact signals are observable." },
  { id: "schema", category: "structured_data", match: /schema|structured data|structured signal|markup/i, why: "Structured signals can make key business and offer details easier for software to interpret.", steps: ["Add only schema that accurately describes the visible business or offer.", "Keep every structured field consistent with the page content."], verify: "Recheck whether the relevant structured signal is observable." },
  { id: "offer", category: "offer_detail", match: /offer|service|product|detail|description/i, why: "Specific offer details help visitors understand what they can buy and whether it fits their need.", steps: ["State what is included, who it is for, and the intended outcome near the offer.", "Tie the description to one clear commercial action."], verify: "Recheck that the offer details are visible and specific." },
  { id: "availability", category: "commercial_availability", match: /availability|available|timing|status|hours/i, why: "Availability context prevents uncertainty about whether and when someone can proceed.", steps: ["State current availability, timing, or operating hours in the relevant section.", "Keep the status current and link to the next action."], verify: "Recheck that availability or timing is observable." },
];

export function actionMetadata(action) {
  const text = `${action?.title || ""} ${action?.reason || ""}`;
  const stable = String(action?.action_id || action?.category || "").toLowerCase();
  const broad = /make key commercial information agent-accessible|commercial.accessib|agent.accessible/.test(String(action?.title || "").toLowerCase());
  const template = broad || stable === "commercial_accessibility" || stable === "buyability" ? TEMPLATES[0] : TEMPLATES.slice(1).find((item) => item.match.test(String(action?.title || "")) || item.id === action?.action_id || item.category === action?.category);
  return { action_id: action?.action_id || template?.id || "unknown", category: action?.category || template?.category || "unknown" };
}

export function remediationForAction(action, audit) {
  const title = String(action?.title || "").trim();
  const reason = String(action?.reason || "").trim();
  const metadata = actionMetadata(action);
  const template = TEMPLATES.find((item) => item.id === metadata.action_id) || TEMPLATES.find((item) => item.category === metadata.category);
  const evidence = audit?.evidence ? Object.values(audit.evidence).flat().filter((item) => item && (item.label || item.excerpt)) : [];
  const relevant = evidence.filter((item) => new RegExp(`${title.split(/\s+/).slice(0, 3).join("|")}`, "i").test(`${item.label || ""} ${item.excerpt || ""}`));
  const affected = ["visibility", "understanding", "buyability"].filter((name) => (audit?.evidence?.[name] || []).length === 0 || (name === "buyability" && !audit?.capabilities?.conversion?.state?.includes("OBSERVED")));
  if (!template) return { id: "unknown", ...metadata, fix_type: "STEP_BY_STEP_FIX", title: title || "This recommendation", evidence: relevant, insufficient: true, why_it_matters: "When visitors and agents cannot reliably follow the commercial journey, they may not understand the offer, identify the next action, or become customers. Making the observable path clearer reduces that uncertainty without assuming anything hidden by limited acquisition.", steps: ["State the primary offer and what it includes in crawlable public content.", "Add a current price or price range when one is applicable and supported by the business.", "Add one clear CTA leading to the factual buy, book, contact, or quote path.", "Ensure that destination is publicly crawlable and describe the action plainly.", "Add structured data only for details that are also visible and verifiable on the page."], where: "The exact implementation location could not be determined from the bounded public audit.", verification_hint: "Recheck the site to see whether this recommendation remains prioritized.", affected_dimensions: affected };
  return { ...template, ...metadata, title, evidence: relevant, fix_type: "STEP_BY_STEP_FIX", insufficient: !reason, why_it_matters: template.why, affected_dimensions: affected, where: relevant.length ? "The page section represented by the observed evidence above." : "The exact implementation location could not be determined from the bounded public audit." };
}

export function recheckState(original, next) {
  if (!next || next.status === "error") return "INSUFFICIENT_EVIDENCE";
  const title = String(original?.title || "");
  const originalMeta = actionMetadata(original);
  const still = (next.actions || []).some((item) => { const meta = actionMetadata(item); return (originalMeta.action_id !== "unknown" && meta.action_id === originalMeta.action_id) || (originalMeta.category !== "unknown" && meta.category === originalMeta.category); });
  if (still) return "STILL_DETECTED";
  if (next.acquisition?.status === "blocked" || next.score_status === "insufficient_evidence") return "INSUFFICIENT_EVIDENCE";
  return "RESOLVED";
}
