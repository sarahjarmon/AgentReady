from __future__ import annotations

import unittest

from agentready.extractor import Extractor
from agentready.htmlparse import PublicPageParser
from agentready.models import BusinessProfile, CanonicalBusiness, CrawlResult, Evidence, Fact, FactState, Issue, Offer, Page
from agentready.offer_extraction import extract_page_offers
from agentready.recommendations import recommendation_sanity_check
from agentready.textutils import parse_prices


def page(html, url="https://example.test/"):
    parser = PublicPageParser(url); parser.feed(html)
    return Page(url, 200, "text/html", **parser.result())


def crawl(pages):
    return CrawlResult("https://example.test", "https://example.test", pages,
                       "https://example.test/robots.txt", True, [], [], [], "now", 1, {"max_pages": 40}, {})


class MoneyReliabilityTests(unittest.TestCase):
    def test_all_required_european_and_international_formats(self):
        cases = {
            "9,90 €": 9.90, "9.90 €": 9.90, "1 140 €": 1140,
            "1\u202f140 €": 1140, "1.140,50 €": 1140.50, "1,140.50 €": 1140.50,
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                price = parse_prices(raw)[0]
                self.assertEqual(price.minimum, expected)
                self.assertEqual(price.currency, "EUR")
                self.assertEqual(price.display, raw)

    def test_ranges_from_frequency_and_struck_prices(self):
        values = parse_prices("<del>29,90 €</del> 19,90 €; à partir de 20 €; 30 à 50 €; 9,99 € / mois; 99 € par an")
        self.assertEqual([x.minimum for x in values], [29.9, 19.9, 20, 30, 9.99, 99])
        self.assertEqual(values[3].maximum, 50)
        self.assertEqual(values[2].qualifier, "from")
        self.assertEqual(values[4].frequency, "monthly")
        self.assertEqual(values[5].frequency, "yearly")

    def test_ambiguous_number_is_unknown_not_guessed(self):
        self.assertIsNone(parse_prices("Prix 1,23,4 €")[0].minimum if parse_prices("Prix 1,23,4 €") else None)


class FactReliabilityTests(unittest.TestCase):
    def test_price_recommendation_is_rejected_when_canonical_price_exists(self):
        facts = {name: Fact(name) for name in Extractor.FACT_FIELDS}
        facts["pricing"] = Fact("pricing", FactState.CONFLICTING, ["9,90 €"], [Evidence("https://example.test/p", "price", "9,90 €")], .9)
        business = CanonicalBusiness(BusinessProfile.ECOMMERCE, .9, [], {}, False, facts,
                                     [Offer("Produit", "https://example.test/p", "product", price="9,90 €", price_value=9.9)])
        issue = Issue("x", "UNDR.PRICE.004", "Information tarifaire absente", "high", 94, ["understanding"], "absent", "content", "add")
        kept, rejected = recommendation_sanity_check([issue], business)
        self.assertEqual(kept, [])
        self.assertEqual(rejected[0]["rule_id"], "UNDR.PRICE.004")

    def test_temporary_closure_overrides_generic_hours(self):
        p = page("<html><head><meta name='description' content='Institut de massage'></head><body><h1>Institut</h1><p>Ouvert 7j/7. Information clients : fermeture temporaire. Nous ne pouvons pas communiquer de date de réouverture.</p><a>Réserver en ligne</a></body></html>")
        business = Extractor().extract(crawl([p]))
        self.assertEqual(business.facts["commercial_status"].values, ["temporarily_closed"])
        self.assertEqual(business.facts["availability"].values, ["temporarily_closed"])
        self.assertTrue(business.facts["availability"].evidence)

    def test_recommendation_widget_cannot_become_primary_product(self):
        p = page("""<html><body><main class='product-main'><h1>Café Bio</h1><p>9,90 €</p><button>Ajouter au panier</button></main>
        <section class='related-products recommendations'><h2>Panier en osier</h2><p>25 €</p><button>Ajouter au panier</button></section></body></html>""", "https://example.test/products/cafe")
        offers = extract_page_offers(p)
        self.assertEqual([x.name for x in offers], ["Café Bio"])
        self.assertEqual(offers[0].price_value, 9.9)

    def test_old_event_article_and_process_are_not_offers(self):
        old_event = page("<h1>Salon Vinister 2021</h1><p>Dégustation et vente</p><a>Nous contacter</a>", "https://example.test/news/salon-vinister")
        article = page("<h1>Comment choisir son café</h1><p>Découvrez nos conseils et nos produits.</p><a>Acheter</a>", "https://example.test/blog/choisir-cafe")
        process = page("<h1>Comment ça marche</h1><p>Étape 1 diagnostic, étape 2 livraison.</p><a>Demander un devis</a>", "https://example.test/services")
        self.assertEqual(extract_page_offers(old_event), [])
        self.assertEqual(extract_page_offers(article), [])
        self.assertEqual(extract_page_offers(process), [])

    def test_explicit_booking_and_quote_paths_are_recognized(self):
        booking_pages = [page("<h1>Massage Deep Tissue</h1><p>À partir de 75 €.</p><a>Réserver ce massage</a>", f"https://example.test/{x}") for x in ("", "tarifs")]
        booking = Extractor().extract(crawl(booking_pages))
        self.assertEqual(booking.profile, BusinessProfile.SERVICE_WITH_BOOKING)
        quote_pages = [page("<h1>Agencement sur mesure</h1><p>Nous concevons votre projet.</p><a>Demander un devis gratuit</a>", f"https://example.test/{x}") for x in ("", "services")]
        quote = Extractor().extract(crawl(quote_pages))
        self.assertEqual(quote.profile, BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD)


if __name__ == "__main__":
    unittest.main()
