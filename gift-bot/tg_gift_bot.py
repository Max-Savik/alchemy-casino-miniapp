#!/usr/bin/env python3
# tg_gift_bot.py — бизнес-аккаунт Gift-tracker
# ────────────────────────────────────────────────────────────────────────────
#  • Ловит входящие Gift/UniqueGift, кеширует business_connection_id.
#  • Каждые 60 с синхронизируется через getBusinessAccountGifts.
#  • Пишет JSON  DATA_DIR/gifts.json  и verbose-логи в stdout.
#  • Требует: python-telegram-bot[job-queue] ≥ 22.1
# ---------------------------------------------------------------------------

import asyncio, json, logging, os, sys, time
from pathlib import Path
from typing import Dict, List, Optional

from telegram import Update
from telegram.request import HTTPXRequest
from telegram.ext import (
    ApplicationBuilder, MessageHandler, ContextTypes, filters
)

# ──────── ENV / конфиг ──────────────────────────────────────────────────────
BOT_TOKEN  = os.getenv("GIFTS_BOT_TOKEN")                   # BotFather token
DATA_DIR   = Path(os.getenv("DATA_DIR", "./data"))
LOG_LEVEL  = os.getenv("LOG_LEVEL", "INFO").upper()         # DEBUG, INFO…

DATA_DIR.mkdir(parents=True, exist_ok=True)
GIFTS_PATH = DATA_DIR / "gifts.json"
BC_PATH    = DATA_DIR / "bc_id.txt"

BUSINESS_CONNECTION_ID: Optional[str] = os.getenv("BUSINESS_CONNECTION_ID")

# ──────── логирование ───────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("gift-bot")

# ───────── help: обёртка для детальных HTTP-логй ──────────────────────────
def log_request(req, *, tag="API"):
    log.debug(
        "%s ⇒ %s %s | body=%s",
        tag,
        req.method,
        req.url,
        (req.data or req.json) if LOG_LEVEL == "DEBUG" else "…",
    )

class LoggedRequest(HTTPXRequest):
    async def do_request(self, *a, **kw):
        response = await super().do_request(*a, **kw)
        log_request(response.request)
        log.debug("%s ⇐ %s %s | %s", "API", response.status_code, response.url,
                  (response.text[:400] + "…") if len(response.text) > 400 else response.text)
        return response

# ──────── in-memory кеш подарков ───────────────────────────────────────────
_gifts: Dict[str, List[dict]] = {}

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
    log.debug("gifts.json updated (%s bytes)", GIFTS_PATH.stat().st_size)

load_gifts()

# ──────── BC-ID helpers ────────────────────────────────────────────────────
def persist_bc_id(bc_id: str) -> None:
    global BUSINESS_CONNECTION_ID
    if not BUSINESS_CONNECTION_ID:
        BUSINESS_CONNECTION_ID = bc_id
        try:
            BC_PATH.write_text(bc_id)
        except Exception:
            log.warning("Can't write %s", BC_PATH)
        log.info("Captured BUSINESS_CONNECTION_ID = %s", bc_id)

if not BUSINESS_CONNECTION_ID and BC_PATH.exists():
    BUSINESS_CONNECTION_ID = BC_PATH.read_text().strip() or None
    if BUSINESS_CONNECTION_ID:
        log.info("Loaded BUSINESS_CONNECTION_ID from file (%s)", BUSINESS_CONNECTION_ID)

# ──────── утилиты разбора подарков ─────────────────────────────────────────
def file_id_from_gift(g) -> Optional[str]:
    if getattr(g, "sticker", None):                    # Regular
        return g.sticker.file_id
    if getattr(g, "symbol", None):                     # Unique
        return g.symbol.file_id
    if getattr(g, "gift", None) and getattr(g.gift, "sticker", None):
        return g.gift.sticker.file_id                  # GiftInfo
    return None

def extract_gift_id(g) -> str:
    if hasattr(g, "unique_id"):   # regular
        return g.unique_id
    if hasattr(g, "id"):          # unique
        return g.id
    if getattr(g, "gift", None) and hasattr(g.gift, "unique_id"):
        return g.gift.unique_id
    return "unknown"

# ──────── основной хэндлер ─────────────────────────────────────────────────
async def gift_received(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg   = update.effective_message
    bc_id = getattr(msg, "business_connection_id", None) or \
            getattr(update, "business_connection", None) and update.business_connection.id
    if bc_id:
        persist_bc_id(bc_id)

    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        log.debug("Update %s: no gift payload", msg.id)
        return

    user_id  = str(update.effective_user.id)
    gift_id  = extract_gift_id(gift)
    owned_id = getattr(gift, "owned_gift_id", None)
    name     = getattr(gift, "name", None) or getattr(getattr(gift, "gift", None), "name", None)

    record = {
        "gift_id"  : gift_id,
        "owned_id" : owned_id,
        "name"     : name,
        "file_id"  : file_id_from_gift(gift),
        "ts"       : int(time.time() * 1000),
    }

    gifts = _gifts.setdefault(user_id, [])
    if any(g.get("owned_id") == owned_id for g in gifts):
        log.debug("Duplicate gift %s ignored", owned_id)
        return

    gifts.append(record)
    save_gifts()
    log.info("📥  New gift for %s: %s (%s)", user_id, name, owned_id)

    try:
        await msg.reply_text("🎁 Подарок сохранён!", quote=False)
    except Exception:
        pass

# ──────── периодическая синхронизация ──────────────────────────────────────
async def sync_owned_gifts(app) -> None:
    if not BUSINESS_CONNECTION_ID:
        log.debug("sync → BC-ID unknown, skip")
        return

    try:
        og = await app.bot.get_business_account_gifts(
            business_connection_id=BUSINESS_CONNECTION_ID
        )
        merged = og.gifts
        log.debug("sync → %d gifts from API", len(merged))
        new = 0

        for owned in merged:
            uid = str(getattr(owned, "from_user", None).id) if getattr(owned, "from_user", None) else "unknown"
            gifts = _gifts.setdefault(uid, [])

            if owned.type == "regular":
                base      = owned.gift
                file_id   = base.sticker.file_id if base.sticker else None
                gift_id   = base.unique_id
            else:
                base      = owned.unique_gift
                file_id   = base.symbol.file_id if getattr(base, "symbol", None) else None
                gift_id   = base.id

            if any(x.get("owned_id") == owned.owned_gift_id for x in gifts):
                continue

            gifts.append({
                "gift_id" : gift_id,
                "owned_id": owned.owned_gift_id,
                "name"    : base.name,
                "file_id" : file_id,
                "ts"      : int(owned.date.timestamp() * 1000),
            })
            new += 1

        if new:
            save_gifts()
            log.info("🔄  Synced %d new gifts from business account", new)
        else:
            log.debug("sync → 0 new gifts")

    except Exception as e:
        log.exception("sync_owned_gifts error: %s", e)

# ──────── bootstrap ────────────────────────────────────────────────────────
def main() -> None:
    if not BOT_TOKEN:
        sys.exit("❌  GIFTS_BOT_TOKEN env not set")

    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .request_class(LoggedRequest)   # логируем каждый HTTP-запрос
        .build()
    )

    app.add_handler(MessageHandler(filters.ALL, gift_received))

    app.job_queue.run_repeating(
        lambda *_: asyncio.create_task(sync_owned_gifts(app)),
        interval=60, first=10
    )

    log.info("Gift-tracker started  | BC-ID = %s | LOG_LEVEL=%s",
             BUSINESS_CONNECTION_ID or "—", LOG_LEVEL)

    app.run_polling(stop_signals=None)

if __name__ == "__main__":
    main()
