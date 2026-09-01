from __future__ import annotations

import math
from typing import Any, Dict

from .models import CanonicalBusiness, CrawlResult


VERSION = "coverage.v0.1"


def assess_coverage(crawl: CrawlResult, business: CanonicalBusiness, observed_readiness: int) -> Dict[str, Any]:
    raw = crawl.coverage
    analyzed = int(raw.get("pages_html_analyzed", raw.get("pages_analyzed", len(crawl.pages))))
    discovered = max(analyzed, int(raw.get("pages_html_discovered", raw.get("discovered_sitemap_pages", analyzed))))
    page_ratio = min(1.0, analyzed / discovered) if discovered else 0.0
    page_quality = (0.70 if raw.get("page_limit_reached") else 1.0) * (0.60 + 0.40 * math.sqrt(page_ratio))

    detected = max(len(business.offers), business.offers_detected_total)
    kept = len(business.offers)
    offer_ratio = min(1.0, kept / detected) if detected else 1.0
    offer_quality = (0.75 if business.offers_truncated else 1.0) * (0.60 + 0.40 * math.sqrt(offer_ratio))

    needed = int(raw.get("headless_needed", 0))
    used = int(raw.get("headless_used", crawl.limits.get("headless_pages_used", 0)))
    headless_ratio = min(1.0, used / needed) if needed else 1.0
    headless_quality = (0.70 if raw.get("headless_budget_reached") else 1.0) * (0.60 + 0.40 * math.sqrt(headless_ratio))
    confidence = round(100 * (0.55 * page_quality + 0.30 * offer_quality + 0.15 * headless_quality))

    reasons = []
    if raw.get("page_limit_reached"):
        reasons.append(f"Plafond de pages atteint : {analyzed} pages HTML analysées sur {discovered} découvertes.")
    if discovered >= max(50, analyzed * 5):
        reasons.append(f"Le périmètre découvert ({discovered} URLs HTML) est beaucoup plus grand que l'échantillon analysé ({analyzed}).")
    if business.offers_truncated:
        reasons.append(f"Plafond d'offres atteint : {kept} offres conservées sur {detected} offres consolidées.")
    if raw.get("headless_budget_reached"):
        reasons.append(f"Budget headless atteint : rendu utilisé pour {used} page(s), nécessaire sur {needed} page(s) détectée(s).")
    elif needed > used:
        reasons.append(f"Rendu headless incomplet : utilisé avec succès pour {used} page(s) sur {needed} page(s) qui le nécessitaient.")
    if raw.get("non_html_skipped"):
        reasons.append(f"{raw['non_html_skipped']} ressource(s) non HTML ignorée(s) sans consommer le budget de contenu.")
    if not reasons:
        reasons.append("Aucun plafond de pages, d'offres ou de rendu headless n'a limité le périmètre découvert.")

    if raw.get("page_limit_reached") or business.offers_truncated:
        confidence = min(confidence, 74)
    elif raw.get("headless_budget_reached") or needed > used:
        confidence = min(confidence, 89)
    status = "complete" if confidence >= 90 else "substantial" if confidence >= 75 else "partial" if confidence >= 50 else "limited"
    return {
        "version": VERSION, "coverage_confidence": confidence, "coverage_status": status,
        "coverage_reasons": reasons,
        "confidence_adjusted_readiness": round(observed_readiness * confidence / 100),
        "pages_html_discovered": discovered, "pages_html_analyzed": analyzed,
        "offer_candidates_detected": business.offer_candidates_total,
        "offers_consolidated": business.offers_detected_total, "offers_kept": kept,
        "headless_needed": needed, "headless_used": used,
        "limitations": [r for r in reasons if "ignorée" not in r],
    }
