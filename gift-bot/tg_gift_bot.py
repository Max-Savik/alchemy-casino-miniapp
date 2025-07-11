#!/usr/bin/env python3
# ─── tg_gift_bot.py ───────────────────────────────────────────────
#  Отслеживает входящие regular/unique gifts и сохраняет их
#  в DATA_DIR/gifts.json, которую читает Node-сервер.
#  ENV: BOT_TOKEN, DATA_DIR (та же папка, что у Jackpot-сервера)
import os, json, asyncio, logging, time
from pathlib import Path
from telegram import Update
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

# ---------- bootstrap ---------------------------------------------------------
async def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN env not set")
    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(MessageHandler(filters.ALL, gift_received))
    logging.info("Gift-tracker bot started")
    await app.run_polling()

if __name__ == "__main__":
    asyncio.run(main())
