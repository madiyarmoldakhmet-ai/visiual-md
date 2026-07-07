# -*- coding: utf-8 -*-
"""Генерирует workflow «спасения телефонов» для китов без номера из карантина.

  python3 tools/gen_rescue.py
Берёт из quarantine/rejected.jsonl строки no_phone с признаками кита
(IG≥10k, или сеть, или ≥2 сигналов), пишет work/wf_rescue.js.
Агенты ищут taplink/wa.me и пишут raw/rescue.jsonl (обычная схема raw).
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import WORK_DIR, QUARANTINE_DIR

PROMPT = r'''Ты — охотник за WhatsApp-контактами крупных образовательных центров. У этих школ подтверждён масштаб, но не найден телефон. Твоя задача — найти их номер ЧЕРЕЗ ДЕТЕРМИНИРОВАННЫЙ СКРИПТ.

ШКОЛЫ (JSON): __LEADS__

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. Телефон попадает в строку ТОЛЬКО из JSON-вывода скрипта fetch_extract.py. Номер из сниппета поиска, из памяти, из пересказа WebFetch — ЗАПРЕЩЁН.
2. Не нашёл через скрипт — школу не записывай. Пустота лучше догадки.
3. Российские +79 игнорируй.

КАК ИСКАТЬ (на школу ≤4 запроса, таймбокс ~2 мин):
- WebSearch: "<instagram-handle> taplink" | "<школа> <город> wa.me" | "<школа> <город> whatsapp контакты" | "<школа> сайт"
- Кандидаты-URL (taplink.cc, linktr.ee, mssg.me, сайт школы, страница контактов) прогони ОДНИМ вызовом:
  cd "/Users/omirgaliramazan/база контактов/lead-hunter" && python3 tools/fetch_extract.py --urls "url1,url2,..." --auto-contacts
- Скрипт вернул телефон → бери phone/type/source/evidence из его вывода; source_url = URL страницы, где скрипт нашёл номер.

ЗАПИСЬ: добавь (append, НЕ перезаписывай чужие строки) в файл /Users/omirgaliramazan/база контактов/lead-hunter/raw/__CHUNK__.jsonl по одной JSON-строке на школу С НАЙДЕННЫМ телефоном. Схема строки — скопируй все поля школы из задания (batch_id, city, country, segment, name, instagram, ig_followers, branch_count, signals и пр. как было) и добавь/замени: "phone", "phone_raw", "wa_link", "wa_verified" (true только при wa-ссылке), "source", "source_url", "phone_evidence", "website" (если нашёлся собственный сайт школы — не taplink/каталог). Ничего не выдумывай сверх задания и вывода скрипта.
Верни сводку по схеме structured output.'''

SCHEMA_JS = """{
  type: 'object',
  required: ['chunk', 'processed', 'rescued'],
  properties: {
    chunk: { type: 'string' },
    processed: { type: 'integer' },
    rescued: { type: 'integer' },
    notes: { type: 'string', maxLength: 200 },
  },
}"""


def is_whale(row):
    if (row.get("ig_followers") or 0) >= 10000:
        return True
    if (row.get("branch_count") or 0) >= 2:
        return True
    sig = row.get("signals") or {}
    return sum(1 for v in sig.values() if v) >= 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk", type=int, default=4)
    args = ap.parse_args()

    path = os.path.join(QUARANTINE_DIR, "rejected.jsonl")
    whales = []
    seen = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("reason") != "no_phone":
                continue
            row = rec.get("row")
            if not row or not is_whale(row):
                continue
            key = (row.get("name"), row.get("city"))
            if key in seen:
                continue
            seen.add(key)
            whales.append(row)

    if not whales:
        print("нет китов для спасения", file=sys.stderr)
        sys.exit(1)

    tasks = []
    for i in range(0, len(whales), args.chunk):
        chunk_id = "rescue_%02d" % (i // args.chunk + 1)
        chunk = whales[i:i + args.chunk]
        payload = json.dumps(chunk, ensure_ascii=False)
        p = PROMPT.replace("__LEADS__", payload).replace("__CHUNK__", chunk_id)
        tasks.append({"label": chunk_id, "prompt": p})

    js_tasks = ",\n".join(
        "  { label: %s, prompt: %s }" % (json.dumps(t["label"]), json.dumps(t["prompt"], ensure_ascii=False))
        for t in tasks)
    script = """export const meta = {
  name: 'lead-hunter-rescue',
  description: 'Спасение телефонов IG-китов без контактов',
  phases: [{ title: 'Спасение' }],
}
const SCHEMA = %(schema)s
const TASKS = [
%(tasks)s
]
phase('Спасение')
const results = await parallel(TASKS.map(t => () =>
  agent(t.prompt, { label: t.label, phase: 'Спасение', schema: SCHEMA })))
const ok = results.filter(Boolean)
const sum = k => ok.reduce((s, r) => s + (r[k] || 0), 0)
return { chunks_ok: ok.length, chunks_failed: TASKS.length - ok.length,
         processed: sum('processed'), rescued: sum('rescued'),
         notes: ok.map(r => r.chunk + ': ' + (r.notes || '')) }
""" % {"schema": SCHEMA_JS, "tasks": js_tasks}

    out = os.path.join(WORK_DIR, "wf_rescue.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write(script)
    print(out)
    print("китов на спасение: %d, агентов: %d" % (len(whales), len(tasks)), file=sys.stderr)


if __name__ == "__main__":
    main()
