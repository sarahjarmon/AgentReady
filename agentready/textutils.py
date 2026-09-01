from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence


SPACE_RE = re.compile(r"[\s\u00a0\u202f]+")


def normalized(value: str) -> str:
    value = unicodedata.normalize("NFKD", value.casefold())
    value = "".join(char for char in value if not unicodedata.combining(char))
    value = re.sub(r"[^\w]+", " ", value)
    return SPACE_RE.sub(" ", value).strip()


def phrase_pattern(phrase: str) -> re.Pattern:
    parts = [re.escape(x) for x in normalized(phrase).split()]
    return re.compile(r"(?<![\w])" + r"[\s\u00a0\u202f-]+".join(parts) + r"(?![\w])", re.I)


def find_phrase(text: str, phrases: Sequence[str]) -> Optional[re.Match]:
    value = normalized(text)
    for phrase in phrases:
        match = phrase_pattern(phrase).search(value)
        if match:
            return match
    return None


LEGAL_EXCLUSIONS = {
    "booking": (
        "se reserve le droit", "reserve le droit", "reserver l acces", "acces reserve",
        "categorie reservee", "droits reserves",
    ),
    "returns": (
        "se retourner contre", "retour vers soi", "retour d experience", "retours d experience",
        "retour a la page", "en retour de",
    ),
    "quote": ("ta devise", "ma devise", "notre devise", "votre devise", "quelle devise"),
}


def commercial_phrase(text: str, phrases: Sequence[str], context: Optional[str] = None) -> Optional[str]:
    value = normalized(text)
    for phrase in phrases:
        for match in phrase_pattern(phrase).finditer(value):
            window = value[max(0, match.start() - 70):match.end() + 70]
            if context and any(phrase_pattern(x).search(window) for x in LEGAL_EXCLUSIONS.get(context, ())):
                continue
            return phrase
    return None


@dataclass(frozen=True)
class ParsedPrice:
    display: str
    currency: str
    minimum: Optional[float]
    maximum: Optional[float]
    qualifier: Optional[str]
    frequency: Optional[str]
    start: int
    end: int


NUMBER = r"(?:\d{1,3}(?:[\s\u00a0\u202f.,]\d{3})+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?)"
CURRENCY = r"(?:€|EUR|\$|USD|£|GBP)"
PRICE_RE = re.compile(
    rf"(?<![\d.,])(?P<qualifier>à\s+partir\s+de|a\s+partir\s+de|dès|des|from)?\s*"
    rf"(?:(?P<currency_before>{CURRENCY})\s*)?"
    rf"(?P<first>{NUMBER})"
    rf"(?:\s*(?:-|–|—|à|a)\s*(?P<second>{NUMBER}))?\s*"
    rf"(?P<currency_after>{CURRENCY})"
    rf"(?:\s*(?P<frequency>/\s*(?:mois|month|an|année|annee|year)|par\s+(?:mois|an|année|annee)|mensuel(?:le)?|annuel(?:le)?))?(?!\d)",
    re.I,
)


def parse_prices(text: str) -> List[ParsedPrice]:
    result: List[ParsedPrice] = []
    for match in PRICE_RE.finditer(text):
        currency_raw = match.group("currency_before") or match.group("currency_after") or ""
        currency = {"€": "EUR", "$": "USD", "£": "GBP"}.get(currency_raw.upper(), currency_raw.upper())
        first = _number(match.group("first"))
        second = _number(match.group("second")) if match.group("second") else None
        qualifier_raw = normalized(match.group("qualifier") or "")
        qualifier = "from" if qualifier_raw in {"a partir de", "des", "from"} else None
        frequency_raw = normalized(match.group("frequency") or "")
        frequency = None
        if frequency_raw:
            frequency = "monthly" if any(x in frequency_raw for x in ("mois", "month", "mensuel")) else "yearly"
        result.append(ParsedPrice(
            display=match.group(0).strip(), currency=currency,
            minimum=first, maximum=second, qualifier=qualifier, frequency=frequency,
            start=match.start(), end=match.end(),
        ))
    return result


def _number(value: str) -> Optional[float]:
    """Parse a monetary number without guessing an ambiguous separator."""
    compact = re.sub(r"[\s\u00a0\u202f]", "", value)
    if not compact or not re.fullmatch(r"\d+(?:[.,]\d+)*", compact):
        return None
    comma, dot = compact.count(","), compact.count(".")
    if comma and dot:
        decimal = "," if compact.rfind(",") > compact.rfind(".") else "."
        grouping = "." if decimal == "," else ","
        integer, fraction = compact.rsplit(decimal, 1)
        if len(fraction) not in {1, 2} or not _valid_grouped(integer, grouping):
            return None
        normalized_number = integer.replace(grouping, "") + "." + fraction
    elif comma or dot:
        separator = "," if comma else "."
        parts = compact.split(separator)
        if len(parts) == 2 and len(parts[1]) in {1, 2}:
            normalized_number = parts[0] + "." + parts[1]
        elif len(parts) >= 2 and all(len(x) == 3 for x in parts[1:]) and 1 <= len(parts[0]) <= 3:
            normalized_number = "".join(parts)
        else:
            return None
    else:
        normalized_number = compact
    try:
        return float(normalized_number)
    except ValueError:
        return None


def _valid_grouped(integer: str, separator: str) -> bool:
    parts = integer.split(separator)
    return bool(parts and 1 <= len(parts[0]) <= 3 and all(len(x) == 3 for x in parts[1:]))


def excerpt(text: str, start: int, end: int, width: int = 240) -> str:
    return SPACE_RE.sub(" ", text[max(0, start - 80):min(len(text), end + width - 80)]).strip()
