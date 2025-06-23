import crypto from 'crypto';
import dotenv  from 'dotenv';
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_IDS = '' } = process.env;
const admins = ADMIN_IDS.split(',').map(x => x.trim());

export function verifyAdmin(req, res, next) {
  // 1) Base64 → raw (тот же, что WebApp.initData)
  const b64 = req.headers['x-tg-init-data-b64'];
  if (!b64) return res.status(400).end('missing initData');

  let raw;
  try {
    raw = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return res.status(400).end('bad initData');
  }

  console.log('[DEBUG initData raw]>', raw);  // логируем для проверки

  try {
    // 2) Разбираем все ключи/значения
    const url = new URLSearchParams(raw);
    const hash = url.get('hash');
    url.delete('hash');

    // 🛠 **Вот ключ**: удаляем лишний ключ, мешающий HMAC
    url.delete('signature');

    // 3) Собираем data_check_string (оставшиеся URL-encoded)
    const dcs = [...url.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    // 4) Проверяем HMAC-SHA256
    const secret = crypto
      .createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN)
      .digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    if (calc !== hash) return res.status(401).end('bad hash');

    // 5) Наконец достаём пользователя
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
