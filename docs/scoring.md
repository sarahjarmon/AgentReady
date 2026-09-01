# Référentiel de scoring AgentReady 0.1

## Principes

1. Un point est attribué seulement à partir d'un signal observable.
2. Chaque règle rend un statut, une explication, ses points et ses preuves.
3. Une information absente reste `unknown`. Une correction emploie un placeholder ou demande une validation humaine ; elle ne complète jamais le fait.
4. `not_applicable` retire les points possibles du dénominateur. Le sous-score restant est renormalisé sur 100.
5. La priorité des problèmes dépend d'abord de l'impact commercial : offre, conversion, prix, zone, disponibilité, paiement et politiques précèdent les optimisations secondaires.

## AI Discoverability (nom interne historique : Visibility)

| Règle | Points |
|---|---:|
| Pages publiques accessibles | 20 |
| Directives de crawl | 10 |
| Indexabilité déclarée | 15 |
| Canonicalisation | 10 |
| Sitemap | 10 |
| Découverte interne | 20 |
| Metadata descriptive | 15 |

Ce score ne mesure aucun classement externe.

## Understanding

| Règle | Points |
|---|---:|
| Identité | 15 |
| Activité et marché | 10 |
| Offres | 25 |
| Modèle tarifaire | 10 |
| Zone desservie | 10 |
| Données structurées | 15 |
| Cohérence | 15 |

## Buyability

| Règle | Points |
|---|---:|
| Parcours de conversion adapté au profil | 30 |
| Prix ou devis | 15 |
| Disponibilité | 10 |
| Livraison ou zone desservie | 10 |
| Paiement | 10 |
| Retours ou annulations | 10 |
| Offre lisible par machine | 15 |

Pour un site informationnel, les règles transactionnelles non applicables sont retirées. Pour un service sur devis, l'absence de prix fixe n'est pas inventée : un mécanisme de devis explicite constitue le parcours attendu, mais l'information tarifaire reste évaluée séparément lorsqu'elle est pertinente.

## Score global

```text
AI Readiness = 0,30 × AI Discoverability
             + 0,35 × Understanding
             + 0,35 × Buyability
```

Les valeurs sont arrondies à l'entier le plus proche.

## Priorités

- `critical` : impact 95–100
- `high` : impact 80–94
- `medium` : impact 55–79
- `low` : impact inférieur à 55

Les indices d'impact sont versionnés dans le code. Ils servent uniquement à ordonner les corrections de cet audit ; ils ne prétendent pas prédire une valeur financière.

## Couverture — `coverage.v0.1`

La qualité observée et la couverture sont deux mesures séparées. `Observed AI Readiness` conserve strictement la formule métier ci-dessus. `coverage_confidence` estime la représentativité du périmètre avec une règle déterministe : 55 % couverture des pages HTML, 30 % couverture des offres consolidées, 15 % couverture du rendu headless. Chaque composante utilise `0,60 + 0,40 × √ratio`, puis applique un facteur de 0,70 lorsqu'un plafond de pages ou headless est atteint et 0,75 lorsqu'un plafond d'offres est atteint.

Un plafond de pages ou d'offres borne la couverture à 74 % ; un plafond headless seul la borne à 89 %. Les statuts sont : `complete` ≥ 90, `substantial` ≥ 75, `partial` ≥ 50, `limited` < 50. L'indice séparé `Confidence-adjusted Readiness` vaut `Observed AI Readiness × coverage_confidence / 100`. Il exprime la confiance dans la généralisation du résultat, pas une dégradation de la qualité constatée.

## Consolidation des offres — `offer-consolidation.v0.1`

Les candidats sont fusionnés seulement en présence d'une identité forte : même URL canonique et même nom/type, nom très similaire avec même prix ou CTA dans le même contexte canonique, ou répétition exacte d'un CTA de réservation. Les produits et variantes portés par des URLs distinctes restent séparés. Les étapes de processus et sections informatives reconnues ne deviennent pas des offres autonomes ; leurs preuves sont attachées à l'offre réelle de la même page. Chaque offre publie les sources, motifs, rôles et relations utilisés par la consolidation.
