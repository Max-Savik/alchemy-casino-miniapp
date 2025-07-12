#!/usr/bin/env python3
# tg_gift_bot.py — Gift-tracker для бизнес-аккаунта Telegram
# pip install "python-telegram-bot[job-queue]>=22.2"

import asyncio, json, logging, os, time
from pathlib import Path
from typing import Dict, List, Optional
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    ContextTypes,
    MessageHandler,
    filters,
)

# ─────── ENV ───────────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("GIFTS_BOT_TOKEN")               # обязательно
DATA_DIR  = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

GIFTS_JSON = DATA_DIR / "gifts.json"
BC_FILE    = DATA_DIR / "bc_id.txt"
BUSINESS_CONNECTION_ID: str | None = os.getenv("BUSINESS_CONNECTION_ID") or None

# ─────── LOG ───────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gift-bot")

# ─────── RAM-хранилище ─────────────────────────────────────────────────────
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

# ─────── вспомогательные ───────────────────────────────────────────────────
def remember_bc_id(bc: str) -> None:
    global BUSINESS_CONNECTION_ID
    if BUSINESS_CONNECTION_ID:
        return
    BUSINESS_CONNECTION_ID = bc
    BC_FILE.write_text(bc)
    log.info("captured BUSINESS_CONNECTION_ID = %s", bc)

if not BUSINESS_CONNECTION_ID and BC_FILE.exists():
    BUSINESS_CONNECTION_ID = BC_FILE.read_text().strip()

def file_id_from(obj) -> Optional[str]:
    if getattr(obj, "sticker", None):
        return obj.sticker.file_id
    if getattr(obj, "symbol", None):
        return obj.symbol.file_id
    return None

# ─────── handlers ──────────────────────────────────────────────────────────
async def on_update(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Принимает и обычные сообщения, и business_message.
    """
    msg = (
        update.message
        or getattr(update, "business_message", None) and update.business_message.message
    )
    if not msg:
        return

    # берём BC-ID
    if getattr(update, "business_connection", None):
        remember_bc_id(update.business_connection.id)
    if getattr(update, "business_message", None):
        remember_bc_id(update.business_message.business_connection_id)

    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        return                       # не подарок

    uid = str(getattr(update.effective_user, "id", "unknown"))

    gift_id = (
        getattr(gift, "unique_id", None)
        or getattr(gift, "id", None)
        or f"gift-{msg.message_id}"
    )
    owned_id = getattr(gift, "owned_gift_id", None)

    rec = {
        "gift_id":  gift_id,
        "owned_id": owned_id,
        "name":     getattr(gift, "name", None),
        "ts":       int(time.time() * 1000),
        "file_id":  file_id_from(gift),
    }

    arr = _gifts.setdefault(uid, [])
    if not any(x["owned_id"] == owned_id for x in arr):
        arr.append(rec)
        save_gifts()
        log.info("▶ realtime gift saved (uid=%s id=%s)", uid, gift_id)

# ─────── periodic sync ─────────────────────────────────────────────────────
async def sync_gifts(app) -> None:
    if not BUSINESS_CONNECTION_ID:
        return
    try:
        og = await app.bot.get_business_account_gifts(
            business_connection_id=BUSINESS_CONNECTION_ID
        )
        added = 0
        for owned in og.gifts or []:
            uid   = str(getattr(owned.from_user, "id", "unknown"))
            glist = _gifts.setdefault(uid, [])
            if any(x["owned_id"] == owned.owned_gift_id for x in glist):
                continue

            if owned.gift:                                # regular
                ginfo   = owned.gift
                gift_id = ginfo.unique_id
                file_id = ginfo.sticker.file_id if ginfo.sticker else None
            else:                                         # unique
                ginfo   = owned.unique_gift
                gift_id = ginfo.id
                file_id = ginfo.symbol.file_id if ginfo.symbol else None

            glist.append({
                "gift_id":  gift_id,
                "owned_id": owned.owned_gift_id,
                "name":     ginfo.name,
                "ts":       owned.date * 1000,
                "file_id":  file_id,
            })
            added += 1
        if added:
            save_gifts()
            log.info("⬆ synced %d gifts via getBusinessAccountGifts", added)
    except Exception as e:
        log.exception("sync error: %s", e)

# ─────── bootstrap ─────────────────────────────────────────────────────────
def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("GIFTS_BOT_TOKEN env missing")

    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(MessageHandler(filters.ALL, on_update))

    if app.job_queue:
        app.job_queue.run_repeating(
            lambda *_: asyncio.create_task(sync_gifts(app)),
            interval=60,
            first=10,
        )

    log.info("gift-bot started (BC_ID=%s)", BUSINESS_CONNECTION_ID or "—")
    app.run_polling(
        stop_signals=None,
        allowed_updates=[
            "message",
            "business_message",
            "business_connection",
            "edited_message",
        ],
    )

if __name__ == "__main__":
    main()
