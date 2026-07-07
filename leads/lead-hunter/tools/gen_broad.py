# -*- coding: utf-8 -*-
"""Генератор массовой ШИРОКОЙ волны сбора (режим объёма: все с телефоном).

  python3 tools/gen_broad.py --tier top     # 6 крупных городов × 4 под-темы
  python3 tools/gen_broad.py --tier mid     # средние города × 3 под-темы
  python3 tools/gen_broad.py --tier small   # малые города × 2 под-темы
Пишет work/wf_broad_<tier>.js и добавляет батчи <city>_<sub>_b в queue.json.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (ALL_CITIES, QUEUE_FILE, WORK_DIR, BROAD_QUERIES, city_country)

SUB_DESC = {
    "ielts": "языковые школы и курсы английского/иностранных языков (любого размера)",
    "ent": "подготовка к ЕНТ/ҰБТ, репетиторские и учебные центры, подготовка к школе",
    "abroad": "поступление и обучение за рубежом, образовательные агентства",
    "other": "детские развивающие центры, ментальная арифметика, IT/программирование для детей, скорочтение, робототехника",
}

# город -> список под-тем
TOP_CITIES = ["almaty", "astana", "shymkent", "karaganda", "bishkek", "aktobe"]
MID_CITIES = ["atyrau", "pavlodar", "oskemen", "kostanay", "taraz", "semey",
              "kyzylorda", "aktau", "uralsk"]
SMALL_CITIES = ["petropavlovsk", "osh", "jalalabad"]

TIER_PLAN = {
    "top": (TOP_CITIES, ["ielts", "ent", "other", "abroad"]),
    "mid": (MID_CITIES, ["ielts", "ent", "other"]),
    "small": (SMALL_CITIES, ["ielts", "ent"]),
}

BROAD_PROMPT = r'''Ты — сборщик базы образовательных центров для B2B (продукт — AI-ассистент для обработки заявок). РЕЖИМ ОБЪЁМА: заказчику нужен объём, бери ВСЕХ — и крупных, и средних, и небольших, — у кого есть добываемый телефон и это ОРГАНИЗАЦИЯ (а не частное лицо на дому).

БАТЧ: город __CITY__ (__COUNTRY__), тема __SUB__ — __SUBDESC__.
ПРОЕКТ: /Users/omirgaliramazan/база контактов/lead-hunter (дальше — PROJECT)

ШАГ 0 — ИДЕМПОТЕНТНОСТЬ. Выполни: cat "PROJECT/state/__ID__.done.json". Если файл есть и это валидный JSON — верни его содержимое и НЕМЕДЛЕННО закончи.

ЖЕЛЕЗНЫЕ ПРАВИЛА (нарушение = отравленная база):
1. Телефон/wa-ссылка попадают в строку ТОЛЬКО копированием из JSON-вывода fetch_extract.py. Номер из сниппета, из памяти, из пересказа WebFetch — ЗАПРЕЩЁН. Скрипт не нашёл номер — строку не пиши.
2. Каждое непустое поле подтверждено страницей/сниппетом ЭТОЙ сессии. Нет подтверждения — null.
3. Российские +79 игнорируй.
4. КОГО БРАТЬ: любой образовательный центр/школа/курсы/агентство с телефоном и признаком организации (есть сайт, ИЛИ бизнес-Instagram, ИЛИ карточка в каталоге с адресом/названием бренда). КОГО НЕ БРАТЬ: частный репетитор-физлицо «на дому», «ИП Иванова занимаюсь дома», личная страница человека без бренда — это НЕ организация, посчитай в skipped_small.

БЮДЖЕТ: ≤12 WebSearch; ≤3 запуска fetch_extract.py (суммарно ≤30 URL); ≤4 WebFetch; ≤40 строк в выход. С недоступным сайтом не воюй дольше 2 попыток.

ПЛАН:
1. Прогони через WebSearch запросы (варьируй, город обязателен):
__QUERIES__
   Собери МАКСИМУМ кандидатов из выдачи и каталогов (2gis-сниппеты, zoon, satu, kursy-*): название, сайт, IG, телефон-подсказку. Цель — объём, поэтому не отсеивай средних.
2. Собери URL кандидатов (сайты, taplink.cc/linktr.ee из IG) и прогони ПАРТИЯМИ (по ≤15 URL):
   cd "/Users/omirgaliramazan/база контактов/lead-hunter" && python3 tools/fetch_extract.py --urls "url1,url2,..." --auto-contacts
3. Для каждой организации с телефоном из вывода скрипта — сформируй строку. Бери phone/type/source/evidence ТОЛЬКО из вывода скрипта; source_url = страница где скрипт нашёл номер.
4. Сигналы масштаба (signals.*) заполняй, если видны (для tier-скоринга), но их отсутствие — не повод пропускать: средних тоже берём. IG-подписчики — из сниппетов поиска, если попались.
5. Сегмент: __SUB__ для большинства; если центр явно другой темы — поставь корректный из {abroad, ielts, ent, other}. Языки→ielts; ЕНТ/школьная подготовка/репетиторы→ent; за рубеж→abroad; детские развивающие/IT/арифметика→other.
6. SELF-CHECK строки: телефон из вывода скрипта? source_url тот, где номер? формат +77.../+996...? +79 удалён? website — собственный домен (не каталог/соцсеть/taplink), иначе null?
7. Запиши PROJECT/raw/__ID__.jsonl — по одной JSON-строке на организацию (схема ниже). Затем PROJECT/state/__ID__.done.json со сводкой. Верни сводку.

СХЕМА строки raw jsonl (null для ненайденного):
{"batch_id":"__ID__","city":"__CITY__","country":"__COUNTRY__","segment":"__SUB__","name":"название без ТОО/ИП","website":"https://... или null","instagram":"handle или null","phone":"+77XXXXXXXXX из скрипта","phone_raw":"как в скрипте","wa_link":"https://wa.me/... или null","wa_verified":true,"source":"wa_link|tel_link|site_text|catalog","source_url":"https://страница-с-номером","phone_evidence":"цитата из вывода скрипта","extra_phones":[],"email":null,"ig_followers":null,"ig_followers_source":null,"branch_count":null,"founded_year":null,"official_status":null,"google_rating":null,"google_reviews":null,"signals":{"network":false,"ads":false,"team":false,"age":false,"official":false,"infra":false},"lpr_name":null,"lpr_role":null,"lpr_instagram":null,"lpr_source":null,"hook_custom":null,"collected_at":"2026-07-06"}

Цель — собрать как можно больше РЕАЛЬНЫХ организаций с телефонами (ориентир 20-40). Дубли с прошлыми проходами не страшны — их уберёт дедуп; твоя задача — объём. Финальный ответ — ТОЛЬКО JSON-сводка по схеме.'''

SCHEMA_JS = """{
  type: 'object',
  required: ['batch_id', 'status', 'found', 'skipped_small', 'notes'],
  properties: {
    batch_id: { type: 'string' },
    status: { enum: ['done', 'empty', 'partial'] },
    found: { type: 'integer' },
    whales: { type: 'integer' },
    wa_verified: { type: 'integer' },
    skipped_small: { type: 'integer' },
    notes: { type: 'string', maxLength: 300 },
  },
}"""


def build_prompt(city_slug, sub):
    city_ru = ALL_CITIES[city_slug]
    bid = "%s_%s_b" % (city_slug, sub)
    queries = BROAD_QUERIES[sub]
    qlines = "\n".join('   - "%s"' % q.format(city=city_ru) for q in queries)
    p = BROAD_PROMPT
    p = p.replace("__ID__", bid).replace("__CITY__", city_ru)
    p = p.replace("__COUNTRY__", city_country(city_slug)).replace("__SUB__", sub)
    p = p.replace("__SUBDESC__", SUB_DESC[sub])
    p = p.replace("__QUERIES__", qlines)
    return bid, p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", choices=["top", "mid", "small"], required=True)
    args = ap.parse_args()

    cities, subs = TIER_PLAN[args.tier]
    with open(QUEUE_FILE, encoding="utf-8") as f:
        q = json.load(f)
    existing = {b["id"] for b in q["batches"]}

    entries = []
    for city_slug in cities:
        for sub in subs:
            bid, prompt = build_prompt(city_slug, sub)
            entries.append({"id": bid, "prompt": prompt})
            if bid not in existing:
                q["batches"].append({
                    "id": bid, "city": ALL_CITIES[city_slug], "city_slug": city_slug,
                    "country": city_country(city_slug), "segment": sub,
                    "status": "pending", "found": 0, "whales_hint": 0,
                    "wa_verified": 0, "skipped_small": 0, "attempts": 0,
                    "note": "broad-волна объёма",
                })

    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(q, f, ensure_ascii=False, indent=1)

    js_batches = ",\n".join(
        "  { id: %s, prompt: %s }" % (json.dumps(e["id"]), json.dumps(e["prompt"], ensure_ascii=False))
        for e in entries)
    script = """export const meta = {
  name: 'lead-hunter-broad-%(tier)s',
  description: 'Массовый широкий сбор (объём): %(tier)s города',
  phases: [{ title: 'Массовый сбор' }],
}
const SCHEMA = %(schema)s
const BATCHES = [
%(batches)s
]
phase('Массовый сбор')
log('Батчей: ' + BATCHES.length)
const results = await parallel(BATCHES.map(b => () =>
  agent(b.prompt, { label: b.id, phase: 'Массовый сбор', schema: SCHEMA })))
const ok = results.filter(Boolean)
const failed = BATCHES.filter((b, i) => !results[i]).map(b => b.id)
const sum = k => ok.reduce((s, r) => s + (r[k] || 0), 0)
return {
  done: ok.filter(r => r.status === 'done').map(r => r.batch_id),
  empty: ok.filter(r => r.status === 'empty').map(r => r.batch_id),
  failed,
  totals: { found: sum('found'), wa_verified: sum('wa_verified'), skipped_small: sum('skipped_small') },
  notes: ok.map(r => r.batch_id + ': ' + (r.notes || '')),
}
""" % {"tier": args.tier, "schema": SCHEMA_JS, "batches": js_batches}

    out = os.path.join(WORK_DIR, "wf_broad_%s.js" % args.tier)
    with open(out, "w", encoding="utf-8") as f:
        f.write(script)
    print(out)
    print("broad-%s: %d батчей (%d городов × %d под-тем)" % (
        args.tier, len(entries), len(cities), len(subs)), file=sys.stderr)


if __name__ == "__main__":
    main()
