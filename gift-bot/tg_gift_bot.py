#!/usr/bin/env python3
# tg_gift_bot.py  —  подробный Gift-tracker (Business аккаунт)
# ---------------------------------------------------------------------------
#  • Перехватывает Gift/UniqueGift + опрашивает getBusinessAccountGifts.
#  • Пишет подробные DEBUG-логи (включаются env LOG_LEVEL=DEBUG).
#  • Сохраняет gifts.json и bc_id.txt в DATA_DIR (общий диск Render).
#  • Требует: python-telegram-bot[job-queue] >= 22.1
# ---------------------------------------------------------------------------

import asyncio, json, logging, os, sys, time
from pathlib import Path
from typing import Dict, List, Optional

from telegram import Update
from telegram.request import HTTPXRequest
from telegram.ext import (
    ApplicationBuilder, MessageHandler, ContextTypes, filters
)

# ───── ENV ------------------------------------------------------------------
BOT_TOKEN  = os.getenv("GIFTS_BOT_TOKEN")                # BotFather token
DATA_DIR   = Path(os.getenv("DATA_DIR", "./data"))
LOG_LEVEL  = os.getenv("LOG_LEVEL", "INFO").upper()      # DEBUG/INFO…

DATA_DIR.mkdir(parents=True, exist_ok=True)
GIFTS_PATH = DATA_DIR / "gifts.json"
BC_PATH    = DATA_DIR / "bc_id.txt"

BUSINESS_CONNECTION_ID: Optional[str] = os.getenv("BUSINESS_CONNECTION_ID")

# ───── logging --------------------------------------------------------------
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("gift-bot")

# ───── HTTP trace helper ----------------------------------------------------
def log_request(req, *, tag="API"):
    log.debug("%s ⇒ %s %s | body=%s",
              tag, req.method, req.url,
              (req.data or req.json) if LOG_LEVEL == "DEBUG" else "…")

class LoggedRequest(HTTPXRequest):
    async def do_request(self, *a, **kw):
        resp = await super().do_request(*a, **kw)
        log_request(resp.request)
        log.debug("%s ⇐ %s | %s", "API", resp.status_code,
                  resp.text[:400] + ("…" if len(resp.text) > 400 else ""))
        return resp

# ───── gifts cache ----------------------------------------------------------
_gifts: Dict[str, List[dict]] = {}
def load_gifts():
    global _gifts
    try:
        _gifts = json.loads(GIFTS_PATH.read_text("utf-8"))
    except FileNotFoundError:
        _gifts = {}
    log.info("Loaded %d users with gifts", len(_gifts))

def save_gifts():
    tmp = GIFTS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(_gifts, ensure_ascii=False, indent=2))
    tmp.replace(GIFTS_PATH)
    log.debug("gifts.json saved (%d bytes)", GIFTS_PATH.stat().st_size)

load_gifts()

# ───── BC-ID helpers ---------------------------------------------------------
def persist_bc_id(bc_id: str):
    global BUSINESS_CONNECTION_ID
    if not BUSINESS_CONNECTION_ID:
        BUSINESS_CONNECTION_ID = bc_id
        try:
            BC_PATH.write_text(bc_id)
        except Exception:
            log.warning("Can't write bc_id.txt")
        log.info("Captured BUSINESS_CONNECTION_ID = %s", bc_id)

if not BUSINESS_CONNECTION_ID and BC_PATH.exists():
    BUSINESS_CONNECTION_ID = BC_PATH.read_text().strip() or None
    if BUSINESS_CONNECTION_ID:
        log.info("Loaded BUSINESS_CONNECTION_ID from file")

# ───── utilities ------------------------------------------------------------
def file_id_from_gift(g) -> Optional[str]:
    if getattr(g, "sticker", None):
        return g.sticker.file_id
    if getattr(g, "symbol", None):
        return g.symbol.file_id
    if getattr(g, "gift", None) and getattr(g.gift, "sticker", None):
        return g.gift.sticker.file_id
    return None

def extract_gift_id(g) -> str:
    if hasattr(g, "unique_id"):
        return g.unique_id
    if hasattr(g, "id"):
        return g.id
    if getattr(g, "gift", None) and hasattr(g.gift, "unique_id"):
        return g.gift.unique_id
    return "unknown"

# ───── main handler ---------------------------------------------------------
async def gift_received(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    bc_in = getattr(msg, "business_connection_id", None) or \
            getattr(update, "business_connection", None) and update.business_connection.id
    if bc_in:
        persist_bc_id(bc_in)

    gift = getattr(msg, "unique_gift", None) or getattr(msg, "gift", None)
    if not gift:
        return

    user_id  = str(update.effective_user.id)
    gift_id  = extract_gift_id(gift)
    owned_id = getattr(gift, "owned_gift_id", None)
    name = getattr(gift, "name", None) or getattr(getattr(gift, "gift", None), "name", None)

    rec = {
        "gift_id": gift_id,
        "owned_id": owned_id,
        "name": name,
        "file_id": file_id_from_gift(gift),
        "ts": int(time.time() * 1000),
    }
    gifts = _gifts.setdefault(user_id, [])
    if any(g["owned_id"] == owned_id for g in gifts):
        log.debug("Duplicate gift %s", owned_id)
        return

    gifts.append(rec); save_gifts()
    log.info("📥 New gift for %s: %s (%s)", user_id, name, owned_id)

# ───── periodic sync --------------------------------------------------------
async def sync_owned_gifts(app):
    if not BUSINESS_CONNECTION_ID:
        log.debug("sync: BC-ID unknown, skip")
        return
    try:
        og = await app.bot.get_business_account_gifts(
            business_connection_id=BUSINESS_CONNECTION_ID
        )
        merged, new = og.gifts, 0
        for owned in merged:
            uid = str(owned.from_user.id) if owned.from_user else "unknown"
            gifts = _gifts.setdefault(uid, [])

            if owned.type == "regular":
                base, file_id = owned.gift, owned.gift.sticker.file_id if owned.gift.sticker else None
                gift_id = base.unique_id
            else:
                base, file_id = owned.unique_gift, (base.symbol.file_id if (base := owned.unique_gift).symbol else None)
                gift_id = base.id

            if any(x["owned_id"] == owned.owned_gift_id for x in gifts):
                continue
            gifts.append({
                "gift_id": gift_id,
                "owned_id": owned.owned_gift_id,
                "name": base.name,
                "file_id": file_id,
                "ts": int(owned.date.timestamp() * 1000),
            }); new += 1
        if new: save_gifts(); log.info("🔄 Synced %d new gifts", new)
    except Exception as e:
        log.exception("sync error: %s", e)

# ───── bootstrap ------------------------------------------------------------
def main():
    if not BOT_TOKEN:
        sys.exit("❌ GIFTS_BOT_TOKEN env not set")

    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .request(LoggedRequest())       # <-- FIX: экземпляр, не request_class
        .build()
    )

    app.add_handler(MessageHandler(filters.ALL, gift_received))
    app.job_queue.run_repeating(
        lambda *_: asyncio.create_task(sync_owned_gifts(app)),
        interval=60, first=10
    )

    log.info("Gift-tracker started | BC-ID=%s | LOG_LEVEL=%s",
             BUSINESS_CONNECTION_ID or "—", LOG_LEVEL)
    app.run_polling(stop_signals=None)

if __name__ == "__main__":
    main()
