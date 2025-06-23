import crypto from 'crypto';
import dotenv  from 'dotenv';
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_IDS = '' } = process.env;
const admins = ADMIN_IDS.split(',').map(x => x.trim());

export function verifyAdmin(req, res, next) {
  /* 1. Берём base64-заголовок */
  const b64 = req.headers['x-tg-init-data-b64'];
  if (!b64) return res.status(400).end('missing initData');

  let raw;
  try {
    raw = Buffer.from(b64, 'base64').toString('utf8');   // ← точная строка от Telegram
  } catch {
    return res.status(400).end('bad initData');
  }

  try {
    const url  = new URLSearchParams(raw);
    const hash = url.get('hash');
    url.delete('hash');

    /* -- HMAC -- */
    const dcs = [...url.entries()]
      .map(([k,v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    const secret = crypto
      .createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN)
      .digest();

    const calc  = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    if (calc !== hash) return res.status(401).end('bad hash');

    /* -- user -- */
    const user = JSON.parse(decodeURIComponent(url.get('user') || '%7B%7D'));
    if (!admins.includes(String(user.id))) {
      return res.status(403).end('not an admin');
    }

    req.tgUser = user;
    next();
  } catch (e) {
    console.error('initData parse error:', e);
    res.status(400).end('bad initData');
  }
}
