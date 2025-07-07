import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || '/data';

export const HISTORY_FILE  = path.join(DATA_DIR, 'history.json');
export const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');
export const TX_FILE       = path.join(DATA_DIR, 'transactions.json');
export const WD_FILE       = path.join(DATA_DIR, 'withdrawals.json');
export const ADDR_FILE     = path.join(DATA_DIR, 'addresses.json');

await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});

export let history = [];
export let balances = {};
export let txs = [];
export let withdrawals = [];
export let addrMap = {};

export async function loadHistory(){
  try{
    history = JSON.parse(await fs.readFile(HISTORY_FILE,'utf8'));
  }catch(e){
    if(e.code!=="ENOENT") console.error('History read error:',e);
    history=[];
  }
}

export async function saveHistory(){
  const tmp = HISTORY_FILE+'.tmp';
  await fs.writeFile(tmp, JSON.stringify(history,null,2));
  await fs.rename(tmp, HISTORY_FILE);
}

export async function loadBalances(){
  try{
    balances = JSON.parse(await fs.readFile(BALANCES_FILE,'utf8'));
  }catch(e){
    if(e.code!=="ENOENT") console.error('Balances read error:',e);
    balances={};
  }
}

export async function saveBalances(){
  const tmp = BALANCES_FILE+'.tmp';
  await fs.writeFile(tmp, JSON.stringify(balances,null,2));
  await fs.rename(tmp, BALANCES_FILE);
}

export async function loadTx(){
  try{
    txs = JSON.parse(await fs.readFile(TX_FILE,'utf8'));
  }catch(e){ if(e.code!=="ENOENT") console.error(e); txs=[]; }
}

export async function saveTx(){
  const tmp = TX_FILE+'.tmp';
  await fs.writeFile(tmp, JSON.stringify(txs,null,2));
  await fs.rename(tmp, TX_FILE);
}

export async function loadWithdrawals(){
  try{
    withdrawals = JSON.parse(await fs.readFile(WD_FILE,'utf8'));
  }catch(e){ if(e.code!=="ENOENT") console.error(e); withdrawals=[]; }
}

export async function saveWithdrawals(){
  const tmp = WD_FILE+'.tmp';
  await fs.writeFile(tmp, JSON.stringify(withdrawals,null,2));
  await fs.rename(tmp, WD_FILE);
}

export async function loadAddr(){
  try{ addrMap = JSON.parse(await fs.readFile(ADDR_FILE,'utf8')); }
  catch(e){ if(e.code!=="ENOENT") console.error(e); addrMap={}; }
}

export async function saveAddr(){
  const tmp = ADDR_FILE+'.tmp';
  await fs.writeFile(tmp, JSON.stringify(addrMap,null,2));
  await fs.rename(tmp, ADDR_FILE);
}
