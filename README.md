# AgentReady 0.1

Prototype technique d'audit d'un site public. Il explore un périmètre borné, extrait des informations avec leurs preuves, applique des règles déterministes et produit un JSON ainsi qu'un rapport HTML local.

`AI Discoverability` désigne uniquement la découvrabilité technique observable. Ce n'est pas un classement dans ChatGPT, Gemini, Perplexity ou un autre assistant.

## Installation et lancement

Le prototype nécessite Python 3.9 ou plus. Le mode HTTP n'a aucune dépendance externe. Le fallback JavaScript utilise Playwright et Chromium :

```bash
python3 -m pip install -e '.[headless]'
python3 -m playwright install chromium
```

```bash
python3 -m agentready audit https://example.com
```

Pour installer la commande dans un environnement virtuel :

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/agentready audit https://example.com
```

Options principales :

```text
--json PATH       sortie JSON (agentready-report.json par défaut)
--html PATH       sortie HTML (agentready-report.html par défaut)
--max-pages N     maximum 40 par défaut, plafond de sécurité 200
--max-depth N     profondeur 3 par défaut, plafond 8
--timeout N       délai HTTP par requête, 12 secondes par défaut
```

Le crawler reste sur le même hôte, respecte `robots.txt`, exclut les routes de compte, panier, checkout et administration, ne soumet aucun formulaire et limite chaque réponse HTTP à 5 Mo. Il commence en HTTP et n'ouvre Chromium que si le contenu paraît sous-rendu. Chaque page expose `fetch_method: http|headless` et, le cas échéant, `headless_reason`. Le budget headless est borné à huit pages prioritaires par audit ; le rapport indique son utilisation et signale si ce budget est atteint.

## Profils métier

- `ecommerce`
- `service_with_booking`
- `service_with_quote_or_lead`
- `local_business`
- `informational`
- `unknown`

La classification est une heuristique explicable. Sa confiance et ses preuves sont incluses dans le rapport. Les règles non applicables au profil sont retirées du dénominateur avant renormalisation sur 100.

Une offre canonique combine au moins deux familles de signaux concordants parmi URL, heading, prix, CTA, formulation commerciale et données structurées. Une consolidation conservatrice regroupe les blocs qui désignent manifestement la même offre et conserve toutes leurs preuves ainsi que les raisons du regroupement. Elle expose son type, prix/devise, fréquence, disponibilité, CTA, URL, preuves et confiance. Le profil publie également les scores candidats et un indicateur d'ambiguïté ; un résultat trop serré reste `unknown`.

La couverture indique séparément les pages HTML découvertes et analysées, les offres candidates/consolidées/conservées, le besoin et l'usage headless, les ressources non HTML ignorées et l'atteinte éventuelle des plafonds. `Observed AI Readiness` décrit uniquement la qualité observée ; `Coverage` et `Confidence-adjusted Readiness` indiquent séparément à quel point ce résultat peut être généralisé au site. Les règles versionnées figurent dans `docs/scoring.md`.

## Sorties

Le JSON suit le schéma logique `agentready.audit.v0.2`. Il contient : périmètre de crawl, modèle canonique, états des faits, offres, preuves, scores, points par règle, incohérences, problèmes priorisés, recommandations rejetées par le contrôle de cohérence et limites.

La V0.2 applique la chaîne `extraction déterministe → preuves → validation contextuelle → faits canoniques → scoring déterministe`. Les montants conservent valeur numérique, devise, chaîne originale et preuve. Les rôles de page/bloc et les états de disponibilité commerciale sont explicites. Une interface sémantique stricte et interchangeable existe, mais elle est désactivée par défaut et ne peut jamais attribuer de points.

Le rapport HTML expose les mêmes informations dans un format lisible. Il ne charge aucune ressource distante.

## Tests et corpus

```bash
python3 -m unittest discover -s tests -v
```

Le corpus synthétique dans `tests/fixtures` couvre les six profils et un mini-site e-commerce. Toutes les informations y sont fictives.

## Limites v0.1

- le rendu JavaScript nécessite l'extra optionnelle `headless` et Chromium ;
- français et anglais principalement ;
- extraction heuristique, sans LLM ni connaissance externe ;
- pas de navigation transactionnelle ni validation du checkout ;
- pas d'analyse des PDF, images ou contenu authentifié ;
- pas de mesure d'impressions, de rang, de citation ou de recommandation dans un moteur externe.

Voir [docs/scoring.md](docs/scoring.md) pour le référentiel complet.
