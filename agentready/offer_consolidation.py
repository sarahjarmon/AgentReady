from __future__ import annotations

from difflib import SequenceMatcher
from typing import Dict, List, Optional, Tuple
from urllib.parse import urldefrag

from .models import BusinessProfile, CrawlResult, Evidence, Offer
from .textutils import normalized


VERSION = "offer-consolidation.v0.1"

PROCESS_NAMES = {
    "echange diagnostic", "devis planning", "realisation pilotee", "livraison garanties",
    "prise de contact", "analyse du besoin", "validation du devis", "suivi du projet",
}
INFORMATIVE_NAMES = {
    "innovation", "disponibilite", "rigueur", "durabilite", "nos engagements",
    "notre equipe", "nos valeurs", "pourquoi nous choisir", "garanties",
}
CATEGORY_NAMES = {
    "produits associes", "informations produit", "l essentiel", "notre boutique",
    "meilleures ventes", "favoris", "les cours", "les tarifs", "un espace a decouvrir",
}
INFORMATIVE_PREFIXES = (
    "inscrivez vous a notre newsletter", "pourquoi visiter", "une boutique a votre service",
    "venir a la boutique", "mais aussi des cours",
)


def _canonical(url: str, canonical_by_url: Dict[str, str]) -> str:
    base = urldefrag(url)[0].rstrip("/") or url
    value = canonical_by_url.get(base, base)
    result = urldefrag(value)[0].rstrip("/") or value
    return result[:-5] if result.lower().endswith(".html") else result


def _role(offer: Offer) -> str:
    if offer.candidate_role in {"recommendation_widget", "article", "event", "portfolio", "testimonial", "legal", "process_step", "informational", "category"}:
        return offer.candidate_role
    name = normalized(offer.name)
    if name in CATEGORY_NAMES:
        return "commercial_category"
    if any(name.startswith(prefix) for prefix in INFORMATIVE_PREFIXES):
        return "informative_section"
    if name in PROCESS_NAMES or any(name.startswith(x + " ") for x in PROCESS_NAMES):
        return "process_step"
    if name in INFORMATIVE_NAMES or any(name.startswith(x + " ") for x in INFORMATIVE_NAMES):
        return "informative_section"
    if offer.price or offer.cta or offer.availability or offer.confidence >= .82:
        return "commercial_offer"
    if offer.offer_type in {"product", "formation", "reservation"}:
        return "commercial_offer"
    return "sub_service"


def _same_cta(a: Offer, b: Offer) -> bool:
    return bool(a.cta and b.cta and normalized(a.cta) == normalized(b.cta))


def _mergeable(a: Offer, b: Offer, canonical_by_url: Dict[str, str]) -> Optional[str]:
    an, bn = normalized(a.name), normalized(b.name)
    same_type = a.offer_type == b.offer_type or "unknown" in {a.offer_type, b.offer_type}
    if not same_type:
        return None
    same_page = _canonical(a.url, canonical_by_url) == _canonical(b.url, canonical_by_url)
    similarity = SequenceMatcher(None, an, bn).ratio()
    if an == bn and a.offer_type == "reservation" and an in {"reserver un cours", "reserver une seance decouverte"}:
        return "repeated_booking_cta"
    if an == bn and a.offer_type == "reservation" and _same_cta(a, b) and not same_page:
        return "repeated_booking_cta"
    if an == bn and (_same_cta(a, b) or same_page):
        return "same_name_and_repeated_cta" if _same_cta(a, b) else "same_name_and_canonical_url"
    if same_page and similarity >= .90 and (a.price == b.price or _same_cta(a, b)):
        return "similar_name_same_canonical_context"
    if an == bn and a.offer_type in {"service", "formation", "reservation"} and a.price == b.price:
        return "exact_service_name_same_type"
    # A repeated, explicit booking gateway represents one offer even when repeated
    # across several pages. Different product/service URLs remain distinct.
    return None


def _combine(target: Offer, source: Offer, reason: str, role: str) -> None:
    target.evidence = _unique_evidence(target.evidence + source.evidence)
    target.price = target.price or source.price
    if target.price_value is None and source.price_value is not None:
        target.price_value = source.price_value
        target.price_original = source.price_original
        target.price_evidence = list(source.price_evidence)
    target.currency = target.currency or source.currency
    target.frequency = target.frequency or source.frequency
    target.availability = target.availability or source.availability
    target.cta = target.cta or source.cta
    target.cta_url = target.cta_url or source.cta_url
    target.description = target.description or source.description
    target.confidence = max(target.confidence, source.confidence)
    meta = target.consolidation
    meta["merged_count"] = int(meta.get("merged_count", 1)) + 1
    meta.setdefault("reasons", []).append(reason)
    meta.setdefault("source_names", []).append(source.name)
    meta.setdefault("source_urls", []).append(source.url)
    if role != "commercial_offer":
        meta.setdefault("absorbed_elements", []).append({"name": source.name, "role": role, "url": source.url})


def _unique_evidence(items: List[Evidence]) -> List[Evidence]:
    seen = set()
    result = []
    for item in items:
        key = (item.url, item.kind, item.excerpt, item.selector)
        if key not in seen:
            seen.add(key); result.append(item)
    return result[:50]


def consolidate_offers(offers: List[Offer], crawl: CrawlResult, profile: BusinessProfile) -> Tuple[List[Offer], Dict[str, int]]:
    canonical_by_url = {}
    for page in crawl.pages:
        base = urldefrag(page.url)[0].rstrip("/") or page.url
        canonical_by_url[base] = page.canonical or base

    ordered = sorted(offers, key=lambda o: (-o.confidence, o.url, normalized(o.name)))
    result: List[Offer] = []
    deferred: List[Tuple[Offer, str]] = []
    for offer in ordered:
        role = _role(offer)
        offer.consolidation = {
            "version": VERSION, "role": role, "merged_count": 1, "reasons": [],
            "source_names": [offer.name], "source_urls": [offer.url], "relationship": "standalone",
        }
        if role in {"process_step", "informative_section", "commercial_category", "recommendation_widget", "article", "event", "portfolio", "testimonial", "legal", "informational", "category"}:
            deferred.append((offer, role)); continue
        match = next(((existing, reason) for existing in result
                      if (reason := _mergeable(existing, offer, canonical_by_url))), None)
        if match:
            _combine(match[0], offer, match[1], role)
        else:
            result.append(offer)

    # Process/benefit sections are retained as evidence on the closest real offer,
    # never promoted to standalone offers merely because they share a page.
    for section, role in deferred:
        base = _canonical(section.url, canonical_by_url)
        candidates = [o for o in result if _canonical(o.url, canonical_by_url) == base]
        if candidates:
            parent = max(candidates, key=lambda o: (bool(o.cta), bool(o.price), o.confidence))
            _combine(parent, section, f"{role}_attached_to_same_canonical_offer", role)

    # Local catalog headings are grouped only with the fragmentless parent on the
    # same canonical page, preserving sub-service names and every proof.
    if profile == BusinessProfile.LOCAL_BUSINESS:
        for base in sorted({_canonical(o.url, canonical_by_url) for o in result}):
            group = [o for o in result if _canonical(o.url, canonical_by_url) == base]
            parents = [o for o in group if "#" not in o.url]
            children = [o for o in group if o not in parents and "#" in o.url and not o.price and not o.cta]
            if parents and children:
                parent = max(parents, key=lambda o: (o.confidence, bool(o.cta), bool(o.price)))
                for child in children:
                    _combine(parent, child, "local_subservice_same_canonical_page", "sub_service")
                    parent.consolidation["relationship"] = "category_with_subservices"
                    result.remove(child)

    result.sort(key=lambda o: (-o.confidence, o.url, normalized(o.name)))
    return result, {"candidates": len(offers), "consolidated": len(result)}
