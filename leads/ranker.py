#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lead Qualification: очистка -> relevance_score -> отбор 300 по квотам.
Работает по файлу на диске, стандартный csv (без pandas).
"""
import csv, re
from collections import Counter, defaultdict

SRC = "leads_database.csv"
OUT_TOP = "leads_top300.csv"
OUT_MSG = "leads_top300_messages.csv"
OUT_RES = "leads_reserve.csv"

TARGET_SEGMENTS = {"abroad", "ielts", "ent"}
WHITELIST_PREFIX = {"700","701","702","705","706","707","708","747","771","775","776","777","778"}
PHONE_RE = re.compile(r"^\+77\d{9}$|^\+996\d{9}$")

def ne(r, k):
    return bool((r.get(k) or "").strip())

def val(r, k):
    return (r.get(k) or "").strip()

def to_int(s, default=0):
    s = (s or "").strip()
    try:
        return int(float(s))
    except Exception:
        return default

# ---------- ЗАГРУЗКА ----------
with open(SRC, encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    COLS = list(reader.fieldnames)
    rows = [dict(r) for r in reader]

log = defaultdict(int)
log["input_total"] = len(rows)

# ---------- САНИТАРНАЯ ОЧИСТКА ----------
def mobile_prefix(phone):
    # +77XXYYYYYYY -> XXX after +7
    if phone.startswith("+7") and len(phone) == 12:
        return phone[2:5]
    return None

def is_meloch(r):
    name = val(r, "school_name").lower()
    # репетитор-одиночка / частный / на дому — жёсткий признак, режем всегда
    if any(w in name for w in ["репетитор", "частный", "на дому"]):
        return True
    # ИП [имя] без бренда — эвристика: начинается с "ип " и нет сайта/ig
    if name.startswith("ип ") and not ne(r, "website") and not ne(r, "school_instagram"):
        return True
    # Рескью: контакт прошёл ручной ветинг (верифицированный WA или живой hook)
    # -> это не репетитор-одиночка, из мелочи исключаем.
    vetted = (val(r, "wa_verified").lower() == "true") or ne(r, "hook") or ne(r, "lpr_name")
    if vetted:
        return False
    # scale<=1 И нет сайта И нет бизнес-ig И нет рейтинга -> микро-контакт
    sc = to_int(val(r, "scale_score"), 0)
    if sc <= 1 and not ne(r, "website") and not ne(r, "school_instagram") and not ne(r, "google_rating"):
        return True
    return False

survivors = []
dropped = []
seen_phone = set()
seen_school = {}

def norm_phone(p):
    return re.sub(r"\D", "", p)

def norm_school(r):
    s = val(r, "school_name").lower()
    s = re.sub(r"\b(тоо|ип|оо|чу|too|ip)\b", "", s)
    s = re.sub(r"[^\wа-яё]", "", s)
    city = val(r, "city").lower()
    return s + "|" + city

for r in rows:
    phone = val(r, "phone_whatsapp")
    # 1+2 валидность/гео
    if not PHONE_RE.match(phone):
        log["drop_bad_phone"] += 1
        dropped.append((r, "bad_phone")); continue
    # 3 source_url обязателен
    if not ne(r, "source_url"):
        log["drop_no_source"] += 1
        dropped.append((r, "no_source_url")); continue
    # 5 мелочь
    if is_meloch(r):
        log["drop_meloch"] += 1
        dropped.append((r, "meloch")); continue
    survivors.append(r)

# 4 дедупликация (после базовой чистки), оставляем строку с максимумом данных
def data_richness(r):
    return sum(1 for c in COLS if ne(r, c))

by_phone = {}
for r in survivors:
    key = norm_phone(val(r, "phone_whatsapp"))
    if key in by_phone:
        log["drop_dup_phone"] += 1
        if data_richness(r) > data_richness(by_phone[key]):
            by_phone[key] = r
    else:
        by_phone[key] = r
survivors = list(by_phone.values())

by_school = {}
for r in survivors:
    key = norm_school(r)
    if key in by_school:
        log["drop_dup_school"] += 1
        if data_richness(r) > data_richness(by_school[key]):
            by_school[key] = r
    else:
        by_school[key] = r
survivors = list(by_school.values())

log["survivors"] = len(survivors)

# ---------- РАНЖИРОВАНИЕ ----------
SEG_SCORE = {"abroad": 15, "ielts": 8, "ent": 4}
SOURCE_SCORE = {"wa_link": 10, "site_button": 7, "tel_link": 4, "site_text": 4, "catalog": 1}

def score_row(r):
    seg = val(r, "segment")
    # Блок А (макс 45)
    sc = to_int(val(r, "scale_score"), 0)
    scale_pts = min(30, round(sc * 4.3, 1))
    seg_pts = SEG_SCORE.get(seg, 0)
    blockA = scale_pts + seg_pts
    # Блок Б (макс 30)
    if val(r, "wa_verified").lower() == "true":
        reach_pts = 20
    elif mobile_prefix(val(r, "phone_whatsapp")) in WHITELIST_PREFIX:
        reach_pts = 10
    else:
        reach_pts = 0
    src_pts = SOURCE_SCORE.get(val(r, "source"), 0)
    blockB = reach_pts + src_pts
    # Блок В (макс 25)
    st = val(r, "lpr_status").upper()
    pers = {"A": 25, "B": 15, "C": 3}.get(st, 0)
    if ne(r, "hook") and st in ("B", "C"):
        pers = min(25, pers + 3)
    blockC = pers
    total = round(blockA + blockB + blockC, 1)
    r["relevance_score"] = total
    r["score_breakdown"] = f"scale{round(blockA,1)}|reach{blockB}|pers{blockC}"
    r["_blockA"] = blockA; r["_blockB"] = blockB; r["_blockC"] = blockC
    return total

for r in survivors:
    score_row(r)

# делим на целевые сегменты и прочее
target = [r for r in survivors if val(r, "segment") in TARGET_SEGMENTS]
other = [r for r in survivors if val(r, "segment") not in TARGET_SEGMENTS]

target.sort(key=lambda r: r["relevance_score"], reverse=True)
other.sort(key=lambda r: r["relevance_score"], reverse=True)

# ---------- ОТБОР 300 ПО КВОТАМ ----------
ENT_CAP = 80
NEED = 300
selected = []
ent_count = 0
seg_count = Counter()
for r in target:
    if len(selected) >= NEED:
        break
    seg = val(r, "segment")
    if seg == "ent" and ent_count >= ENT_CAP:
        continue
    selected.append(r)
    seg_count[seg] += 1
    if seg == "ent":
        ent_count += 1

# если целевых не хватило до 300 — добор лучшими из other
if len(selected) < NEED:
    for r in other:
        if len(selected) >= NEED:
            break
        selected.append(r)
        seg_count[val(r, "segment")] += 1

selected.sort(key=lambda r: r["relevance_score"], reverse=True)
for i, r in enumerate(selected, 1):
    r["rank"] = i

# резерв = всё остальное по убыванию
sel_ids = set(id(r) for r in selected)
reserve = [r for r in (target + other) if id(r) not in sel_ids]
reserve.sort(key=lambda r: r["relevance_score"], reverse=True)

# ---------- ВЫВОД ----------
OUT_COLS = ["rank","relevance_score","score_breakdown","phone_whatsapp","wa_verified",
    "school_name","city","country","segment","lpr_name","lpr_instagram","school_instagram",
    "website","lpr_status","hook","scale_score","ig_followers","branches","source_url","source"]

def write_csv(path, data, cols):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in data:
            w.writerow(r)

write_csv(OUT_TOP, selected, OUT_COLS)

# messages
MSG_TMPL = {
    "abroad": "Здравствуйте! Вижу, что {school} помогает с поступлением за рубеж. Хочу показать AI-продажника, который закрывает заявки на консультации 24/7 — можно кратко?",
    "ielts": "Здравствуйте! {school} готовит к IELTS/TOEFL — предлагаю AI-ассистента, который обрабатывает заявки и записывает на пробный урок без менеджера. Интересно?",
    "ent": "Здравствуйте! Для центра подготовки к ЕНТ {school} есть решение — AI-продажник, отвечающий на заявки родителей мгновенно. Показать?",
}
msg_cols = ["rank","relevance_score","phone_whatsapp","school_name","lpr_name","segment","city","lpr_status","message"]
msg_rows = []
for r in selected:
    m = val(r, "message") if "message" in r else ""
    if not m:
        m = MSG_TMPL.get(val(r,"segment"), "").format(school=val(r,"school_name"))
    row = {k: r.get(k, "") for k in msg_cols}
    row["message"] = m
    msg_rows.append(row)
write_csv(OUT_MSG, msg_rows, msg_cols)

write_csv(OUT_RES, reserve, OUT_COLS)

# ---------- СТАТИСТИКА для AUDIT ----------
scores = [r["relevance_score"] for r in selected]
allscores = [r["relevance_score"] for r in (target+other)]
allscores.sort()
def pct(lst, p):
    if not lst: return 0
    return lst[int(len(lst)*p)]
print("=== ОЧИСТКА ===")
for k,v in log.items(): print(f"  {k}: {v}")
print("\n=== ОТБОР 300 ===")
print("  выбрано:", len(selected), "| резерв:", len(reserve))
print("  структура по сегментам:", dict(seg_count))
print("  ent_count:", ent_count)
print("\n=== SCORE ===")
print(f"  top300: min {min(scores)} / медиана {sorted(scores)[len(scores)//2]} / max {max(scores)}")
print(f"  порог отсечки (score последнего в топ300): {selected[-1]['relevance_score']}")
print(f"  вся база score: min {min(allscores)} / медиана {allscores[len(allscores)//2]} / max {max(allscores)}")

# структура топ300 детально
print("\n=== СТРУКТУРА ТОП-300 ===")
for seg in ["abroad","ielts","ent"]:
    sub=[r for r in selected if val(r,"segment")==seg]
    if not sub: continue
    avg=round(sum(r["relevance_score"] for r in sub)/len(sub),1)
    avgsc=round(sum(to_int(val(r,"scale_score")) for r in sub)/len(sub),2)
    wa=sum(1 for r in sub if val(r,"wa_verified").lower()=="true")
    a=sum(1 for r in sub if val(r,"lpr_status").upper()=="A")
    print(f"  {seg:8} n={len(sub):3} avg_score={avg} avg_scale={avgsc} wa={wa} A={a}")
print("\n  города топ300:", Counter(val(r,"city") for r in selected).most_common(15))

# сохраним разбивку в файл для отчёта
import json
with open("_stats.json","w",encoding="utf-8") as f:
    json.dump({
        "log":dict(log),
        "seg_count":dict(seg_count),
        "top300_min":min(scores),"top300_med":sorted(scores)[len(scores)//2],"top300_max":max(scores),
        "cutoff":selected[-1]["relevance_score"],
        "cities":Counter(val(r,"city") for r in selected).most_common(20),
    },f,ensure_ascii=False,indent=2)
print("\nOK: файлы записаны.")
