from __future__ import annotations

import html
from typing import Iterable

from .models import AuditReport, Evidence, FactState


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def evidence_html(evidence: Iterable[Evidence]) -> str:
    items = list(evidence)
    if not items:
        return '<p class="muted">Aucune preuve positive : information non trouvée dans le périmètre exploré.</p>'
    rows = "".join(
        f'<li><a href="{esc(e.url)}">{esc(e.url)}</a><br><span>{esc(e.excerpt)}</span> <small>({esc(e.kind)})</small></li>'
        for e in items[:8]
    )
    return f"<ul class='evidence'>{rows}</ul>"


def render_html(report: AuditReport) -> str:
    s = report.scores
    score_cards = "".join([
        _score_card("AI Discoverability", s["ai_discoverability"], "Découvrabilité technique, pas classement réel"),
        _score_card("Understanding", s["understanding"], "Clarté et cohérence des informations"),
        _score_card("Buyability", s["buyability"], "Capacité à suivre une action commerciale"),
        _score_card("Observed AI Readiness", s["ai_readiness"], "Qualité observée dans le périmètre audité"),
        _score_card("Coverage", report.coverage_confidence, f"{report.coverage_status} — confiance dans la couverture"),
        _score_card("Confidence-adjusted", report.confidence_adjusted_readiness, "Readiness observée × couverture"),
    ])
    issues = "".join(
        f"<article class='issue {esc(i.priority)}'><div><span class='badge'>{esc(i.priority)}</span> "
        f"<strong>{esc(i.title)}</strong><span class='impact'>Impact {i.commercial_impact}/100</span></div>"
        f"<p>{esc(i.explanation)}</p><h4>Correction proposée</h4><p>{esc(i.correction)}</p>"
        + (f"<p><strong>À valider :</strong> {esc(', '.join(i.requires_human_input))}</p>" if i.requires_human_input else "")
        + f"<details><summary>Preuves et règle {esc(i.rule_id)}</summary>{evidence_html(i.evidence)}</details></article>"
        for i in report.issues
    ) or "<p>Aucun problème prioritaire détecté dans le périmètre audité.</p>"
    facts = "".join(
        f"<tr><td>{esc(name)}</td><td><span class='state {esc(fact.state.value)}'>{esc(fact.state.value)}</span></td>"
        f"<td>{esc(' · '.join(fact.values[:4]) or 'Inconnu')}</td><td>{len(fact.evidence)}</td></tr>"
        for name, fact in report.business.facts.items()
    )
    offers = "".join(
        f"<tr><td><a href='{esc(o.url)}'>{esc(o.name)}</a></td><td>{esc(o.offer_type)}</td>"
        f"<td>{esc(o.price or 'Inconnu')} {esc(o.currency or '')}</td><td>{esc(o.frequency or '—')}</td>"
        f"<td>{esc(o.availability or 'Inconnue')}</td><td>{esc(o.cta or 'Inconnu')}</td><td>{o.confidence:.0%}</td></tr>"
        for o in report.business.offers
    ) or "<tr><td colspan='7'>Aucune offre identifiée avec suffisamment de signaux concordants.</td></tr>"
    coverage_reasons = "".join(f"<li>{esc(reason)}</li>" for reason in report.coverage_reasons)
    rules = "".join(
        f"<tr><td>{esc(r.rule_id)}</td><td>{esc(r.label)}</td><td>{esc(r.status)}</td>"
        f"<td>{r.points_awarded:g} / {r.points_possible:g}</td><td>{esc(r.reason)}</td></tr>"
        for r in report.rules
    )
    pages = "".join(f"<li>{p.status} — <strong>{esc(p.fetch_method)}</strong> — <a href='{esc(p.url)}'>{esc(p.title or p.url)}</a>"
                    + (f" <small>fallback : {esc(p.headless_reason)}</small>" if p.headless_reason else "") + "</li>" for p in report.crawl.pages)
    limitations = "".join(f"<li>{esc(x)}</li>" for x in report.limitations)
    rejected = "".join(f"<li>{esc(x['title'])} — {esc(x['reason'])}</li>" for x in report.recommendation_rejections) or "<li>Aucune recommandation contradictoire rejetée.</li>"
    return f"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audit AgentReady — {esc(report.target_url)}</title><style>
:root{{--ink:#17212b;--muted:#647383;--line:#dce3e8;--bg:#f5f7f8;--blue:#2457d6;--red:#b42318;--amber:#b54708;--green:#087443}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,sans-serif}}main{{max-width:1120px;margin:auto;padding:36px 20px 80px}}h1{{font-size:34px;margin:0}}h2{{margin-top:38px}}a{{color:var(--blue)}}.notice{{background:#eef3ff;border-left:4px solid var(--blue);padding:14px 18px;margin:18px 0}}.scores{{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}}.score,.issue,section.panel{{background:white;border:1px solid var(--line);border-radius:10px;padding:18px}}.score b{{display:block;font-size:42px}}.score small,.muted,small{{color:var(--muted)}}.issue{{margin:12px 0;border-left:5px solid var(--amber)}}.issue.critical{{border-left-color:var(--red)}}.issue.high{{border-left-color:#e26d00}}.impact{{float:right;color:var(--muted)}}.badge,.state{{display:inline-block;border-radius:99px;padding:2px 8px;background:#edf1f4;font-size:12px}}.badge{{text-transform:uppercase}}table{{width:100%;border-collapse:collapse;background:white}}th,td{{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid var(--line)}}th{{background:#eef2f4}}.known{{color:var(--green)}}.unknown,.conflicting{{color:var(--red)}}details{{margin-top:10px}}.evidence li{{margin:8px 0;overflow-wrap:anywhere}}.table-wrap{{overflow:auto;border:1px solid var(--line);border-radius:10px}}code{{background:#edf1f4;padding:2px 5px;border-radius:4px}}
</style></head><body><main>
<p>AgentReady v0.2</p><h1>Audit de préparation IA</h1><p><a href="{esc(report.target_url)}">{esc(report.target_url)}</a></p>
<div class="notice"><strong>Ce que mesure ce rapport.</strong> {esc(report.methodology_notice)}</div>
<div class="scores">{score_cards}</div><p>{esc(report.score_formula)}</p>
<section class="panel"><strong>Couverture {report.coverage_confidence}% — {esc(report.coverage_status)}</strong><ul>{coverage_reasons}</ul>
<p>Le score ajusté est un indice de confiance séparé, calculé par <code>Observed AI Readiness × Coverage</code>. Il ne remplace pas la qualité observée.</p></section>
<h2>Profil détecté</h2><section class="panel"><strong>{esc(report.business.profile.value)}</strong> — confiance {report.business.profile_confidence:.0%}
<p>Ambigu : {esc('oui' if report.business.profile_ambiguous else 'non')} — candidats : {esc(report.business.profile_candidates)}</p><p>{report.business.offer_candidates_total} bloc(s) candidat(s), {report.business.offers_detected_total} offre(s) après consolidation, {len(report.business.offers)} conservée(s){' — plafond atteint' if report.business.offers_truncated else ''}, {len(report.crawl.pages)} page(s) HTML récupérée(s).</p></section>
<h2>Offres détectées</h2><div class="table-wrap"><table><thead><tr><th>Nom</th><th>Type</th><th>Prix</th><th>Fréquence</th><th>Disponibilité</th><th>CTA</th><th>Confiance</th></tr></thead><tbody>{offers}</tbody></table></div>
<h2>Priorités commerciales</h2>{issues}
<h2>Contrôle de cohérence des recommandations</h2><section class="panel"><ul>{rejected}</ul></section>
<h2>Informations extraites</h2><div class="table-wrap"><table><thead><tr><th>Champ</th><th>État</th><th>Valeur(s)</th><th>Preuves</th></tr></thead><tbody>{facts}</tbody></table></div>
<h2>Détail explicable des scores</h2><div class="table-wrap"><table><thead><tr><th>Règle</th><th>Contrôle</th><th>Résultat</th><th>Points</th><th>Explication</th></tr></thead><tbody>{rules}</tbody></table></div>
<h2>Périmètre exploré</h2><section class="panel"><p>Méthode : {esc(report.coverage_methodology_version)} — statut {esc(report.coverage_status)}.</p><ul>{pages}</ul><p>Durée : {report.crawl.duration_ms} ms. Limites : {esc(report.crawl.limits)}</p><p>Mesures brutes : {esc(report.crawl.coverage)}</p></section>
<h2>Limites</h2><section class="panel"><ul>{limitations}</ul></section>
<p class="muted">Rapport généré le {esc(report.generated_at)} — schéma {esc(report.schema_version)}</p>
</main></body></html>"""


def _score_card(label: str, value: int, note: str) -> str:
    return f"<div class='score'><span>{esc(label)}</span><b>{value}</b><small>{esc(note)}</small></div>"
