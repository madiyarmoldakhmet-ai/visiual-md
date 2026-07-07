# -*- coding: utf-8 -*-
"""QA-валидация базы и линт сообщений.

  python3 validator.py check            # машинные проверки leads_database.csv
  python3 validator.py sample --n 20    # стратифицированная выборка для агентского QA
  python3 validator.py lint-messages    # линт leads_messages.csv
"""

import argparse
import csv
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
from config import (PROJECT_DIR, SCORE_THRESHOLD, BORDERLINE_SCORE,
                    BORDERLINE_SEGMENT, CSV_COLUMNS, VOLUME_MODE, SEGMENT_PRIORITY)
from common import norm_name, norm_domain

DB_FILE = os.path.join(PROJECT_DIR, "leads_database.csv")
MSG_FILE = os.path.join(PROJECT_DIR, "leads_messages.csv")
PHONE_RE = re.compile(r"^\+77\d{9}$|^\+996\d{9}$")


def load_db():
    with open(DB_FILE, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def cmd_check():
    rows = load_db()
    errors = []

    if rows and list(rows[0].keys()) != CSV_COLUMNS:
        errors.append("колонки CSV не совпадают с ТЗ")

    phones, school_city = {}, {}
    for i, r in enumerate(rows, 2):  # строка 1 — заголовок
        p = r["phone_whatsapp"]
        if not PHONE_RE.match(p):
            errors.append("стр %d: телефон %r вне формата" % (i, p))
        if p.startswith("+79"):
            errors.append("стр %d: российский номер" % i)
        if p in phones:
            errors.append("стр %d: дубль номера с стр %d" % (i, phones[p]))
        phones[p] = i
        key = (norm_name(r["school_name"]), r["city"])
        if key in school_city:
            errors.append("стр %d: дубль школа+город с стр %d (%s)" % (i, school_city[key], r["school_name"]))
        school_city[key] = i
        for field in ("source_url", "segment", "city", "country", "scale_score", "school_name"):
            if not r[field]:
                errors.append("стр %d: пустое %s" % (i, field))
        try:
            score = int(r["scale_score"])
            if not VOLUME_MODE and score < SCORE_THRESHOLD and not (
                    score == BORDERLINE_SCORE and r["segment"] == BORDERLINE_SEGMENT):
                errors.append("стр %d: мелочь в базе (score=%d, %s)" % (i, score, r["segment"]))
        except ValueError:
            errors.append("стр %d: scale_score не число" % i)
        if r["website"] and not norm_domain(r["website"]):
            errors.append("стр %d: website — каталог/агрегатор: %s" % (i, r["website"]))
        if r["wa_verified"] not in ("true", "false"):
            errors.append("стр %d: wa_verified не true/false" % i)
        for ep in filter(None, r["extra_phones"].split(";")):
            if not PHONE_RE.match(ep):
                errors.append("стр %d: extra_phone %r вне формата" % (i, ep))

    # сортировка
    def key(r):
        seg = SEGMENT_PRIORITY[r["segment"]]
        lpr = {"A": 0, "B": 1, "C": 2}[r["lpr_status"]]
        return (-int(r["scale_score"]), lpr, seg, r["city"])
    if [key(r) for r in rows] != sorted([key(r) for r in rows]):
        errors.append("нарушена сортировка scale_score→lpr_status→сегмент→город")

    report = {"rows": len(rows), "errors": len(errors), "ok": not errors,
              "details": errors[:30]}
    print(json.dumps(report, ensure_ascii=False, indent=1))
    sys.exit(0 if not errors else 1)


def cmd_sample(n):
    rows = load_db()
    random.shuffle(rows)
    # стратификация: по сегментам пропорционально, минимум по 3 из каждого при наличии
    by_seg = {}
    for r in rows:
        by_seg.setdefault(r["segment"], []).append(r)
    picked = []
    for seg, lst in by_seg.items():
        picked.extend(lst[:max(3, int(n * len(lst) / max(1, len(rows))))])
    picked = picked[:n]
    out = [{"phone": r["phone_whatsapp"], "school": r["school_name"],
            "city": r["city"], "source_url": r["source_url"]} for r in picked]
    print(json.dumps(out, ensure_ascii=False, indent=1))


def cmd_lint_messages():
    with open(MSG_FILE, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    errors = []
    for i, r in enumerate(rows, 2):
        m = r["message"]
        if "[" in m or "]" in m or "{" in m or "}" in m:
            errors.append("стр %d: скобки шаблона" % i)
        if "  " in m:
            errors.append("стр %d: двойной пробел" % i)
        if re.search(r"!\s*\.\s", m) or re.search(r"\.\s*\.\s", m):
            errors.append("стр %d: пустой hook оставил мусор пунктуации" % i)
        if len(m) > 450:
            errors.append("стр %d: длина %d > 450" % (i, len(m)))
        if r["lpr_name"] and " " in r["lpr_name"].strip():
            errors.append("стр %d: в lpr_name не первое имя: %r" % (i, r["lpr_name"]))
    print(json.dumps({"messages": len(rows), "errors": len(errors),
                      "ok": not errors, "details": errors[:30]}, ensure_ascii=False, indent=1))
    sys.exit(0 if not errors else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["check", "sample", "lint-messages"])
    ap.add_argument("--n", type=int, default=20)
    args = ap.parse_args()
    if args.cmd == "check":
        cmd_check()
    elif args.cmd == "sample":
        cmd_sample(args.n)
    else:
        cmd_lint_messages()


if __name__ == "__main__":
    main()
