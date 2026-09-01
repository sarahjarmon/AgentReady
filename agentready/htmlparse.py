from __future__ import annotations

import html
import json
import re
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin


SPACE_RE = re.compile(r"\s+")


class PublicPageParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title_parts: List[str] = []
        self.text_parts: List[str] = []
        self.headings: List[str] = []
        self.content_blocks: List[Dict[str, Any]] = []
        self.links: List[str] = []
        self.actions: List[str] = []
        self.description = ""
        self.robots: List[str] = []
        self.canonical: Optional[str] = None
        self.jsonld_raw: List[str] = []
        self._in_title = False
        self._hidden_depth = 0
        self._jsonld_depth = 0
        self._jsonld_buffer: List[str] = []
        self._heading_tag: Optional[str] = None
        self._heading_buffer: List[str] = []
        self._action_tag: Optional[str] = None
        self._action_buffer: List[str] = []
        self._action_meta: Dict[str, str] = {}
        self._current_block: Optional[Dict[str, Any]] = None
        self._element_stack: List[Dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        data = {k.lower(): (v or "") for k, v in attrs}
        tag = tag.lower()
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self._element_stack.append({"tag": tag, "id": data.get("id", ""), "class": data.get("class", "")})
        if tag in {"script", "style", "noscript", "svg", "template"}:
            self._hidden_depth += 1
        if tag == "script" and data.get("type", "").lower() == "application/ld+json":
            self._jsonld_depth = self._hidden_depth
            self._jsonld_buffer = []
        if tag == "title":
            self._in_title = True
        if tag in {"h1", "h2", "h3"}:
            if self._current_block and self._current_block.get("text"):
                self.content_blocks.append(self._current_block)
            ancestry = self._element_stack[-6:]
            self._current_block = {"heading": "", "text": [], "actions": [], "action_details": [], "tag": tag,
                                   "context": {"ancestors": ancestry, "id": data.get("id", ""), "class": data.get("class", "")}}
            self._heading_tag = tag
            self._heading_buffer = []
        if tag in {"a", "button"}:
            self._action_tag = tag
            self._action_buffer = []
            self._action_meta = {"href": urljoin(self.base_url, data.get("href", "")) if data.get("href") else "",
                                 "id": data.get("id", ""), "class": data.get("class", "")}
        if tag == "a" and data.get("href"):
            self.links.append(urljoin(self.base_url, data["href"]))
            if data.get("aria-label"):
                self.actions.append(data["aria-label"])
        if tag == "form" and data.get("action"):
            self.actions.append(urljoin(self.base_url, data["action"]))
        if tag in {"button", "input"}:
            label = data.get("value") or data.get("aria-label") or data.get("title")
            if label:
                self.actions.append(label)
        if tag == "meta":
            name = (data.get("name") or data.get("property") or "").lower()
            content = data.get("content", "").strip()
            if name in {"description", "og:description"} and not self.description:
                self.description = content
            if name in {"robots", "googlebot"}:
                self.robots.extend(x.strip().lower() for x in content.split(",") if x.strip())
        if tag == "link" and "canonical" in data.get("rel", "").lower() and data.get("href"):
            self.canonical = urljoin(self.base_url, data["href"])

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        if tag == self._heading_tag:
            value = SPACE_RE.sub(" ", " ".join(self._heading_buffer)).strip()
            if value:
                self.headings.append(value)
                if self._current_block is not None:
                    self._current_block["heading"] = value
            self._heading_tag = None
            self._heading_buffer = []
        if tag == self._action_tag:
            value = SPACE_RE.sub(" ", " ".join(self._action_buffer)).strip()
            if value:
                self.actions.append(value)
                if self._current_block is not None:
                    self._current_block["actions"].append(value)
                    self._current_block["action_details"].append({"label": value, "tag": tag, **self._action_meta})
            self._action_tag = None
            self._action_buffer = []
            self._action_meta = {}
        if tag == "script" and self._jsonld_depth == self._hidden_depth:
            raw = "".join(self._jsonld_buffer).strip()
            if raw:
                self.jsonld_raw.append(raw)
            self._jsonld_depth = 0
            self._jsonld_buffer = []
        if tag in {"script", "style", "noscript", "svg", "template"} and self._hidden_depth:
            self._hidden_depth -= 1
        for index in range(len(self._element_stack) - 1, -1, -1):
            if self._element_stack[index].get("tag") == tag:
                del self._element_stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if self._jsonld_depth:
            self._jsonld_buffer.append(data)
        if self._in_title:
            self.title_parts.append(data)
        if self._heading_tag:
            self._heading_buffer.append(data)
        if self._action_tag:
            self._action_buffer.append(data)
        if not self._hidden_depth:
            cleaned = SPACE_RE.sub(" ", html.unescape(data)).strip()
            if cleaned:
                self.text_parts.append(cleaned)
                if self._current_block is not None:
                    self._current_block["text"].append(cleaned)

    def result(self) -> Dict[str, Any]:
        if self._current_block and self._current_block.get("text"):
            self.content_blocks.append(self._current_block)
            self._current_block = None
        jsonld: List[Dict[str, Any]] = []
        for raw in self.jsonld_raw:
            try:
                value = json.loads(raw)
                candidates = value if isinstance(value, list) else [value]
                for candidate in candidates:
                    if isinstance(candidate, dict):
                        if isinstance(candidate.get("@graph"), list):
                            jsonld.extend(x for x in candidate["@graph"] if isinstance(x, dict))
                        else:
                            jsonld.append(candidate)
            except (ValueError, TypeError):
                continue
        return {
            "title": SPACE_RE.sub(" ", " ".join(self.title_parts)).strip(),
            "description": self.description,
            "text": SPACE_RE.sub(" ", " ".join(self.text_parts)).strip(),
            "headings": list(dict.fromkeys(self.headings)),
            "content_blocks": [
                {"heading": x.get("heading", ""), "text": SPACE_RE.sub(" ", " ".join(x.get("text", []))).strip(),
                 "actions": list(dict.fromkeys(x.get("actions", []))), "action_details": x.get("action_details", []),
                 "context": x.get("context", {}), "tag": x.get("tag", "")}
                for x in self.content_blocks if x.get("heading") or x.get("text")
            ],
            "links": list(dict.fromkeys(self.links)),
            "actions": list(dict.fromkeys(self.actions)),
            "jsonld": jsonld,
            "robots": self.robots,
            "canonical": self.canonical,
        }
