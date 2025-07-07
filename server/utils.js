import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not set');

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
export const JWT_LIFE   = '30d';

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  max     : 60,
});

export function userAuth(req, res, next){
  try{
    const token =
      req.cookies?.sid || (req.get('Authorization') || '').replace('Bearer ','');
    if(!token) return res.status(401).json({ error: 'no token' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  }catch{
    return res.status(401).json({ error: 'invalid token' });
  }
}

export function adminAuth(req, res, next){
  const token = req.get('X-Admin-Token');
  if (token !== ADMIN_TOKEN) return res.sendStatus(403);
  next();
}
