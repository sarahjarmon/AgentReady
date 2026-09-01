from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class BusinessProfile(str, Enum):
    ECOMMERCE = "ecommerce"
    SERVICE_WITH_BOOKING = "service_with_booking"
    SERVICE_WITH_QUOTE_OR_LEAD = "service_with_quote_or_lead"
    LOCAL_BUSINESS = "local_business"
    INFORMATIONAL = "informational"
    UNKNOWN = "unknown"


class FactState(str, Enum):
    KNOWN = "known"
    UNKNOWN = "unknown"
    CONFLICTING = "conflicting"
    NOT_APPLICABLE = "not_applicable"


@dataclass
class Evidence:
    url: str
    kind: str
    excerpt: str
    selector: Optional[str] = None


@dataclass
class Fact:
    field: str
    state: FactState = FactState.UNKNOWN
    values: List[str] = field(default_factory=list)
    evidence: List[Evidence] = field(default_factory=list)
    confidence: float = 0.0


@dataclass
class Offer:
    name: str
    url: str
    offer_type: str = "unknown"
    candidate_role: str = "commercial_offer"
    description: Optional[str] = None
    price: Optional[str] = None
    price_value: Optional[float] = None
    price_original: Optional[str] = None
    price_evidence: List[Evidence] = field(default_factory=list)
    currency: Optional[str] = None
    frequency: Optional[str] = None
    availability: Optional[str] = None
    cta: Optional[str] = None
    cta_url: Optional[str] = None
    evidence: List[Evidence] = field(default_factory=list)
    confidence: float = 0.0
    consolidation: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Page:
    url: str
    status: int
    content_type: str
    title: str = ""
    description: str = ""
    text: str = ""
    headings: List[str] = field(default_factory=list)
    content_blocks: List[Dict[str, Any]] = field(default_factory=list)
    links: List[str] = field(default_factory=list)
    actions: List[str] = field(default_factory=list)
    jsonld: List[Dict[str, Any]] = field(default_factory=list)
    robots: List[str] = field(default_factory=list)
    canonical: Optional[str] = None
    fetch_error: Optional[str] = None
    fetch_method: str = "http"
    headless_reason: Optional[str] = None
    page_role: str = "informational"


@dataclass
class CrawlResult:
    requested_url: str
    final_origin: str
    pages: List[Page]
    robots_url: str
    robots_accessible: bool
    sitemap_urls: List[str]
    blocked_urls: List[str]
    warnings: List[str]
    started_at: str
    duration_ms: int
    limits: Dict[str, int]
    coverage: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CanonicalBusiness:
    profile: BusinessProfile
    profile_confidence: float
    profile_evidence: List[Evidence]
    profile_candidates: Dict[str, float]
    profile_ambiguous: bool
    facts: Dict[str, Fact]
    offers: List[Offer]
    offer_candidates_total: int = 0
    offers_detected_total: int = 0
    offers_truncated: bool = False


@dataclass
class RuleResult:
    rule_id: str
    score: str
    label: str
    status: str
    points_awarded: float
    points_possible: float
    reason: str
    evidence: List[Evidence] = field(default_factory=list)


@dataclass
class Issue:
    issue_id: str
    rule_id: str
    title: str
    priority: str
    commercial_impact: int
    scores_affected: List[str]
    explanation: str
    correction_type: str
    correction: str
    evidence: List[Evidence] = field(default_factory=list)
    requires_human_input: List[str] = field(default_factory=list)


@dataclass
class AuditReport:
    schema_version: str
    generated_at: str
    target_url: str
    methodology_notice: str
    crawl: CrawlResult
    business: CanonicalBusiness
    scores: Dict[str, int]
    coverage_confidence: int
    coverage_status: str
    coverage_reasons: List[str]
    confidence_adjusted_readiness: int
    coverage_methodology_version: str
    score_formula: str
    rules: List[RuleResult]
    inconsistencies: List[Issue]
    issues: List[Issue]
    recommendation_rejections: List[Dict[str, Any]]
    limitations: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
