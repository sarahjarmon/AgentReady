from __future__ import annotations

import re
from collections import defaultdict
from typing import Dict, List

from .models import CanonicalBusiness, CrawlResult, Evidence, FactState, Issue


def _price_key(value: str) -> str:
    return re.sub(r"[^0-9.,]", "", value).replace(",", ".")


def detect_inconsistencies(crawl: CrawlResult, business: CanonicalBusiness) -> List[Issue]:
    issues: List[Issue] = []
    by_url: Dict[str, List[Evidence]] = defaultdict(list)
    for offer in business.offers:
        if offer.price:
            key = _price_key(offer.price)
            page = next((p for p in crawl.pages if p.url == offer.url), None)
            if page and key and key not in page.text.replace(",", "."):
                by_url[page.url].extend(offer.evidence)
    for url, evidence in by_url.items():
        issues.append(Issue(
            issue_id=f"inconsistency-price-{len(issues)+1}", rule_id="CONS.PRICE.001",
            title="Prix structuré non confirmé dans le contenu visible", priority="high", commercial_impact=85,
            scores_affected=["understanding", "buyability"],
            explanation="Le prix JSON-LD de cette offre n'a pas été retrouvé dans le texte visible de la même page. Il peut être obsolète, masqué ou formaté différemment.",
            correction_type="structured_data",
            correction="Aligner le prix visible et offers.price, puis vérifier la devise et la disponibilité. Ne publier que le prix commercial actuellement valide.",
            evidence=evidence, requires_human_input=["prix commercial valide"],
        ))
    if issues:
        business.facts["pricing"].state = FactState.CONFLICTING
    return issues
