from __future__ import annotations

import unittest
from urllib.error import URLError

from agentready.crawler import Crawler
from agentready.extractor import Extractor
from agentready.headless import RenderedPage, under_render_reason


CLASSIC_HTML = """<!doctype html><html><head><title>Entreprise classique</title>
<meta name="description" content="Service de conseil aux PME."></head><body>
<nav><a href="/services">Services</a><a href="/contact">Contact</a></nav>
<h1>Entreprise classique</h1><p>{text}</p><button>Demander un devis</button></body></html>""".format(
    text=" ".join(["Nous présentons clairement nos services de conseil pour les petites entreprises."] * 12)
)
JS_HTML = """<!doctype html><html><head><title>Chargement</title>
<script src="/assets/app.js"></script></head><body><div id="root"></div></body></html>"""


class StubCrawler(Crawler):
    def __init__(self, html: str, renderer):
        super().__init__(max_pages=1, max_depth=1, timeout=2, headless_renderer=renderer)
        self.html = html

    def _get(self, url):
        if url.endswith("robots.txt"):
            return 200, "text/plain", b"User-agent: *\nAllow: /", url
        if url.endswith("sitemap.xml"):
            raise URLError("fixture: no sitemap")
        return 200, "text/html; charset=utf-8", self.html.encode(), url


class RecordingRenderer:
    def __init__(self):
        self.calls = []
        self.closed = False

    def render(self, url):
        self.calls.append(url)
        return RenderedPage(
            url=url, title="Consultations Démo", description="Consultations professionnelles sur réservation.",
            text="Consultations Démo propose une consultation détaillée à distance. Tarif 80 EUR. Réserver maintenant.",
            headings=["Consultation Démo"],
            content_blocks=[{"heading": "Consultation Démo", "text": "Consultation à 80 EUR", "actions": ["Réserver maintenant"], "tag": "h1"}],
            links=[url + "reservation"], actions=["Réserver maintenant"], robots=[], canonical=url,
            jsonld=[{"@context": "https://schema.org", "@type": "Service", "name": "Consultation Démo", "offers": {"@type": "Offer", "price": "80", "priceCurrency": "EUR"}}],
        )

    def close(self):
        self.closed = True


class HeadlessFallbackTests(unittest.TestCase):
    def test_classic_html_page_keeps_http_method(self):
        renderer = RecordingRenderer()
        result = StubCrawler(CLASSIC_HTML, renderer).crawl("https://example.test/")
        self.assertEqual(result.pages[0].fetch_method, "http")

    def test_javascript_page_uses_headless_renderer(self):
        renderer = RecordingRenderer()
        result = StubCrawler(JS_HTML, renderer).crawl("https://example.test/")
        self.assertEqual(result.pages[0].fetch_method, "headless")
        self.assertEqual(renderer.calls, ["https://example.test/"])
        self.assertIn("Réserver maintenant", result.pages[0].actions)

    def test_fallback_detection(self):
        self.assertEqual(under_render_reason("Chargement", [], [], JS_HTML), "very_little_visible_text")
        self.assertIsNone(under_render_reason("Texte utile " * 80, ["https://example.test/service"], [], CLASSIC_HTML))

    def test_no_unnecessary_fallback_call(self):
        renderer = RecordingRenderer()
        StubCrawler(CLASSIC_HTML, renderer).crawl("https://example.test/")
        self.assertEqual(renderer.calls, [])
        self.assertTrue(renderer.closed)

    def test_evidence_is_preserved_after_rendering(self):
        renderer = RecordingRenderer()
        crawl = StubCrawler(JS_HTML, renderer).crawl("https://example.test/")
        business = Extractor().extract(crawl)
        self.assertTrue(business.offers)
        self.assertEqual(business.offers[0].name, "Consultation Démo")
        self.assertEqual(business.offers[0].evidence[0].kind, "jsonld")
        self.assertEqual(business.offers[0].evidence[0].url, "https://example.test/")
        self.assertTrue(business.facts["pricing"].evidence)

    def test_headless_budget_is_enforced(self):
        renderer = RecordingRenderer()
        crawler = StubCrawler(JS_HTML, renderer)
        crawler.max_headless_pages = 0
        result = crawler.crawl("https://example.test/")
        self.assertEqual(result.pages[0].fetch_method, "http")
        self.assertEqual(renderer.calls, [])
        self.assertTrue(any("Budget headless atteint" in warning for warning in result.warnings))


if __name__ == "__main__":
    unittest.main()
