"""Génère les exemples de sortie à partir du corpus synthétique, sans réseau."""
from datetime import datetime, timezone
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agentready.audit import NOTICE
from agentready.consistency import detect_inconsistencies
from agentready.extractor import Extractor
from agentready.htmlparse import PublicPageParser
from agentready.models import AuditReport, CrawlResult, Page
from agentready.recommendations import build_recommendations
from agentready.report_html import render_html
from agentready.scoring import score


FIXTURES = ROOT / "tests/fixtures/ecommerce"
OUT = ROOT / "examples"


def fixture_page(name: str, url: str) -> Page:
    parser = PublicPageParser(url)
    parser.feed((FIXTURES / name).read_text(encoding="utf-8"))
    return Page(url=url, status=200, content_type="text/html", **parser.result())


def main() -> None:
    pages = [
        fixture_page("index.html", "https://example.test/"),
        fixture_page("product.html", "https://example.test/product.html"),
        fixture_page("faq.html", "https://example.test/faq.html"),
    ]
    crawl = CrawlResult(
        requested_url="https://example.test/", final_origin="https://example.test", pages=pages,
        robots_url="https://example.test/robots.txt", robots_accessible=True,
        sitemap_urls=["https://example.test/sitemap.xml"], blocked_urls=[], warnings=[],
        started_at="2026-08-30T00:00:00+00:00", duration_ms=42,
        limits={"max_pages": 40, "max_depth": 3, "timeout_seconds": 12},
    )
    business = Extractor().extract(crawl)
    inconsistencies = detect_inconsistencies(crawl, business)
    scores, rules = score(crawl, business)
    issues = sorted(build_recommendations(rules, business) + inconsistencies, key=lambda x: -x.commercial_impact)
    report = AuditReport(
        schema_version="agentready.audit.v0.1", generated_at="2026-08-30T00:00:00+00:00",
        target_url="https://example.test/", methodology_notice=NOTICE, crawl=crawl,
        business=business, scores=scores,
        score_formula="AI Readiness = 30% AI Discoverability + 35% Understanding + 35% Buyability",
        rules=rules, inconsistencies=inconsistencies, issues=issues,
        limitations=["Exemple synthétique; aucune entreprise réelle n'est représentée."],
    )
    OUT.mkdir(exist_ok=True)
    (OUT / "example-report.json").write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "example-report.html").write_text(render_html(report), encoding="utf-8")


if __name__ == "__main__":
    main()
