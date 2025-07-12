#!/usr/bin/env python3
# tg_gift_bot.py – вытягиваем BC-ID через getBusinessConnections,
#                 если он не был задан вручную и не пришёл апдейтом.

import asyncio, json, logging, os, time
from pathlib import Path
from typing import Dict, List, Optional

from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, TypeHandler

BOTПАЛАМАЛ_TOKEN = os.getenv("GIFTS_BOT_TOKEN")
DATA_DIR  = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(exist_ok=True, parents=True)
GIFTS_JSON = DATA_DIR / "gifts.json"
BC_FILE    = DATA_DIR / "bc_id.txt"

BUSINESS_CONNECTION_ID: str | None = (
    os.getenv("BUSINESS_CONNECTION_ID") or
    (BC_FILE.read_text().strip() if BC_FILE.exists() else None)
)

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s:%(lineno)d %(message)s")
log = logging.getLogger("gift-bot")

# ---------- helpers -------------------------------------------------------
def save_bc_id(bc_id: str) -> None:
    global BUSINESS_CONNECTION_ID
    BUSINESS_CONNECTION_ID = bc_id
    BC_FILE.write_text(bc_id)
    log.info("BC-ID captured → %s", bc_id)

# ---------- on-update -----------------------------------------------------
async def on_update(upd: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if upd.business_connection:
        save_bc_id(upd.business_connection.id)
    if upd.business_message:
        save_bc_id(upd.business_message.business_connection_id)

# ---------- getBusinessConnections Fallback -------------------------------
async def fetch_bc_via_rest(app) -> None:
    """
    Для PTB 22: делаем сырой POST к Bot API.
    Ответ формата:
      { "ok":true,
        "result":[ { "id":"XXXX", "user":{…}, "is_enabled":true, … } ] }
    """
    if BUSINESS_CONNECTION_ID:
        return
    try:
        resp: dict = await app.bot.request.post("getBusinessConnections")
        conns = resp.get("result", [])
        if conns:
            save_bc_id(conns[0]["id"])
        else:
            log.warning("getBusinessConnections → 0 results")
    except Exception as e:
        log.error("getBusinessConnections failed (raw): %s", e)

# ---------- bootstrap -----------------------------------------------------
def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("GIFTS_BOT_TOKEN env missing")

    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(TypeHandler(Update, on_update))

    # post_init должен быть КОРУТИНА – run_polling сам её Await-ит
    async def _post_init(application, *_):
        await fetch_bc_via_rest(application)

    app.post_init = _post_init

    log.info("startup (BC-ID=%s)", BUSINESS_CONNECTION_ID or "—")
    app.run_polling(stop_signals=None)

if __name__ == "__main__":
    main()
