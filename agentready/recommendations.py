from __future__ import annotations

from typing import Dict, List, Tuple

from .models import CanonicalBusiness, FactState, Issue, RuleResult


PRIORITY: Dict[str, Tuple[int, str, str, str, List[str]]] = {
    "UNDR.OFFERS.003": (100, "Offres insuffisamment explicites", "content", "Créer une page par offre avec son nom, sa finalité, son public, ses caractéristiques et la prochaine action commerciale.", ["détails validés de chaque offre"]),
    "BUY.CONVERSION.001": (98, "Parcours commercial introuvable", "content", "Présenter un appel à l'action explicite et décrire les étapes réelles pour acheter, réserver, demander un devis ou contacter l'entreprise.", ["étapes réelles du parcours"]),
    "UNDR.PRICE.004": (94, "Information tarifaire absente", "commercial_information", "Publier le prix, une fourchette ou les facteurs de calcul. Si le prix dépend du besoin, expliquer comment demander un devis sans inventer de montant.", ["modèle tarifaire validé"]),
    "BUY.PRICE.002": (94, "Prix ou devis indéterminable", "commercial_information", "Indiquer le prix ou ajouter un mécanisme de devis explicite avec les informations nécessaires et le délai de réponse attendu.", ["prix ou règles de devis"]),
    "UNDR.AREA.005": (91, "Zone desservie inconnue", "commercial_information", "Ajouter une section « Zones desservies » ou « Livraison » avec les lieux réellement couverts et les éventuelles exclusions.", ["zones réellement desservies"]),
    "BUY.AREA.004": (91, "Éligibilité géographique inconnue", "commercial_information", "Préciser avant la conversion où l'offre est disponible, livrable ou réalisable.", ["zones réellement desservies"]),
    "BUY.AVAILABILITY.003": (90, "Disponibilité inconnue", "commercial_information", "Afficher le stock, les créneaux, les délais ou la méthode permettant d'obtenir cette information.", ["règle de disponibilité réelle"]),
    "UNDR.IDENTITY.001": (89, "Identité de l'entreprise ambiguë", "content", "Afficher un nom d'entreprise cohérent et une présentation factuelle sur les pages principales.", ["nom légal ou commercial validé"]),
    "UNDR.ACTIVITY.002": (88, "Activité ou marché peu explicite", "content", "Ajouter une phrase factuelle indiquant ce que l'entreprise propose, à qui et sur quel marché, à partir d'informations validées.", ["activité et clientèle validées"]),
    "BUY.PAYMENT.005": (82, "Modalités de paiement inconnues", "commercial_information", "Indiquer les moyens de paiement réellement acceptés et le moment où le paiement est demandé.", ["moyens de paiement acceptés"]),
    "BUY.POLICY.006": (80, "Politique commerciale manquante", "commercial_information", "Publier la politique applicable de retour, remboursement ou annulation avec délais, conditions et exceptions validés.", ["politique validée"]),
    "UNDR.SCHEMA.006": (64, "Données structurées absentes", "structured_data", "Ajouter du JSON-LD adapté au profil (Organization/LocalBusiness et Product ou Service). N'inclure que les faits visibles et validés.", []),
    "BUY.MACHINE.007": (62, "Offre non structurée pour les machines", "structured_data", "Structurer les offres et leurs attributs publiés en JSON-LD sans ajouter de prix, stock ou politique inconnus.", []),
    "DISC.ACCESS.001": (78, "Pages publiques difficilement accessibles", "technical", "Corriger les erreurs HTTP et rendre les pages commerciales essentielles accessibles sans authentification.", []),
    "DISC.ROBOTS.002": (55, "Exploration limitée", "technical", "Vérifier robots.txt et autoriser l'accès aux pages publiques pertinentes lorsque cela correspond à la politique de l'entreprise.", []),
    "DISC.INDEX.003": (58, "Pages déclarées non indexables", "technical", "Vérifier les directives noindex des pages commerciales et les retirer uniquement lorsqu'elles sont involontaires.", []),
    "DISC.CANONICAL.004": (42, "Canonicalisation incomplète", "technical", "Déclarer une URL canonique interne et stable sur les pages publiques pertinentes.", []),
    "DISC.SITEMAP.005": (38, "Sitemap non découvert", "technical", "Publier un sitemap XML des pages publiques importantes et le déclarer dans robots.txt.", []),
    "DISC.LINKS.006": (60, "Pages importantes peu découvrables", "technical", "Relier les offres et informations commerciales depuis la navigation ou des pages de catégorie accessibles.", []),
    "DISC.META.007": (35, "Metadata descriptive incomplète", "content", "Ajouter à chaque page un titre distinct et une description fidèle à son contenu.", []),
}


def build_recommendations(rules: List[RuleResult], business: CanonicalBusiness) -> List[Issue]:
    issues: List[Issue] = []
    seen_titles = set()
    for result in rules:
        if result.status not in {"fail", "partial"} or result.rule_id not in PRIORITY:
            continue
        impact, title, kind, correction, inputs = PRIORITY[result.rule_id]
        if title in seen_titles:
            continue
        seen_titles.add(title)
        priority = "critical" if impact >= 95 else "high" if impact >= 80 else "medium" if impact >= 55 else "low"
        issues.append(Issue(
            issue_id=f"issue-{len(issues)+1:03d}", rule_id=result.rule_id, title=title,
            priority=priority, commercial_impact=impact, scores_affected=[result.score],
            explanation=result.reason, correction_type=kind, correction=correction,
            evidence=result.evidence, requires_human_input=inputs,
        ))
    return sorted(issues, key=lambda x: (-x.commercial_impact, x.rule_id))


def recommendation_sanity_check(issues: List[Issue], business: CanonicalBusiness):
    """Reject absence claims contradicted anywhere in the retained canonical model."""
    field_by_rule = {
        "UNDR.PRICE.004": "pricing", "BUY.PRICE.002": "pricing",
        "BUY.AVAILABILITY.003": "availability", "UNDR.AREA.005": "service_area",
        "BUY.AREA.004": "service_area", "BUY.PAYMENT.005": "payment",
        "BUY.POLICY.006": "returns",
    }
    path_rules = {"BUY.CONVERSION.001": ("purchase_process", "booking_process", "quote_process", "contact_process")}
    retained, rejected = [], []
    for issue in issues:
        contradiction = None
        field = field_by_rule.get(issue.rule_id)
        if field:
            fact = business.facts[field]
            if fact.state in {FactState.KNOWN, FactState.CONFLICTING} and (fact.values or fact.evidence):
                contradiction = f"Le fait canonique {field} contient déjà des preuves retenues."
            if issue.rule_id in {"UNDR.PRICE.004", "BUY.PRICE.002"} and any(o.price_value is not None for o in business.offers):
                contradiction = "Au moins une offre canonique contient déjà un prix numérique validé."
            if field == "availability" and business.facts.get("commercial_status") and business.facts["commercial_status"].state == FactState.KNOWN:
                contradiction = "Un état commercial explicite est déjà retenu."
        for rule_id, paths in path_rules.items():
            if issue.rule_id == rule_id and any(business.facts[p].state in {FactState.KNOWN, FactState.CONFLICTING} and business.facts[p].evidence for p in paths):
                contradiction = "Un parcours commercial explicite possède déjà des preuves canoniques."
        if issue.rule_id == "BUY.POLICY.006":
            applicable = "returns" if business.profile.value == "ecommerce" else "cancellation"
            fact = business.facts[applicable]
            if fact.state in {FactState.KNOWN, FactState.CONFLICTING} and fact.evidence:
                contradiction = f"La politique {applicable} possède déjà des preuves canoniques."
        if contradiction:
            rejected.append({"issue_id": issue.issue_id, "rule_id": issue.rule_id, "title": issue.title, "reason": contradiction})
        else:
            retained.append(issue)
    return retained, rejected
