# -*- coding: utf-8 -*-
"""Детерминированное извлечение контактов и сигналов масштаба из сайтов.

Использование:
  python3 tools/fetch_extract.py --urls "https://a.kz,https://b.kz" [--auto-contacts] [--out f.json]
  python3 tools/fetch_extract.py --urls-file urls.txt --auto-contacts

Выводит JSON: по каждому URL — телефоны (нормализованные, с типом, источником
и дословной цитатой-evidence), wa-ссылки, instagram, email, маркеры масштаба.
Телефоны в базу попадают ТОЛЬКО из вывода этого скрипта.
"""

import argparse
import json
import re
import sys
import time
import os
from urllib.parse import urljoin, unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import normalize_phone, phone_type

import requests

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}
TIMEOUT = 12
_last_hit = {}  # домен -> время последнего запроса

WA_PATTERNS = [
    (re.compile(r"wa\.me/(?:%2B|\+)?(\d{10,13})"), "wa_link"),
    (re.compile(r"api\.whatsapp\.com/send/?\?(?:[^\"'\s>]*?)phone=(?:%2B|\+)?(\d{10,13})"), "wa_link"),
    (re.compile(r"whatsapp://send\?(?:[^\"'\s>]*?)phone=(?:%2B|\+)?(\d{10,13})"), "wa_link"),
]
TEL_RE = re.compile(r"""tel:(\+?[\d\-\s\(\)\.]{9,20})""")
KZ_TEXT_RE = re.compile(
    r"(?<!\d)(?:\+7|8)[\s\-\(\)]{0,3}7\d{2}[\s\-\(\)]{0,3}\d{3}[\s\-\(\)]{0,3}\d{2}[\s\-\(\)]{0,3}\d{2}(?!\d)")
KG_TEXT_RE = re.compile(
    r"(?<!\d)(?:\+?996|0)[\s\-\(\)]{0,3}\d{3}[\s\-\(\)]{0,3}\d{2,3}[\s\-\(\)]{0,3}\d{2,4}(?!\d)")
IG_RE = re.compile(r"instagram\.com/([A-Za-z0-9_\.]{2,40})")
EMAIL_RE = re.compile(r"[a-zA-Z0-9_\.\+\-]+@[a-zA-Z0-9\-]+\.[a-zA-Z0-9\-\.]+")

MARKER_PATTERNS = {
    "branches": re.compile(r"(филиал\w*|наши адреса|адреса школ|бөлімше\w*|our branches|"
                           r"наши офисы|адреса центров|наши центры)", re.I),
    "team": re.compile(r"(наша команда|our team|команда центра|команда школы|преподавательский состав|"
                       r"біздің команда|отдел продаж|наши менеджеры)", re.I),
    "age": re.compile(r"((?:работаем|на рынке|основан\w*|since|опыт работы)\s*[—\-:с]*\s*(?:19|20)\d{2}|"
                      r"(?:19|20)\d{2}\s*год[ау]?\s*(?:основания)?|\d{1,2}\s*лет\s*(?:на рынке|опыта|работы)|"
                      r"\d[\d\s]*\+?\s*(?:тысяч\s*)?выпускник\w*|\d[\d\s]*\+?\s*(?:наших\s*)?студент\w*)", re.I),
    "official": re.compile(r"(\bbritish\s+council\b|\bcambridge\b|\bidp\b|\bicef\b|\bfelca\b|"
                           r"\bpearson\b|\bets\b|лицензи\w+|аккредит\w+|"
                           r"официальн\w+\s+(?:центр|партн[её]р|представитель)|"
                           r"\bauthorized\b|official\s+partner)", re.I),
    "infra": re.compile(r"(онлайн[\s\-]?платформ\w*|личный кабинет|LMS|мобильное приложение|"
                        r"собственн\w+\s+(?:здание|кампус|платформ\w+))", re.I),
}
PIXEL_PATTERNS = {
    "meta_pixel": re.compile(r"(connect\.facebook\.net|fbq\s*\(|facebook\.com/tr\?)", re.I),
    "google_tag": re.compile(r"(googletagmanager\.com|gtag\s*\(|google-analytics\.com)", re.I),
    "yandex_metrika": re.compile(r"(mc\.yandex\.ru|ym\s*\(\s*\d)", re.I),
}
CONTACT_LINK_RE = re.compile(
    r"""href=["']([^"']*(?:contact|kontakt|контакт|байланыс|about|o-nas|о-нас)[^"']*)["']""", re.I)


def polite_get(url):
    """GET с браузерным UA, паузой по домену, 1 ретраем."""
    dom = re.sub(r"https?://", "", url).split("/")[0]
    wait = 1.5 - (time.time() - _last_hit.get(dom, 0))
    if wait > 0:
        time.sleep(wait)
    last_err = None
    for attempt in range(2):
        try:
            _last_hit[dom] = time.time()
            r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
            if r.status_code in (403, 429) and attempt == 0:
                time.sleep(5)
                continue
            return r, None
        except requests.RequestException as e:
            last_err = "%s: %s" % (type(e).__name__, str(e)[:120])
            time.sleep(3)
    return None, last_err


def snippet(text, start, end, radius=90):
    s = max(0, start - radius)
    e = min(len(text), end + radius)
    return re.sub(r"\s+", " ", text[s:e]).strip()


def extract_from_html(html, url):
    """Извлекает контакты и маркеры из сырого HTML. Только детерминированные regex."""
    out = {"url": url, "phones": [], "instagram": [], "emails": [],
           "markers": {}, "pixels": {}}
    seen_phones = {}

    def add_phone(raw, source, pos_start, pos_end):
        phone, cc = normalize_phone(raw)
        if not phone:
            return
        key = phone
        entry = {
            "phone": phone,
            "phone_raw": re.sub(r"\s+", " ", str(raw)).strip()[:40],
            "type": phone_type(phone),
            "country": cc,
            "source": source,
            "evidence": snippet(html, pos_start, pos_end, 60)[:200],
        }
        prio = {"wa_link": 0, "tel_link": 1, "site_text": 2}
        if key not in seen_phones or prio[source] < prio[seen_phones[key]["source"]]:
            seen_phones[key] = entry

    for rx, src in WA_PATTERNS:
        for m in rx.finditer(html):
            add_phone(unquote(m.group(1)), "wa_link", m.start(), m.end())
    for m in TEL_RE.finditer(html):
        add_phone(m.group(1), "tel_link", m.start(), m.end())
    for rx in (KZ_TEXT_RE, KG_TEXT_RE):
        for m in rx.finditer(html):
            add_phone(m.group(0), "site_text", m.start(), m.end())

    out["phones"] = sorted(seen_phones.values(),
                           key=lambda p: ({"wa_link": 0, "tel_link": 1, "site_text": 2}[p["source"]],
                                          0 if p["type"] == "mobile" else 1))

    igs = {}
    for m in IG_RE.finditer(html):
        h = m.group(1).lower().rstrip(".")
        if h not in ("p", "reel", "reels", "explore", "accounts", "stories",
                     "share", "tv", "direct", "instagram"):
            igs[h] = True
    out["instagram"] = list(igs)[:10]

    emails = {}
    for m in EMAIL_RE.finditer(html):
        e = m.group(0).lower()
        if not re.search(r"\.(png|jpg|jpeg|gif|svg|webp|css|js)$", e):
            emails[e] = True
    out["emails"] = list(emails)[:5]

    for name, rx in MARKER_PATTERNS.items():
        hits = []
        for m in rx.finditer(html):
            hits.append(snippet(html, m.start(), m.end(), 80)[:180])
            if len(hits) >= 3:
                break
        if hits:
            out["markers"][name] = hits
    for name, rx in PIXEL_PATTERNS.items():
        out["pixels"][name] = bool(rx.search(html))

    tm = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    out["title"] = re.sub(r"\s+", " ", tm.group(1)).strip()[:150] if tm else None
    return out


def strip_tags_keep_text(html):
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.I | re.S)
    return html


def process_url(url, auto_contacts=False):
    results = []
    r, err = polite_get(url)
    if r is None:
        return [{"url": url, "status": "error", "error": err}]
    if r.status_code != 200:
        return [{"url": url, "status": "error", "error": "http_%d" % r.status_code}]
    html = r.text
    main = extract_from_html(html, str(r.url))
    main["status"] = "ok"
    main["requested_url"] = url
    results.append(main)

    if auto_contacts:
        seen = {url, str(r.url)}
        extra = []
        for m in CONTACT_LINK_RE.finditer(html):
            link = urljoin(str(r.url), m.group(1))
            if link not in seen and link.split("://")[-1].split("/")[0] in str(r.url):
                seen.add(link)
                extra.append(link)
            if len(extra) >= 2:
                break
        for link in extra:
            r2, err2 = polite_get(link)
            if r2 is not None and r2.status_code == 200:
                sub = extract_from_html(r2.text, str(r2.url))
                sub["status"] = "ok"
                sub["requested_url"] = link
                results.append(sub)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", help="URL через запятую")
    ap.add_argument("--urls-file", help="файл со списком URL (по одному на строку)")
    ap.add_argument("--auto-contacts", action="store_true",
                    help="автоматически фетчить страницы контактов/о-нас с того же домена")
    ap.add_argument("--out", help="сохранить JSON в файл")
    args = ap.parse_args()

    urls = []
    if args.urls:
        urls += [u.strip() for u in args.urls.split(",") if u.strip()]
    if args.urls_file:
        with open(args.urls_file, encoding="utf-8") as f:
            urls += [line.strip() for line in f if line.strip() and not line.startswith("#")]
    urls = list(dict.fromkeys(urls))[:20]
    if not urls:
        print("нет URL", file=sys.stderr)
        sys.exit(1)

    all_results = []
    for u in urls:
        if not u.startswith("http"):
            u = "https://" + u
        all_results.extend(process_url(u, auto_contacts=args.auto_contacts))

    payload = json.dumps(all_results, ensure_ascii=False, indent=1)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(payload)
    print(payload)


if __name__ == "__main__":
    main()
