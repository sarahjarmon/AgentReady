from __future__ import annotations

import re
from datetime import datetime, timezone
from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .models import BusinessProfile, CanonicalBusiness, CrawlResult, Evidence, Fact, FactState, Offer, Page
from .offer_extraction import extract_page_offers, page_kind
from .offer_consolidation import consolidate_offers
from .textutils import commercial_phrase, normalized, parse_prices, phrase_pattern


EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
PHONE_RE = re.compile(r"(?<!\d)(?:\+\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?){2,5}\d{2,4}(?!\d)")

KEYWORDS = {
    "availability": ("en stock", "in stock", "disponible", "availability", "rupture", "out of stock", "créneau", "slot"),
    "service_area": ("zone desservie", "zones desservies", "nous intervenons", "livraison en", "livrons", "delivery area", "service area", "available in"),
    "shipping": ("livraison", "expédition", "shipping", "delivery", "retrait", "click and collect"),
    "payment": ("paiement", "payment", "visa", "mastercard", "paypal", "apple pay", "virement", "carte bancaire"),
    "returns": ("retour", "remboursement", "refund", "return policy", "returns", "droit de rétractation"),
    "cancellation": ("annulation", "annuler", "cancellation", "cancel booking"),
    "faq": ("faq", "questions fréquentes", "frequently asked questions"),
    "booking_process": ("réserver", "reservation", "réservation", "book now", "book a", "prendre rendez-vous", "appointment"),
    "quote_process": ("devis", "quote", "estimate", "demander une offre", "request a proposal"),
    "purchase_process": ("ajouter au panier", "add to cart", "acheter", "buy now", "commander", "checkout", "s'inscrire", "je veux", "rejoindre le programme", "accès immédiat"),
    "contact_process": ("contact", "nous appeler", "call us", "email us", "formulaire"),
    "hours": ("horaires", "opening hours", "ouvert", "open monday", "lundi", "monday"),
    "address": ("adresse", "address", "nous trouver", "find us"),
}


def _excerpt(text: str, needle: str, width: int = 180) -> str:
    lower = text.lower()
    index = lower.find(needle.lower())
    if index < 0:
        return text[:width].strip()
    start = max(0, index - width // 3)
    return text[start:index + len(needle) + width * 2 // 3].strip()


def _evidence(page: Page, kind: str, excerpt: str, selector: Optional[str] = None) -> Evidence:
    return Evidence(url=page.url, kind=kind, excerpt=excerpt[:300], selector=selector)


def _schema_types(node: Dict[str, Any]) -> List[str]:
    value = node.get("@type", [])
    return [value] if isinstance(value, str) else [str(x) for x in value]


def _walk_json(value: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_json(child)


class Extractor:
    FACT_FIELDS = (
        "business_name", "business_description", "activity_market", "contact_email", "contact_phone",
        "address", "service_area", "pricing", "availability", "shipping", "payment", "returns",
        "commercial_status",
        "cancellation", "faq", "purchase_process", "booking_process", "quote_process", "contact_process",
        "opening_hours", "structured_data",
    )

    def extract(self, crawl: CrawlResult) -> CanonicalBusiness:
        buckets: Dict[str, List[Tuple[str, Evidence, float]]] = defaultdict(list)
        offers: List[Offer] = []
        schema_types: Counter[str] = Counter()

        for page in crawl.pages:
            page.page_role = page_kind(page)
            if page.status < 200 or page.status >= 400 or not page.text:
                continue
            self._extract_page_text(page, buckets)
            self._extract_schema(page, buckets, offers, schema_types)
            offers.extend(extract_page_offers(page))

        if schema_types:
            page = next((p for p in crawl.pages if p.jsonld), crawl.pages[0])
            summary = ", ".join(f"{name} ({count})" for name, count in schema_types.most_common())
            buckets["structured_data"].append((summary, _evidence(page, "jsonld", summary, "script[type='application/ld+json']"), 1.0))

        offers, candidate_total = self._dedupe_offers(offers)
        for offer in offers:
            proof = offer.evidence[0] if offer.evidence else Evidence(offer.url, "offer", offer.name)
            if offer.price:
                buckets["pricing"].append((offer.price, proof, offer.confidence))
            if offer.availability:
                buckets["availability"].append((offer.availability, proof, offer.confidence))
        facts = {field: self._make_fact(field, buckets.get(field, [])) for field in self.FACT_FIELDS}
        self._resolve_commercial_status(facts)
        profile, confidence, profile_evidence, candidates, ambiguous = self._classify(crawl, facts, offers, schema_types)
        offers, consolidation = consolidate_offers(offers, crawl, profile)
        offers_total = consolidation["consolidated"]
        offers = offers[:50]
        valid_prices = [(o.price_original or o.price, o.price_evidence[0] if o.price_evidence else (o.evidence[0] if o.evidence else Evidence(o.url, "offer_price", o.price or "")), o.confidence)
                        for o in offers if o.price_value is not None and (o.price_original or o.price)]
        if valid_prices:
            facts["pricing"] = self._make_fact("pricing", valid_prices)
        profile, confidence, profile_evidence, candidates, ambiguous = self._classify(crawl, facts, offers, schema_types)
        self._apply_not_applicable(profile, facts)
        return CanonicalBusiness(
            profile=profile, profile_confidence=confidence, profile_evidence=profile_evidence,
            profile_candidates=candidates, profile_ambiguous=ambiguous, facts=facts, offers=offers,
            offer_candidates_total=candidate_total, offers_detected_total=offers_total,
            offers_truncated=offers_total > len(offers),
        )

    def _extract_page_text(self, page: Page, buckets: Dict[str, List[Tuple[str, Evidence, float]]]) -> None:
        text = page.text
        status = self._commercial_status(text)
        if status:
            label, phrase = status
            proof = _evidence(page, "commercial_status", _excerpt(text, phrase), "visible_text")
            buckets["commercial_status"].append((label, proof, 1.0))
            buckets["availability"].append((label, proof, 1.0))
        for match in EMAIL_RE.findall(text):
            buckets["contact_email"].append((match, _evidence(page, "visible_text", match), 0.95))
        for match in PHONE_RE.findall(text):
            value = match.strip()
            digits = re.sub(r"\D", "", value)
            position = text.find(value)
            context = normalized(text[max(0, position - 35):position + len(value) + 20])
            if len(digits) >= 8 and not (len(digits) in {9, 14} and any(x in context for x in ("siren", "siret", "tva"))):
                buckets["contact_phone"].append((value, _evidence(page, "visible_text", value), 0.8))
        for field, words in KEYWORDS.items():
            target = "opening_hours" if field == "hours" else field
            context_kind = "quote" if field == "quote_process" else "booking" if field == "booking_process" else "returns" if field == "returns" else None
            phrase = commercial_phrase(" ".join((text, page.url, page.title)), words, context_kind)
            if phrase:
                value = _excerpt(text, phrase)
                buckets[target].append((value, _evidence(page, "visible_text", value), 0.75))
        if page.description:
            buckets["business_description"].append((page.description, _evidence(page, "meta", page.description, "meta[name='description']"), 0.8))
            buckets["activity_market"].append((page.description, _evidence(page, "meta", page.description, "meta[name='description']"), 0.65))
        if page.title and page.url.rstrip("/").count("/") <= 2:
            candidate = re.split(r"\s+[|–—-]\s+", page.title)[0].strip()
            if 1 < len(candidate.split()) <= 8:
                buckets["business_name"].append((candidate, _evidence(page, "title", page.title, "title"), 0.65))

    def _extract_schema(self, page: Page, buckets: Dict[str, List[Tuple[str, Evidence, float]]], offers: List[Offer], schema_types: Counter[str]) -> None:
        for root in page.jsonld:
            for node in _walk_json(root):
                types = _schema_types(node)
                schema_types.update(types)
                proof = _evidence(page, "jsonld", str({k: node.get(k) for k in ("@type", "name", "price", "priceCurrency", "availability") if node.get(k) is not None}), "script[type='application/ld+json']")
                if any(t in types for t in ("Organization", "LocalBusiness", "Corporation", "Store", "ProfessionalService")):
                    self._add_schema_value(buckets, "business_name", node.get("name"), proof)
                    self._add_schema_value(buckets, "business_description", node.get("description"), proof)
                    self._add_schema_value(buckets, "contact_phone", node.get("telephone"), proof)
                    self._add_schema_value(buckets, "contact_email", node.get("email"), proof)
                    self._add_schema_value(buckets, "address", node.get("address"), proof)
                    self._add_schema_value(buckets, "service_area", node.get("areaServed"), proof)
                    self._add_schema_value(buckets, "opening_hours", node.get("openingHours"), proof)
                if "FAQPage" in types:
                    buckets["faq"].append(("FAQPage", proof, 1.0))
                if any(t in types for t in ("Product", "Service", "Course", "Event")):
                    name = self._string(node.get("name"))
                    if name and not ("Event" in types and self._past_event(node)):
                        raw_offers = node.get("offers")
                        offer_node = raw_offers if isinstance(raw_offers, dict) else next((x for x in raw_offers if isinstance(x, dict)), {}) if isinstance(raw_offers, list) else {}
                        schema_type = "product" if "Product" in types else "formation" if "Course" in types else "reservation" if "Event" in types else "service"
                        raw_price = self._string(offer_node.get("price"))
                        currency = self._string(offer_node.get("priceCurrency"))
                        parsed = parse_prices(f"{raw_price or ''} {currency or ''}")
                        amount = next((p for p in parsed if p.minimum is not None), None)
                        offers.append(Offer(
                            name=name, url=self._string(node.get("url")) or page.url,
                            offer_type=schema_type,
                            candidate_role="booking" if schema_type == "reservation" else schema_type,
                            description=self._string(node.get("description")),
                            price=amount.display if amount else None, price_value=amount.minimum if amount else None,
                            price_original=amount.display if amount else None,
                            price_evidence=[proof] if amount else [], currency=amount.currency if amount else currency,
                            frequency=self._string(offer_node.get("billingDuration") or offer_node.get("priceSpecification")),
                            availability=self._string(offer_node.get("availability")),
                            cta=self._string(offer_node.get("url")), cta_url=self._string(offer_node.get("url")), evidence=[proof], confidence=1.0,
                        ))
                if "Offer" in types:
                    self._add_schema_value(buckets, "pricing", node.get("price"), proof)
                    self._add_schema_value(buckets, "availability", node.get("availability"), proof)
                    self._add_schema_value(buckets, "shipping", node.get("shippingDetails"), proof)
                self._add_schema_value(buckets, "returns", node.get("hasMerchantReturnPolicy"), proof)
                self._add_schema_value(buckets, "payment", node.get("paymentAccepted"), proof)

    @staticmethod
    def _past_event(node: Dict[str, Any]) -> bool:
        value = node.get("endDate") or node.get("startDate")
        if not value:
            return False
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed < datetime.now(timezone.utc)
        except ValueError:
            return False

    @staticmethod
    def _commercial_status(text: str) -> Optional[Tuple[str, str]]:
        value = normalized(text)
        ordered = (
            ("permanently_closed", ("fermeture definitive", "definitivement ferme", "permanently closed")),
            ("temporarily_closed", ("fermeture temporaire", "temporairement ferme", "actuellement temporairement ferme", "temporarily closed")),
            ("unavailable", ("indisponible", "non disponible")),
            ("seasonal", ("ouverture saisonniere", "selon la saison", "seasonal")),
            ("open", ("ouvert 7j", "ouvert du lundi", "open daily")),
        )
        for label, phrases in ordered:
            for phrase in phrases:
                if phrase_pattern(phrase).search(value):
                    return label, phrase
        return None

    @staticmethod
    def _add_schema_value(buckets: Dict[str, List[Tuple[str, Evidence, float]]], field: str, value: Any, proof: Evidence) -> None:
        rendered = Extractor._string(value)
        if rendered:
            buckets[field].append((rendered, proof, 1.0))

    @staticmethod
    def _string(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, str):
            return value.strip() or None
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, list):
            parts = [Extractor._string(x) for x in value]
            return "; ".join(x for x in parts if x) or None
        if isinstance(value, dict):
            preferred = [value.get(k) for k in ("name", "streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry")]
            parts = [Extractor._string(x) for x in preferred]
            return ", ".join(x for x in parts if x) or str(value)
        return str(value)

    @staticmethod
    def _make_fact(field: str, values: List[Tuple[str, Evidence, float]]) -> Fact:
        unique: Dict[str, Tuple[str, List[Evidence], float]] = {}
        for value, evidence, confidence in values:
            normalized = re.sub(r"\s+", " ", value).strip()
            if not normalized:
                continue
            key = normalized.casefold()
            if key not in unique:
                unique[key] = (normalized, [], confidence)
            unique[key][1].append(evidence)
        rendered = list(unique.values())[:12]
        return Fact(
            field=field, state=FactState.KNOWN if rendered else FactState.UNKNOWN,
            values=[x[0] for x in rendered], evidence=[ev for x in rendered for ev in x[1]][:15],
            confidence=max((x[2] for x in rendered), default=0.0),
        )

    @staticmethod
    def _resolve_commercial_status(facts: Dict[str, Fact]) -> None:
        fact = facts["commercial_status"]
        priority = ("permanently_closed", "temporarily_closed", "unavailable", "seasonal", "open")
        chosen = next((value for value in priority if value in fact.values), None)
        if not chosen:
            return
        evidence = [e for e in fact.evidence if chosen.replace("_", " ") in normalized(e.excerpt) or
                    (chosen == "temporarily_closed" and "fermeture temporaire" in normalized(e.excerpt))]
        fact.values = [chosen]
        fact.evidence = evidence or fact.evidence[:5]
        fact.state = FactState.KNOWN
        if chosen in {"permanently_closed", "temporarily_closed", "unavailable", "seasonal"}:
            facts["availability"] = Fact("availability", FactState.KNOWN, [chosen], fact.evidence, 1.0)

    def _classify(self, crawl: CrawlResult, facts: Dict[str, Fact], offers: List[Offer], types: Counter[str]):
        scores: Counter[BusinessProfile] = Counter()
        families: Dict[BusinessProfile, set] = defaultdict(set)

        def add(profile: BusinessProfile, points: float, family: str) -> None:
            scores[profile] += points
            families[profile].add(family)

        paid_products = [o for o in offers if o.offer_type in {"product", "formation"} and o.price]
        purchase_ctas = [o for o in offers if o.cta and any(x in o.cta.lower() for x in ("acheter", "commander", "je veux", "inscri", "rejoindre", "accéder", "buy", "order"))]
        booking_offers = [o for o in offers if o.offer_type == "reservation"]
        service_offers = [o for o in offers if o.offer_type in {"service", "formation"}]

        if paid_products:
            add(BusinessProfile.ECOMMERCE, 4, "paid_product_or_formation")
        if purchase_ctas or facts["purchase_process"].state == FactState.KNOWN:
            add(BusinessProfile.ECOMMERCE, 6, "purchase_path")
        if facts["pricing"].state == FactState.KNOWN and facts["payment"].state == FactState.KNOWN:
            add(BusinessProfile.ECOMMERCE, 2, "price_and_payment")
        if types["Product"] or types["Offer"]:
            add(BusinessProfile.ECOMMERCE, 4, "structured_commerce")

        if booking_offers:
            add(BusinessProfile.SERVICE_WITH_BOOKING, 4, "booking_offer")
        if facts["booking_process"].state == FactState.KNOWN or types["Reservation"] or types["Event"]:
            add(BusinessProfile.SERVICE_WITH_BOOKING, 7, "booking_path")
        if (booking_offers or facts["booking_process"].state == FactState.KNOWN) and facts["availability"].state == FactState.KNOWN:
            add(BusinessProfile.SERVICE_WITH_BOOKING, 1, "availability")

        if facts["quote_process"].state == FactState.KNOWN:
            add(BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD, 7, "quote_path")
            description = " ".join(facts["business_description"].values).lower()
            if any(token in description for token in ("service", "conseil", "cabinet", "agence", "consult", "accompagnement", "studio")):
                add(BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD, 2, "service_context")
        if service_offers and facts["contact_process"].state == FactState.KNOWN:
            add(BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD, 3, "service_and_contact")
        if types["Service"] and facts["contact_process"].state == FactState.KNOWN:
            add(BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD, 2, "structured_service")

        if types["LocalBusiness"]:
            add(BusinessProfile.LOCAL_BUSINESS, 4, "structured_local_business")
        if facts["address"].state == FactState.KNOWN and facts["opening_hours"].state == FactState.KNOWN:
            add(BusinessProfile.LOCAL_BUSINESS, 4, "address_and_hours")
        if facts["address"].state == FactState.KNOWN and facts["contact_process"].state == FactState.KNOWN:
            add(BusinessProfile.LOCAL_BUSINESS, 1, "address_and_contact")

        commercial = bool(offers or paid_products or booking_offers or facts["pricing"].state == FactState.KNOWN
                          or any(facts[x].state == FactState.KNOWN for x in ("purchase_process", "booking_process", "quote_process")))
        if facts["business_description"].state == FactState.KNOWN and not commercial:
            add(BusinessProfile.INFORMATIONAL, 5, "descriptive_content_without_commerce")
        if len(crawl.pages) >= 2 and not commercial:
            add(BusinessProfile.INFORMATIONAL, 2, "multiple_content_pages")

        eligible = [(p, float(value)) for p, value in scores.items() if value >= 4 and len(families[p]) >= 2]
        if scores[BusinessProfile.INFORMATIONAL] >= 5 and not commercial:
            eligible.append((BusinessProfile.INFORMATIONAL, float(scores[BusinessProfile.INFORMATIONAL])))
        eligible = sorted(set(eligible), key=lambda x: (-x[1], x[0].value))
        candidates = {p.value: round(float(value), 2) for p, value in sorted(scores.items(), key=lambda x: -x[1])}
        evidence_url_count = lambda field: len({e.url for e in facts[field].evidence})
        dominant = []
        if (evidence_url_count("purchase_process") >= 2 or types["Product"] or types["Offer"]) and scores[BusinessProfile.ECOMMERCE] >= 6:
            dominant.append(BusinessProfile.ECOMMERCE)
        if (evidence_url_count("booking_process") >= 2 or (booking_offers and facts["quote_process"].state != FactState.KNOWN)) and scores[BusinessProfile.SERVICE_WITH_BOOKING] >= 7:
            dominant.append(BusinessProfile.SERVICE_WITH_BOOKING)
        if evidence_url_count("quote_process") >= 2 and scores[BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD] >= 7:
            dominant.append(BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD)
        if (facts["address"].state == FactState.KNOWN and facts["opening_hours"].state == FactState.KNOWN
                and evidence_url_count("quote_process") < 2 and scores[BusinessProfile.LOCAL_BUSINESS] >= 4):
            dominant.append(BusinessProfile.LOCAL_BUSINESS)
        if dominant:
            dominant = sorted(set(dominant), key=lambda p: -scores[p])
            profile = dominant[0]
            top = float(scores[profile])
            second = max((float(scores[p]) for p in dominant[1:]), default=0.0)
            ambiguous = len(dominant) > 1 and top - second < 2
            if not ambiguous:
                confidence = round(min(.97, .55 + top * .035 + (top - second) * .015), 2)
                evidence_fields = {
                    BusinessProfile.ECOMMERCE: ("purchase_process", "pricing", "payment"),
                    BusinessProfile.SERVICE_WITH_BOOKING: ("booking_process", "availability"),
                    BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD: ("quote_process", "contact_process"),
                    BusinessProfile.LOCAL_BUSINESS: ("address", "opening_hours"),
                }[profile]
                evidence = [ev for o in offers for ev in o.evidence][:5] + [ev for f in evidence_fields for ev in facts[f].evidence][:5]
                return profile, confidence, evidence[:10], candidates, False
        # One strongly explicit primary path can be decisive even on a compact site.
        booking_urls = evidence_url_count("booking_process")
        quote_urls = evidence_url_count("quote_process")
        purchase_urls = evidence_url_count("purchase_process")
        if booking_urls and scores[BusinessProfile.SERVICE_WITH_BOOKING] >= 7 and booking_urls > quote_urls and booking_urls >= purchase_urls:
            profile = BusinessProfile.SERVICE_WITH_BOOKING
            evidence = facts["booking_process"].evidence[:10]
            return profile, .88, evidence, candidates, False
        if quote_urls and scores[BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD] >= 7 and quote_urls > booking_urls and quote_urls >= purchase_urls:
            profile = BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD
            evidence = facts["quote_process"].evidence[:10]
            return profile, .88, evidence, candidates, False
        if not eligible:
            return BusinessProfile.UNKNOWN, .25, [], candidates, bool(scores)
        profile, top = eligible[0]
        second = eligible[1][1] if len(eligible) > 1 else 0.0
        ambiguous = second >= 4 and top - second <= 2
        if ambiguous:
            evidence = [ev for o in offers for ev in o.evidence][:8]
            return BusinessProfile.UNKNOWN, round(min(.55, .30 + top / 40), 2), evidence, candidates, True
        margin = top - second
        confidence = round(min(.97, .42 + top * .045 + margin * .02), 2)
        evidence_fields = {
            BusinessProfile.ECOMMERCE: ("purchase_process", "pricing", "payment"),
            BusinessProfile.SERVICE_WITH_BOOKING: ("booking_process", "availability"),
            BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD: ("quote_process", "contact_process"),
            BusinessProfile.LOCAL_BUSINESS: ("address", "opening_hours"),
            BusinessProfile.INFORMATIONAL: ("business_description",),
        }.get(profile, ())
        evidence = [ev for o in offers for ev in o.evidence][:5] + [ev for f in evidence_fields for ev in facts[f].evidence][:5]
        return profile, confidence, evidence[:10], candidates, False

    @staticmethod
    def _apply_not_applicable(profile: BusinessProfile, facts: Dict[str, Fact]) -> None:
        not_applicable = {
            BusinessProfile.ECOMMERCE: ("booking_process", "quote_process", "opening_hours"),
            BusinessProfile.SERVICE_WITH_BOOKING: ("shipping", "returns", "purchase_process"),
            BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD: ("shipping", "returns", "availability", "payment", "cancellation", "purchase_process", "booking_process"),
            BusinessProfile.LOCAL_BUSINESS: ("shipping", "returns"),
            BusinessProfile.INFORMATIONAL: ("pricing", "availability", "shipping", "payment", "returns", "cancellation", "purchase_process", "booking_process", "quote_process"),
        }.get(profile, ())
        for field in not_applicable:
            if facts[field].state == FactState.UNKNOWN:
                facts[field].state = FactState.NOT_APPLICABLE

    @staticmethod
    def _dedupe_offers(offers: List[Offer]):
        by_url: Dict[str, Offer] = {}
        for offer in offers:
            base_url = offer.url.split("#", 1)[0]
            key = base_url + "|" + normalized(offer.name)
            current = by_url.get(key)
            if current is None or offer.confidence > current.confidence:
                if current:
                    offer.evidence = (current.evidence + offer.evidence)[:10]
                    offer.price = offer.price or current.price
                    offer.currency = offer.currency or current.currency
                    offer.cta = offer.cta or current.cta
                by_url[key] = offer
            elif current:
                current.evidence = (current.evidence + offer.evidence)[:10]
                current.price = current.price or offer.price
                current.currency = current.currency or offer.currency
                current.cta = current.cta or offer.cta
        result = sorted(by_url.values(), key=lambda o: (-o.confidence, o.url))
        return result, len(result)
