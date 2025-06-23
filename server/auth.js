// auth.js
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_IDS = '' } = process.env;
const admins = ADMIN_IDS.split(',').map(x => x.trim());

export function verifyAdmin(req, res, next) {
  let raw = req.headers['x-telegram-init-data']
          || req.query.initData
          || '';
  if (req.query.initData) raw = decodeURIComponent(raw);     // ← снимаем 1 слой

  try {
    const url  = new URLSearchParams(raw);
    const hash = url.get('hash');
    url.delete('hash');

    /* ---------- HMAC проверки ---------- */
    const dataCheckString = [...url.entries()]
      .map(([k, v]) => `${k}=${v}`)     // NB: user-value остаётся %7B…%7D
      .sort()
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const calcHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (calcHash !== hash) return res.status(401).end('bad hash');

    /* ---------- достаём объект user ---------- */
    const userRaw = url.get('user') || '%7B%7D';              // %7B%7D = {}
    const user    = JSON.parse(decodeURIComponent(userRaw));  // ← снимаем ОДИН слой
    if (!admins.includes(String(user.id))) {
      return res.status(403).end('not an admin');
    }

    req.tgUser = user;        // логировать удобно
    next();
  } catch (e) {
    console.error('initData parse error:', e);
    res.status(400).end('bad initData');
  }
}

