#!/usr/bin/env python3
# ─── tg_gift_bot.py ───────────────────────────────────────────────
#  Отслеживает входящие regular/unique gifts и сохраняет их
#  в DATA_DIR/gifts.json, которую читает Node-сервер.
#  ENV: BOT_TOKEN, DATA_DIR (та же папка, что у Jackpot-сервера)
import os, json, logging, time
from pathlib import Path
from telegram import Update
from telegram.constants import ParseMode
# ID бизнес-коннекшна → видно в BotFather ↦ Business tabs
BC_ID      = os.getenv("BUSINESS_CONNECTION_ID")
from telegram.ext import (
    ApplicationBuilder, MessageHandler, ContextTypes, filters
)

BOT_TOKEN  = os.getenv("GIFTS_BOT_TOKEN")
DATA_DIR   = Path(os.getenv("DATA_DIR", "./data"))
GIFTS_FILE = DATA_DIR / "gifts.json"

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    level=logging.INFO
)

# ---------- helpers -----------------------------------------------------------
_gifts: dict[str, list[dict]] = {}

def load_gifts() -> None:
    global _gifts
    try:
        _gifts = json.loads(GIFTS_FILE.read_text("utf-8"))
    except FileNotFoundError:
        _gifts = {}
    except Exception as e:
        logging.exception("Can't read %s: %s", GIFTS_FILE, e)

def save_gifts() -> None:
    tmp = GIFTS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_gifts, ensure_ascii=False, indent=2))
    tmp.replace(GIFTS_FILE)

load_gifts()

# ---------- handler -----------------------------------------------------------
async def gift_received(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        return

    user_id = str(update.effective_user.id)
    gift_id = getattr(gift, "unique_id", None) or f"gift-{msg.id}"
# owned_gift_id обязателен для дальнейших transferGift
    owned_id    = getattr(gift, "owned_gift_id", None),

    record = {
        "gift_id"   : gift_id,
        "name"      : getattr(gift, "name", None),
        "base_name" : getattr(gift, "base_name", None),
        "number"    : getattr(gift, "number", None),
        "star_count": getattr(gift, "star_count", None),
        "file_id"   : gift.sticker.file_id if gift.sticker else None,
        "ts"        : int(time.time() * 1000)
    }

    gifts = _gifts.setdefault(user_id, [])
    if not any(g["gift_id"] == gift_id for g in gifts):
        gifts.append(record)
        save_gifts()
        logging.info("User %s obtained gift %s", user_id, record["name"])
        try:
            await msg.reply_text("Подарок сохранён ✅", quote=False)
        except Exception:
            pass

# ---------- periodic sync -----------------------------------------------------
async def sync_owned_gifts(app) -> None:
    """Раз в N c опрашиваем Bot API → не потеряем подарки,
       полученные до запуска или пока бот оффлайн."""
    if not BC_ID:
        logging.warning("BUSINESS_CONNECTION_ID not set – skip sync")
        return
    try:
        og = await app.bot.get_business_account_gifts(business_connection_id=BC_ID)
        # og.regular, og.unique – списки OwnedGiftRegular / OwnedGiftUnique
        merged = og.regular + og.unique
        new = 0
        for g in merged:
            uid = str(g.user.id) if g.user else "unknown"
            gifts = _gifts.setdefault(uid, [])
            if not any(x.get("owned_id") == g.owned_gift_id for x in gifts):
                gifts.append({
                    "gift_id"  : g.gift.unique_id if g.gift else None,
                    "owned_id" : g.owned_gift_id,
                    "name"     : getattr(g.gift, "name", None),
                    "ts"       : g.date.timestamp() * 1000,
                    "file_id"  : g.gift.sticker.file_id if g.gift and g.gift.sticker else None
                })
                new += 1
        if new:
            save_gifts()
            logging.info("Synced %+d gifts from business account", new)
    except Exception as e:
        logging.exception("getBusinessAccountGifts failed: %s", e)

# ---------- bootstrap ---------------------------------------------------------
def main() -> None:
    """
    Entry-point без дополнительного event-loop:
    Application.run_polling() сам создаёт и управляет asyncio-циклом.
    """
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN env not set")

    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(MessageHandler(filters.ALL, gift_received))

    # периодический sync (каждые 3 мин)
    if BC_ID:
        app.job_queue.run_repeating(
            lambda *_: asyncio.create_task(sync_owned_gifts(app)),
            interval=60, first=5
        )

    logging.info("Gift-tracker bot started (BC_ID=%s)", BC_ID or "—")
    # блокирующий вызов; если упадёт — Render перезапустит контейнер
    app.run_polling(stop_signals=None)


if __name__ == "__main__":
    main()
