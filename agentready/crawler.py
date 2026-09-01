from __future__ import annotations

import gzip
import time
from collections import deque
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, build_opener
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

from .htmlparse import PublicPageParser
from .headless import PlaywrightRenderer, under_render_reason
from .models import CrawlResult, Page


USER_AGENT = "AgentReadyAudit/0.1 (+public-site-audit)"
RELEVANT = (
    "product", "produit", "service", "pricing", "price", "tarif", "shop", "boutique",
    "faq", "help", "aide", "shipping", "delivery", "livraison", "return", "refund",
    "retour", "annulation", "cancel", "booking", "reservation", "réservation", "contact",
    "about", "apropos", "qui-sommes", "payment", "paiement", "legal", "mentions",
)
EXCLUDED = ("/login", "/signin", "/account", "/admin", "/cart", "/checkout", "/wp-admin")
NON_HTML_EXTENSIONS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".css", ".js", ".xml", ".pdf", ".zip", ".mp4", ".webm", ".woff", ".woff2")


def normalize_url(url: str) -> str:
    parsed = urlparse(url if "://" in url else "https://" + url)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    port = parsed.port
    netloc = host if not port or (scheme == "https" and port == 443) or (scheme == "http" and port == 80) else f"{host}:{port}"
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    safe_query = [(k, v) for k, v in parse_qsl(parsed.query) if not k.lower().startswith(("utm_", "fbclid", "gclid"))]
    return urlunparse((scheme, netloc, path, "", urlencode(safe_query), ""))


class Crawler:
    def __init__(self, max_pages: int = 40, max_depth: int = 3, timeout: int = 12, headless_renderer=None, max_headless_pages: int = 8) -> None:
        self.max_pages = max(1, min(max_pages, 200))
        self.max_depth = max(0, min(max_depth, 8))
        self.timeout = timeout
        self.opener = build_opener()
        self.headless_renderer = headless_renderer
        self._headless_unavailable_reported = False
        self.max_headless_pages = max(0, min(max_headless_pages, self.max_pages))
        self._headless_pages = 0
        self._headless_budget_reported = False

    def _get(self, url: str) -> Tuple[int, str, bytes, str]:
        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1"})
        with self.opener.open(request, timeout=self.timeout) as response:
            body = response.read(5_000_000)
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                body = gzip.decompress(body)
            return response.status, response.headers.get("Content-Type", ""), body, response.geturl()

    def crawl(self, requested_url: str) -> CrawlResult:
        start = time.monotonic()
        started_at = datetime.now(timezone.utc).isoformat()
        seed = normalize_url(requested_url)
        parsed_seed = urlparse(seed)
        if parsed_seed.scheme not in {"http", "https"} or not parsed_seed.hostname:
            raise ValueError("L'URL doit être une URL HTTP(S) publique valide")
        origin = f"{parsed_seed.scheme}://{parsed_seed.netloc}"
        robots_url = urljoin(origin, "/robots.txt")
        robot = RobotFileParser()
        robot.set_url(robots_url)
        robots_accessible = False
        robots_text = ""
        warnings: List[str] = []
        try:
            _, _, raw, _ = self._get(robots_url)
            robots_text = raw.decode("utf-8", "replace")
            robot.parse(robots_text.splitlines())
            robots_accessible = True
        except Exception as exc:
            robot.parse([])
            warnings.append(f"robots.txt inaccessible: {type(exc).__name__}")

        sitemap_candidates = self._sitemaps(origin, robots_text)
        sitemap_urls: List[str] = []
        sitemap_pages: List[str] = []
        for sitemap in sitemap_candidates[:5]:
            found_pages, found_sitemaps = self._read_sitemap(sitemap, origin, warnings)
            sitemap_urls.extend(found_sitemaps)
            sitemap_pages.extend(found_pages)

        queue = deque([(seed, 0)])
        prioritized = sorted(set(sitemap_pages), key=lambda u: (not self._relevant(u), len(u)))
        for url in prioritized[: self.max_pages * 3]:
            queue.append((url, 1))
        visited: Set[str] = set()
        blocked: List[str] = []
        pages: List[Page] = []
        non_html_skipped = 0
        html_discovered: Set[str] = {seed}
        html_discovered.update(u for u in sitemap_pages if not self._non_html_url(u))
        headless_needed = 0

        try:
            while queue and len(pages) < self.max_pages:
                url, depth = queue.popleft()
                url = normalize_url(url)
                if url in visited or not self._same_site(url, origin) or self._excluded(url):
                    continue
                visited.add(url)
                if robots_accessible and not robot.can_fetch(USER_AGENT, url):
                    blocked.append(url)
                    continue
                try:
                    status, content_type, body, final_url = self._get(url)
                    if "text/html" not in content_type.lower():
                        non_html_skipped += 1
                        continue
                    charset = "utf-8"
                    if "charset=" in content_type.lower():
                        charset = content_type.lower().split("charset=", 1)[1].split(";", 1)[0].strip()
                    html_text = body.decode(charset, "replace")
                    parser = PublicPageParser(final_url)
                    parser.feed(html_text)
                    data = parser.result()
                    reason = under_render_reason(data["text"], data["links"], data["actions"], html_text)
                    page = Page(url=final_url, status=status, content_type=content_type, headless_reason=reason, **data)
                    if reason:
                        headless_needed += 1
                        rendered = self._render_headless(final_url, reason, warnings)
                        if rendered is not None:
                            page = Page(
                                url=rendered.url, status=status, content_type=content_type,
                                title=rendered.title, description=rendered.description, text=rendered.text,
                                headings=rendered.headings, content_blocks=rendered.content_blocks,
                                links=rendered.links, actions=rendered.actions, jsonld=rendered.jsonld,
                                robots=rendered.robots, canonical=rendered.canonical,
                                fetch_method="headless", headless_reason=reason,
                            )
                    pages.append(page)
                    if depth < self.max_depth:
                        links = sorted(page.links, key=lambda u: (not self._relevant(u), len(u)))
                        for link in links:
                            if self._same_site(link, origin) and not self._excluded(link) and not self._non_html_url(link):
                                html_discovered.add(normalize_url(link))
                                queue.append((link, depth + 1))
                except HTTPError as exc:
                    pages.append(Page(url=url, status=exc.code, content_type="", fetch_error=str(exc)))
                except (URLError, TimeoutError, OSError, ValueError) as exc:
                    pages.append(Page(url=url, status=0, content_type="", fetch_error=f"{type(exc).__name__}: {exc}"))
        finally:
            if self.headless_renderer is not None and hasattr(self.headless_renderer, "close"):
                self.headless_renderer.close()

        page_limit_reached = bool(queue) and len(pages) >= self.max_pages
        if page_limit_reached:
            warnings.append("Limite de pages atteinte; le site n'a pas été exploré intégralement.")
        if not pages:
            warnings.append("Aucune page publique analysable n'a été récupérée.")
        return CrawlResult(
            requested_url=requested_url, final_origin=origin, pages=pages, robots_url=robots_url,
            robots_accessible=robots_accessible, sitemap_urls=sitemap_urls, blocked_urls=blocked,
            warnings=warnings, started_at=started_at,
            duration_ms=round((time.monotonic() - start) * 1000),
            limits={"max_pages": self.max_pages, "max_depth": self.max_depth, "timeout_seconds": self.timeout,
                    "max_headless_pages": self.max_headless_pages, "headless_pages_used": self._headless_pages},
            coverage={"pages_analyzed": len(pages), "pages_html_analyzed": len(pages),
                      "pages_html_discovered": len(html_discovered), "page_limit_reached": page_limit_reached,
                      "discovered_sitemap_pages": len(set(sitemap_pages)), "non_html_skipped": non_html_skipped,
                      "headless_needed": headless_needed,
                      "headless_used": sum(1 for page in pages if page.fetch_method == "headless"),
                      "headless_budget_reached": self._headless_budget_reported},
        )

    def _render_headless(self, url: str, reason: str, warnings: List[str]):
        if self._headless_pages >= self.max_headless_pages:
            if not self._headless_budget_reported:
                warnings.append(f"Budget headless atteint ({self.max_headless_pages} page(s)); les autres pages restent analysées en HTTP.")
                self._headless_budget_reported = True
            return None
        if self.headless_renderer is None:
            if not PlaywrightRenderer.available():
                if not self._headless_unavailable_reported:
                    warnings.append("Fallback headless requis mais Playwright/Chromium n'est pas disponible.")
                    self._headless_unavailable_reported = True
                return None
            self.headless_renderer = PlaywrightRenderer(timeout_seconds=self.timeout)
        self._headless_pages += 1
        try:
            return self.headless_renderer.render(url)
        except Exception as exc:
            warnings.append(f"Rendu headless impossible pour {url}: {type(exc).__name__}: {exc}")
            return None

    def _sitemaps(self, origin: str, robots_text: str) -> List[str]:
        found = []
        for line in robots_text.splitlines():
            if line.lower().startswith("sitemap:"):
                found.append(line.split(":", 1)[1].strip())
        if not found:
            found.append(urljoin(origin, "/sitemap.xml"))
        return list(dict.fromkeys(found))

    def _read_sitemap(self, url: str, origin: str, warnings: List[str], depth: int = 0):
        try:
            _, _, body, _ = self._get(url)
            root = ElementTree.fromstring(body)
            sitemaps = [url]
            pages: List[str] = []
            if root.tag.endswith("sitemapindex") and depth < 2:
                children = [node.text.strip() for node in root.findall(".//{*}sitemap/{*}loc") if node.text]
                for child in children[:20]:
                    if self._same_site(child, origin):
                        child_pages, child_sitemaps = self._read_sitemap(child, origin, warnings, depth + 1)
                        pages.extend(child_pages); sitemaps.extend(child_sitemaps)
            else:
                values = [node.text.strip() for node in root.findall(".//{*}url/{*}loc") if node.text]
                pages.extend(normalize_url(v) for v in values if self._same_site(v, origin))
            return pages, list(dict.fromkeys(sitemaps))
        except Exception:
            return [], []

    @staticmethod
    def _same_site(url: str, origin: str) -> bool:
        a, b = urlparse(url), urlparse(origin)
        return a.scheme in {"http", "https"} and (a.hostname or "").lower() == (b.hostname or "").lower()

    @staticmethod
    def _relevant(url: str) -> bool:
        value = url.lower()
        return any(token in value for token in RELEVANT)

    @staticmethod
    def _excluded(url: str) -> bool:
        path = urlparse(url).path.lower()
        return any(token in path for token in EXCLUDED)

    @staticmethod
    def _non_html_url(url: str) -> bool:
        return urlparse(url).path.lower().endswith(NON_HTML_EXTENSIONS)
