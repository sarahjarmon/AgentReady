import test from "node:test";
import assert from "node:assert/strict";
import { actionMetadata, remediationForAction, recheckState } from "../web/remediation.js";

test("broad commercial finding wins over reason keywords", () => assert.equal(actionMetadata({ title: "Make key commercial information agent-accessible", reason: "Expose offers, prices, and next steps" }).action_id, "commercial_accessibility"));
test("specific findings retain their templates", () => {
  assert.equal(actionMetadata({ title: "Explain price or the quote process", reason: "No visible price" }).action_id, "pricing");
  assert.equal(actionMetadata({ title: "Add a booking path", reason: "Booking is unclear" }).action_id, "booking");
});

test("maps a known pricing action", () => {
  const plan = remediationForAction({ title: "Pricing clarity", reason: "Price is not observable" }, {});
  assert.equal(plan.category, "missing_or_unclear_pricing");
  assert.equal(plan.fix_type, "STEP_BY_STEP_FIX");
});
test("metadata is stable and backward compatible", () => assert.deepEqual(actionMetadata({ title: "Pricing clarity", reason: "Price is not observable" }), { action_id: "pricing", category: "missing_or_unclear_pricing" }));
test("unknown action falls back safely", () => assert.equal(remediationForAction({ title: "Novel gap", reason: "unknown" }, {}).insufficient, true));
test("recheck distinguishes resolved and still detected", () => {
  const original = { title: "Missing CTA", reason: "No action" };
  assert.equal(recheckState(original, { actions: [{ title: "Missing CTA" }] }), "STILL_DETECTED");
  assert.equal(recheckState(original, { actions: [], acquisition: { status: "full" } }), "RESOLVED");
});
test("blocked recheck is insufficient", () => assert.equal(recheckState({ title: "x" }, { actions: [], acquisition: { status: "blocked" } }), "INSUFFICIENT_EVIDENCE"));
