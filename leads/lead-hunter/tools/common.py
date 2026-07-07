# -*- coding: utf-8 -*-
"""Общие функции нормализации: телефоны, домены, названия."""

import re
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import KZ_MOBILE_PREFIXES, CATALOG_DOMAINS


def normalize_phone(raw):
    """Нормализует сырой телефон в +7XXXXXXXXXX / +996XXXXXXXXX.

    Возвращает (phone, country) или (None, reason).
    Российские +79... и невалидные форматы отбрасываются.
    """
    if not raw:
        return None, "empty"
    digits = re.sub(r"\D", "", str(raw))
    if not digits:
        return None, "empty"

    # KZ: 8XXXXXXXXXX -> 7XXXXXXXXXX
    if len(digits) == 11 and digits.startswith("8"):
        digits = "7" + digits[1:]
    # KG local: 0XXXXXXXXX -> 996XXXXXXXXX
    if len(digits) == 10 and digits.startswith("0"):
        digits = "996" + digits[1:]

    if digits.startswith("996"):
        if len(digits) != 12:
            return None, "bad_kg_len"
        return "+" + digits, "KG"
    if digits.startswith("7"):
        if len(digits) != 11:
            return None, "bad_kz_len"
        if digits[1] == "9":  # +79... Россия
            return None, "russia"
        if digits[1] != "7":  # +7 не-казахстанский диапазон
            return None, "not_kz_range"
        return "+" + digits, "KZ"
    # 10 цифр, начинается на 7XX (без кода страны) — казахстанский мобильный без 8/+7
    if len(digits) == 10 and digits.startswith("7"):
        cand = "7" + digits
        if cand[1] == "7":
            return "+" + cand, "KZ"
    return None, "unrecognized"


def phone_type(phone):
    """mobile / landline для нормализованного номера."""
    if not phone:
        return None
    if phone.startswith("+77"):
        return "mobile" if phone[2:5] in KZ_MOBILE_PREFIXES else "landline"
    if phone.startswith("+996"):
        # городские коды KG начинаются на 3
        return "landline" if phone[4] == "3" else "mobile"
    return None


def norm_domain(url):
    """Домен без www из URL; None если это каталог/агрегатор/соцсеть."""
    if not url:
        return None
    m = re.search(r"https?://(?:www\.)?([^/\s]+)", str(url).strip().lower())
    if not m:
        return None
    dom = m.group(1)
    for cat in CATALOG_DOMAINS:
        if cat in dom:
            return None
    return dom


def is_own_website(url):
    return norm_domain(url) is not None


def norm_name(name):
    """Нормализованное название школы для дедупа."""
    if not name:
        return ""
    s = str(name).lower()
    s = re.sub(r"\b(тоо|ип|llp|llc|ооо|образовательный центр|учебный центр|"
               r"education center|school|центр|школа)\b", " ", s)
    s = re.sub(r"[^a-zа-яё0-9]+", "", s)
    return s


def norm_ig(handle):
    if not handle:
        return None
    h = str(handle).strip().lstrip("@").lower()
    h = re.sub(r"[^a-z0-9_\.]", "", h)
    bad = {"p", "reel", "reels", "explore", "accounts", "stories", "share",
           "instagram", "tv", "direct", ""}
    return None if h in bad else h
