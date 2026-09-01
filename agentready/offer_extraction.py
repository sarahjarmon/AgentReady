from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import unquote, urlparse

from .models import Evidence, Offer, Page
from .textutils import ParsedPrice, commercial_phrase, excerpt, normalized, parse_prices, phrase_pattern

URL_TYPES: Sequence[Tuple[str, Tuple[str, ...]]] = (
    ("reservation", ("reservation", "reserver", "booking", "rendez vous", "rdv", "appointment", "consultation")),
    ("formation", ("formation", "formations", "cours", "course", "programme", "programmes", "program", "academy", "academie")),
    ("product", ("produit", "produits", "product", "products", "boutique", "shop", "store", "ebook", "livre", "livres", "book", "pains", "viennoiseries", "patisseries", "confiseries")),
    ("service", ("service", "services", "offre", "offres", "offer", "tarif", "tarifs", "pricing", "coaching", "accompagnement", "soin", "traiteur")),
)
COMMERCIAL_TERMS = ("formation", "programme", "consultation", "reservation", "rendez vous", "service", "produit", "ebook", "livre", "atelier", "coaching", "accompagnement", "soin", "acces immediat", "paiement securise", "inscription", "tarif", "commande", "devis")
CTA_TERMS = ("acheter", "buy", "commander", "order", "ajouter au panier", "add to cart", "s inscrire", "inscription", "reserver", "book", "prendre rendez vous", "demander un devis", "request a quote", "obtenir un devis", "je veux", "rejoindre", "rejoins", "acceder", "commencer", "obtiens", "obtenir", "contactez", "contact us")
PAGE_KINDS = {
    "legal": ("mentions legales", "legal", "cgu", "cgv", "privacy", "confidentialite", "politique"),
    "portfolio": ("realisation", "realisations", "portfolio", "projet", "projets", "case study", "etude de cas"),
    "article": ("blog", "article", "actualite", "actualites", "news", "conseil", "conseils", "journal"),
    "event": ("event", "events", "evenement", "evenements", "agenda", "salon"),
    "testimonial": ("temoignage", "temoignages", "avis clients", "success story"),
    "category": ("collection", "collections", "categorie", "categories", "univers", "rayon", "faq", "foire aux questions"),
}


def page_kind(page: Page) -> str:
    segments = [normalized(x.replace("-", " ")) for x in unquote(urlparse(page.url).path).split("/") if x]
    for kind, tokens in PAGE_KINDS.items():
        if any(normalized(token) in segments for token in tokens):
            return kind
    return "offer_or_general"


def extract_page_offers(page: Page) -> List[Offer]:
    if page_kind(page) != "offer_or_general":
        return []
    path = normalized(unquote(urlparse(page.url).path).replace("/", " ").replace("-", " "))
    url_type = _type_from(path)
    blocks = page.content_blocks or [{"heading": page.headings[0] if page.headings else _title_name(page.title), "text": page.text, "actions": page.actions, "tag": "h1"}]
    result: List[Offer] = []
    for index, block in enumerate(blocks[:80]):
        offer = _offer_from_block(page, block, url_type, index)
        if offer:
            result.append(offer)
    return _dedupe(result)


def _offer_from_block(page: Page, block: Dict[str, Any], url_type: Optional[str], index: int) -> Optional[Offer]:
    heading = re.sub(r"\s+", " ", str(block.get("heading", ""))).strip()
    text = re.sub(r"\s+", " ", str(block.get("text", ""))).strip()
    actions = [re.sub(r"\s+", " ", str(x)).strip() for x in block.get("actions", []) if str(x).strip()]
    heading_type = _type_from(normalized(heading))
    role = classify_block_role(page, block)
    if role in {"recommendation_widget", "article", "event", "portfolio", "testimonial", "legal", "process_step", "informational"}:
        return None
    prices = [p for p in parse_prices(text) if p.minimum is not None and not _non_offer_price_context(text, p)]
    cta_candidates = [x for x in actions if commercial_phrase(x, CTA_TERMS, "booking")]
    cta = max(cta_candidates, key=lambda x: (_cta_score(x), len(x)), default=None)
    cta_detail = next((x for x in block.get("action_details", []) if normalized(str(x.get("label", ""))) == normalized(cta or "")), {})
    commercial_copy = commercial_phrase(text[:4000], COMMERCIAL_TERMS)
    signals: Set[str] = set()
    evidence: List[Evidence] = []
    if url_type:
        signals.add("url"); evidence.append(Evidence(page.url, "url", urlparse(page.url).path or "/"))
    if heading_type:
        signals.add("heading"); evidence.append(Evidence(page.url, "heading", heading, str(block.get("tag") or "h1,h2,h3")))
    if prices:
        signals.add("price"); evidence.append(Evidence(page.url, "visible_text", excerpt(text, prices[0].start, prices[0].end), "context-block"))
    if cta:
        signals.add("cta"); evidence.append(Evidence(page.url, "cta", cta, "context-block a,button"))
    if commercial_copy:
        signals.add("commercial_copy"); evidence.append(Evidence(page.url, "visible_text", text[:300], "context-block"))
    if url_type in {"service", "product"} and len(text) >= 80 and normalized(heading) not in {"nos engagements", "notre equipe", "questions frequentes", "foire aux questions"}:
        signals.add("descriptive_block")
    if len(signals) < 2 or (not (url_type or heading_type) and len(signals) < 3):
        return None
    if not heading or len(heading.split()) > 20:
        return None
    selected = prices[0] if prices else None
    confidence = min(.96, .35 + .13 * len(signals) + (.08 if "price" in signals and "cta" in signals else 0))
    price_proof = Evidence(page.url, "visible_price", excerpt(text, selected.start, selected.end), "context-block") if selected else None
    return Offer(
        name=heading, url=page.url + (f"#offer-{index+1}" if index else ""), offer_type=heading_type or url_type or "service",
        candidate_role=role, description=page.description or text[:300] or None, price=selected.display if selected else None,
        price_value=selected.minimum if selected else None, price_original=selected.display if selected else None,
        price_evidence=[price_proof] if price_proof else [],
        currency=selected.currency if selected else None, frequency=selected.frequency if selected else _frequency(text),
        availability=_availability(text), cta=cta, cta_url=cta_detail.get("href") or None,
        evidence=evidence[:8], confidence=round(confidence, 2),
    )


def classify_block_role(page: Page, block: Dict[str, Any]) -> str:
    page_role = page_kind(page)
    if page_role in {"article", "event", "portfolio", "testimonial", "legal"}:
        return page_role
    heading = normalized(str(block.get("heading", "")))
    context = block.get("context") or {}
    structural = normalized(" ".join(
        [str(context.get("id", "")), str(context.get("class", ""))]
        + [str(x.get("id", "")) + " " + str(x.get("class", "")) for x in context.get("ancestors", []) if isinstance(x, dict)]
    ))
    if any(phrase_pattern(x).search(structural) for x in ("related", "recommended", "recommendation", "similar", "upsell", "cross sell", "recently viewed", "you may also", "produits associes")):
        return "recommendation_widget"
    if any(phrase_pattern(x).search(heading) for x in ("produits associes", "vous aimerez", "a decouvrir aussi", "filtrer par", "menu")):
        return "recommendation_widget"
    if any(phrase_pattern(x).search(heading) for x in ("etape", "comment ca marche", "deroulement", "notre processus", "echange diagnostic", "devis planning", "livraison garanties")):
        return "process_step"
    if any(phrase_pattern(x).search(heading) for x in ("notre equipe", "nos valeurs", "nos engagements", "informations pratiques", "questions frequentes", "contact", "service client")):
        return "informational"
    if page_role == "category" or any(phrase_pattern(x).search(heading) for x in ("nos produits", "nos services", "les tarifs", "les cours", "categories")):
        return "category"
    value = normalized(" ".join((str(block.get("text", ""))[:1000], " ".join(block.get("actions", [])))))
    if any(phrase_pattern(x).search(value) for x in ("reserver", "prendre rendez vous", "book now", "reservation en ligne")):
        return "booking"
    if any(phrase_pattern(x).search(value) for x in ("demander un devis", "obtenir un devis", "request a quote")):
        return "quote"
    kind = _type_from(heading) or _type_from(normalized(unquote(urlparse(page.url).path)))
    return "product" if kind == "product" else "service" if kind in {"service", "formation"} else "commercial_offer"


def _type_from(value: str) -> Optional[str]:
    for offer_type, tokens in URL_TYPES:
        if any(phrase_pattern(token).search(value) for token in tokens):
            return offer_type
    return None


def _non_offer_price_context(text: str, price: ParsedPrice) -> bool:
    around = normalized(text[max(0, price.start - 80):price.end + 80])
    return any(phrase_pattern(x).search(around) for x in ("budget", "chiffre d affaires", "economies realisees", "montant des travaux"))


def _cta_score(value: str) -> int:
    lower = normalized(value)
    strong = ("ajouter au panier", "add to cart", "acheter", "commander", "buy now", "reserver maintenant", "demander un devis")
    contextual = ("formation", "ebook", "programme", "consultation", "rendez vous", "offre", "devis")
    return (5 if any(phrase_pattern(x).search(lower) for x in strong) else 2) + (3 if any(phrase_pattern(x).search(lower) for x in contextual) else 0)


def _availability(text: str) -> Optional[str]:
    value = normalized(text)
    for label, phrases in (("temporarily_closed", ("fermeture temporaire", "temporairement ferme", "temporarily closed")), ("permanently_closed", ("fermeture definitive", "definitivement ferme", "permanently closed")), ("unavailable", ("indisponible", "non disponible")), ("seasonal", ("ouverture saisonniere", "selon la saison", "seasonal")), ("in_stock", ("en stock", "in stock")), ("out_of_stock", ("rupture", "out of stock")), ("immediate_access", ("acces immediat", "access immediate")), ("open", ("ouvert 7j", "ouvert du lundi", "open daily")), ("available", ("disponible", "places disponibles", "creneau disponible"))):
        if any(phrase_pattern(x).search(value) for x in phrases):
            return label
    return None


def _frequency(text: str) -> Optional[str]:
    value = normalized(text)
    if any(phrase_pattern(x).search(value) for x in ("par mois", "mensuel")): return "monthly"
    if any(phrase_pattern(x).search(value) for x in ("par an", "annuel")): return "yearly"
    if phrase_pattern("paiement unique").search(value): return "one_time"
    return None


def _title_name(title: str) -> str:
    return re.split(r"\s+[|–—-]\s+", title)[0].strip()


def _dedupe(offers: List[Offer]) -> List[Offer]:
    seen = set(); result = []
    for offer in offers:
        key = (normalized(offer.name), offer.url.split("#", 1)[0])
        if key not in seen:
            seen.add(key); result.append(offer)
    return result
