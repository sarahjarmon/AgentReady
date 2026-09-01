from __future__ import annotations

import unittest
from urllib.error import URLError

from agentready.crawler import Crawler
from agentready.extractor import Extractor
from agentready.htmlparse import PublicPageParser
from agentready.models import BusinessProfile, CrawlResult, Page
from agentready.scoring import score
from agentready.textutils import commercial_phrase, parse_prices


def make_page(html: str, url: str) -> Page:
    parser = PublicPageParser(url); parser.feed(html)
    return Page(url=url, status=200, content_type="text/html", **parser.result())


def make_crawl(pages):
    return CrawlResult("https://example.test", "https://example.test", pages, "https://example.test/robots.txt", True, [], [], [], "now", 1, {"max_pages": 40}, {})


class PrecisionRegressionTests(unittest.TestCase):
    def test_word_boundaries_and_legal_context(self):
        self.assertIsNone(commercial_phrase("Ma devise : toujours avancer", ("devis",), "quote"))
        self.assertIsNone(commercial_phrase("La société se réserve le droit de suspendre l'accès", ("réserver",), "booking"))
        self.assertIsNone(commercial_phrase("L'éditeur pourra se retourner contre le visiteur", ("retour",), "returns"))
        page = make_page("<html><body><h1>La transformation, sous vos yeux</h1><p>Budget 35 000 €</p><a>Demander un devis</a></body></html>", "https://example.test/realisations")
        business = Extractor().extract(make_crawl([page]))
        self.assertEqual(business.offers, [])
        self.assertEqual(business.facts["pricing"].state.value, "unknown")

    def test_price_formats_ranges_frequency_and_qualifier(self):
        prices = parse_prices("À partir de 1\u202f140 € par an; 35 000 €; 19,90 €; 12.50 USD; 20 à 30 €; 9 € / mois")
        self.assertEqual(prices[0].minimum, 1140)
        self.assertEqual(prices[0].qualifier, "from")
        self.assertEqual(prices[0].frequency, "yearly")
        self.assertEqual(prices[1].minimum, 35000)
        self.assertEqual(prices[2].minimum, 19.90)
        self.assertEqual(prices[3].minimum, 12.50)
        self.assertEqual((prices[4].minimum, prices[4].maximum), (20, 30))
        self.assertEqual(prices[5].frequency, "monthly")

    def test_global_navigation_price_and_cta_are_not_offer_attributes(self):
        page = make_page("""<html><body><nav><a>Acheter</a><span>999 €</span></nav>
        <h1>Service de conseil</h1><p>Un accompagnement personnalisé pour PME.</p></body></html>""", "https://example.test/service")
        offer = Extractor().extract(make_crawl([page])).offers[0]
        self.assertIsNone(offer.price)
        self.assertIsNone(offer.cta)

    def test_booking_is_not_quote_because_of_devise(self):
        page = make_page("""<html><head><meta name='description' content='Studio de yoga à Bordeaux'></head><body>
        <h1>Réserver un cours de yoga</h1><p>Créneaux disponibles, séance 10 €.</p><button>Réserver maintenant</button>
        <h2>Notre équipe</h2><p>Ma devise : le yoga pour tous.</p></body></html>""", "https://example.test/reservation")
        business = Extractor().extract(make_crawl([page]))
        self.assertEqual(business.profile, BusinessProfile.SERVICE_WITH_BOOKING)
        self.assertEqual(business.facts["quote_process"].state.value, "unknown")

    def test_quote_path_beats_local_address(self):
        pages = []
        for path in ("/", "/services"):
            pages.append(make_page("""<html><head><meta name='description' content='Entreprise de rénovation'></head><body>
            <h1>Service de rénovation</h1><p>17 rue Exemple. Ouvert du lundi au vendredi.</p>
            <a>Demander un devis gratuit</a></body></html>""", "https://example.test" + path))
        business = Extractor().extract(make_crawl(pages))
        self.assertEqual(business.profile, BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD)

    def test_local_applicability_uses_address_hours_and_quote(self):
        page = make_page("""<html><head><meta name='description' content='Boulangerie artisanale à Lyon'></head><body>
        <h1>Boulangerie locale</h1><p>Adresse : 31 rue Exemple, Lyon. Horaires : mardi au samedi 7h-19h.</p>
        <h2>Traiteur</h2><p>Contactez-nous pour un devis gratuit.</p></body></html>""", "https://example.test/")
        business = Extractor().extract(make_crawl([page]))
        business.profile = BusinessProfile.LOCAL_BUSINESS
        scores, rules = score(make_crawl([page]), business)
        by_id = {r.rule_id: r for r in rules}
        self.assertEqual(by_id["UNDR.AREA.005"].status, "pass")
        self.assertEqual(by_id["BUY.AVAILABILITY.003"].status, "pass")
        self.assertEqual(by_id["BUY.POLICY.006"].status, "not_applicable")
        self.assertEqual(by_id["BUY.PRICE.002"].status, "pass")
        self.assertEqual(business.facts["booking_process"].state.value, "unknown")

    def test_incomplete_offers_prevent_perfect_scores_and_report_truncation(self):
        products = [{"@context": "https://schema.org", "@type": "Product", "name": f"Produit {i}", "url": f"https://example.test/p/{i}"} for i in range(60)]
        page = Page("https://example.test/", 200, "text/html", title="Boutique", description="Boutique", text="Acheter nos produits", jsonld=products)
        business = Extractor().extract(make_crawl([page]))
        scores, _ = score(make_crawl([page]), business)
        self.assertTrue(business.offers_truncated)
        self.assertEqual(business.offers_detected_total, 60)
        self.assertLess(scores["understanding"], 100)
        self.assertLess(scores["buyability"], 100)


class SitemapCrawler(Crawler):
    def __init__(self):
        super().__init__(max_pages=2, max_depth=1, timeout=1, max_headless_pages=0)

    def _get(self, url):
        if url.endswith("robots.txt"):
            return 200, "text/plain", b"User-agent: *\nSitemap: https://example.test/index.xml", url
        if url.endswith("index.xml"):
            return 200, "application/xml", b'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.test/pages.xml</loc></sitemap></sitemapindex>', url
        if url.endswith("pages.xml"):
            return 200, "application/xml", b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.test/one</loc><image:image xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><image:loc>https://example.test/photo.jpg</image:loc></image:image></url><url><loc>https://example.test/two</loc></url></urlset>', url
        if url.endswith("photo.jpg"):
            return 200, "image/jpeg", b"jpg", url
        return 200, "text/html", b"<html><body><h1>Page utile</h1><p>Contenu public suffisamment descriptif pour le test du crawler.</p></body></html>", url


class CrawlCoverageRegressionTests(unittest.TestCase):
    def test_sitemap_index_and_media_do_not_consume_page_budget(self):
        result = SitemapCrawler().crawl("https://example.test/")
        self.assertEqual(len(result.pages), 2)
        self.assertTrue(all("text/html" in p.content_type for p in result.pages))
        self.assertEqual(result.coverage["discovered_sitemap_pages"], 2)
        self.assertNotIn("https://example.test/photo.jpg", [p.url for p in result.pages])


if __name__ == "__main__": unittest.main()
