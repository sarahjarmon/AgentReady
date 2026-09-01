from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .audit import audit_url
from .report_html import render_html


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="agentready", description="Audit explicable d'un site public")
    root.add_argument("--version", action="version", version=__version__)
    commands = root.add_subparsers(dest="command", required=True)
    audit = commands.add_parser("audit", help="Auditer une URL publique")
    audit.add_argument("url")
    audit.add_argument("--json", dest="json_path", default="agentready-report.json", help="Fichier JSON de sortie")
    audit.add_argument("--html", dest="html_path", default="agentready-report.html", help="Rapport HTML de sortie")
    audit.add_argument("--max-pages", type=int, default=40)
    audit.add_argument("--max-depth", type=int, default=3)
    audit.add_argument("--timeout", type=int, default=12)
    return root


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        report = audit_url(args.url, args.max_pages, args.max_depth, args.timeout)
        json_path = Path(args.json_path).resolve()
        html_path = Path(args.html_path).resolve()
        json_path.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        html_path.write_text(render_html(report), encoding="utf-8")
        s = report.scores
        print(f"AgentReady v{__version__} — {args.url}")
        print(f"Profil: {report.business.profile.value} (confiance {report.business.profile_confidence:.0%})")
        print(f"AI Discoverability: {s['ai_discoverability']}/100")
        print(f"Understanding:      {s['understanding']}/100")
        print(f"Buyability:         {s['buyability']}/100")
        print(f"Observed AI Readiness: {s['ai_readiness']}/100")
        print(f"Coverage:              {report.coverage_confidence}% — {report.coverage_status}")
        print(f"Confidence-adjusted:   {report.confidence_adjusted_readiness}/100")
        print(f"Problèmes: {len(report.issues)} — JSON: {json_path} — HTML: {html_path}")
        return 0
    except (ValueError, OSError) as exc:
        print(f"Erreur: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
