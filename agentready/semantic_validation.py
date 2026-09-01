from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional, Protocol


ALLOWED_CLASSIFICATIONS = {
    "commercial_offer", "product", "service", "booking", "quote", "category",
    "recommendation_widget", "article", "event", "portfolio", "testimonial", "legal",
    "process_step", "informational",
}


@dataclass(frozen=True)
class SemanticCandidate:
    excerpt: str
    url: str
    heading: str
    dom_context: Dict[str, Any]
    candidate_type: str
    deterministic_evidence: Dict[str, Any]


@dataclass(frozen=True)
class SemanticDecision:
    classification: str
    accept: bool
    related_offer: Optional[str]
    confidence: float
    justification: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class SemanticValidator(Protocol):
    def validate(self, candidate: SemanticCandidate) -> SemanticDecision:
        ...


class DisabledSemanticValidator:
    """Default provider: never changes a deterministic decision."""

    def validate(self, candidate: SemanticCandidate) -> SemanticDecision:
        return SemanticDecision(candidate.candidate_type, False, None, 0.0,
                                "Validation sémantique désactivée; décision déterministe conservée.")


def validate_strict_response(value: Dict[str, Any]) -> SemanticDecision:
    required = {"classification", "accept", "related_offer", "confidence", "justification"}
    if set(value) != required:
        raise ValueError("Réponse sémantique invalide: clés JSON strictes attendues")
    classification = value["classification"]
    confidence = value["confidence"]
    if classification not in ALLOWED_CLASSIFICATIONS:
        raise ValueError("Classification sémantique non autorisée")
    if not isinstance(value["accept"], bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise ValueError("Types ou confiance sémantique invalides")
    if value["related_offer"] is not None and not isinstance(value["related_offer"], str):
        raise ValueError("Relation d'offre invalide")
    if not isinstance(value["justification"], str) or not value["justification"].strip():
        raise ValueError("Justification sémantique requise")
    return SemanticDecision(classification, value["accept"], value["related_offer"], float(confidence), value["justification"].strip())
