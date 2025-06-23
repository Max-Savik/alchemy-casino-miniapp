import crypto from 'crypto';
import dotenv  from 'dotenv';
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_IDS = '' } = process.env;
const admins = ADMIN_IDS.split(',').map(x => x.trim());

export function verifyAdmin(req, res, next) {
  const b64 = req.headers['x-tg-init-data-b64'];
  if (!b64) return res.status(400).end('missing initData');

  let raw;
  try {
    raw = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return res.status(400).end('bad initData');
  }

  try {
    const url    = new URLSearchParams(raw);
    const hash   = url.get('hash');
    url.delete('hash');
    url.delete('signature');  // если был

    // 1) Правильный secret: HMAC-SHA256(key=BOT_TOKEN, msg="WebAppData")
    const secret = crypto
      .createHmac('sha256', TELEGRAM_BOT_TOKEN)
      .update('WebAppData')
      .digest();

    // 2) Data-check-string из оставшихся полей (URL-encoded!)
    const dcs = [...url.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    // 3) Считаем HMAC-SHA256(key=secret, msg=dcs)
    const calc = crypto
      .createHmac('sha256', secret)
      .update(dcs)
      .digest('hex');

    if (calc !== hash) return res.status(401).end('bad hash');

    // 4) Достаем user
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
