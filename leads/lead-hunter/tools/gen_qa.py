# -*- coding: utf-8 -*-
"""Генерирует workflow QA-верификации: N случайных строк базы, проверка source_url.

  python3 tools/gen_qa.py --n 20
Пишет work/wf_qa.js (по 2 строки на агента).
"""

import argparse
import csv
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import PROJECT_DIR, WORK_DIR

DB_FILE = os.path.join(PROJECT_DIR, "leads_database.csv")

PROMPT = r'''Ты — QA-верификатор базы контактов. Проверь, что телефоны реально присутствуют на страницах-источниках.

Строки для проверки (JSON): __ROWS__

Для КАЖДОЙ строки:
1. Загрузи source_url. Сначала детерминированно:
   cd "/Users/omirgaliramazan/база контактов/lead-hunter" && python3 tools/fetch_extract.py --urls "<source_url>"
   Если скрипт вернул этот телефон (поле phone совпадает) — verdict="pass".
2. Если скрипт не нашёл или страница не отдалась — попробуй WebFetch того же URL с вопросом, какие телефоны/WhatsApp указаны на странице. Совпадение цифр номера (форматирование не важно: +7 777 216 67 89 == +77772166789) — verdict="pass".
3. Страница не открывается совсем (обе попытки) — verdict="page_dead".
4. Страница открылась, но номера там нет — verdict="fail".
Не засчитывай pass по памяти или догадке — только по реальному содержимому страницы этой сессии.
Верни JSON-массив вердиктов по схеме structured output.'''

SCHEMA_JS = """{
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['phone', 'verdict'],
        properties: {
          phone: { type: 'string' },
          verdict: { enum: ['pass', 'fail', 'page_dead'] },
          note: { type: 'string', maxLength: 150 },
        },
      },
    },
  },
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--batch-rows", type=int, default=2)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    with open(DB_FILE, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    random.seed(args.seed)
    random.shuffle(rows)
    # стратификация по сегментам
    by_seg = {}
    for r in rows:
        by_seg.setdefault(r["segment"], []).append(r)
    picked = []
    quota = max(1, args.n // max(1, len(by_seg)))
    for seg in by_seg:
        picked.extend(by_seg[seg][:quota])
    for r in rows:
        if len(picked) >= args.n:
            break
        if r not in picked:
            picked.append(r)
    picked = picked[:args.n]

    tasks = []
    for i in range(0, len(picked), args.batch_rows):
        chunk = picked[i:i + args.batch_rows]
        payload = json.dumps([{"phone": r["phone_whatsapp"], "school": r["school_name"],
                               "source_url": r["source_url"]} for r in chunk],
                             ensure_ascii=False)
        tasks.append({"label": "qa_%d" % (i // args.batch_rows + 1),
                      "prompt": PROMPT.replace("__ROWS__", payload)})

    js_tasks = ",\n".join(
        "  { label: %s, prompt: %s }" % (json.dumps(t["label"]), json.dumps(t["prompt"], ensure_ascii=False))
        for t in tasks)
    script = """export const meta = {
  name: 'lead-hunter-qa',
  description: 'QA: выборочная сверка телефонов с source_url',
  phases: [{ title: 'QA' }],
}
const SCHEMA = %(schema)s
const TASKS = [
%(tasks)s
]
phase('QA')
const results = await parallel(TASKS.map(t => () =>
  agent(t.prompt, { label: t.label, phase: 'QA', schema: SCHEMA })))
const verdicts = results.filter(Boolean).flatMap(r => r.verdicts)
const count = v => verdicts.filter(x => x.verdict === v).length
return { total: verdicts.length, pass: count('pass'), fail: count('fail'),
         page_dead: count('page_dead'),
         failures: verdicts.filter(x => x.verdict !== 'pass') }
""" % {"schema": SCHEMA_JS, "tasks": js_tasks}

    out = os.path.join(WORK_DIR, "wf_qa.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write(script)
    print(out)
    print("строк на проверку: %d, агентов: %d" % (len(picked), len(tasks)), file=sys.stderr)


if __name__ == "__main__":
    main()
