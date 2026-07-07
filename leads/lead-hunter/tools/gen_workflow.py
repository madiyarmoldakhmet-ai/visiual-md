# -*- coding: utf-8 -*-
"""Генерирует JS-скрипт Workflow для волны сбора из queue.json.

  python3 tools/gen_workflow.py --wave abroad            # все незакрытые батчи волны
  python3 tools/gen_workflow.py --ids almaty_abroad,bishkek_ielts --name pilot

Пишет work/wf_<name>.js и печатает путь.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import QUERIES, QUEUE_FILE, WORK_DIR, PROJECT_DIR

TERMINAL = {"done", "empty", "failed_final"}

SEG_DESC = {
    "abroad": "подготовка к поступлению за рубеж (SAT, гранты, консалтинг) — самый платёжеспособный сегмент",
    "ielts": "языковые школы, IELTS/TOEFL/английский",
    "ent": "подготовка к ЕНТ/ҰБТ — брать ТОЛЬКО сетевые/масштабные центры, рынок кишит одиночками",
}

PROMPT_TEMPLATE = r'''Ты — сборщик базы КРУПНЫХ образовательных центров для B2B-продаж дорогого продукта (AI-продажник, чек 700 000+ тг). Мелкие школы и репетиторы бесполезны — нужен только масштаб.

БАТЧ: город __CITY__ (__COUNTRY__), сегмент __SEGMENT__ — __SEGDESC__.
ПРОЕКТ: /Users/omirgaliramazan/база контактов/lead-hunter (дальше — PROJECT)

ШАГ 0 — ИДЕМПОТЕНТНОСТЬ. Выполни: cat "PROJECT/state/__ID__.done.json" (подставь полный путь). Если файл существует и это валидный JSON — верни его содержимое как свой результат и НЕМЕДЛЕННО закончи, ничего больше не делая.

ЖЕЛЕЗНЫЕ ПРАВИЛА (нарушение = отравленная база):
1. Телефоны и wa-ссылки попадают в строку ТОЛЬКО копированием из JSON-вывода скрипта fetch_extract.py. ЗАПРЕЩЕНО брать номер из сниппета поиска, из памяти, из WebFetch-пересказа. Увидел номер в сниппете — прогони сайт через скрипт; скрипт номер не нашёл — телефона нет.
2. Каждое непустое поле подтверждено конкретной страницей/сниппетом ЭТОЙ сессии. Нет подтверждения — null. Пустое поле — нормальный результат; выдуманное — провал миссии.
3. Ты можешь «помнить» эти школы из обучения. Память — НЕ источник. Только сегодняшний вывод поиска/скрипта/страницы.
4. Мелочь НЕ записывай, только посчитай в skipped_small. Мелочь: репетитор-одиночка, «частный преподаватель», «на дому», ИП без бренда, личный IG <2k подписчиков без других сигналов, нет ни сайта, ни бизнес-Instagram.
5. Российские номера +79... игнорируй полностью.

БЮДЖЕТ (жёсткий): ≤8 WebSearch; ≤2 запуска fetch_extract.py (суммарно ≤15 URL); ≤5 WebFetch; ≤25 строк в выход; ≤3 поиска ЛПР. С недоступным сайтом не воюй дольше 2 попыток — пропусти.

ПЛАН:
1. Прогони через WebSearch запросы (можно слегка варьировать, город обязателен):
__QUERIES__
   Из выдачи собери кандидатов: название, сайт, IG-handle, признаки масштаба из сниппетов. Каталоги (2gis, zoon, satu, olx, kursy-*) — не сайт школы, но названия/сайты школ из их сниппетов бери. Приоритет тем, кто пахнет масштабом: «филиалы», «сеть», большая аудитория, реклама в выдаче.
2. Собери URL кандидатов (главные страницы; плюс taplink.cc/linktr.ee из IG-био — они отлично парсятся) и запусти ОДНИМ вызовом:
   cd "/Users/omirgaliramazan/база контактов/lead-hunter" && python3 tools/fetch_extract.py --urls "url1,url2,url3" --auto-contacts
   Вывод: по каждому URL телефоны (нормализованные, с type mobile/landline, source, evidence-цитатой), wa-ссылки, instagram, email, маркеры масштаба (branches/team/age/official/infra с цитатами), пиксели рекламы (meta_pixel/google_tag). Скрипт сам дофетчит страницы контактов того же домена.
3. Для 3-7 кандидатов с сильными, но неподтверждёнными сигналами — WebFetch страницы «О нас»/«Команда»/«Филиалы»: число филиалов, размер команды, год основания, официальные статусы, имя основателя. (WebFetch годится для ФАКТОВ о масштабе и именах, но НЕ для телефонов.)
4. IG-подписчики — ключевой сигнал масштаба. Бери ТОЛЬКО из сниппетов WebSearch (запросы вида: instagram.com <handle> followers, либо site:instagram.com "<школа>"). Instagram напрямую не открывается — не трать попытки. Нет числа — ig_followers=null (не гадай).
4a. Если крупный кандидат (10k+ IG или сеть) живёт только в Instagram без сайта — поищи его линк-страницу: WebSearch "<handle> taplink" или "<школа> <город> wa.me". Найденный taplink.cc/linktr.ee/mssg.me прогони через fetch_extract.py — там почти всегда wa.me. Строку БЕЗ телефона пиши только для подтверждённого кита (сеть или 10k+ IG) — такие добьём отдельной фазой; для остальных без телефона строку не пиши.
5. Сигналы масштаба (signals.*=true только при evidence):
   - network: ≥2 филиала или города (заполни branch_count числом)
   - ads: meta_pixel=true или google_tag=true из вывода скрипта, либо явные следы таргета/лендинга с «оставьте заявку»
   - team: страница команды, несколько менеджеров, вакансии продажников
   - age: ≥5 лет на рынке (заполни founded_year), или 100+ отзывов (заполни google_reviews), или тысячи выпускников
   - official: лицензия/аккредитация/официальный партнёр или экзаменационный центр (British Council, Cambridge, IDP, ICEF...). ВАЖНО: сертификаты CELTA/DELTA у отдельных преподавателей — это НЕ official.
   - infra: многостраничный собственный сайт, LMS/онлайн-платформа, своё здание/кампус
6. ЛПР — только для очевидных китов (видна сеть филиалов или 30k+ IG), максимум 3: страница «О нас»/«Команда», поиск «"<школа>" основатель» / «"<школа>" директор», IG-био из сниппетов. Только реально найденное имя; должность в lpr_role; lpr_source=URL.
7. SELF-CHECK каждой строки перед записью: телефон скопирован из вывода скрипта? source_url — та страница, где скрипт нашёл номер? wa_verified=true только если есть wa_link? website — собственный домен школы (не каталог/соцсеть/taplink), иначе null? segment по приоритету abroad>ielts>ent (школа делает и abroad и ielts → abroad)? у каждого signals=true есть evidence? Поле без подтверждения — обнули.
8. Запиши файл PROJECT/raw/__ID__.jsonl — по одной JSON-строке на школу (БЕЗ переносов внутри объекта), схема ниже. Если строк нет — файл не создавай.
9. Запиши PROJECT/state/__ID__.done.json со сводкой (схема твоего ответа) и верни ту же сводку.

СХЕМА строки raw jsonl (null для ненайденного, никаких лишних полей):
{"batch_id":"__ID__","city":"__CITY__","country":"__COUNTRY__","segment":"__SEGMENT__","name":"название без ТОО/ИП","website":"https://... или null","instagram":"handle_без_@ или null","phone":"+77XXXXXXXXX из скрипта","phone_raw":"как в выводе скрипта","wa_link":"https://wa.me/... или null","wa_verified":true,"source":"wa_link|tel_link|site_text|catalog","source_url":"https://страница-с-номером","phone_evidence":"цитата из вывода скрипта","extra_phones":["+7..."],"email":null,"ig_followers":25000,"ig_followers_source":"serp","branch_count":3,"branches_evidence":"url: цитата","team_size":null,"founded_year":2004,"official_status":"официальный партнёр IDP или null","google_rating":4.9,"google_reviews":127,"signals":{"network":true,"ads":false,"team":false,"age":true,"official":false,"infra":true},"signals_evidence":["url: цитата"],"lpr_name":null,"lpr_role":null,"lpr_instagram":null,"lpr_source":null,"hook_custom":"конкретный факт масштаба ≤12 слов или null","hook_evidence":null,"collected_at":"2026-07-06"}

whale для сводки = network, или ig_followers≥10000, или ≥2 сигналов true.
Если кандидатов нет или все — мелочь: raw-файл не создавай, в done.json запиши found=0, status="empty", в notes — почему пусто. Это валидный результат, не растягивай поиск.
Твой финальный ответ — ТОЛЬКО JSON-сводка по схеме structured output.'''

SCHEMA_JS = """{
  type: 'object',
  required: ['batch_id', 'status', 'found', 'whales', 'wa_verified', 'skipped_small', 'notes'],
  properties: {
    batch_id: { type: 'string' },
    status: { enum: ['done', 'empty', 'partial'] },
    found: { type: 'integer' },
    whales: { type: 'integer' },
    wa_verified: { type: 'integer' },
    with_lpr: { type: 'integer' },
    skipped_small: { type: 'integer' },
    top3: { type: 'array', maxItems: 3, items: { type: 'string' } },
    notes: { type: 'string', maxLength: 300 },
  },
}"""


def build_prompt(batch):
    queries = QUERIES[batch["segment"]]
    qlines = "\n".join('   - "%s"' % q.format(city=batch["city"]) for q in queries)
    p = PROMPT_TEMPLATE
    p = p.replace("__ID__", batch["id"]).replace("__CITY__", batch["city"])
    p = p.replace("__COUNTRY__", batch["country"]).replace("__SEGMENT__", batch["segment"])
    p = p.replace("__SEGDESC__", SEG_DESC[batch["segment"]])
    p = p.replace("__QUERIES__", qlines)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wave", choices=["abroad", "ielts", "ent"])
    ap.add_argument("--ids", help="явный список batch_id через запятую")
    ap.add_argument("--name", help="имя workflow (по умолчанию = wave)")
    args = ap.parse_args()

    with open(QUEUE_FILE, encoding="utf-8") as f:
        q = json.load(f)
    batches = []
    want_ids = set(args.ids.split(",")) if args.ids else None
    for b in q["batches"]:
        if want_ids is not None:
            if b["id"] in want_ids:
                batches.append(b)
        elif args.wave and b["segment"] == args.wave and b["status"] not in TERMINAL:
            batches.append(b)
    if not batches:
        print("нет батчей для генерации", file=sys.stderr)
        sys.exit(1)

    name = args.name or (args.wave or "custom")
    entries = []
    for b in batches:
        entries.append({"id": b["id"], "prompt": build_prompt(b)})

    js_batches = ",\n".join(
        "  { id: %s, prompt: %s }" % (json.dumps(e["id"]), json.dumps(e["prompt"], ensure_ascii=False))
        for e in entries)

    script = """export const meta = {
  name: 'lead-hunter-%(name)s',
  description: 'Сбор батчей (%(name)s): крупные образовательные центры KZ/KG',
  phases: [{ title: 'Сбор' }],
}
const SCHEMA = %(schema)s
const BATCHES = [
%(batches)s
]
phase('Сбор')
log('Батчей: ' + BATCHES.length)
const results = await parallel(BATCHES.map(b => () =>
  agent(b.prompt, { label: b.id, phase: 'Сбор', schema: SCHEMA })))
const ok = results.filter(Boolean)
const failed = BATCHES.filter((b, i) => !results[i]).map(b => b.id)
const sum = k => ok.reduce((s, r) => s + (r[k] || 0), 0)
return {
  done: ok.filter(r => r.status === 'done').map(r => r.batch_id),
  empty: ok.filter(r => r.status === 'empty').map(r => r.batch_id),
  partial: ok.filter(r => r.status === 'partial').map(r => r.batch_id),
  failed,
  totals: { found: sum('found'), whales: sum('whales'),
            wa_verified: sum('wa_verified'), skipped_small: sum('skipped_small') },
  notes: ok.map(r => r.batch_id + ': ' + (r.notes || '')),
}
""" % {"name": name, "schema": SCHEMA_JS, "batches": js_batches}

    out_path = os.path.join(WORK_DIR, "wf_%s.js" % name)
    os.makedirs(WORK_DIR, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(script)
    print(out_path)
    print("батчей: %d" % len(batches), file=sys.stderr)


if __name__ == "__main__":
    main()
