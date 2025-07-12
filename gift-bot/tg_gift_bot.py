#!/usr/bin/env python3
# ────────────────────────────────────────────────────────────────────────────
#  tg_gift_bot.py  –  Gift-tracker для Telegram-Business-аккаунта
#  --------------------------------------------------------------------------
#  • Ловит входящие regular / unique gifts (service-messages) в Business-акке.
#  • Раз в 60 с делает getBusinessAccountGifts → ничего не потеряется,
#    даже если бот был оффлайн и сервис-сообщение не пришло.
#  • Пишет всё в  DATA_DIR/gifts.json   (читает Node-бекенд)
#    и хранит business_connection_id в  DATA_DIR/bc_id.txt .
#
#  ENV:
#     GIFTS_BOT_TOKEN          токен BotFather (Business Mode = ON)
#     DATA_DIR=/data           тот же persist-диск, что у Jackpot-сервера
#     BUSINESS_CONNECTION_ID   (optional)  если хотите задать вручную
#
#  pip install  "python-telegram-bot[job-queue]>=22.2"
# ---------------------------------------------------------------------------

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Dict, List, Optional

from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    ContextTypes,
    MessageHandler,
    filters,
)

# ─────────── конфиг ─────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("GIFTS_BOT_TOKEN")           # ‼️ обязательно
DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

GIFTS_PATH = DATA_DIR / "gifts.json"
BC_PATH    = DATA_DIR / "bc_id.txt"                # кешируем BC-ID

BUSINESS_CONNECTION_ID: str | None = os.getenv("BUSINESS_CONNECTION_ID") or None

# ─────────── логирование ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("gift-bot")

# ─────────── in-memory база ────────────────────────────────────────────────
_gifts: Dict[str, List[dict]] = {}                 # { user_id : [ gifts ] }

def load_gifts() -> None:
    global _gifts
    try:
        _gifts = json.loads(GIFTS_PATH.read_text("utf-8"))
    except FileNotFoundError:
        _gifts = {}
    except Exception as e:
        log.exception("Can't read %s: %s", GIFTS_PATH, e)
        _gifts = {}
    log.info("Loaded %d users with gifts", len(_gifts))

def save_gifts() -> None:
    tmp = GIFTS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(_gifts, ensure_ascii=False, indent=2))
    tmp.replace(GIFTS_PATH)

load_gifts()

# ─────────── helpers ────────────────────────────────────────────────────────
def persist_bc_id(bc_id: str) -> None:
    """Запоминаем business_connection_id."""
    global BUSINESS_CONNECTION_ID
    if BUSINESS_CONNECTION_ID:
        return
    BUSINESS_CONNECTION_ID = bc_id
    try:
        BC_PATH.write_text(bc_id)
    except Exception as e:
        log.warning("Can't write bc_id.txt: %s", e)
    log.info("Captured BUSINESS_CONNECTION_ID → %s", bc_id)

if not BUSINESS_CONNECTION_ID and BC_PATH.exists():
    BUSINESS_CONNECTION_ID = BC_PATH.read_text().strip() or None
    if BUSINESS_CONNECTION_ID:
        log.info("Loaded BUSINESS_CONNECTION_ID from file")

# ---------------------------------------------------------------------------#
#                                HANDLERS                                    #
# ---------------------------------------------------------------------------#
def file_id_from_gift(obj) -> Optional[str]:
    """
    • regular → obj.sticker.file_id
    • unique  → obj.symbol.file_id
    """
    if getattr(obj, "sticker", None):
        return obj.sticker.file_id
    if getattr(obj, "symbol", None):
        return obj.symbol.file_id
    if getattr(obj, "gift", None) and getattr(obj.gift, "sticker", None):
        return obj.gift.sticker.file_id
    return None

async def gift_received(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Обрабатывает все сообщения:
      1) Вытаскивает business_connection_id.
      2) Если это gift / unique_gift → добавляет запись.
    """
    msg = update.effective_message

    # авто-детект Business-connection
    bc_in_msg = getattr(msg, "business_connection_id", None)
    bc_in_upd = getattr(update, "business_connection", None)
    if bc_in_msg:
        persist_bc_id(bc_in_msg)
    elif bc_in_upd:
        persist_bc_id(bc_in_upd.id)

    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        return                                    # не подарок → выходим

    user_id = str(update.effective_user.id)

    # ID подарка
    if hasattr(gift, "unique_id"):                # regular gift
        gift_id = gift.unique_id
    elif hasattr(gift, "id"):                     # unique gift
        gift_id = gift.id
    elif getattr(gift, "gift", None):
        gift_id = gift.gift.unique_id
    else:
        gift_id = f"gift-{msg.id}"

    owned_id = getattr(gift, "owned_gift_id", None)

    record = {
        "gift_id"   : gift_id,
        "owned_id"  : owned_id,
        "name"      : getattr(gift, "name", None)
                      or getattr(getattr(gift, "gift", None), "name", None),
        "ts"        : int(time.time() * 1000),
        "file_id"   : file_id_from_gift(gift),
    }

    gifts = _gifts.setdefault(user_id, [])
    if not any(g["owned_id"] == owned_id for g in gifts):
        gifts.append(record)
        save_gifts()
        log.info("▶ saved realtime gift (uid=%s, id=%s)", user_id, gift_id)

# ---------------------------------------------------------------------------#
#                               SYNC LOOP                                    #
# ---------------------------------------------------------------------------#
async def sync_owned_gifts(app) -> None:
    """
    Раз в минуту опрашиваем getBusinessAccountGifts – дособираем «потерянные»
    подарки.  Ограничений по количеству ответ даёт до 1000 предметов.
    """
    if not BUSINESS_CONNECTION_ID:
        return

    try:
        og = await app.bot.get_business_account_gifts(
            business_connection_id=BUSINESS_CONNECTION_ID
        )
        merged = og.gifts or []                   # список OwnedGift*
        new_cnt = 0

        for owned in merged:
            # user может быть None, если подарили анонимно
            uid = str(owned.from_user.id) if owned.from_user else "unknown"
            gifts = _gifts.setdefault(uid, [])

            if owned.gift:                        # regular
                ginfo = owned.gift
                gift_id  = ginfo.unique_id
                file_id  = ginfo.sticker.file_id if ginfo.sticker else None
            else:                                 # unique
                ginfo = owned.unique_gift
                gift_id = ginfo.id
                file_id = ginfo.symbol.file_id if ginfo.symbol else None

            rec = {
                "gift_id"  : gift_id,
                "owned_id" : owned.owned_gift_id,
                "name"     : ginfo.name,
                "ts"       : owned.date * 1000,   # API выдаёт Unix-time (сек.)
                "file_id"  : file_id,
            }

            if not any(x["owned_id"] == rec["owned_id"] for x in gifts):
                gifts.append(rec)
                new_cnt += 1

        if new_cnt:
            save_gifts()
            log.info("⬆ synced %d gifts via getBusinessAccountGifts", new_cnt)

    except Exception as e:
        log.exception("sync error: %s", e)

# ---------------------------------------------------------------------------#
#                                 BOOTSTRAP                                  #
# ---------------------------------------------------------------------------#
def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("GIFTS_BOT_TOKEN env missing")

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    #   получаем все апдейты (service-messages тоже «messages»)
    app.add_handler(MessageHandler(filters.ALL, gift_received))

    #   периодический sync (каждые 60 с)
    if app.job_queue:
        app.job_queue.run_repeating(
            lambda *_: asyncio.create_task(sync_owned_gifts(app)),
            interval=60,
            first=10,
        )
    else:
        log.warning("JobQueue not available – background sync disabled")

    log.info("Started  (BC_ID = %s)", BUSINESS_CONNECTION_ID or "—")
    app.run_polling(stop_signals=None)

if __name__ == "__main__":
    main()
