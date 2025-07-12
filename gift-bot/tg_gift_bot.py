#!/usr/bin/env python3
# tg_gift_bot.py  –  Gift-tracker для Telegram-Business-аккаунта
# ------------------------------------------------------------------
#  • Реaltime:   Update.business_message → message.{gift|unique_gift}
#  • Fallback:   getBusinessAccountGifts раз в 60 с
#  • Данные:     DATA_DIR/gifts.json  (+ bc_id.txt для BC-ID)
#
# ENV:
#   GIFTS_BOT_TOKEN
#   DATA_DIR=/data
#   BUSINESS_CONNECTION_ID   (необязательно)
#
# pip install "python-telegram-bot[job-queue]>=22.2"
# ------------------------------------------------------------------

import asyncio, json, logging, os, time
from pathlib import Path
from typing import Dict, List, Optional

from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    ContextTypes,
    TypeHandler,        # даёт все Update-ы как есть
)

# ──────── конфиг ───────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("GIFTS_BOT_TOKEN")
DATA_DIR  = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

GIFTS_JSON = DATA_DIR / "gifts.json"
BC_FILE    = DATA_DIR / "bc_id.txt"
BUSINESS_CONNECTION_ID: str | None = os.getenv("BUSINESS_CONNECTION_ID") or None

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gift-bot")

# ──────── RAM-база ────────────────────────────────────────────────────────
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

# ──────── helpers ──────────────────────────────────────────────────────────
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
    return (
        getattr(obj, "sticker", None) and obj.sticker.file_id
        or getattr(obj, "symbol", None)  and obj.symbol.file_id
    )

# ──────── основной обработчик ─────────────────────────────────────────────
async def on_update(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Смотрим все Update-ы (TypeHandler) → выдёргиваем gifts & BC-ID.
    """
    # 1️⃣  выцепляем BusinessConnection-ID
    if update.business_connection:
        remember_bc_id(update.business_connection.id)
    if update.business_message:
        remember_bc_id(update.business_message.business_connection_id)

    # 2️⃣  ищем Message с подарком
    msg = (
        update.message
        or update.business_message
        or update.edited_message
    )
    if not msg:
        return

    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        return                      # сообщение не содержит подарок

    uid = str(msg.from_user.id) if msg.from_user else "unknown"
    owned_id = getattr(gift, "owned_gift_id", None)

    # id подарка: unique → id, regular → unique_id
    gift_id = getattr(gift, "unique_id", None) or getattr(gift, "id", None)
    rec = {
        "gift_id":  gift_id,
        "owned_id": owned_id,
        "name":     getattr(gift, "name", None),
        "ts":       int(time.time() * 1000),
        "file_id":  file_id_from(gift),
    }

    lst = _gifts.setdefault(uid, [])
    if not any(x["owned_id"] == owned_id for x in lst):
        lst.append(rec)
        save_gifts()
        log.info("▶ realtime gift (uid=%s, id=%s)", uid, gift_id)

# ──────── периодический REST-sync ──────────────────────────────────────────
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
            lst   = _gifts.setdefault(uid, [])
            if any(x["owned_id"] == owned.owned_gift_id for x in lst):
                continue

            if owned.gift:                          # regular
                gift_id = owned.gift.unique_id
                name    = owned.gift.name
                file_id = owned.gift.sticker.file_id if owned.gift.sticker else None
            else:                                   # unique
                gift_id = owned.unique_gift.id
                name    = owned.unique_gift.name
                file_id = (
                    owned.unique_gift.symbol.file_id
                    if owned.unique_gift.symbol else None
                )

            lst.append({
                "gift_id":  gift_id,
                "owned_id": owned.owned_gift_id,
                "name":     name,
                "ts":       owned.date * 1000,      # сек → мс
                "file_id":  file_id,
            })
            added += 1

        if added:
            save_gifts()
            log.info("⬆ synced %d gifts via REST", added)

    except Exception as e:
        log.exception("sync error: %s", e)

# ──────── bootstrap ────────────────────────────────────────────────────────
def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("GIFTS_BOT_TOKEN env missing")

    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .build()
    )

    # TypeHandler даёт ВСЕ Update-ы одним коллбеком
    app.add_handler(TypeHandler(Update, on_update))

    if app.job_queue:
        app.job_queue.run_repeating(
            lambda *_: asyncio.create_task(sync_gifts(app)),
            interval=60,
            first=10,
        )

    log.info("gift-bot started (BC_ID=%s)", BUSINESS_CONNECTION_ID or "—")
    app.run_polling(
        stop_signals=None,
        # просим Telegram присылать business_message + всё остальное
        allowed_updates=["business_message", "business_connection", "message"],
    )

if __name__ == "__main__":
    main()
