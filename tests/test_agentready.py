from __future__ import annotations

import functools
import json
import os
import tempfile
import threading
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agentready.audit import audit_url
from agentready.extractor import Extractor
from agentready.htmlparse import PublicPageParser
from agentready.models import BusinessProfile, CrawlResult, Page
from agentready.report_html import render_html
from agentready.scoring import score


ROOT = Path(__file__).parent


def page_from_fixture(path: Path, url="https://example.test/") -> Page:
    parser = PublicPageParser(url)
    parser.feed(path.read_text(encoding="utf-8"))
    return Page(url=url, status=200, content_type="text/html", **parser.result())


def crawl_for(page: Page) -> CrawlResult:
    return CrawlResult("https://example.test", "https://example.test", [page], "https://example.test/robots.txt", True, [], [], [], "now", 1, {"max_pages": 1, "max_depth": 0, "timeout_seconds": 1})


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == "/sitemap.xml":
            port = self.server.server_port
            content = f'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://127.0.0.1:{port}/</loc></url><url><loc>http://127.0.0.1:{port}/product.html</loc></url><url><loc>http://127.0.0.1:{port}/faq.html</loc></url></urlset>'.encode()
            self.send_response(200); self.send_header("Content-Type", "application/xml"); self.end_headers(); self.wfile.write(content)
            return
        if self.path == "/robots.txt":
            port = self.server.server_port
            content = f"User-agent: *\nAllow: /\nSitemap: http://127.0.0.1:{port}/sitemap.xml\n".encode()
            self.send_response(200); self.send_header("Content-Type", "text/plain"); self.end_headers(); self.wfile.write(content)
            return
        super().do_GET()


class AgentReadyTests(unittest.TestCase):
    def test_jsonld_and_visible_extraction_keep_evidence(self):
        page = page_from_fixture(ROOT / "fixtures/ecommerce/product.html", "https://example.test/product.html")
        business = Extractor().extract(crawl_for(page))
        self.assertEqual(business.profile, BusinessProfile.ECOMMERCE)
        self.assertEqual(business.offers[0].name, "Gourde Horizon")
        self.assertTrue(business.facts["pricing"].evidence)
        self.assertEqual(business.facts["payment"].state.value, "known")

    def test_all_six_profiles_are_available(self):
        expected = {
            "booking": BusinessProfile.SERVICE_WITH_BOOKING,
            "lead": BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD,
            "local": BusinessProfile.LOCAL_BUSINESS,
            "informational": BusinessProfile.INFORMATIONAL,
            "unknown": BusinessProfile.UNKNOWN,
        }
        for name, profile in expected.items():
            with self.subTest(name=name):
                page = page_from_fixture(ROOT / f"fixtures/profiles/{name}.html")
                self.assertEqual(Extractor().extract(crawl_for(page)).profile, profile)
        self.assertIn(BusinessProfile.UNKNOWN, set(BusinessProfile))

    def test_not_applicable_rules_are_renormalized(self):
        page = page_from_fixture(ROOT / "fixtures/profiles/informational.html")
        business = Extractor().extract(crawl_for(page))
        scores, rules = score(crawl_for(page), business)
        self.assertTrue(0 <= scores["buyability"] <= 100)
        self.assertTrue(any(r.status == "not_applicable" for r in rules))

    def test_bounded_crawl_full_report_and_html(self):
        directory = str(ROOT / "fixtures/ecommerce")
        handler = functools.partial(QuietHandler, directory=directory)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/"
            report = audit_url(url, max_pages=3, max_depth=2, timeout=2)
            self.assertLessEqual(len(report.crawl.pages), 3)
            self.assertEqual(report.business.profile, BusinessProfile.ECOMMERCE)
            self.assertIn("ai_discoverability", report.scores)
            self.assertNotIn("visibility", report.scores)
            encoded = json.dumps(report.to_dict(), ensure_ascii=False)
            self.assertIn("AI Discoverability", render_html(report))
            self.assertIn("rule_id", encoded)
            self.assertTrue(all(issue.correction for issue in report.issues))
        finally:
            server.shutdown(); server.server_close()


if __name__ == "__main__":
    unittest.main()
