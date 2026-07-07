# -*- coding: utf-8 -*-
"""Очистка: нормализация, гео-фильтр, карантин, merge-дедуп, патчи enrichment.

Читает raw/*.jsonl (+ enrich/*.jsonl как патчи по телефону),
пишет work/cleaned.jsonl и quarantine/rejected.jsonl. Идемпотентен.
"""

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
from config import RAW_DIR, ENRICH_DIR, WORK_DIR, QUARANTINE_DIR, SEGMENT_PRIORITY
from common import normalize_phone, phone_type, norm_domain, norm_name, norm_ig

SOURCE_PRIORITY = {"wa_link": 0, "site_button": 1, "tel_link": 2, "site_text": 3, "catalog": 4}


def load_raw():
    rows = []
    for path in sorted(glob.glob(os.path.join(RAW_DIR, "*.jsonl"))):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    return rows


def load_enrich_patches():
    patches = {}
    for path in sorted(glob.glob(os.path.join(ENRICH_DIR, "*.jsonl"))):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    p = json.loads(line)
                except ValueError:
                    continue
                key = p.get("phone")
                if key:
                    patches.setdefault(key, {}).update(
                        {k: v for k, v in p.items() if v not in (None, "", [])})
    return patches


def sanitize(row):
    """Нормализация одной строки. Возвращает (row, None) или (None, причина)."""
    phone_in = row.get("phone")
    if not phone_in:
        return None, "no_phone"
    phone, cc = normalize_phone(phone_in)
    if not phone:
        return None, "bad_phone:%s" % cc
    if not row.get("source_url"):
        return None, "no_source_url"
    row["phone"] = phone
    row["country"] = row.get("country") or cc
    row["phone_type"] = phone_type(phone)
    if row.get("wa_verified") and not row.get("wa_link"):
        row["wa_verified"] = False
    # городской номер не может быть wa_verified без wa-ссылки — уже покрыто;
    # приоритет городских минимальный, отражается сортировкой при дедупе
    if row.get("website") and not norm_domain(row["website"]):
        row["website"] = None  # каталог/агрегатор — не сайт школы
    row["instagram"] = norm_ig(row.get("instagram"))
    row["lpr_instagram"] = norm_ig(row.get("lpr_instagram"))
    seg = row.get("segment")
    if seg not in SEGMENT_PRIORITY:
        return None, "bad_segment:%r" % seg
    extra = []
    for e in row.get("extra_phones") or []:
        ne, _ = normalize_phone(e)
        if ne and ne != phone:
            extra.append(ne)
    row["extra_phones"] = list(dict.fromkeys(extra))
    sig = row.get("signals") or {}
    if (row.get("branch_count") or 0) >= 2:
        sig["network"] = True
    row["signals"] = sig
    return row, None


def richness(row):
    """Ключ качества строки для выбора победителя при слиянии."""
    lpr = 0 if row.get("lpr_name") else 1
    wa = 0 if row.get("wa_verified") else 1
    mob = 0 if row.get("phone_type") == "mobile" else 1
    src = SOURCE_PRIORITY.get(row.get("source"), 5)
    sig = -sum(1 for v in (row.get("signals") or {}).values() if v)
    return (lpr, wa, mob, src, sig)


def merge_group(rows):
    """Слияние дублей: победитель + лучшее непустое из остальных."""
    rows = sorted(rows, key=richness)
    base = dict(rows[0])
    phones = {base["phone"]: base}
    for r in rows[1:]:
        if r["phone"] not in phones:
            phones[r["phone"]] = r
        for k, v in r.items():
            if base.get(k) in (None, "", [], {}) and v not in (None, "", [], {}):
                base[k] = v
        for k in ("branch_count", "ig_followers", "google_reviews"):
            if r.get(k) and (not base.get(k) or r[k] > base[k]):
                base[k] = r[k]
        for k, v in (r.get("signals") or {}).items():
            if v:
                base["signals"][k] = True
        base.setdefault("segments_all", set())
    segs = {r.get("segment") for r in rows}
    base["segments_all"] = sorted(segs, key=lambda s: SEGMENT_PRIORITY[s])
    base["segment"] = base["segments_all"][0]
    # лучший номер — мобильный/wa_verified; остальные в extra_phones
    ordered = sorted(phones.values(), key=richness)
    best = ordered[0]
    base["phone"] = best["phone"]
    base["phone_type"] = best["phone_type"]
    base["wa_verified"] = best.get("wa_verified", False)
    base["wa_link"] = best.get("wa_link")
    base["source"] = best.get("source")
    base["source_url"] = best.get("source_url")
    base["phone_evidence"] = best.get("phone_evidence")
    extras = []
    for r in ordered[1:]:
        extras.append(r["phone"])
    for r in rows:
        extras.extend(r.get("extra_phones") or [])
    base["extra_phones"] = [p for p in dict.fromkeys(extras) if p != base["phone"]]
    if (base.get("branch_count") or 0) >= 2:
        base["signals"]["network"] = True
    return base


class DSU:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def dedup(rows):
    dsu = DSU()
    for i, r in enumerate(rows):
        dsu.union(("row", i), ("phone", r["phone"]))
        nm = norm_name(r.get("name"))
        if nm:
            dsu.union(("row", i), ("name", nm, r.get("city")))
        dom = norm_domain(r.get("website"))
        if dom:
            dsu.union(("row", i), ("dom", dom, r.get("city")))
        # IG-хендл склеивает бренды только внутри одного города
        # (одна строка на бренд×город — филиалы сети в разных городах остаются раздельными)
        ig = norm_ig(r.get("instagram"))
        if ig:
            dsu.union(("row", i), ("ig", ig, r.get("city")))
    groups = {}
    for i, r in enumerate(rows):
        groups.setdefault(dsu.find(("row", i)), []).append(r)
    return [merge_group(g) for g in groups.values()]


def main():
    raw = load_raw()
    patches = load_enrich_patches()
    cleaned, rejected = [], []
    for row in raw:
        orig = dict(row)
        srow, reason = sanitize(orig)
        if reason:
            rejected.append({"reason": reason, "row": orig})
            continue
        cleaned.append(srow)

    merged = dedup(cleaned)
    n_merged_away = len(cleaned) - len(merged)

    # патчи enrichment (ЛПР, IG-добор, hook) — по основному и extra номерам
    patched = 0
    for row in merged:
        for key in [row["phone"]] + (row.get("extra_phones") or []):
            if key in patches:
                p = patches[key]
                for k, v in p.items():
                    if k in ("phone",):
                        continue
                    if k in ("ig_followers", "branch_count", "google_reviews"):
                        if v and (not row.get(k) or v > row.get(k) or not row.get(k)):
                            row[k] = v
                    elif row.get(k) in (None, "", []):
                        row[k] = v
                if p.get("signals"):
                    for sk, sv in p["signals"].items():
                        if sv:
                            row["signals"][sk] = True
                patched += 1
                break
    for row in merged:
        if (row.get("branch_count") or 0) >= 2:
            row["signals"]["network"] = True

    os.makedirs(WORK_DIR, exist_ok=True)
    os.makedirs(QUARANTINE_DIR, exist_ok=True)
    with open(os.path.join(WORK_DIR, "cleaned.jsonl"), "w", encoding="utf-8") as f:
        for row in merged:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(os.path.join(QUARANTINE_DIR, "rejected.jsonl"), "w", encoding="utf-8") as f:
        for r in rejected:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    reasons = {}
    for r in rejected:
        key = r["reason"].split(":")[0]
        reasons[key] = reasons.get(key, 0) + 1
    print(json.dumps({
        "raw_rows": len(raw), "cleaned": len(cleaned), "rejected": len(rejected),
        "reject_reasons": reasons, "merged_away": n_merged_away,
        "final_rows": len(merged), "enrich_patched": patched,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
