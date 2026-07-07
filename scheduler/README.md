# WhatsApp Scheduler

Multi-instance WhatsApp marketing dispatch scheduler. Each instance runs as an
independent process (PM2 / Docker), paces sends through **wave-based time
windows** with per-wave quotas, applies randomized human-like intervals, and
shuts down **gracefully** (preserving in-flight state) on SIGINT/SIGTERM.

Optionally pushes **real-time Telegram alerts** on boot / shutdown / crash using
Node's native `https` module — **zero runtime npm dependencies beyond `luxon`**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    InstanceRunner                            │
│   (orchestrator — one per process / instanceId)              │
│                                                              │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│   │ WaveScheduler│  │ IntervalGen  │  │  ConfigAdapter   │  │
│   │  (waves +    │  │ (jittered    │  │ (waveSchedule[]  │  │
│   │   pauses)    │  │  delays)     │  │  → waves[])      │  │
│   └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │  TimeWindow  — daily window math (midnight-aware)    │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                              │
│   External seams (resolved relative to baseDir):             │
│   ├── core/        → WhatsAppClient  (transport interface)   │
│   ├── data/        → DataManager + Logger (persistence)      │
│   └── incoming/    → IncomingHandler (inbound router)        │
└─────────────────────────────────────────────────────────────┘
```

### Modules

| Path | Purpose |
|------|---------|
| `scheduler/InstanceRunner.js` | Main orchestrator: config load, lifecycle, send loop, signal handling, Telegram alerts |
| `scheduler/ConfigAdapter.js` | Adapts `waveSchedule[]` (real JSON format) → native `waves[]`; applies production fallback defaults |
| `scheduler/WaveScheduler.js` | Wave + pause orchestration inside the daily window; per-wave quotas |
| `scheduler/TimeWindow.js` | Daily working-window math (supports midnight crossing, e.g. 17:00→03:00) |
| `scheduler/IntervalGenerator.js` | ±N% jitter around a base interval; Promise-based `sleep()` |
| `core/index.js` | `WhatsAppClient` — async transport interface (stub ships in-repo; swap for a real client) |
| `incoming/index.js` | `IncomingHandler` — routes inbound messages / receipts / session-status signals |
| `data/DataManager.js` | Locked atomic read-modify-write persistence for contact shards + shared registry |
| `data/Logger.js` | Per-instance append-only JSON-lines logger |
| `data/safe_store.js` | Primitives: atomic JSON write, cross-process locks, temp-file sweep |

---

## Quick start

```bash
# 1. Install the single dependency
npm install

# 2. Run the end-to-end integration test (no real WhatsApp / Telegram needed)
npm test
# → node test_integration.js

# 3. Run a single dispatch instance
node scheduler/InstanceRunner.js --config configs/instance_1.json --id 1
```

---

## Configuration

Each instance loads a JSON config from `configs/instance_<id>.json`. The
**Config Adapter** accepts two equivalent wave formats:

### Format A — `waveSchedule[]` (the real JSON shipped here)

```json
{
  "instanceId": 1,
  "timezone": "Asia/Almaty",
  "telegram": { "botToken": "...", "chatId": "..." },
  "waveSchedule": [
    { "wave": 1, "startAt": "09:00", "windowMinutes": 60 },
    { "wave": 4, "startAt": "19:30", "windowMinutes": 30 }
  ]
}
```

The adapter computes absolute `end` boundaries (`start + windowMinutes`,
midnight-aware) and maps to the native format automatically.

### Format B — native `waves[]`

```json
{
  "waves": [
    { "name": "Wave 1", "start": { "hour": 9, "minute": 0 }, "end": { "hour": 10, "minute": 0 }, "messageCount": 50 }
  ]
}
```

### Production fallback defaults (applied when absent from JSON)

| Key | Default |
|-----|---------|
| `baseIntervalSec` | `540` (~9 min between sends) |
| `messageTemplate` | `'Hello {name}'` |
| `randomizationPercent` | `20` |
| `totalInstances` | `5` |
| `timezone` | `'Asia/Almaty'` |
| `messageCount` (per wave) | `50` |

### Message template placeholders

`{name}` · `{phone}` · `{id}` — substituted per recipient at send time.

---

## Telegram alerts

When `telegram.botToken` and `telegram.chatId` are present in the config,
`InstanceRunner` pushes notifications via the **native `https` module**
(no `node-telegram-bot-api`, no `axios`):

- 🟢 **boot** — instance started, N waves loaded
- 🛑 **shutdown** — graceful shutdown initiated (reason included)
- 🔴 **crash** — fatal error (message included)
- ✅ **cycle** — send cycle completed naturally

The alert call is fire-and-forget with a 5 s timeout; it never blocks the
dispatch loop or the shutdown path.

> ⚠️ **Security**: the committed `configs/instance_*.json` ship with **empty**
> `botToken` / `chatId`. Fill them in your local copy (`configs/instance_*.json.local`,
> gitignored) or via environment variables. See [`.env.example`](./.env.example).

---

## Graceful shutdown

`SIGINT` / `SIGTERM` flip `isRunning = false`. The send loop checks this flag
at the **top of every iteration** and after every sleep slice, so:

- An **in-flight `sendMessage()` is never truncated** — shutdown waits for the
  current dispatch to drain (bounded by `INSTANCE_RUNNER_DRAIN_TIMEOUT_MS`).
- The **cursor** ("final index position") is atomically persisted so a restart
  resumes without redelivering messages.

On clean teardown the contract line is printed exactly once:
```
[Agent 1] Successfully disengaged gracefully without loss of state
```

---

## Integration test

`test_integration.js` exercises the full pipeline against the real
`configs/instance_1.json`:

1. **STEP 1** — verifies `ConfigAdapter.adapt()` maps `waveSchedule[]` → `waves[]`
   and applies all fallback defaults.
2. **STEP 2** — synthesizes a time-compressed config around "now" (in the same
   `waveSchedule[]` format) so the cycle can run at any wall-clock time.
3. **STEP 3** — runs the live cycle through the real `core/`, `incoming/`, and
   `data/` subsystems, then triggers a watchdog-driven graceful shutdown.

The test **snapshots and restores** the production shard / cursor / registry /
log, so it is fully idempotent and never permanently mutates real data.

---

## License

MIT
