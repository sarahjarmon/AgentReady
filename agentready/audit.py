from __future__ import annotations

from datetime import datetime, timezone

from .consistency import detect_inconsistencies
from .coverage import assess_coverage
from .crawler import Crawler
from .extractor import Extractor
from .models import AuditReport
from .recommendations import build_recommendations, recommendation_sanity_check
from .scoring import score


NOTICE = (
    "AI Discoverability mesure les signaux techniques observables du site public. "
    "Ce n'est pas une mesure de classement, de citation ou de recommandation réelle dans ChatGPT, Gemini, Perplexity ou un autre moteur."
)


def audit_url(url: str, max_pages: int = 40, max_depth: int = 3, timeout: int = 12) -> AuditReport:
    crawl = Crawler(max_pages=max_pages, max_depth=max_depth, timeout=timeout).crawl(url)
    business = Extractor().extract(crawl)
    inconsistencies = detect_inconsistencies(crawl, business)
    scores, rules = score(crawl, business)
    coverage = assess_coverage(crawl, business, scores["ai_readiness"])
    issues = build_recommendations(rules, business)
    issues, recommendation_rejections = recommendation_sanity_check(issues, business)
    issues = sorted(issues + inconsistencies, key=lambda x: (-x.commercial_impact, x.issue_id))
    return AuditReport(
        schema_version="agentready.audit.v0.2", generated_at=datetime.now(timezone.utc).isoformat(),
        target_url=url, methodology_notice=NOTICE, crawl=crawl, business=business,
        scores=scores, score_formula="AI Readiness = 30% AI Discoverability + 35% Understanding + 35% Buyability",
        coverage_confidence=coverage["coverage_confidence"], coverage_status=coverage["coverage_status"],
        coverage_reasons=coverage["coverage_reasons"],
        confidence_adjusted_readiness=coverage["confidence_adjusted_readiness"],
        coverage_methodology_version=coverage["version"],
        rules=rules, inconsistencies=inconsistencies, issues=issues,
        recommendation_rejections=recommendation_rejections,
        limitations=[
            "Le crawl est borné et ne représente pas nécessairement l'intégralité du site.",
            "Le rendu JavaScript est borné; du contenu client peut rester absent lorsque le budget headless est atteint.",
            "Les heuristiques linguistiques couvrent principalement le français et l'anglais.",
            "Aucun formulaire, panier, paiement ou réservation n'est soumis ou exécuté.",
            "Les informations derrière une authentification ou disponibles seulement via une API ne sont pas observables.",
            "Les scores n'évaluent ni le classement ni les citations réelles dans les assistants IA.",
        ],
    )
