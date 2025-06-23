import crypto from 'crypto';
import dotenv  from 'dotenv';
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_IDS = '' } = process.env;
const admins = ADMIN_IDS.split(',').map(s => s.trim());

export function verifyAdmin(req, res, next) {
  /* 1. Берём initData: заголовок → query → '' */
  let raw = req.headers['x-telegram-init-data']
         || req.query.initData
         || '';

  /* 2. Если пришёл через query, снимаем ОДИН слой кодировки */
  if (req.query.initData) {
    try { raw = decodeURIComponent(raw); }               // user=%7B…%7D&hash=…
    catch { return res.status(400).end('bad initData'); }
  }

  try {
    /* 3. Разобрали строку 👉 key=value */
    const url  = new URLSearchParams(raw);
    const hash = url.get('hash');
    url.delete('hash');

    /* 4. Готовим data_check_string (значения ещё URL-encoded!) */
    const dcs = [...url.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN)
      .digest();

    const calcHash = crypto
      .createHmac('sha256', secretKey)
      .update(dcs)
      .digest('hex');

    if (calcHash !== hash) return res.status(401).end('bad hash');

    /* 5. Извлекаем user: ДЕКОДИРУЕМ ОДИН РАЗ перед JSON.parse */
    const userJson = decodeURIComponent(url.get('user') || '%7B%7D');
    const user     = JSON.parse(userJson);

    if (!admins.includes(String(user.id))) {
      return res.status(403).end('not an admin');
    }

    req.tgUser = user;            // можно логировать, если хотите
    next();
  } catch (e) {
    console.error('initData parse error:', e);
    res.status(400).end('bad initData');
  }
}
