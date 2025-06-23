// auth.js
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_IDS = '' } = process.env;
const admins = ADMIN_IDS.split(',').map(x => x.trim());

export function verifyAdmin(req, res, next) {
  // ① берём initData либо из заголовка, либо из query
  let raw = req.headers['x-telegram-init-data']
         || req.query.initData
         || '';

  // ② если пришло из query → Express уже один раз раскодировал %3D → '='
  //    но внутри всё ещё закодировано вторым слоем.  Декодируем сами ↓
  if (req.query.initData) raw = decodeURIComponent(raw);

  try {
    const url = new URLSearchParams(raw);      // теперь строка правильная
    const hash = url.get('hash');
    url.delete('hash');

    const dataCheckString = [...url.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

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

    req.tgUser = user;
    next();
  } catch (e) {
    console.error('initData parse error:', e);
    res.status(400).end('bad initData');
  }
}
