# -*- coding: utf-8 -*-
"""Углубляющий проход по китовым городам: новые ракурсы запросов + список known.

  python3 tools/gen_deepen.py
Добавляет батчи <city>_<segment>_d2 в queue.json, пишет work/wf_deepen.js.
"""

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import ALL_CITIES, QUEUE_FILE, WORK_DIR, RAW_DIR, city_country
from gen_workflow import PROMPT_TEMPLATE, SEG_DESC, SCHEMA_JS

# Китовые пары город×сегмент для второго прохода
DEEPEN_PAIRS = [
    ("almaty", "abroad"), ("almaty", "ielts"), ("almaty", "ent"),
    ("astana", "abroad"), ("astana", "ielts"), ("astana", "ent"),
    ("shymkent", "ielts"), ("shymkent", "ent"),
    ("bishkek", "abroad"), ("bishkek", "ielts"),
    ("karaganda", "ielts"),
]

# Свежие ракурсы (не повторяют волну 1)
DEEPEN_QUERIES = {
    "abroad": [
        "лучшие образовательные агентства {city} рейтинг",
        "обучение в Корее агентство {city}",
        "обучение в Китае агентство {city}",
        "образование в Великобритании {city}",
        "подготовка Назарбаев Университет NUFYP {city}",
        "стипендия Болашак подготовка {city}",
        "международное образование выставка {city} участники",
        "топ консультантов по поступлению {city}",
    ],
    "ielts": [
        "топ языковых школ {city} рейтинг",
        "куда пойти учить английский {city} отзывы",
        "сеть языковых школ {city}",
        "english school {city} branches",
        "разговорный клуб английского {city} школа",
        "языковые курсы {city} цены сравнение",
        "ағылшын тілі оқу орталығы {city} бағасы",
        "курсы английского для взрослых {city} филиалы",
    ],
    "ent": [
        "лучшие курсы подготовки к ЕНТ {city} рейтинг",
        "ЕНТ орталығы {city} филиалдары",
        "сеть образовательных центров ЕНТ {city}",
        "подготовка к ЕНТ {city} гарантия результата",
        "ЕНТ 130 баллов курсы {city}",
        "оқу орталығы {city} ҰБТ нәтижелері",
    ],
}


def known_names_for_city(city_ru):
    names = set()
    for path in glob.glob(os.path.join(RAW_DIR, "*.jsonl")):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("name") and (r.get("city") == city_ru or (r.get("branch_count") or 0) >= 2):
                    names.add(r["name"].strip())
    return sorted(names)


def main():
    with open(QUEUE_FILE, encoding="utf-8") as f:
        q = json.load(f)
    existing = {b["id"] for b in q["batches"]}

    entries = []
    for slug, segment in DEEPEN_PAIRS:
        bid = "%s_%s_d2" % (slug, segment)
        city_ru = ALL_CITIES[slug]
        known = known_names_for_city(city_ru)
        qlines = "\n".join('   - "%s"' % qq.format(city=city_ru)
                           for qq in DEEPEN_QUERIES[segment])
        p = PROMPT_TEMPLATE
        p = p.replace("__ID__", bid).replace("__CITY__", city_ru)
        p = p.replace("__COUNTRY__", city_country(slug)).replace("__SEGMENT__", segment)
        p = p.replace("__SEGDESC__", SEG_DESC[segment])
        p = p.replace("__QUERIES__", qlines)
        p += ("\n\nЭТО ВТОРОЙ, УГЛУБЛЯЮЩИЙ ПРОХОД. Эти школы УЖЕ в базе — встретил в выдаче "
              "→ пропусти молча, не трать на них ни запроса и не записывай:\n" +
              "; ".join(known) +
              "\nТвоя цель — НОВЫЕ крупные игроки, которых первый проход не нашёл. "
              "Если новых китов нет — честный found=0, status=\"empty\".")
        entries.append({"id": bid, "prompt": p})
        if bid not in existing:
            q["batches"].append({
                "id": bid, "city": city_ru, "city_slug": slug,
                "country": city_country(slug), "segment": segment,
                "status": "pending", "found": 0, "whales_hint": 0,
                "wa_verified": 0, "skipped_small": 0, "attempts": 0,
                "note": "углубляющий проход",
            })

    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(q, f, ensure_ascii=False, indent=1)

    js_batches = ",\n".join(
        "  { id: %s, prompt: %s }" % (json.dumps(e["id"]), json.dumps(e["prompt"], ensure_ascii=False))
        for e in entries)
    script = """export const meta = {
  name: 'lead-hunter-deepen',
  description: 'Углубляющий проход по китовым городам',
  phases: [{ title: 'Добор' }],
}
const SCHEMA = %(schema)s
const BATCHES = [
%(batches)s
]
phase('Добор')
log('Батчей: ' + BATCHES.length)
const results = await parallel(BATCHES.map(b => () =>
  agent(b.prompt, { label: b.id, phase: 'Добор', schema: SCHEMA })))
const ok = results.filter(Boolean)
const failed = BATCHES.filter((b, i) => !results[i]).map(b => b.id)
const sum = k => ok.reduce((s, r) => s + (r[k] || 0), 0)
return {
  done: ok.filter(r => r.status === 'done').map(r => r.batch_id),
  empty: ok.filter(r => r.status === 'empty').map(r => r.batch_id),
  failed,
  totals: { found: sum('found'), whales: sum('whales'),
            wa_verified: sum('wa_verified'), skipped_small: sum('skipped_small') },
  notes: ok.map(r => r.batch_id + ': ' + (r.notes || '')),
}
""" % {"schema": SCHEMA_JS, "batches": js_batches}

    out = os.path.join(WORK_DIR, "wf_deepen.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write(script)
    print(out)
    print("батчей добора: %d" % len(entries), file=sys.stderr)


if __name__ == "__main__":
    main()
