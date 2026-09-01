from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

@dataclass
class RenderedPage:
    url: str
    title: str
    description: str
    text: str
    headings: List[str]
    content_blocks: List[Dict[str, Any]]
    links: List[str]
    actions: List[str]
    jsonld: List[Dict[str, Any]]
    robots: List[str]
    canonical: Optional[str]


JS_APP_MARKERS = (
    r'id=["\'](?:root|app|__next|__nuxt)["\']', r'/_next/', r'__NEXT_DATA__',
    r'webpack', r'vite', r'ng-version=', r'data-reactroot',
)


def under_render_reason(text: str, links: List[str], actions: List[str], html: str) -> Optional[str]:
    """Retourne une raison stable lorsque le HTML initial paraît sous-rendu."""
    normalized = re.sub(r"\s+", " ", text).strip()
    words = len(normalized.split())
    exploitable_links = [x for x in links if x.startswith(("http://", "https://"))]
    js_signals = sum(bool(re.search(marker, html, re.I)) for marker in JS_APP_MARKERS)
    script_count = len(re.findall(r"<script\b", html, re.I))
    if len(normalized) < 80 or words < 12:
        return "very_little_visible_text"
    if not exploitable_links and not actions and len(normalized) < 400:
        return "no_links_or_actions_and_little_text"
    if (js_signals >= 1 or script_count >= 3) and not exploitable_links and not actions and len(normalized) < 800:
        return "javascript_application_likely"
    return None


class PlaywrightRenderer:
    """Renderer Chromium paresseux. Il ne clique et ne soumet jamais rien."""

    def __init__(self, timeout_seconds: int = 12, useful_wait_seconds: int = 3) -> None:
        self.timeout_ms = min(8000, max(1, timeout_seconds) * 1000)
        self.useful_wait_ms = max(1, min(useful_wait_seconds, timeout_seconds)) * 1000
        self._playwright = None
        self._browser = None

    @staticmethod
    def available() -> bool:
        try:
            import playwright.sync_api  # noqa: F401
            return True
        except ImportError:
            return False

    def _ensure_browser(self):
        if self._browser is not None:
            return
        from playwright.sync_api import sync_playwright
        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(headless=True)

    def render(self, url: str) -> RenderedPage:
        self._ensure_browser()
        context = self._browser.new_context(
            user_agent="AgentReadyAudit/0.1 (+public-site-audit)",
            java_script_enabled=True,
        )
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=self.timeout_ms)
            try:
                page.wait_for_function(
                    """() => {
                      const text = (document.body?.innerText || '').trim();
                      const useful = document.querySelectorAll('a[href], button, [role="button"], form, script[type="application/ld+json"]').length;
                      return text.length >= 180 || useful >= 2;
                    }""",
                    timeout=self.useful_wait_ms,
                )
            except Exception:
                pass
            try:
                page.wait_for_load_state("networkidle", timeout=min(750, self.useful_wait_ms))
            except Exception:
                pass
            snapshot = page.evaluate("""() => ({
              url: location.href,
              title: document.title || '',
              description: document.querySelector('meta[name="description"],meta[property="og:description"]')?.content || '',
              text: document.body?.innerText || '',
              headings: [...document.querySelectorAll('h1,h2,h3')].map(x => (x.innerText || '').trim()).filter(Boolean),
              content_blocks: [...document.querySelectorAll('h1,h2,h3')].map(h => {
                let root = h.closest('article,section,li,[class*="product"],[class*="service"],[class*="price"],[class*="card"]') || h.parentElement;
                let hops = 0;
                while (root?.parentElement && hops < 5) {
                  const txt = (root.innerText || '').trim();
                  const useful = root.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"]').length;
                  if ((txt.length >= 100 || useful > 0) && txt.length > (h.innerText || '').trim().length) break;
                  root = root.parentElement; hops += 1;
                }
                return {
                  heading: (h.innerText || '').trim(), tag: h.tagName.toLowerCase(),
                  text: (root?.innerText || h.innerText || '').trim().slice(0, 6000),
                  context: {id: root?.id || '', class: String(root?.className || ''),
                    ancestors: [root, root?.parentElement, root?.parentElement?.parentElement].filter(Boolean)
                      .map(x => ({tag: x.tagName.toLowerCase(), id: x.id || '', class: String(x.className || '')}))},
                  actions: [...(root?.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"]') || [])]
                    .map(x => x.innerText || x.value || x.getAttribute('aria-label') || '').map(x => x.trim()).filter(Boolean),
                  action_details: [...(root?.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"]') || [])]
                    .map(x => ({label: (x.innerText || x.value || x.getAttribute('aria-label') || '').trim(), href: x.href || '',
                      tag: x.tagName.toLowerCase(), id: x.id || '', class: String(x.className || '')})).filter(x => x.label)
                };
              }).filter(x => x.heading || x.text),
              links: [...document.querySelectorAll('a[href]')].map(x => x.href).filter(Boolean),
              actions: [...document.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"],form[action]')]
                .map(x => x.innerText || x.value || x.getAttribute('aria-label') || x.getAttribute('action') || '').map(x => x.trim()).filter(Boolean),
              robots: [...document.querySelectorAll('meta[name="robots"],meta[name="googlebot"]')]
                .flatMap(x => (x.content || '').toLowerCase().split(',').map(y => y.trim()).filter(Boolean)),
              canonical: document.querySelector('link[rel~="canonical"]')?.href || null,
              jsonldRaw: [...document.querySelectorAll('script[type="application/ld+json"]')].map(x => x.textContent || '')
            })""")
            jsonld = _parse_jsonld(snapshot.pop("jsonldRaw", []))
            return RenderedPage(jsonld=jsonld, **snapshot)
        finally:
            context.close()

    def close(self) -> None:
        if self._browser is not None:
            try:
                self._browser.close()
            except Exception:
                pass
            self._browser = None
        if self._playwright is not None:
            try:
                self._playwright.stop()
            except Exception:
                pass
            self._playwright = None


def _parse_jsonld(raw_values: List[str]) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for raw in raw_values:
        try:
            value = json.loads(raw)
        except (ValueError, TypeError):
            continue
        nodes = value if isinstance(value, list) else [value]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            graph = node.get("@graph")
            if isinstance(graph, list):
                result.extend(x for x in graph if isinstance(x, dict))
            else:
                result.append(node)
    return result
