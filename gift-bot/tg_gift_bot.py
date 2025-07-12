#!/usr/bin/env python3
# tg_gift_bot.py — Gift-tracker для бизнес-аккаунта
# pip install "python-telegram-bot[job-queue]>=22.2"

import asyncio, json, logging, os, time
from pathlib import Path
from typing import Dict, List, Optional

from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, TypeHandler

# ─── ENV / paths ───────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("GIFTS_BOT_TOKEN")
DATA_DIR  = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

GIFTS_JSON = DATA_DIR / "gifts.json"
BC_FILE    = DATA_DIR / "bc_id.txt"
BUSINESS_CONNECTION_ID: str | None = os.getenv("BUSINESS_CONNECTION_ID") or None

# ─── logging ───────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gift-bot")

# ─── runtime storage ───────────────────────────────────────────────────────
_gifts: Dict[str, List[dict]] = {}
if GIFTS_JSON.exists():
    try:
        _gifts = json.loads(GIFTS_JSON.read_text("utf-8"))
    except Exception as e:
        log.warning("can't read gifts.json: %s", e)

def save_gifts() -> None:
    tmp = GIFTS_JSON.with_suffix(".tmp")
    tmp.write_text(json.dumps(_gifts, ensure_ascii=False, indent=2))
    tmp.replace(GIFTS_JSON)

# ─── helpers ───────────────────────────────────────────────────────────────
def remember_bc_id(bc: str) -> None:
    global BUSINESS_CONNECTION_ID
    if BUSINESS_CONNECTION_ID:
        return
    BUSINESS_CONNECTION_ID = bc
    BC_FILE.write_text(bc)
    log.info("captured BUSINESS_CONNECTION_ID = %s", bc)

if not BUSINESS_CONNECTION_ID and BC_FILE.exists():
    BUSINESS_CONNECTION_ID = BC_FILE.read_text().strip() or None

def file_id_from(obj) -> Optional[str]:
    return (
        getattr(obj, "sticker", None) and obj.sticker.file_id
        or getattr(obj, "symbol",  None) and obj.symbol.file_id
    )

# ─── main update handler ───────────────────────────────────────────────────
async def on_update(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Ловим ВСЕ Update-ы и выдёргиваем подарки."""

    # 1️⃣  Business-connection ID
    if update.business_connection:
        remember_bc_id(update.business_connection.id)

    # 2️⃣  Сообщения бизнес-аккаунта (plural!)
    biz_msgs = getattr(update, "business_messages", None)
    if biz_msgs:                                 # список Message
        for m in biz_msgs:
            await handle_message(m)

    # 3️⃣  Обычные личные сообщения (если разрешены privacy-настройками)
    if update.message:
        await handle_message(update.message)

async def handle_message(msg) -> None:
    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        return

    uid      = str(msg.from_user.id) if msg.from_user else "unknown"
    owned_id = getattr(gift, "owned_gift_id", None)
    gift_id  = getattr(gift, "unique_id", None) or getattr(gift, "id", None)

    entry = {
        "gift_id":  gift_id,
        "owned_id": owned_id,
        "name":     getattr(gift, "name", None),
        "ts":       int(time.time() * 1000),
        "file_id":  file_id_from(gift),
    }

    lst = _gifts.setdefault(uid, [])
    if not any(x["owned_id"] == owned_id for x in lst):
        lst.append(entry)
        save_gifts()
        log.info("▶ realtime gift (uid=%s id=%s)", uid, gift_id)

# ─── periodic REST sync ────────────────────────────────────────────────────
async def sync_gifts(app) -> None:
    if not BUSINESS_CONNECTION_ID:
        return
    try:
        og = await app.bot.get_business_account_gifts(
            business_connection_id=BUSINESS_CONNECTION_ID, limit=1000
        )
        added = 0
        for owned in og.gifts or []:
            uid   = str(getattr(owned.from_user, "id", "unknown"))
            lst   = _gifts.setdefault(uid, [])
            if any(x["owned_id"] == owned.owned_gift_id for x in lst):
                continue

            if owned.gift:                       # regular
                g = owned.gift
                gift_id = g.unique_id
                name    = g.name
                file_id = g.sticker.file_id if g.sticker else None
            else:                                # unique
                g = owned.unique_gift
                gift_id = g.id
                name    = g.name
                file_id = g.symbol.file_id if g.symbol else None

            lst.append({
                "gift_id":  gift_id,
                "owned_id": owned.owned_gift_id,
                "name":     name,
                "ts":       owned.date * 1000,
                "file_id":  file_id,
            })
            added += 1

        if added:
            save_gifts()
            log.info("⬆ synced %d gifts via REST", added)

    except Exception as e:
        log.exception("sync error: %s", e)

# ─── bootstrap ─────────────────────────────────────────────────────────────
def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("GIFTS_BOT_TOKEN env missing")

    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(TypeHandler(Update, on_update))

    # фоновой REST-синк
    app.job_queue.run_repeating(
        lambda *_: asyncio.create_task(sync_gifts(app)),
        interval=60, first=10,
    )

    log.info("gift-bot started (BC_ID=%s)", BUSINESS_CONNECTION_ID or "—")
    # ⚠️  allowed_updates НЕ задаём → Telegram шлёт все типы, в т.ч. business_messages
    app.run_polling(stop_signals=None)

if __name__ == "__main__":
    main()
