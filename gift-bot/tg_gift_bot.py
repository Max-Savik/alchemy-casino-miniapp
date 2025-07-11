#!/usr/bin/env python3
# ────────────────────────────────────────────────────────────────────────────
#  tg_gift_bot.py ― Gift-tracker для Telegram-Business-аккаунта
#  --------------------------------------------------------------------------
#  • Ловит входящие regular / unique gifts в управляемом бизнес-аккаунте.
#  • Поддерживает двухстороннюю синхронизацию:
#      ① real-time через сервис-сообщения;
#      ② раз в 60 с ― запросом getBusinessAccountGifts, чтобы «догнать»
#         подарки, полученные, пока бот был оффлайн.
#  • Хранит данные в  JSON-файле  DATA_DIR/gifts.json  (читается Node-сервером)
#    и кеширует business_connection_id в  DATA_DIR/bc_id.txt .
#
#  ENV:
#      GIFTS_BOT_TOKEN          токен BotFather (Business Mode ON)
#      DATA_DIR=/data           общий persist-диск (как у Jackpot-сервера)
#      BUSINESS_CONNECTION_ID   (необяз.) можно задать вручную
# ---------------------------------------------------------------------------
#  Требования: python-telegram-bot >= 22.1
# ---------------------------------------------------------------------------

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Dict, List

from telegram import Update
from typing import Optional
from telegram.ext import (
    ApplicationBuilder,
    ContextTypes,
    MessageHandler,
    filters,
)

# ─────────── конфиг ─────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("GIFTS_BOT_TOKEN")           # MUST-HAVE
DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

GIFTS_PATH = DATA_DIR / "gifts.json"
BC_PATH = DATA_DIR / "bc_id.txt"                   # кешируем ID сюда

# env-override (если задали вручную)
BUSINESS_CONNECTION_ID: str | None = os.getenv("BUSINESS_CONNECTION_ID") or None

# ─────────── логирование ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("gift-bot")

# ─────────── in-memory хранилище ────────────────────────────────────────────
_gifts: Dict[str, List[dict]] = {}                 # { user_id: [gift,…] }

def load_gifts() -> None:
    global _gifts
    try:
        _gifts = json.loads(GIFTS_PATH.read_text("utf-8"))
        log.info("Loaded %d users with gifts", len(_gifts))
    except FileNotFoundError:
        _gifts = {}
    except Exception as e:
        log.exception("Can't read %s: %s", GIFTS_PATH, e)
        _gifts = {}

def save_gifts() -> None:
    tmp = GIFTS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(_gifts, ensure_ascii=False, indent=2))
    tmp.replace(GIFTS_PATH)

load_gifts()

# ─────────── helpers ────────────────────────────────────────────────────────
def persist_bc_id(bc_id: str) -> None:
    """Сохраняем ID на диск, чтобы при перезапуске сразу знать его."""
    global BUSINESS_CONNECTION_ID
    if BUSINESS_CONNECTION_ID:
        return                       # уже был
    BUSINESS_CONNECTION_ID = bc_id
    try:
        BC_PATH.write_text(bc_id)
        log.info("Captured BUSINESS_CONNECTION_ID = %s", bc_id)
    except Exception as e:
        log.warning("Can't write bc_id.txt: %s", e)

# при старте ─ пробуем прочитать сохранённое значение
if not BUSINESS_CONNECTION_ID and BC_PATH.exists():
    BUSINESS_CONNECTION_ID = BC_PATH.read_text().strip() or None
    if BUSINESS_CONNECTION_ID:
        log.info("Loaded BUSINESS_CONNECTION_ID from file")

# ─────────── main handlers ──────────────────────────────────────────────────
async def gift_received(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Обрабатывает любое сообщение, ловим:
      • Gift / UniqueGift  → сохраняем в JSON;
      • business_connection_id        → кешируем.
    """
    msg = update.effective_message

    # 1) авто-детект business_connection_id
    bc_in_msg = getattr(msg, "business_connection_id", None)
    bc_in_upd = getattr(update, "business_connection", None)
    if bc_in_msg:
        persist_bc_id(bc_in_msg)
    elif bc_in_upd:
        persist_bc_id(bc_in_upd.id)

    # 2) обрабатываем подарок
    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        return

    user_id = str(update.effective_user.id)
    gift_id  = getattr(gift, "unique_id", None) or getattr(gift, "gift", None) and gift.gift.unique_id \
               or f"gift-{msg.id}"
    owned_id = getattr(gift, "owned_gift_id", None)

    def file_id_from_gift(g) -> Optional[str]:
        # GiftInfo → g.gift.sticker, UniqueGiftInfo → g.symbol
        if getattr(g, "sticker", None):
            return g.sticker.file_id
        if getattr(g, "symbol", None):
            return g.symbol.file_id
        if getattr(g, "gift", None) and getattr(g.gift, "sticker", None):
            return g.gift.sticker.file_id
        return None

    name = (
        getattr(gift, "name", None)
        or getattr(getattr(gift, "gift", None), "name", None)
    )

    record = {
        "gift_id"   : gift_id,
        "owned_id"  : owned_id,
        "name"      : name,
        "base_name" : getattr(gift, "base_name", None),
        "number"    : getattr(gift, "number", None),
        "star_count": getattr(gift, "star_count", None),
        "file_id"   : file_id_from_gift(gift),
        "ts"        : int(time.time() * 1000),
    }

    gifts = _gifts.setdefault(user_id, [])
    if not any(g.get("owned_id") == owned_id for g in gifts):
        gifts.append(record)
        save_gifts()
        log.info("User %s obtained gift %s", user_id, record["name"])
        try:
            await msg.reply_text("Подарок сохранён ✅", quote=False)
        except Exception:
            pass

# ─────────── periodic sync ─────────────────────────────────────────────────
async def sync_owned_gifts(app) -> None:
    """
    Раз в 60 с опрашиваем getBusinessAccountGifts.
    Позволяет увидеть всё, что пришло, пока бот был оффлайн.
    """
    if not BUSINESS_CONNECTION_ID:
        return  # ждём, пока поймаем ID

    try:
        og = await app.bot.get_business_account_gifts(
            business_connection_id=BUSINESS_CONNECTION_ID
        )
        merged = og.gifts                          # общий список OwnedGift
        new = 0
        for owned in merged:
            uid = str(owned.user.id) if owned.user else "unknown"
            gifts = _gifts.setdefault(uid, [])

            if owned.type == "regular":
                base = owned.gift           # Gift
                name = base.name
                file_id = base.sticker.file_id if base.sticker else None
                owned_id = owned.owned_gift_id
                gift_id = base.unique_id
            else:                           # unique
                base = owned.unique_gift    # UniqueGift
                name = base.name
                file_id = base.symbol.file_id if base.symbol else None
                owned_id = owned.owned_gift_id
                gift_id = base.unique_id

            if not any(x.get("owned_id") == owned_id for x in gifts):
                gifts.append(
                    {
                        "gift_id": gift_id,
                        "owned_id": owned_id,
                        "name": name,
                        "ts": int(owned.date.timestamp() * 1000),
                        "file_id": file_id,
                    }
                )
                new += 1
        if new:
            save_gifts()
            log.info("Synced %+d gifts from business account", new)
    except Exception as e:
        log.exception("getBusinessAccountGifts failed: %s", e)

# ─────────── bootstrap ─────────────────────────────────────────────────────
def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("GIFTS_BOT_TOKEN env not set")

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    # global catch-all: получаем все типы сообщений
    app.add_handler(MessageHandler(filters.ALL, gift_received))

    # периодический sync (каждые 60 с)
    app.job_queue.run_repeating(
        lambda *_: asyncio.create_task(sync_owned_gifts(app)),
        interval=60,
        first=10,
    )

    log.info("Gift-tracker bot started (BC_ID=%s)", BUSINESS_CONNECTION_ID or "—")
    # блокирующий вызов; если упадёт — оркестратор перезапустит контейнер
    app.run_polling(stop_signals=None)

if __name__ == "__main__":
    main()
