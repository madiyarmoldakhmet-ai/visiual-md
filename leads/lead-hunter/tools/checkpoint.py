# -*- coding: utf-8 -*-
"""Чекпоинты: queue.json + STATUS.md. Истина — в файлах raw/ и state/.

Команды:
  python3 tools/checkpoint.py init                # создать queue.json (51 батч)
  python3 tools/checkpoint.py pending [--wave X]  # JSON-список незакрытых батчей волны
  python3 tools/checkpoint.py sync                # сканировать файлы -> queue.json + STATUS.md
"""

import argparse
import json
import os
import re
import sys
import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (WAVES, ALL_CITIES, QUEUE_FILE, STATUS_FILE, RAW_DIR,
                    STATE_DIR, city_country)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import normalize_phone

TERMINAL = {"done", "empty", "failed_final"}


def load_queue():
    with open(QUEUE_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_queue(q):
    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(q, f, ensure_ascii=False, indent=1)


def cmd_init():
    batches = []
    for segment, order in WAVES:
        for slug in order:
            batches.append({
                "id": "%s_%s" % (slug, segment),
                "city": ALL_CITIES[slug],
                "city_slug": slug,
                "country": city_country(slug),
                "segment": segment,
                "status": "pending",
                "found": 0, "whales_hint": 0, "wa_verified": 0,
                "skipped_small": 0, "attempts": 0, "note": "",
            })
    save_queue({"batches": batches})
    print("queue.json: %d батчей" % len(batches))


def validate_jsonl(path):
    """Проверка raw-файла: (валидных строк, ошибок[])."""
    ok, errors = 0, []
    if not os.path.exists(path):
        return 0, []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                errors.append("строка %d: не JSON" % i)
                continue
            phone = row.get("phone")
            if phone:
                norm, _ = normalize_phone(phone)
                if norm != phone:
                    errors.append("строка %d: телефон %r не нормализован" % (i, phone))
                    continue
                if not row.get("source_url"):
                    errors.append("строка %d: телефон без source_url" % i)
                    continue
                if row.get("wa_verified") and not row.get("wa_link"):
                    errors.append("строка %d: wa_verified без wa_link" % i)
                    continue
            ok += 1
    return ok, errors


def cmd_sync():
    q = load_queue()
    for b in q["batches"]:
        bid = b["id"]
        done_path = os.path.join(STATE_DIR, bid + ".done.json")
        raw_path = os.path.join(RAW_DIR, bid + ".jsonl")
        if not os.path.exists(done_path):
            if b["status"] not in ("pending", "failed", "failed_final"):
                b["status"] = "pending"
            continue
        try:
            with open(done_path, encoding="utf-8") as f:
                summary = json.load(f)
        except ValueError:
            b["status"] = "invalid"
            b["note"] = "битый done.json"
            continue
        ok_rows, errors = validate_jsonl(raw_path)
        if errors:
            b["status"] = "invalid"
            b["note"] = "; ".join(errors[:3])
            b["found"] = ok_rows
            continue
        b["found"] = ok_rows
        b["wa_verified"] = summary.get("wa_verified", 0)
        b["whales_hint"] = summary.get("whales", 0)
        b["skipped_small"] = summary.get("skipped_small", 0)
        b["note"] = (summary.get("notes") or "")[:200]
        b["status"] = "empty" if ok_rows == 0 else "done"
    save_queue(q)
    write_status(q)
    totals = summarize(q)
    print(json.dumps(totals, ensure_ascii=False))


def summarize(q):
    st = {}
    for b in q["batches"]:
        st[b["status"]] = st.get(b["status"], 0) + 1
    return {
        "statuses": st,
        "total_rows": sum(b["found"] for b in q["batches"]),
        "wa_verified": sum(b["wa_verified"] for b in q["batches"]),
        "skipped_small": sum(b["skipped_small"] for b in q["batches"]),
        "batches_total": len(q["batches"]),
        "batches_closed": sum(1 for b in q["batches"] if b["status"] in TERMINAL),
    }


def write_status(q):
    t = summarize(q)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        "# STATUS — Lead Hunter (Whale Edition)",
        "Обновлено: %s" % now,
        "",
        "## Прогресс: %d/%d батчей закрыто" % (t["batches_closed"], t["batches_total"]),
        "Сырых строк собрано: %d · wa_verified: %d · отсеяно мелочи на сборе: %d" % (
            t["total_rows"], t["wa_verified"], t["skipped_small"]),
        "",
        "| Батч | Статус | Строк | wa_verified | Отсеяно мелочи | Заметка |",
        "|---|---|---|---|---|---|",
    ]
    for b in q["batches"]:
        note = (b.get("note") or "").replace("|", "/")[:80]
        lines.append("| %s | %s | %d | %d | %d | %s |" % (
            b["id"], b["status"], b["found"], b["wa_verified"], b["skipped_small"], note))
    with open(STATUS_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def cmd_pending(wave):
    q = load_queue()
    out = []
    for b in q["batches"]:
        if wave and b["segment"] != wave:
            continue
        if b["status"] in TERMINAL:
            continue
        out.append({"id": b["id"], "city": b["city"], "country": b["country"],
                    "segment": b["segment"], "status": b["status"]})
    print(json.dumps(out, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["init", "pending", "sync"])
    ap.add_argument("--wave", choices=["abroad", "ielts", "ent"])
    args = ap.parse_args()
    if args.cmd == "init":
        cmd_init()
    elif args.cmd == "pending":
        cmd_pending(args.wave)
    else:
        cmd_sync()


if __name__ == "__main__":
    main()
