# -*- coding: utf-8 -*-
"""Конфигурация Lead Hunter (Whale Edition) — города, запросы, префиксы, пороги."""

import os

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(PROJECT_DIR, "raw")
STATE_DIR = os.path.join(PROJECT_DIR, "state")
ENRICH_DIR = os.path.join(PROJECT_DIR, "enrich")
QUARANTINE_DIR = os.path.join(PROJECT_DIR, "quarantine")
WORK_DIR = os.path.join(PROJECT_DIR, "work")
QUEUE_FILE = os.path.join(PROJECT_DIR, "queue.json")
STATUS_FILE = os.path.join(PROJECT_DIR, "STATUS.md")

# ── География ────────────────────────────────────────────────────────────────
KZ_CITIES = {
    "almaty": "Алматы", "astana": "Астана", "shymkent": "Шымкент",
    "karaganda": "Караганда", "aktobe": "Актобе", "atyrau": "Атырау",
    "pavlodar": "Павлодар", "oskemen": "Усть-Каменогорск", "kostanay": "Костанай",
    "taraz": "Тараз", "semey": "Семей", "kyzylorda": "Кызылорда",
    "aktau": "Актау", "uralsk": "Уральск", "petropavlovsk": "Петропавловск",
}
KG_CITIES = {"bishkek": "Бишкек", "osh": "Ош", "jalalabad": "Джалал-Абад"}
ALL_CITIES = {**KZ_CITIES, **KG_CITIES}

def city_country(slug):
    return "KG" if slug in KG_CITIES else "KZ"

# Порядок городов внутри волн (киты сначала)
_ABROAD_IELTS_ORDER = [
    "almaty", "astana", "bishkek", "shymkent", "karaganda", "aktobe", "atyrau",
    "pavlodar", "oskemen", "kostanay", "taraz", "semey", "kyzylorda", "aktau",
    "uralsk", "petropavlovsk", "osh", "jalalabad",
]
_ENT_ORDER = [
    "almaty", "astana", "shymkent", "karaganda", "aktobe", "atyrau", "pavlodar",
    "oskemen", "kostanay", "taraz", "semey", "kyzylorda", "aktau", "uralsk",
    "petropavlovsk",
]
WAVES = [
    ("abroad", _ABROAD_IELTS_ORDER),
    ("ielts", _ABROAD_IELTS_ORDER),
    ("ent", _ENT_ORDER),  # ent — только Казахстан
]

# ── Поисковые запросы по сегментам ({city} подставляется по-русски) ──────────
QUERIES = {
    "abroad": [
        "подготовка к поступлению за рубеж {city}",
        "образование за рубежом агентство {city}",
        "поступление в университеты США {city}",
        "курсы SAT {city}",
        "study abroad consultant {city} Kazakhstan",
        "образовательное агентство {city} whatsapp",
        "гранты обучение за границей {city} центр",
        "шетелде оқу {city}",
    ],
    "ielts": [
        "курсы IELTS {city}",
        "подготовка TOEFL {city}",
        "языковая школа английский {city} филиалы",
        "IELTS центр {city}",
        "курсы английского языка {city} instagram",
        "ағылшын тілі курстары {city}",
        "языковая школа {city} whatsapp",
    ],
    "ent": [
        "подготовка к ЕНТ {city} образовательный центр",
        "курсы ЕНТ {city} филиалы",
        "ЕНТ дайындық орталық {city}",
        "ҰБТ дайындық {city}",
        "репетиторский центр ЕНТ {city}",
        "білім беру орталығы {city} instagram",
    ],
}

# ── Телефония ────────────────────────────────────────────────────────────────
# Белый список мобильных префиксов KZ (после +7)
KZ_MOBILE_PREFIXES = {
    "700", "701", "702", "705", "706", "707", "708", "747",
    "771", "775", "776", "777", "778",
}
# KG: городские коды начинаются на 3 (312 Бишкек, 3222 Ош, 3722 Джалал-Абад)
# мобильные — всё остальное (50x, 55x, 70x, 77x, 99x ...)

# ── Скоринг ──────────────────────────────────────────────────────────────────
SCORE_THRESHOLD = 3        # в базу
BORDERLINE_SCORE = 2       # берём только в abroad
BORDERLINE_SEGMENT = "abroad"

LPR_PRIORITY = {"A": 0, "B": 1, "C": 2}
GOLD_CITIES = {"Алматы", "Астана", "Бишкек", "Шымкент"}

# Домены, которые НЕ могут быть website школы (каталоги/агрегаторы/соцсети)
CATALOG_DOMAINS = {
    "2gis", "satu.kz", "olx.kz", "olx.kg", "yell.kz", "flamp", "krisha.kz",
    "kursy-almaty.kz", "kursy-astana.kz", "instagram.com", "facebook.com",
    "vk.com", "wa.me", "whatsapp.com", "taplink.cc", "linktr.ee", "t.me",
    "youtube.com", "tiktok.com", "google.com", "yandex", "prodoctorov",
    "zoon.kz", "orgpage", "bizorg", "tumba.kz", "pulscen", "allbiz",
    "ucheba.kz", "edugid", "linkedin.com", "hh.kz", "hh.ru",
}

CSV_COLUMNS = [
    "phone_whatsapp", "wa_verified", "school_name", "city", "country", "segment",
    "lpr_name", "lpr_instagram", "school_instagram", "website", "lpr_status",
    "hook", "source_url", "source", "branches", "google_rating", "google_reviews",
    "ig_followers", "runs_ads", "scale_score", "tier", "extra_phones",
]
MSG_COLUMNS = [
    "phone_whatsapp", "school_name", "lpr_name", "segment", "city",
    "lpr_status", "scale_score", "tier", "message",
]

# ── Режим объёма (заказчику нужен объём 1000, а не только киты) ───────────────
# tier: whale (score>=3) — приоритет; mid (score 1-2); base (score 0)
# В volume-режиме в базу идут ВСЕ с валидным телефоном и признаком организации.
VOLUME_MODE = os.environ.get("LEADHUNTER_VOLUME", "1") == "1"


def tier_of(score):
    if score >= 3:
        return "whale"
    if score >= 1:
        return "mid"
    return "base"


# Приоритет добавлен для 4-го «сборного» сегмента прочих образовательных центров
SEGMENT_PRIORITY = {"abroad": 0, "ielts": 1, "ent": 2, "other": 3}

# Широкие запросы для массового сбора (средние и мелкие тоже) по под-темам
BROAD_QUERIES = {
    "ielts": [
        "языковые курсы {city}", "курсы английского языка {city}",
        "школа английского {city}", "курсы английского {city} whatsapp",
        "разговорный английский {city}", "курсы иностранных языков {city}",
        "ағылшын тілі курстары {city}", "языковой центр {city}",
    ],
    "ent": [
        "подготовка к ЕНТ {city}", "курсы ЕНТ {city}", "ҰБТ дайындық {city}",
        "репетиторский центр {city}", "учебный центр {city}",
        "образовательный центр {city}", "подготовка к школе {city}",
        "оқу орталығы {city}", "курсы {city} whatsapp",
    ],
    "abroad": [
        "образование за рубежом {city}", "поступление за границу {city}",
        "учеба за рубежом агентство {city}", "study abroad {city}",
    ],
    "other": [
        "детский развивающий центр {city}", "ментальная арифметика {city}",
        "курсы программирования {city}", "IT школа для детей {city}",
        "робототехника дети {city}", "школа скорочтения {city}",
        "центр развития ребенка {city}",
    ],
}
