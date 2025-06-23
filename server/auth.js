// auth.js
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_IDS = '' } = process.env;
const admins = ADMIN_IDS.split(',').map(x => x.trim());

/** Проверяем, что запрос от Telegram и user.id — админ */
export function verifyAdmin(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || '';
  try {
    const url = new URLSearchParams(initData);
    const hash = url.get('hash');
    url.delete('hash');

    const dataCheckString = [...url.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    // 🔑 секрет = HMAC(botToken, 'WebAppData')
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN)
      .digest();

    const calcHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (calcHash !== hash) return res.status(401).end('bad hash');

    const user = JSON.parse(url.get('user') || '{}');
    if (!admins.includes(String(user.id))) {
      return res.status(403).end('not an admin');
    }

    req.tgUser = user;           // можно логировать, если нужно
    next();
  } catch (e) {
    console.error('initData parse error:', e);
    res.status(400).end('bad initData');
  }
}

