#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Шаг 0: аудит исходной базы leads_database.csv"""
import csv, re
from collections import Counter, defaultdict

SRC = "leads_database.csv"

rows = []
with open(SRC, encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    cols = reader.fieldnames
    for r in reader:
        rows.append(r)

N = len(rows)

def nonempty(r, k):
    return bool((r.get(k) or "").strip())

seg = Counter(r.get("segment","").strip() for r in rows)
city = Counter(r.get("city","").strip() for r in rows)
country = Counter(r.get("country","").strip() for r in rows)
wa_true = sum(1 for r in rows if (r.get("wa_verified","").strip().lower()=="true"))
has_lpr = sum(1 for r in rows if nonempty(r,"lpr_name"))
has_scale = sum(1 for r in rows if nonempty(r,"scale_score"))
has_source_url = sum(1 for r in rows if nonempty(r,"source_url"))
has_hook = sum(1 for r in rows if nonempty(r,"hook"))
lpr_status = Counter((r.get("lpr_status","") or "").strip() for r in rows)

# критичные пустые
crit = ["phone_whatsapp","school_name","segment","source_url"]
empties = {c: sum(1 for r in rows if not nonempty(r,c)) for c in cols}

print("КОЛОНКИ:", cols)
print("ВСЕГО СТРОК:", N)
print("\nСЕГМЕНТЫ:", dict(seg))
print("\nСТРАНЫ:", dict(country))
print("\nГОРОДА (top20):", city.most_common(20))
print("\nwa_verified=true:", wa_true)
print("has lpr_name:", has_lpr)
print("has scale_score:", has_scale)
print("has source_url:", has_source_url)
print("has hook:", has_hook)
print("lpr_status:", dict(lpr_status))
print("\nПУСТЫЕ ПО КРИТИЧНЫМ:")
for c in crit:
    print(f"  {c}: {empties[c]} пустых")

# распределение scale_score
sc = Counter()
for r in rows:
    v = (r.get("scale_score","") or "").strip()
    sc[v] += 1
print("\nscale_score распределение:", dict(sorted(sc.items(), key=lambda x:str(x[0]))))

# префиксы номеров
pref = Counter()
for r in rows:
    p = (r.get("phone_whatsapp","") or "").strip()
    if p.startswith("+7"): pref["+7"] += 1
    elif p.startswith("+996"): pref["+996"] += 1
    else: pref["other:"+p[:4]] += 1
print("\nПРЕФИКСЫ:", dict(pref))
