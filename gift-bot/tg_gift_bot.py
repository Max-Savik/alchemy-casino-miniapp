#!/usr/bin/env python3
# tg_gift_bot.py — Gift-tracker c DEBUG-логами
# ------------------------------------------------------------------
#  • Пишет все raw Update-ы в data/updates.log
#  • Если бизнес-апдейты реально приходят — увидите их целиком.
#  • После запуска делает один getBusinessAccountGifts и пишет,
#    сколько позиций вернул сервер.
#
#  ENV:  GIFTS_BOT_TOKEN  ·  DATA_DIR=/data
# ------------------------------------------------------------------

import asyncio, json, logging, os, time
from pathlib import Path
from typing import Dict, List, Optional

from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, TypeHandler

# ───── конфиг ──────────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("GIFTS_BOT_TOKEN")
DATA_DIR  = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

GIFTS_JSON  = DATA_DIR / "gifts.json"
UPD_LOG     = DATA_DIR / "updates.log"
BC_FILE     = DATA_DIR / "bc_id.txt"
BUSINESS_CONNECTION_ID: str | None = os.getenv("BUSINESS_CONNECTION_ID") or None

# ───── логирование ─────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG,                       # ← DEBUG
    format="%(asctime)s %(levelname)s %(name)s:%(lineno)d  %(message)s",
)
log = logging.getLogger("gift-bot")

# ───── runtime-база ────────────────────────────────────────────────────────
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

# ───── helpers ─────────────────────────────────────────────────────────────
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
    if getattr(obj, "sticker", None):
        return obj.sticker.file_id
    if getattr(obj, "symbol", None):
        return obj.symbol.file_id
    return None

# ───── главный handler ─────────────────────────────────────────────────────
async def on_update(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    # пишем raw-update в файл (одна строка = один update)
    UPD_LOG.write_text(
        json.dumps(update.to_dict(), ensure_ascii=False) + "\n",
        encoding="utf-8",
        mode="a",
    )

    # коллектим BC-ID (на всякий случай)
    if update.business_connection:
        remember_bc_id(update.business_connection.id)
    if update.business_message:
        remember_bc_id(update.business_message.business_connection_id)

    # проверяем, не подарок ли
    msg = update.message or update.business_message
    if not msg:
        return
    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        return

    uid      = str(msg.from_user.id) if msg.from_user else "unknown"
    owned_id = getattr(gift, "owned_gift_id", None)
    gift_id  = getattr(gift, "unique_id", None) or getattr(gift, "id", None)

    if not gift_id:
        gift_id = f"gift-{msg.message_id}"

    rec = {
        "gift_id":  gift_id,
        "owned_id": owned_id,
        "name":     getattr(gift, "name", None),
        "ts":       int(time.time()*1000),
        "file_id":  file_id_from(gift),
    }

    if not any(x["owned_id"] == owned_id for x in _gifts.setdefault(uid, [])):
        _gifts[uid].append(rec)
        save_gifts()
        log.info("saved realtime gift (uid=%s id=%s)", uid, gift_id)

# ───── тестовый REST-запрос сразу после старта ─────────────────────────────
async def initial_check(app) -> None:
    if not BUSINESS_CONNECTION_ID:
        log.warning("initial_check: BC_ID unknown")
        return
    try:
        data = await app.bot.get_business_account_gifts(
            business_connection_id=BUSINESS_CONNECTION_ID, limit=10
        )
        log.info("initial_check: TonCenter returned %d items", len(data.gifts or []))
    except Exception as e:
        log.exception("initial_check error: %s", e)

# ───── bootstrap ───────────────────────────────────────────────────────────
def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("GIFTS_BOT_TOKEN env missing")

    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(TypeHandler(Update, on_update))

    # один раз после запуска
    app.post_init = lambda _app, *_: asyncio.create_task(initial_check(_app))

    log.info("DEBUG gift-bot started (BC_ID=%s)", BUSINESS_CONNECTION_ID or "—")
    app.run_polling(stop_signals=None)           # no allowed_updates → ВСЁ

if __name__ == "__main__":
    main()
