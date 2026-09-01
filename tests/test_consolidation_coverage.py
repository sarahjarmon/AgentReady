from __future__ import annotations

import unittest

from agentready.coverage import VERSION as COVERAGE_VERSION, assess_coverage
from agentready.models import BusinessProfile, CanonicalBusiness, CrawlResult, Evidence, Offer, Page
from agentready.offer_consolidation import consolidate_offers


def crawl(pages=None, coverage=None):
    pages = pages or []
    return CrawlResult("https://example.test", "https://example.test", pages,
                       "https://example.test/robots.txt", True, [], [], [], "now", 1,
                       {"max_pages": 40, "headless_pages_used": 0}, coverage or {})


def offer(name, url, kind="service", cta=None, price=None, confidence=.8):
    return Offer(name=name, url=url, offer_type=kind, cta=cta, price=price,
                 confidence=confidence, evidence=[Evidence(url, "dom_block", name)])


class OfferConsolidationTests(unittest.TestCase):
    def test_repeated_booking_cta_is_one_offer_with_all_proofs(self):
        items = [offer("Réserver une séance découverte", f"https://example.test/page-{i}", "reservation",
                       "Réserver une séance découverte", confidence=.9) for i in range(3)]
        result, counts = consolidate_offers(items, crawl(), BusinessProfile.SERVICE_WITH_BOOKING)
        self.assertEqual(len(result), 1)
        self.assertEqual(counts, {"candidates": 3, "consolidated": 1})
        self.assertEqual(len(result[0].evidence), 3)
        self.assertEqual(result[0].consolidation["merged_count"], 3)
        self.assertIn("repeated_booking_cta", result[0].consolidation["reasons"])

    def test_process_and_benefit_sections_are_not_standalone_offers(self):
        url = "https://example.test/accompagnement"
        page = Page(url, 200, "text/html", canonical=url)
        items = [offer("Accompagnement rénovation", url, cta="Demander un devis", confidence=.9),
                 offer("Échange & diagnostic", url, confidence=.7),
                 offer("Livraison & garanties", url, confidence=.7),
                 offer("Innovation", url, confidence=.7)]
        result, _ = consolidate_offers(items, crawl([page]), BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD)
        self.assertEqual([x.name for x in result], ["Accompagnement rénovation"])
        absorbed = result[0].consolidation["absorbed_elements"]
        self.assertEqual({x["role"] for x in absorbed}, {"process_step", "informative_section"})
        self.assertEqual(len(result[0].evidence), 4)

    def test_distinct_products_and_variants_on_distinct_urls_are_not_merged(self):
        items = [offer("Café Bio 250 g", "https://example.test/p/cafe-250", "product", "Ajouter au panier", "8 €", 1),
                 offer("Café Bio 1 kg", "https://example.test/p/cafe-1kg", "product", "Ajouter au panier", "24 €", 1)]
        result, _ = consolidate_offers(items, crawl(), BusinessProfile.ECOMMERCE)
        self.assertEqual(len(result), 2)

    def test_similar_same_canonical_blocks_merge_conservatively(self):
        page_url = "https://example.test/service"
        page = Page(page_url, 200, "text/html", canonical=page_url)
        items = [offer("Audit énergétique complet", page_url + "#top", cta="Demander un devis", price="1 140 €", confidence=.9),
                 offer("Audit énergétique complet.", page_url + "#details", cta="Demander un devis", price="1 140 €", confidence=.8)]
        result, _ = consolidate_offers(items, crawl([page]), BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD)
        self.assertEqual(len(result), 1)
        self.assertIn("same_name_and_repeated_cta", result[0].consolidation["reasons"])

    def test_generic_commerce_sections_are_not_offers(self):
        url = "https://example.test/products/cafe"
        items = [offer("Café Bio", url, "product", "Ajouter au panier", "8 €", 1),
                 offer("Produits associés", url + "#related", "product", "Ajouter au panier", confidence=.96),
                 offer("Favoris", url + "#favorites", "product", confidence=.74)]
        result, _ = consolidate_offers(items, crawl([Page(url, 200, "text/html", canonical=url)]), BusinessProfile.ECOMMERCE)
        self.assertEqual([x.name for x in result], ["Café Bio"])
        self.assertEqual(len(result[0].evidence), 3)

    def test_html_aliases_and_local_subcategories_are_grouped(self):
        services = [offer("Isolation", "https://example.test/services", "service", cta="Devis"),
                    offer("Isolation", "https://example.test/services.html", "service", cta="Devis")]
        result, _ = consolidate_offers(services, crawl(), BusinessProfile.SERVICE_WITH_QUOTE_OR_LEAD)
        self.assertEqual(len(result), 1)
        page = "https://example.test/pains/"
        local = [offer("Pains & viennoiseries", page, "product", confidence=.74),
                 offer("Une large gamme de pains", page + "#offer-2", "product", confidence=.74),
                 offer("Nos viennoiseries", page + "#offer-3", "product", confidence=.61)]
        result, _ = consolidate_offers(local, crawl(), BusinessProfile.LOCAL_BUSINESS)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].consolidation["relationship"], "category_with_subservices")
        self.assertEqual(len(result[0].consolidation["absorbed_elements"]), 2)


class CoverageTests(unittest.TestCase):
    def business(self, detected=0, kept=0, candidates=0):
        offers = [offer(f"Produit {i}", f"https://example.test/{i}", "product") for i in range(kept)]
        return CanonicalBusiness(BusinessProfile.ECOMMERCE, .9, [], {}, False, {}, offers,
                                 candidates, detected, detected > kept)

    def test_partial_large_catalog_is_separate_from_observed_score(self):
        raw = {"pages_html_analyzed": 40, "pages_html_discovered": 1000, "page_limit_reached": True,
               "headless_needed": 0, "headless_used": 0, "headless_budget_reached": False}
        result = assess_coverage(crawl(coverage=raw), self.business(163, 50, 200), 96)
        self.assertEqual(result["version"], COVERAGE_VERSION)
        self.assertEqual(result["coverage_status"], "partial")
        self.assertLessEqual(result["coverage_confidence"], 74)
        self.assertLess(result["confidence_adjusted_readiness"], 96)
        self.assertTrue(any("50 offres conservées sur 163" in x for x in result["coverage_reasons"]))

    def test_complete_audit_does_not_reduce_observed_score(self):
        raw = {"pages_html_analyzed": 12, "pages_html_discovered": 12, "page_limit_reached": False,
               "headless_needed": 2, "headless_used": 2, "headless_budget_reached": False}
        result = assess_coverage(crawl(coverage=raw), self.business(3, 3, 4), 91)
        self.assertEqual(result["coverage_status"], "complete")
        self.assertEqual(result["coverage_confidence"], 100)
        self.assertEqual(result["confidence_adjusted_readiness"], 91)

    def test_headless_budget_is_reported_and_caps_status(self):
        raw = {"pages_html_analyzed": 20, "pages_html_discovered": 20, "page_limit_reached": False,
               "headless_needed": 10, "headless_used": 8, "headless_budget_reached": True}
        result = assess_coverage(crawl(coverage=raw), self.business(2, 2, 2), 100)
        self.assertEqual(result["coverage_status"], "substantial")
        self.assertLessEqual(result["coverage_confidence"], 89)
        self.assertTrue(any("Budget headless atteint" in x for x in result["coverage_reasons"]))

    def test_failed_required_headless_render_is_not_complete(self):
        raw = {"pages_html_analyzed": 1, "pages_html_discovered": 1, "page_limit_reached": False,
               "headless_needed": 1, "headless_used": 0, "headless_budget_reached": False}
        result = assess_coverage(crawl(coverage=raw), self.business(), 90)
        self.assertEqual(result["coverage_status"], "substantial")
        self.assertTrue(any("Rendu headless incomplet" in x for x in result["coverage_reasons"]))


if __name__ == "__main__":
    unittest.main()
