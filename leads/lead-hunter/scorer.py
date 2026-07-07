# -*- coding: utf-8 -*-
"""Скоринг масштаба (0–7) и отсев мелочи. Единственный источник scale_score.

Читает work/cleaned.jsonl, пишет work/scored.jsonl (киты) и
quarantine/culled_small.jsonl (мелочь). Идемпотентен.
"""

import json
import os
import sys
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import (WORK_DIR, QUARANTINE_DIR, SCORE_THRESHOLD, BORDERLINE_SCORE,
                    BORDERLINE_SEGMENT, VOLUME_MODE, tier_of)

CURRENT_YEAR = 2026


def compute_score(row):
    """scale_score по разделу 10 ТЗ. Сигнал засчитывается только по данным с evidence."""
    score = 0
    breakdown = []
    sig = row.get("signals") or {}

    if (row.get("branch_count") or 0) >= 2 or sig.get("network"):
        score += 2
        breakdown.append("network+2")

    ig = row.get("ig_followers") or 0
    if ig >= 100000:
        score += 3; breakdown.append("ig100k+3")
    elif ig >= 30000:
        score += 2; breakdown.append("ig30k+2")
    elif ig >= 10000:
        score += 1; breakdown.append("ig10k+1")

    if sig.get("ads") or row.get("runs_ads") == "yes":
        score += 1; breakdown.append("ads+1")

    if sig.get("team") or (row.get("team_size") or 0) >= 3:
        score += 1; breakdown.append("team+1")

    fy = row.get("founded_year")
    age_ok = bool(fy) and (CURRENT_YEAR - int(fy)) >= 5
    if sig.get("age") or age_ok or (row.get("google_reviews") or 0) >= 100:
        score += 1; breakdown.append("age+1")

    if sig.get("official") or row.get("official_status"):
        score += 1; breakdown.append("official+1")

    if sig.get("infra"):
        score += 1; breakdown.append("infra+1")

    return min(score, 7), breakdown


def passes(row, score):
    if score >= SCORE_THRESHOLD:
        return True
    if score == BORDERLINE_SCORE and row.get("segment") == BORDERLINE_SEGMENT:
        return True
    return False


def main():
    src = os.path.join(WORK_DIR, "cleaned.jsonl")
    rows = []
    with open(src, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    kept, culled = [], []
    for row in rows:
        score, breakdown = compute_score(row)
        row["scale_score"] = score
        row["score_breakdown"] = breakdown
        row["tier"] = tier_of(score)
        row["runs_ads"] = "yes" if ("ads+1" in breakdown) else (row.get("runs_ads") or "no")
        # VOLUME_MODE: в базу идут все с валидным телефоном (фильтр масштаба снят,
        # заказчику нужен объём); иначе — классический порог масштаба.
        keep = True if VOLUME_MODE else passes(row, score)
        (kept if keep else culled).append(row)

    with open(os.path.join(WORK_DIR, "scored.jsonl"), "w", encoding="utf-8") as f:
        for row in kept:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(os.path.join(QUARANTINE_DIR, "culled_small.jsonl"), "w", encoding="utf-8") as f:
        for row in culled:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    dist = {}
    for row in kept:
        dist[row["scale_score"]] = dist.get(row["scale_score"], 0) + 1
    seg = {}
    for row in kept:
        seg[row["segment"]] = seg.get(row["segment"], 0) + 1
    tiers = {}
    for row in kept:
        tiers[row["tier"]] = tiers.get(row["tier"], 0) + 1
    print(json.dumps({
        "input": len(rows), "kept": len(kept), "culled": len(culled),
        "tiers": tiers,
        "score_distribution": {str(k): dist[k] for k in sorted(dist, reverse=True)},
        "by_segment": seg,
        "avg_score": round(sum(r["scale_score"] for r in kept) / len(kept), 2) if kept else 0,
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
