import express from 'express';
import crypto from 'crypto';
import { apiLimiter, userAuth } from './utils.js';
import { balances, saveBalances, withdrawals, saveWithdrawals, addrMap, saveAddr, txs, saveTx } from './storage.js';

export const wallet = express.Router();
wallet.use(apiLimiter, userAuth);

wallet.get('/balance', (req, res) => {
  const bal = balances[req.userId] || 0;
  res.json({ balance: bal });
});

wallet.post('/withdraw', async (req, res) => {
  const amt = Number(req.body.amount);
  if (!amt || amt <= 0)  return res.status(400).json({ error: 'amount>0' });
  const bal = balances[req.userId] || 0;
  if (bal < amt)         return res.status(400).json({ error: 'insufficient' });

  const toAddr = addrMap[req.userId];
  if (!toAddr) return res.status(400).json({ error: 'no linked address' });

  balances[req.userId] = bal - amt;
  await saveBalances();

  const id = crypto.randomUUID();
  withdrawals.push({
    id, userId: req.userId, amount: amt, to: toAddr,
    ts: Date.now(), status: 'pending'
  });
  await saveWithdrawals();

  txs.push({
    userId : req.userId,
    type   : 'withdraw',
    amount : amt,
    ts     : Date.now(),
    status : 'pending'
  });
  await saveTx();

  res.json({ balance: balances[req.userId], wid: id });
});

wallet.post('/link', async (req,res)=>{
  const {address} = req.body || {};
  if(!address) return res.status(400).json({error:'address required'});
  addrMap[req.userId] = address;
  await saveAddr();
  res.json({ ok:true, address });
});

wallet.get('/history', (req,res)=>{
  const lim = Math.min( Number(req.query.limit||50), 200);
  const list = txs
      .filter(t=>t.userId===req.userId)
      .slice(-lim)
      .reverse();
  res.json(list);
});
