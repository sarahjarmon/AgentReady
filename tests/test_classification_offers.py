from __future__ import annotations

import unittest

from agentready.extractor import Extractor
from agentready.htmlparse import PublicPageParser
from agentready.models import BusinessProfile, CrawlResult, Page


def business_from(html: str, url: str):
    parser = PublicPageParser(url)
    parser.feed(html)
    page = Page(url=url, status=200, content_type="text/html", **parser.result())
    crawl = CrawlResult(
        url, "https://example.test", [page], "https://example.test/robots.txt", True,
        [], [], [], "now", 1, {"max_pages": 1, "max_depth": 0, "timeout_seconds": 1},
    )
    return Extractor().extract(crawl)


def html(title: str, description: str, heading: str, body: str, action: str = "") -> str:
    button = f"<button>{action}</button>" if action else ""
    return f"""<html><head><title>{title}</title><meta name="description" content="{description}"></head>
    <body><h1>{heading}</h1><p>{body}</p>{button}</body></html>"""


class ClassificationAndOffersTests(unittest.TestCase):
    def test_paid_training_is_commercial_offer(self):
        business = business_from(html(
            "Formation Expert", "Formation professionnelle en ligne.", "Formation Expert en ligne",
            "Programme complet à 499 EUR. Paiement sécurisé et accès immédiat.", "Je veux rejoindre la formation",
        ), "https://example.test/formation")
        self.assertEqual(business.profile, BusinessProfile.ECOMMERCE)
        self.assertEqual(len(business.offers), 1)
        offer = business.offers[0]
        self.assertEqual(offer.offer_type, "formation")
        self.assertEqual(offer.price, "499 EUR")
        self.assertEqual(offer.currency, "EUR")
        self.assertEqual(offer.availability, "immediate_access")
        self.assertGreaterEqual(offer.confidence, .7)
        self.assertTrue(offer.evidence)

    def test_service_with_booking(self):
        business = business_from(html(
            "Consultation", "Service de consultation individuelle.", "Consultation individuelle",
            "Choisissez votre créneau pour une séance à 80 EUR.", "Réserver maintenant",
        ), "https://example.test/consultation")
        self.assertEqual(business.profile, BusinessProfile.SERVICE_WITH_BOOKING)
        self.assertEqual(business.offers[0].offer_type, "reservation")
        self.assertIn("Réserver", business.offers[0].cta)

    def test_service_with_quote_or_lead(self):
        business = business_from(html(
            "Conseil PME", "Cabinet de conseil pour PME.", "Service de conseil stratégique",
            "Chaque mission est adaptée à votre entreprise.", "Demander un devis",
        ), "https://example.test/service-conseil")
        self.assertEqual(business.profile, BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD)
        self.assertEqual(business.offers[0].offer_type, "service")

    def test_ecommerce_product(self):
        business = business_from(html(
            "Gourde", "Boutique de produits durables.", "Gourde isotherme Horizon",
            "Disponible en stock au prix de 29 €. Paiement par carte. Livraison en France.", "Ajouter au panier",
        ), "https://example.test/produit/gourde")
        self.assertEqual(business.profile, BusinessProfile.ECOMMERCE)
        self.assertEqual(business.offers[0].offer_type, "product")
        self.assertEqual(business.offers[0].currency, "EUR")

    def test_genuine_informational_site(self):
        business = business_from(html(
            "Observatoire", "Observatoire indépendant de la mobilité.", "Études sur la mobilité",
            "Nous publions des analyses, données publiques et articles de recherche sans activité commerciale.",
        ), "https://example.test/etudes")
        self.assertEqual(business.profile, BusinessProfile.INFORMATIONAL)
        self.assertEqual(business.offers, [])
        self.assertFalse(business.profile_ambiguous)

    def test_ambiguous_booking_and_quote_stays_unknown(self):
        business = business_from(html(
            "Consultation", "Service de consultation personnalisé.", "Consultation personnalisée",
            "Une consultation adaptée à votre besoin.", "Réserver ou demander un devis",
        ), "https://example.test/consultation")
        self.assertEqual(business.profile, BusinessProfile.UNKNOWN)
        self.assertTrue(business.profile_ambiguous)
        self.assertIn("service_with_booking", business.profile_candidates)
        self.assertIn("service_with_quote_or_lead", business.profile_candidates)


if __name__ == "__main__":
    unittest.main()
