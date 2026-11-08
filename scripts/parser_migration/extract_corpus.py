#!/usr/bin/env python3
"""
scripts/parser_migration/extract_corpus.py
-----------------------------------------
Extracts raw conversation text and LaTeX expressions, strictly segmented into
three distinct corpus sets (Section 6.3 & Remediation Plan):

1. real_gemini_output:
   Authoritative raw model outputs received from Gemini with verified provenance.
   *** ONLY entries in this set can justify compatibility rules. ***
   (Initial state: [] until verified raw response payloads with SHA-256 hashes are captured).

2. scenario_inputs:
   User prompts, instructions, and test queries sent TO Gemini (from
   scripts/test_scenario_pool.json and Takeout user prompts).
   Used for input robustness testing, NOT as Gemini output dialect evidence.

3. synthetic_fixtures:
   Hand-crafted test fixtures and edge-case samples constructed for parser tests.
   Non-authoritative for Gemini dialect.

Outputs to: tests/fixtures/parser_migration_corpus.json
"""

import os
import sys
import json
import zipfile
import re
from datetime import datetime

REPO_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTPUT_PATH = os.path.join(REPO_DIR, "tests", "fixtures", "parser_migration_corpus.json")

def extract_corpus():
    pool_path = os.path.join(REPO_DIR, "scripts", "test_scenario_pool.json")
    takeout_path = os.path.join(REPO_DIR, "tests", "fixtures", "gemini_takeout_clean.zip")
    sample_path = os.path.join(REPO_DIR, "tests", "fixtures", "provider", "conversation-sample.json")

    # Math extraction regexes
    display_re = re.compile(r"\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]")
    inline_re = re.compile(r"(?<!\\)\$(.+?)(?<!\\)\$|\\\(([\s\S]+?)\\\)")

    def extract_math(doc_id, text, source):
        items = []
        seen = set()
        for m in display_re.finditer(text):
            expr = m.group(1) or m.group(2)
            if expr:
                s = expr.strip()
                if s and (s, True) not in seen:
                    seen.add((s, True))
                    items.append({
                        "id": f"{doc_id}_m{len(items) + 1}",
                        "docId": doc_id,
                        "latex": s,
                        "display": True,
                        "source": source
                    })
        t_no_disp = display_re.sub(" ", text)
        for m in inline_re.finditer(t_no_disp):
            expr = m.group(1) or m.group(2)
            if expr:
                s = expr.strip()
                # Exclude plain currency numbers ($5, $10.50)
                if s and not re.match(r"^\d+(?:\.\d{1,2})?$", s):
                    if (s, False) not in seen:
                        seen.add((s, False))
                        items.append({
                            "id": f"{doc_id}_m{len(items) + 1}",
                            "docId": doc_id,
                            "latex": s,
                            "display": False,
                            "source": source
                        })
        return items

    # 1. real_gemini_output (Strict Rule: requires verified raw provenance fixture + hash)
    # Empty until real raw model responses are captured and verified.
    real_gemini_output_docs = []
    real_gemini_output_math = []

    # 2. scenario_inputs (User prompts sent TO Gemini)
    scenario_input_docs = []
    scenario_input_math = []

    if os.path.isfile(pool_path):
        with open(pool_path, "r", encoding="utf-8") as fp:
            pool = json.load(fp)
        for sc in pool:
            sc_id = sc["id"]
            for idx, turn in enumerate(sc.get("turns", [])):
                if isinstance(turn, str) and turn.strip():
                    doc_id = f"scenario_prompt_{sc_id}_turn{idx + 1}"
                    doc = {
                        "id": doc_id,
                        "category": "scenario_inputs",
                        "role": "user_prompt",
                        "scenarioId": sc_id,
                        "domain": sc.get("domain", "general"),
                        "features": sc.get("features", []),
                        "text": turn
                    }
                    scenario_input_docs.append(doc)
                    scenario_input_math.extend(extract_math(doc_id, turn, "scenario_pool"))

    if os.path.isfile(takeout_path):
        with zipfile.ZipFile(takeout_path) as zf:
            for name in zf.namelist():
                if name.endswith(".html"):
                    html = zf.read(name).decode("utf-8", errors="replace")
                    # In MyActivity.html, user prompts are marked with 'Prompted ...'
                    chunks = re.findall(r'<div class="content-cell[^"]*">([\s\S]*?)</div>', html)
                    for idx, c in enumerate(chunks):
                        clean = re.sub(r'<br\s*/?>', '\n', c)
                        clean = re.sub(r'<[^>]+>', ' ', clean).strip()
                        if clean.startswith("Prompted"):
                            prompt_text = clean[len("Prompted"):].strip()
                            # Strip trailing timestamp like 'Sep 2, 2026, 12:12:52 PM PDT'
                            prompt_text = re.sub(r'\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4},.*$', '', prompt_text).strip()
                            if prompt_text and len(prompt_text) > 5:
                                doc_id = f"takeout_user_prompt_{idx + 1}"
                                doc = {
                                    "id": doc_id,
                                    "category": "scenario_inputs",
                                    "role": "user_prompt",
                                    "domain": "takeout_user_activity",
                                    "features": ["takeout_prompt"],
                                    "text": prompt_text
                                }
                                scenario_input_docs.append(doc)
                                scenario_input_math.extend(extract_math(doc_id, prompt_text, "takeout_prompt"))

    # 3. synthetic_fixtures (Hand-crafted test data)
    synthetic_docs = []
    synthetic_math = []

    if os.path.isfile(sample_path):
        with open(sample_path, "r", encoding="utf-8") as fp:
            sample = json.load(fp)
        sample_id = sample.get("id", "sample")
        for m in sample.get("messages", []):
            c = m.get("content")
            m_id = m.get("id", "msg")
            if isinstance(c, str) and c.strip():
                doc_id = f"synthetic_{sample_id}_{m_id}"
                doc = {
                    "id": doc_id,
                    "category": "synthetic_fixtures",
                    "role": m.get("role", "unknown"),
                    "domain": "synthetic_sample",
                    "features": ["synthetic"],
                    "text": c
                }
                synthetic_docs.append(doc)
                synthetic_math.extend(extract_math(doc_id, c, "synthetic_sample"))

    corpus = {
        "version": "1.1.0",
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "description": "Corpus strictly segmented into real_gemini_output, scenario_inputs, and synthetic_fixtures. ONLY real_gemini_output may justify compatibility rules.",
        "admissionPolicy": {
            "real_gemini_output": "ONLY entries here can justify compatibility rules (GM-MD-* / GM-TEX-*). Must possess evidence file and originalHash.",
            "scenario_inputs": "User prompts / instructions sent to Gemini. Used for parser robustness, NOT as Gemini output dialect evidence.",
            "synthetic_fixtures": "Synthetic fixtures for structural regression. Non-authoritative."
        },
        "corpusSets": {
            "real_gemini_output": {
                "count": len(real_gemini_output_docs),
                "mathCount": len(real_gemini_output_math),
                "documents": real_gemini_output_docs,
                "mathExpressions": real_gemini_output_math
            },
            "scenario_inputs": {
                "count": len(scenario_input_docs),
                "mathCount": len(scenario_input_math),
                "documents": scenario_input_docs,
                "mathExpressions": scenario_input_math
            },
            "synthetic_fixtures": {
                "count": len(synthetic_docs),
                "mathCount": len(synthetic_math),
                "documents": synthetic_docs,
                "mathExpressions": synthetic_math
            }
        },
        "summary": {
            "totalDocuments": len(real_gemini_output_docs) + len(scenario_input_docs) + len(synthetic_docs),
            "totalMathExpressions": len(real_gemini_output_math) + len(scenario_input_math) + len(synthetic_math),
            "realOutputCount": len(real_gemini_output_docs),
            "scenarioInputCount": len(scenario_input_docs),
            "syntheticCount": len(synthetic_docs)
        }
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as fp:
        json.dump(corpus, fp, indent=2, ensure_ascii=False)

    print("=" * 65)
    print("📦 Corpus Extracted & Segmented Successfully (Version 1.1.0)")
    print(f"File: {os.path.relpath(OUTPUT_PATH, REPO_DIR)}")
    print(f"  • real_gemini_output:  {len(real_gemini_output_docs):3d} docs, {len(real_gemini_output_math):3d} math (ONLY source for compat rules)")
    print(f"  • scenario_inputs:     {len(scenario_input_docs):3d} docs, {len(scenario_input_math):3d} math (User prompts / instructions)")
    print(f"  • synthetic_fixtures:  {len(synthetic_docs):3d} docs, {len(synthetic_math):3d} math (Synthetic samples)")
    print(f"  • TOTAL:               {corpus['summary']['totalDocuments']:3d} docs, {corpus['summary']['totalMathExpressions']:3d} math")
    print("=" * 65)

if __name__ == "__main__":
    extract_corpus()
