# -*- coding: utf-8 -*-
"""Сборка leads_database.csv из work/scored.jsonl: lpr_status, hook, сортировка.

Hook собирается ТОЛЬКО из подтверждённых полей строки — никаких штампов.
"""

import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (WORK_DIR, PROJECT_DIR, CSV_COLUMNS, SEGMENT_PRIORITY,
                    LPR_PRIORITY)

DB_FILE = os.path.join(PROJECT_DIR, "leads_database.csv")


def fmt_followers(n):
    if n >= 1000:
        k = n / 1000.0
        return ("%dk" % round(k)) if k >= 10 else ("%.1fk" % k).replace(".0k", "k")
    return str(n)


def build_hook(row):
    """≤12 слов, только подтверждённые факты. Пусто — валидный результат."""
    custom = (row.get("hook_custom") or "").strip().strip(".")
    if custom and len(custom.split()) <= 12:
        return custom
    facts = []
    bc = row.get("branch_count") or 0
    if bc >= 2:
        facts.append("сеть из %d филиалов" % bc)
    ig = row.get("ig_followers") or 0
    if ig >= 10000:
        facts.append("%s подписчиков в Instagram" % fmt_followers(ig))
    off = (row.get("official_status") or "").strip().strip(".")
    if off and len(off.split()) <= 6:
        facts.append(off)
    fy = row.get("founded_year")
    if fy and (2026 - int(fy)) >= 5:
        facts.append("%d лет на рынке" % (2026 - int(fy)))
    gr = row.get("google_reviews") or 0
    if gr >= 100 and len(facts) < 2:
        facts.append("%d+ отзывов в Google" % gr)
    hook = ", ".join(facts[:2])
    return hook if len(hook.split()) <= 12 else facts[0]


def lpr_status(row, hook):
    if row.get("lpr_name") and row.get("lpr_instagram") and hook:
        return "A"
    if row.get("lpr_name"):
        return "B"
    return "C"


def load_scored():
    rows = []
    with open(os.path.join(WORK_DIR, "scored.jsonl"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def to_csv_row(row):
    hook = build_hook(row)
    status = lpr_status(row, hook)
    return {
        "phone_whatsapp": row["phone"],
        "wa_verified": "true" if row.get("wa_verified") else "false",
        "school_name": (row.get("name") or "").strip(),
        "city": row.get("city") or "",
        "country": row.get("country") or "",
        "segment": row.get("segment") or "",
        "lpr_name": row.get("lpr_name") or "",
        "lpr_instagram": ("@" + row["lpr_instagram"]) if row.get("lpr_instagram") else "",
        "school_instagram": ("@" + row["instagram"]) if row.get("instagram") else "",
        "website": row.get("website") or "",
        "lpr_status": status,
        "hook": hook,
        "source_url": row.get("source_url") or "",
        "source": row.get("source") or "",
        "branches": row.get("branch_count") or "",
        "google_rating": row.get("google_rating") or "",
        "google_reviews": row.get("google_reviews") or "",
        "ig_followers": row.get("ig_followers") or "",
        "runs_ads": row.get("runs_ads") or "no",
        "scale_score": row["scale_score"],
        "tier": row.get("tier") or "base",
        "extra_phones": ";".join(row.get("extra_phones") or []),
    }


def sort_key(r):
    return (-int(r["scale_score"]), LPR_PRIORITY[r["lpr_status"]],
            SEGMENT_PRIORITY[r["segment"]], r["city"])


def main():
    rows = [to_csv_row(r) for r in load_scored()]
    rows.sort(key=sort_key)
    with open(DB_FILE, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    st = {"total": len(rows)}
    for r in rows:
        st["status_" + r["lpr_status"]] = st.get("status_" + r["lpr_status"], 0) + 1
    st["wa_verified"] = sum(1 for r in rows if r["wa_verified"] == "true")
    st["with_hook"] = sum(1 for r in rows if r["hook"])
    print(json.dumps(st, ensure_ascii=False))


if __name__ == "__main__":
    main()
