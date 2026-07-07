# -*- coding: utf-8 -*-
"""Генерирует workflow точечного обогащения: ЛПР для топ-N без имени + IG-добор.

  python3 tools/gen_enrich.py --top 150
Пишет work/wf_enrich.js (по 5 лидов на агента).
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import WORK_DIR

SCORED = os.path.join(WORK_DIR, "scored.jsonl")

PROMPT = r'''Ты — исследователь ЛПР (лиц, принимающих решения) крупных образовательных центров Казахстана/Кыргызстана. Для каждого лида найди имя основателя/директора и (если указано задание ig) число подписчиков Instagram.

ЛИДЫ (JSON): __LEADS__

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. Только реально найденные данные с конкретной страницы/сниппета ЭТОЙ сессии. Память — не источник. Не нашёл — поле null. Пустота лучше догадки.
2. Имя валидно только при однозначной привязке к ЭТОЙ школе (совпадает название и город/сфера).
3. Таймбокс — 2-3 минуты на лида, не больше. Не нашёл быстро — null и дальше.

КАК ИСКАТЬ ЛПР (на лида ≤4 запроса/фетча):
- WebSearch: "<школа>" основатель | "<школа>" директор <город> | "<школа>" founder | "<школа>" CEO интервью
- WebFetch страниц сайта: /about, /team, /o-nas, «О нас», «Команда», «Руководство»
- IG-био из сниппетов: site:instagram.com "<школа>" (в био часто «Основатель @личный_аккаунт»)
- Маркеры: Основатель, Директор, CEO, Founder, Руководитель, Негізін қалаушы
КАК ИСКАТЬ IG-ПОДПИСЧИКОВ (для лидов с "need_ig": true): только сниппеты WebSearch (instagram.com <handle> followers). Instagram напрямую не открывается.

БОНУС (если попалось по пути, НЕ ищи специально): яркий факт масштаба для hook_custom ≤12 слов (кейсы поступлений в топ-вузы, партнёрства, число филиалов) с URL-подтверждением.

ЗАПИСЬ: добавь в файл /Users/omirgaliramazan/база контактов/lead-hunter/enrich/__CHUNK__.jsonl по одной JSON-строке НА КАЖДОГО лида, где что-то найдено (лиды без находок не пиши):
{"phone":"+7... (ключ лида, копируй из задания)","lpr_name":"Имя Фамилия или null","lpr_role":"основатель|директор|... или null","lpr_instagram":"handle_без_@ или null","lpr_source":"URL где найдено","ig_followers":45000,"ig_followers_source":"serp","hook_custom":"факт ≤12 слов или null","hook_evidence":"URL или null"}
Верни сводку по схеме structured output.'''

SCHEMA_JS = """{
  type: 'object',
  required: ['chunk', 'processed', 'found_lpr', 'found_ig'],
  properties: {
    chunk: { type: 'string' },
    processed: { type: 'integer' },
    found_lpr: { type: 'integer' },
    found_ig: { type: 'integer' },
    notes: { type: 'string', maxLength: 200 },
  },
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=150)
    ap.add_argument("--chunk", type=int, default=5)
    args = ap.parse_args()

    rows = []
    with open(SCORED, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    rows.sort(key=lambda r: -r.get("scale_score", 0))
    need_lpr = [r for r in rows if not r.get("lpr_name")][:args.top]
    # IG-добор: на грани порога (2-3) без числа подписчиков — может поднять score
    need_ig_only = [r for r in rows
                    if r.get("scale_score", 0) <= 4 and not r.get("ig_followers")
                    and r.get("instagram") and r not in need_lpr][:40]

    leads = []
    for r in need_lpr:
        leads.append({"phone": r["phone"], "school": r.get("name"), "city": r.get("city"),
                      "website": r.get("website"), "instagram": r.get("instagram"),
                      "segment": r.get("segment"),
                      "need_ig": not r.get("ig_followers") and bool(r.get("instagram"))})
    for r in need_ig_only:
        leads.append({"phone": r["phone"], "school": r.get("name"), "city": r.get("city"),
                      "website": r.get("website"), "instagram": r.get("instagram"),
                      "segment": r.get("segment"), "need_ig": True, "ig_only": True})

    tasks = []
    for i in range(0, len(leads), args.chunk):
        chunk_id = "lpr_%02d" % (i // args.chunk + 1)
        payload = json.dumps(leads[i:i + args.chunk], ensure_ascii=False)
        p = PROMPT.replace("__LEADS__", payload).replace("__CHUNK__", chunk_id)
        tasks.append({"label": chunk_id, "prompt": p})

    js_tasks = ",\n".join(
        "  { label: %s, prompt: %s }" % (json.dumps(t["label"]), json.dumps(t["prompt"], ensure_ascii=False))
        for t in tasks)
    script = """export const meta = {
  name: 'lead-hunter-enrich',
  description: 'Обогащение: ЛПР по топу базы + IG-добор',
  phases: [{ title: 'Обогащение' }],
}
const SCHEMA = %(schema)s
const TASKS = [
%(tasks)s
]
phase('Обогащение')
log('Чанков: ' + TASKS.length)
const results = await parallel(TASKS.map(t => () =>
  agent(t.prompt, { label: t.label, phase: 'Обогащение', schema: SCHEMA })))
const ok = results.filter(Boolean)
const sum = k => ok.reduce((s, r) => s + (r[k] || 0), 0)
return { chunks_ok: ok.length, chunks_failed: TASKS.length - ok.length,
         processed: sum('processed'), found_lpr: sum('found_lpr'), found_ig: sum('found_ig') }
""" % {"schema": SCHEMA_JS, "tasks": js_tasks}

    out = os.path.join(WORK_DIR, "wf_enrich.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write(script)
    print(out)
    print("лидов на ЛПР: %d, на IG-добор: %d, агентов: %d" % (
        len(need_lpr), len(need_ig_only), len(tasks)), file=sys.stderr)


if __name__ == "__main__":
    main()
