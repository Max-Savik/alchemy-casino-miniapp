#!/usr/bin/env python3
# gifts_holder.py — custodial wallet for Telegram Unique Gifts
# ─────────────────────────────────────────────────────────────
#   • Требует: python-telegram-bot >= 22.5
#   • Работает как Business‑бот, привязанный к аккаунту‑холд‑еру
#   • Сохраняет все уникальные подарки в SQLite (/data/gifts.db)
#   • Кэширует couple «chat_id → business_connection_id» в /data/bc_cache.json
#     (нужно для read_business_message / send_message)
#
# ENV:
#   GIFTS_BOT_TOKEN         — BotFather‑токен бизнес‑бота
#   DATA_DIR=/data          — Render disk (тот же, что у Node‑сервера)
# ──────────────────────────────────────────────────────────────

import json, logging, sqlite3, os
from pathlib import Path
from typing import Dict

from telegram import Message, UniqueGiftInfo, Update
from telegram.ext import (
    ApplicationBuilder, BusinessConnectionHandler,
    ContextTypes, JobQueue, TypeHandler,
)

# ─── конфиг через env ──────────────────────────────────────────
BOT_TOKEN  = os.getenv("GIFTS_BOT_TOKEN")
DATA_DIR   = Path(os.getenv("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

CACHE_FILE = DATA_DIR / "bc_cache.json"   # chat_id → bc_id
DB_FILE    = DATA_DIR / "gifts.db"

logging.basicConfig(
    level="INFO",
    format="%(asctime)s %(levelname)s | %(message)s",
    force=True
)
log = logging.getLogger("gift-wallet")

# ─── cache helpers ────────────────────────────────────────────
def _load_cache() -> Dict[int, str]:
    if CACHE_FILE.exists():
        try:
            return {int(k): v for k, v in json.loads(CACHE_FILE.read_text()).items()}
        except Exception as e:
            log.warning("⚠️ cache read error: %s", e)
    return {}

def _save_cache(c: Dict[int, str]) -> None:
    try:
        CACHE_FILE.write_text(json.dumps(c))
    except Exception as e:
        log.warning("⚠️ cache write error: %s", e)

BC_CACHE = _load_cache()

# ─── DB init / insert ─────────────────────────────────────────
def init_db() -> None:
    with sqlite3.connect(DB_FILE) as db:
        db.execute("""\
CREATE TABLE IF NOT EXISTS unique_gifts (
    owned_gift_id  TEXT PRIMARY KEY,
    sender_user_id INTEGER,
    chat_id        INTEGER,
    model          TEXT,
    name           TEXT,
    number         INTEGER,
    symbol         TEXT,
    send_date      INTEGER
)""")
        db.commit()

def save_unique_gift(ug: UniqueGiftInfo, msg: Message) -> bool:
    """INSERT OR IGNORE по owned_gift_id.  True → новая строка."""
    gift      = ug.gift
    owner_id  = ug.owned_gift_id or f"{gift.name}:{gift.number}"
    sender_id = msg.from_user.id if msg.from_user else None
    send_ts   = int(msg.date.timestamp()) if msg.date else None

    try:
        with sqlite3.connect(DB_FILE) as db:
            db.execute(
                "INSERT OR IGNORE INTO unique_gifts "
                "(owned_gift_id,sender_user_id,chat_id,model,name,number,symbol,send_date) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    owner_id, sender_id, msg.chat_id,
                    gift.model, gift.name, gift.number,
                    gift.symbol.name if gift.symbol else None,
                    send_ts,
                ),
            )
            db.commit()
            return db.total_changes > 0
    except Exception as e:
        log.error("DB insert error: %s", e)
        return False

# ─── handlers ─────────────────────────────────────────────────
async def on_connection(update: Update, _):
    bc = update.business_connection
    BC_CACHE[bc.user_chat_id] = bc.id
    _save_cache(BC_CACHE)
    log.info("🔗 connected %s (chat %s)", bc.id, bc.user_chat_id)

async def on_update(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    msg: Message | None = update.business_message
    if not msg or not msg.unique_gift:
        return

    bc_id = msg.business_connection_id or BC_CACHE.get(msg.chat_id)
    if not bc_id:
        return

    ug: UniqueGiftInfo = msg.unique_gift
    is_new = save_unique_gift(ug, msg)

    # помечаем сообщение «прочитанным» от имени бизнес‑аккаунта
    try:
        await ctx.bot.read_business_message(
            business_connection_id=bc_id,
            chat_id=msg.chat_id,
            message_id=msg.message_id,
        )
    except Exception as e:
        log.warning("read_business_message error: %s", e)

    gift = ug.gift
    log.info(
        "🎁 unique_gift owned_id=%s model=%s name=%s num=%s origin=%s",
        ug.owned_gift_id, gift.model, gift.name, gift.number, ug.origin,
    )

    # небольшое подтверждение в чат
    try:
        await ctx.bot.send_message(
            chat_id=msg.chat_id,
            text="🥳 Подарок сохранён!" if is_new else "ℹ️ Уже есть в хранилище.",
            business_connection_id=bc_id,
        )
    except Exception as e:
        log.debug("send_message skipped: %s", e)

# ─── main ─────────────────────────────────────────────────────
def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("GIFTS_BOT_TOKEN env not set")

    init_db()

    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .job_queue(JobQueue())    # нужен, иначе PTB не запустит JobQueue
        .build()
    )

    app.add_handler(BusinessConnectionHandler(on_connection))
    app.add_handler(TypeHandler(Update, on_update))

    log.info("🚀 Gift‑wallet started, waiting for unique gifts …")
    app.run_polling(
        allowed_updates=["business_connection", "business_message"],
        stop_signals=None         # Render сам перезапустит контейнер
    )

if __name__ == "__main__":
    main()
