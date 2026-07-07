# -*- coding: utf-8 -*-
"""Генерация WhatsApp-сообщений и gold top-100 из leads_database.csv.

Шаблоны из ТЗ; hook вплетается бесшовно, при пустом hook фраза опускается.
Пишет leads_messages.csv и leads_gold_top100.csv (utf-8-sig).
"""

import csv
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import PROJECT_DIR, MSG_COLUMNS, LPR_PRIORITY, GOLD_CITIES

DB_FILE = os.path.join(PROJECT_DIR, "leads_database.csv")
MSG_FILE = os.path.join(PROJECT_DIR, "leads_messages.csv")
GOLD_FILE = os.path.join(PROJECT_DIR, "leads_gold_top100.csv")

TEMPLATES = {
    "abroad": {
        "named": ("Ассалаумағалейкум, {name}! Увидел, что {school} готовит к поступлению "
                  "за рубеж. {hook}Один вопрос — за сколько минут ваши менеджеры отвечают "
                  "на заявки с сайта и инстаграма? Мы подключаем сильным центрам подготовки "
                  "AI-ассистента, который отвечает за 3 секунды и не теряет ночные и выходные "
                  "заявки. Могу показать, как работает, за 5 минут."),
        "anon": ("Ассалаумағалейкум! Увидел, что {school} готовит к поступлению за рубеж. "
                 "Один вопрос — за сколько минут ваши менеджеры отвечают на заявки с сайта "
                 "и инстаграма? Мы подключаем сильным центрам подготовки AI-ассистента, "
                 "который отвечает за 3 секунды и не теряет ночные и выходные заявки. "
                 "Могу показать, как работает, за 5 минут."),
    },
    "ielts": {
        "named": ("Сәлеметсіз бе, {name}! Вижу, что {school} готовит к IELTS. {hook}"
                  "Вопрос — что происходит с заявками, которые приходят после рабочего дня? "
                  "Мы делаем AI-ассистента, который отвечает за 3 секунды и сам записывает "
                  "на пробный урок. Есть пара минут — покажу, как работает?"),
        "anon": ("Сәлеметсіз бе! Вижу, что {school} готовит к IELTS. Вопрос — что происходит "
                 "с заявками, которые приходят после рабочего дня? Мы делаем AI-ассистента, "
                 "который отвечает за 3 секунды и сам записывает на пробный урок. "
                 "Есть пара минут — покажу, как работает?"),
    },
    "ent": {
        "named": ("Сәлем, {name}! {school} готовит к ЕНТ — значит, в сезон у вас шквал "
                  "заявок. {hook}Крупные центры теряют до 60% лидов, потому что не успевают "
                  "отвечать. Наш AI-ассистент отвечает мгновенно, на казахском и русском. "
                  "Показать?"),
        "anon": ("Сәлем! {school} готовит к ЕНТ — значит, в сезон у вас шквал заявок. "
                 "Крупные центры теряют до 60% лидов, потому что не успевают отвечать. "
                 "Наш AI-ассистент отвечает мгновенно, на казахском и русском. Показать?"),
    },
    "other": {
        "named": ("Сәлеметсіз бе, {name}! Видел {school}. {hook}Вопрос — за сколько минут "
                  "ваши менеджеры отвечают на заявки из инстаграма и WhatsApp? Мы подключаем "
                  "образовательным центрам AI-ассистента, который отвечает за 3 секунды, 24/7, "
                  "на казахском и русском, и сам записывает на пробное занятие. Показать за 5 минут?"),
        "anon": ("Сәлеметсіз бе! Видел {school}. Вопрос — за сколько минут ваши менеджеры "
                 "отвечают на заявки из инстаграма и WhatsApp? Мы подключаем образовательным "
                 "центрам AI-ассистента, который отвечает за 3 секунды, 24/7, на казахском и "
                 "русском, и сам записывает на пробное занятие. Показать за 5 минут?"),
    },
}


PATRONYMIC_RE = re.compile(r"(вич|вна|ұлы|улы|қызы|кызы|тегі)$", re.I)
SURNAME_RE = re.compile(r"(ов|ев|ёв|ова|ева|ин|ина|ский|ская)$", re.I)


def first_name(full):
    """Первое ИМЯ. Учитывает порядок «Фамилия Имя Отчество» и инициалы."""
    full = (full or "").strip()
    if not full:
        return ""
    tokens = full.split()
    if len(tokens) == 1:
        return tokens[0]
    # только инициалы после первого слова (Бейсембетов И.К.) — имени нет
    if all(("." in t or len(t.rstrip(".")) <= 1) for t in tokens[1:]):
        return ""
    # Фамилия Имя Отчество: последний токен — отчество → имя посередине
    if len(tokens) >= 3 and PATRONYMIC_RE.search(tokens[-1]):
        return tokens[1]
    # Фамилия Имя: первый токен — фамильная форма
    if len(tokens) == 2 and SURNAME_RE.search(tokens[0]):
        return tokens[1]
    return tokens[0]


def build_message(row):
    seg = row["segment"]
    name = first_name(row["lpr_name"])
    # финальная пунктуация в названии («Молодец!», «Гений.») ломает шаблон — снимаем
    school = (row["school_name"] or "").strip().rstrip(" !?.,;:")
    hook = (row["hook"] or "").strip().rstrip(".")
    if name and row["lpr_status"] in ("A", "B"):
        hook_part = (hook[0].upper() + hook[1:] + ". ") if hook else ""
        msg = TEMPLATES[seg]["named"].format(name=name, school=school, hook=hook_part)
    else:
        msg = TEMPLATES[seg]["anon"].format(school=school)
    msg = re.sub(r"\s{2,}", " ", msg).strip()
    return msg


def gold_key(r):
    return (
        -int(r["scale_score"]),
        LPR_PRIORITY[r["lpr_status"]],
        0 if r["wa_verified"] == "true" else 1,
        0 if r["segment"] == "abroad" else 1,
        0 if r["city"] in GOLD_CITIES else 1,
    )


def main():
    with open(DB_FILE, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    out = []
    for r in rows:
        out.append({
            "phone_whatsapp": r["phone_whatsapp"],
            "school_name": r["school_name"],
            "lpr_name": first_name(r["lpr_name"]),
            "segment": r["segment"],
            "city": r["city"],
            "lpr_status": r["lpr_status"],
            "scale_score": r["scale_score"],
            "tier": r.get("tier", "base"),
            "message": build_message(r),
            "wa_verified": r["wa_verified"],  # для gold-каскада, в CSV не пишется
        })

    with open(MSG_FILE, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=MSG_COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(out)

    gold = sorted(out, key=gold_key)[:100]
    with open(GOLD_FILE, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=MSG_COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(gold)

    print(json.dumps({
        "messages": len(out), "gold": len(gold),
        "max_len": max((len(r["message"]) for r in out), default=0),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
