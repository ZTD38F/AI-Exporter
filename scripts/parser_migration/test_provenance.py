#!/usr/bin/env python3
"""
scripts/parser_migration/test_provenance.py
-------------------------------------------
CLI tool for inspecting and verifying test provenance classification (Section 5 & 21).

Usage:
  python3 scripts/parser_migration/test_provenance.py --summary
  python3 scripts/parser_migration/test_provenance.py --tier P0
  python3 scripts/parser_migration/test_provenance.py --domain markdown
"""

import os
import sys
import json
import argparse

REPO_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MANIFEST_PATH = os.path.join(REPO_DIR, "scripts", "parser_migration", "test_provenance_manifest.json")

def load_manifest():
    if not os.path.isfile(MANIFEST_PATH):
        print(f"Error: Manifest not found at {MANIFEST_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(MANIFEST_PATH, "r", encoding="utf-8") as fp:
        return json.load(fp)

def print_summary(manifest):
    print("=" * 65)
    print("📋 Gemini Exporter — Test Provenance Classification Summary")
    print("=" * 65)
    summary = manifest.get("summary", {})
    print(f"Total Audited Suites: {summary.get('totalSuites', len(manifest['suites']))}")
    print(f"Total Audited Tests:  {summary.get('totalTests', sum(s['testCount'] for s in manifest['suites']))}\n")

    print("📊 By Provenance Tier:")
    defs = manifest.get("classificationDefinitions", {})
    by_tier = summary.get("byClassification", {})
    for tier in ["P0", "P1", "P2", "P3", "P4"]:
        count = by_tier.get(tier, 0)
        desc = defs.get(tier, "")
        prefix = desc.split(":")[0] if ":" in desc else tier
        print(f"  [{tier}] {count:3d} tests — {prefix}")

    print("\n📦 By Target Domain:")
    by_domain = {}
    for s in manifest["suites"]:
        d = s.get("domain", "unknown")
        by_domain[d] = by_domain.get(d, 0) + s.get("testCount", 0)
    for d, c in sorted(by_domain.items()):
        print(f"  • {d:15s}: {c:3d} tests")
    print("=" * 65)

def list_suites(manifest, filter_tier=None, filter_domain=None):
    tier_upper = filter_tier.upper() if filter_tier else None
    domain_lower = filter_domain.lower() if filter_domain else None

    matched_suites = []
    for s in manifest["suites"]:
        if domain_lower and s.get("domain") != domain_lower:
            continue

        suite_tests = s.get("tests", [])
        if tier_upper:
            matching_tests = [
                t for t in suite_tests
                if (isinstance(t, dict) and t.get("classification") == tier_upper)
                or (isinstance(t, str) and s.get("classification") == tier_upper)
            ]
            if matching_tests or s.get("classification") == tier_upper:
                matched_suites.append((s, matching_tests))
        else:
            matched_suites.append((s, suite_tests))

    title = f"Suites matching (tier={filter_tier or 'ANY'}, domain={filter_domain or 'ANY'}): {len(matched_suites)} suites"
    print("\n" + title)
    print("-" * len(title))
    for s, matching_tests in matched_suites:
        match_info = f"{len(matching_tests)}/{s['testCount']} tests" if tier_upper else f"{s['testCount']} tests"
        print(f"[{s['classification']}] {s['file']} ({match_info})")
        print(f"    Policy: {s.get('policy', 'N/A')}")
        print(f"    Source: {s.get('provenanceSource', 'N/A')}")
        if tier_upper:
            for t in matching_tests:
                t_name = t.get("name") if isinstance(t, dict) else t
                print(f"      • [{tier_upper}] {t_name}")
        print(f"    Notes:  {s.get('notes', 'N/A')}\n")

def main():
    parser = argparse.ArgumentParser(description="Test Provenance Classification Inspector")
    parser.add_argument("--summary", action="store_true", help="Print overall provenance summary")
    parser.add_argument("--tier", choices=["P0", "P1", "P2", "P3", "P4"], help="Filter by tier")
    parser.add_argument("--domain", choices=["markdown", "latex", "domain", "document_ast", "provider_parser", "typst_payload"], help="Filter by domain")
    args = parser.parse_args()

    manifest = load_manifest()
    if args.tier or args.domain:
        list_suites(manifest, filter_tier=args.tier, filter_domain=args.domain)
    else:
        print_summary(manifest)

if __name__ == "__main__":
    main()
