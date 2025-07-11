#!/usr/bin/env bash
# ─── start.sh — запускает Node и Python, держит оба ───────────────────
set -e
trap "echo '↯ stopping…'; kill 0" SIGINT SIGTERM

# 1. Node-сервер
node server/server.js &
NODE_PID=$!

# 2. Gift-бот
python gift-bot/tg_gift_bot.py &
PY_PID=$!

# 3. Ждём завершения ЛЮБОГО
wait -n $NODE_PID $PY_PID
EXIT_CODE=$?

# 4. Валим второй процесс и отдаем код
kill $NODE_PID $PY_PID 2>/dev/null || true
exit $EXIT_CODE
