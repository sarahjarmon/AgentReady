from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Sequence, Tuple
from urllib.parse import urlparse

from .models import CanonicalBusiness, CrawlResult, Evidence, FactState, RuleResult


DISCOVERABILITY = "ai_discoverability"
UNDERSTANDING = "understanding"
BUYABILITY = "buyability"


@dataclass(frozen=True)
class Rule:
    rule_id: str
    score: str
    label: str
    points: float
    check: Callable[[CrawlResult, CanonicalBusiness], Tuple[str, float, str, List[Evidence]]]


def _fact(field: str, positive: str, negative: str) -> Callable:
    def check(crawl: CrawlResult, business: CanonicalBusiness):
        fact = business.facts[field]
        if fact.state == FactState.NOT_APPLICABLE:
            return "not_applicable", 0, f"{field} n'est pas applicable au profil {business.profile.value}.", []
        if fact.state == FactState.KNOWN:
            return "pass", 1, positive, fact.evidence
        if fact.state == FactState.CONFLICTING:
            return "partial", 0.35, f"{positive}, mais des valeurs contradictoires ont été relevées.", fact.evidence
        return "fail", 0, negative, []
    return check


def _pages_accessible(crawl: CrawlResult, business: CanonicalBusiness):
    good = [p for p in crawl.pages if 200 <= p.status < 300 and p.text]
    if good:
        ratio = len(good) / max(1, len(crawl.pages))
        return ("pass" if ratio >= .8 else "partial", ratio, f"{len(good)} page(s) HTML accessible(s) sur {len(crawl.pages)} récupérée(s).", [])
    return "fail", 0, "Aucune page HTML publique exploitable n'a été récupérée.", []


def _robots(crawl: CrawlResult, business: CanonicalBusiness):
    if crawl.blocked_urls and not crawl.pages:
        return "fail", 0, "Le crawl public est entièrement bloqué par robots.txt.", []
    if crawl.blocked_urls:
        return "partial", .6, f"{len(crawl.blocked_urls)} URL(s) pertinente(s) bloquée(s) par robots.txt.", []
    if crawl.robots_accessible:
        return "pass", 1, "robots.txt est accessible et n'a bloqué aucune page auditée.", []
    return "partial", .6, "robots.txt n'est pas accessible; aucune interdiction explicite n'a pu être vérifiée.", []


def _indexable(crawl: CrawlResult, business: CanonicalBusiness):
    html_pages = [p for p in crawl.pages if p.text]
    blocked = [p for p in html_pages if "noindex" in p.robots]
    if not html_pages:
        return "fail", 0, "Aucune page permettant de vérifier l'indexabilité.", []
    ratio = 1 - len(blocked) / len(html_pages)
    return ("pass" if ratio == 1 else "partial", ratio, f"{len(html_pages) - len(blocked)} page(s) indexable(s) sur {len(html_pages)}.", [])


def _canonicals(crawl: CrawlResult, business: CanonicalBusiness):
    pages = [p for p in crawl.pages if p.text]
    if not pages:
        return "fail", 0, "Aucune page canonique vérifiable.", []
    valid = [p for p in pages if p.canonical and urlparse(p.canonical).hostname == urlparse(p.url).hostname]
    ratio = len(valid) / len(pages)
    status = "pass" if ratio >= .8 else "partial" if ratio > 0 else "fail"
    return status, ratio, f"Une URL canonique interne est déclarée sur {len(valid)} page(s) sur {len(pages)}.", []


def _sitemap(crawl: CrawlResult, business: CanonicalBusiness):
    if crawl.sitemap_urls:
        return "pass", 1, f"{len(crawl.sitemap_urls)} sitemap(s) déclaré(s) ou testé(s).", []
    return "fail", 0, "Aucun sitemap n'a été découvert.", []


def _internal_discovery(crawl: CrawlResult, business: CanonicalBusiness):
    pages = [p for p in crawl.pages if p.text]
    if len(pages) >= 3:
        return "pass", 1, f"Le crawl a découvert {len(pages)} pages publiques exploitables.", []
    if pages:
        return "partial", .4, f"Seulement {len(pages)} page(s) publique(s) exploitable(s) découverte(s).", []
    return "fail", 0, "Aucune architecture de liens exploitable.", []


def _metadata(crawl: CrawlResult, business: CanonicalBusiness):
    pages = [p for p in crawl.pages if p.text]
    if not pages:
        return "fail", 0, "Aucune metadata vérifiable.", []
    complete = [p for p in pages if p.title and p.description]
    ratio = len(complete) / len(pages)
    return ("pass" if ratio >= .8 else "partial" if ratio else "fail", ratio, f"Titre et description présents sur {len(complete)} page(s) sur {len(pages)}.", [])


def _offers(crawl: CrawlResult, business: CanonicalBusiness):
    if business.offers:
        evidence = [e for offer in business.offers for e in offer.evidence][:10]
        completeness = [_offer_completeness(o, business, "understanding") for o in business.offers]
        average = sum(completeness) / len(completeness)
        ratio = .45 + .55 * average
        complete = sum(x >= .8 for x in completeness)
        status = "pass" if average >= .9 else "partial"
        return status, ratio, f"{len(business.offers)} offre(s) identifiée(s); {complete} suffisamment complètes. Complétude moyenne {average:.0%}.", evidence
    if business.profile.value == "informational":
        return "not_applicable", 0, "Les offres ne sont pas applicables au profil informationnel.", []
    return "fail", 0, "Aucune offre, produit ou service clairement identifiable.", []


def _schema(crawl: CrawlResult, business: CanonicalBusiness):
    fact = business.facts["structured_data"]
    if fact.state == FactState.KNOWN:
        return "pass", 1, "Des données structurées JSON-LD exploitables ont été trouvées.", fact.evidence
    return "fail", 0, "Aucune donnée structurée JSON-LD exploitable n'a été trouvée.", []


def _consistency(crawl: CrawlResult, business: CanonicalBusiness):
    conflicting = [f for f in business.facts.values() if f.state == FactState.CONFLICTING]
    if conflicting:
        return "partial", .3, f"{len(conflicting)} champ(s) contradictoire(s) détecté(s).", [e for f in conflicting for e in f.evidence][:10]
    return "pass", 1, "Aucune contradiction déterministe n'a été détectée dans les champs contrôlés.", []


def _conversion(crawl: CrawlResult, business: CanonicalBusiness):
    fields = {
        "ecommerce": "purchase_process", "service_with_booking": "booking_process",
        "service_with_quote_or_lead": "quote_process", "local_business": "contact_process",
    }
    field = fields.get(business.profile.value)
    if business.profile.value == "informational":
        return "not_applicable", 0, "Aucune conversion commerciale attendue pour le profil informationnel.", []
    if not field:
        found = next((x for x in ("purchase_process", "booking_process", "quote_process", "contact_process") if business.facts[x].state == FactState.KNOWN), None)
        if found:
            return "partial", .65, f"Un parcours commercial de type {found} est visible, mais le profil reste incertain.", business.facts[found].evidence
        return "fail", 0, "Aucun parcours d'achat, réservation, devis ou contact clairement identifiable.", []
    if not business.offers:
        fact = business.facts[field]
        if fact.state == FactState.KNOWN:
            return "partial", .65, f"Le parcours {field} est visible, mais aucune offre canonique n'a pu lui être rattachée.", fact.evidence
    base = _fact(field, f"Le parcours {field} attendu est identifiable.", f"Le parcours {field} attendu n'est pas clairement expliqué.")(crawl, business)
    if base[0] == "pass" and business.offers:
        completeness = [_offer_completeness(o, business, "buyability") for o in business.offers]
        average = sum(completeness) / len(completeness)
        if average < .9:
            return "partial", .65 + .35 * average, f"Le parcours global est visible, mais la complétude transactionnelle moyenne des offres est de {average:.0%}.", base[3]
    return base


def _offer_completeness(offer, business: CanonicalBusiness, dimension: str) -> float:
    profile = business.profile.value
    if dimension == "understanding":
        fields = [bool(offer.name), offer.offer_type != "unknown", bool(offer.description)]
        if profile == "ecommerce": fields += [bool(offer.price), bool(offer.availability)]
        elif profile == "service_with_booking": fields += [bool(offer.price or business.facts["pricing"].values), bool(offer.availability)]
        elif profile == "service_with_quote_or_lead": fields += [bool(offer.cta or business.facts["quote_process"].values)]
        return sum(fields) / len(fields)
    if profile == "ecommerce": fields = [bool(offer.price), bool(offer.cta), bool(offer.availability)]
    elif profile == "service_with_booking": fields = [bool(offer.cta), bool(offer.price or business.facts["pricing"].values), bool(offer.availability)]
    elif profile == "service_with_quote_or_lead": fields = [bool(offer.cta or business.facts["quote_process"].values)]
    else: fields = [bool(offer.name), bool(offer.url)]
    return sum(fields) / len(fields)


def _pricing(crawl: CrawlResult, business: CanonicalBusiness):
    if business.facts["pricing"].state == FactState.KNOWN:
        return "pass", 1, "Des informations tarifaires sont publiées.", business.facts["pricing"].evidence
    if business.profile.value in {"service_with_quote_or_lead", "local_business"} and business.facts["quote_process"].state == FactState.KNOWN:
        return "pass", 1, "Aucun prix fixe n'est publié, mais un mécanisme de devis clair est disponible.", business.facts["quote_process"].evidence
    if business.facts["pricing"].state == FactState.NOT_APPLICABLE:
        return "not_applicable", 0, "Le prix n'est pas applicable à ce profil.", []
    return "fail", 0, "Aucun prix, fourchette ou mécanisme tarifaire explicite n'a été trouvé.", []


def _location(crawl: CrawlResult, business: CanonicalBusiness):
    if business.profile.value == "local_business" and business.facts["address"].state == FactState.KNOWN:
        return "pass", 1, "L'adresse physique satisfait la localisation du commerce.", business.facts["address"].evidence
    return _fact("service_area", "La zone desservie est indiquée.", "La zone desservie ou livrée est inconnue.")(crawl, business)


def _availability(crawl: CrawlResult, business: CanonicalBusiness):
    status = business.facts.get("commercial_status")
    if status and status.state == FactState.KNOWN and status.values:
        value = status.values[0]
        if value in {"temporarily_closed", "permanently_closed", "unavailable"}:
            return "fail", 0, f"L'état commercial public est {value}.", status.evidence
        if value == "seasonal":
            return "partial", .5, "L'activité est saisonnière; les dates applicables doivent être vérifiées.", status.evidence
    if business.profile.value == "local_business" and business.facts["opening_hours"].state == FactState.KNOWN:
        return "pass", 1, "Les horaires publiés satisfont la disponibilité du commerce local.", business.facts["opening_hours"].evidence
    return _fact("availability", "La disponibilité est indiquée.", "La disponibilité, les délais ou les créneaux sont inconnus.")(crawl, business)


RULES: Sequence[Rule] = (
    Rule("DISC.ACCESS.001", DISCOVERABILITY, "Pages publiques accessibles", 20, _pages_accessible),
    Rule("DISC.ROBOTS.002", DISCOVERABILITY, "Directives de crawl", 10, _robots),
    Rule("DISC.INDEX.003", DISCOVERABILITY, "Indexabilité déclarée", 15, _indexable),
    Rule("DISC.CANONICAL.004", DISCOVERABILITY, "Canonicalisation", 10, _canonicals),
    Rule("DISC.SITEMAP.005", DISCOVERABILITY, "Sitemap", 10, _sitemap),
    Rule("DISC.LINKS.006", DISCOVERABILITY, "Découverte interne", 20, _internal_discovery),
    Rule("DISC.META.007", DISCOVERABILITY, "Metadata descriptive", 15, _metadata),

    Rule("UNDR.IDENTITY.001", UNDERSTANDING, "Identité de l'entreprise", 15, _fact("business_name", "Le nom de l'entreprise est identifiable.", "Le nom de l'entreprise n'est pas établi avec suffisamment de preuve.")),
    Rule("UNDR.ACTIVITY.002", UNDERSTANDING, "Activité et marché", 10, _fact("activity_market", "L'activité ou le marché est expliqué.", "L'activité et le marché ne sont pas explicitement décrits.")),
    Rule("UNDR.OFFERS.003", UNDERSTANDING, "Offres compréhensibles", 25, _offers),
    Rule("UNDR.PRICE.004", UNDERSTANDING, "Modèle tarifaire", 10, _pricing),
    Rule("UNDR.AREA.005", UNDERSTANDING, "Zone desservie", 10, _location),
    Rule("UNDR.SCHEMA.006", UNDERSTANDING, "Données structurées", 15, _schema),
    Rule("UNDR.CONSISTENCY.007", UNDERSTANDING, "Cohérence des informations", 15, _consistency),

    Rule("BUY.CONVERSION.001", BUYABILITY, "Parcours de conversion", 30, _conversion),
    Rule("BUY.PRICE.002", BUYABILITY, "Prix ou devis", 15, _pricing),
    Rule("BUY.AVAILABILITY.003", BUYABILITY, "Disponibilité", 10, _availability),
    Rule("BUY.AREA.004", BUYABILITY, "Livraison ou zone desservie", 10, _location),
    Rule("BUY.PAYMENT.005", BUYABILITY, "Paiement", 10, _fact("payment", "Les modalités de paiement sont indiquées.", "Les moyens ou modalités de paiement sont inconnus.")),
    Rule("BUY.POLICY.006", BUYABILITY, "Retours ou annulations", 10, lambda c, b: _policy(c, b)),
    Rule("BUY.MACHINE.007", BUYABILITY, "Offre lisible par machine", 15, _schema),
)


def _policy(crawl: CrawlResult, business: CanonicalBusiness):
    fields = ("returns",) if business.profile.value == "ecommerce" else ("cancellation",)
    if business.profile.value in {"service_with_quote_or_lead", "informational", "local_business"}:
        return "not_applicable", 0, "Cette politique n'est pas applicable au profil.", []
    fact = business.facts[fields[0]]
    if fact.state == FactState.KNOWN:
        return "pass", 1, "La politique commerciale applicable est publiée.", fact.evidence
    return "fail", 0, "La politique de retour ou d'annulation applicable est inconnue.", []


def score(crawl: CrawlResult, business: CanonicalBusiness) -> Tuple[Dict[str, int], List[RuleResult]]:
    results: List[RuleResult] = []
    totals: Dict[str, List[float]] = {DISCOVERABILITY: [0, 0], UNDERSTANDING: [0, 0], BUYABILITY: [0, 0]}
    for rule in RULES:
        status, ratio, reason, evidence = rule.check(crawl, business)
        possible = 0 if status == "not_applicable" else rule.points
        awarded = round(rule.points * ratio, 2) if possible else 0
        totals[rule.score][0] += awarded
        totals[rule.score][1] += possible
        results.append(RuleResult(rule.rule_id, rule.score, rule.label, status, awarded, possible, reason, evidence))
    scores = {key: round(100 * awarded / possible) if possible else 100 for key, (awarded, possible) in totals.items()}
    scores["ai_readiness"] = round(.30 * scores[DISCOVERABILITY] + .35 * scores[UNDERSTANDING] + .35 * scores[BUYABILITY])
    return scores, results
