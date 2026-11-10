// Send the verified weekly research summary, without recollecting or rebuilding data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { weeklyReport } from './weekly-report.mjs';
const dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
const local = path.join(dir, '.env');
if (fs.existsSync(local)) for (const line of fs.readFileSync(local, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
Object.assign(env, process.env);
const file = process.argv[2];
if (!file || !/^\d{4}-W\d{2}$/.test(file)) throw new Error('Usage: node send-weekly.mjs YYYY-Www');
const research = JSON.parse(fs.readFileSync(path.join(dir, 'research/weekly', file + '.json'), 'utf8'));
const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
if (!token || !chat) throw new Error('Weekly report NOT sent: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.');
async function api(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} failed (${result.error_code || response.status})`);
  return result.result;
}
const bot = await api('getMe', {});
if (bot.username?.toLowerCase() !== 'wenojadaniel_options_bot') throw new Error('Bot identity mismatch; nothing sent.');
const {period,text}=weeklyReport(research);
const kinds = ['benchmark', 'movers', 'signals'];
const images = kinds.map(kind => path.join(dir, 'share', `${file}-${kind}.png`));
for (const image of images) {
  if (!fs.existsSync(image) || Date.now() - fs.statSync(image).mtimeMs > 86400000)
    throw new Error('Three fresh weekly images required: ' + path.basename(image));
  if (!fs.readFileSync(image).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && !fs.readFileSync(image).subarray(0,3).equals(Buffer.from([255,216,255])))
    throw new Error('Invalid PNG: ' + path.basename(image));
}
const receiptDir=path.join(dir,'logs','telegram'); fs.mkdirSync(receiptDir,{recursive:true});
const receiptFile=path.join(receiptDir,`${file}.json`);
let receipt=fs.existsSync(receiptFile)?JSON.parse(fs.readFileSync(receiptFile,'utf8')):{week:file,bot:bot.username};
const save=()=>fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
if(!receipt.imageMessageIds) {
const form = new FormData();
form.set('chat_id', chat);
form.set('media', JSON.stringify(kinds.map((kind,i) => ({type:'photo', media:`attach://${kind}`, ...(i===0 ? {caption:`OPSHNZ · ${period}\n벤치마크 · 가격 변화 · 시그널\nhttps://opshnz.com`} : {})}))));
images.forEach((image,i) => form.set(kinds[i], new Blob([fs.readFileSync(image)], {type:fs.readFileSync(image)[0]===255?'image/jpeg':'image/png'}), path.basename(image)));
const response = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {method:'POST', body:form, signal:AbortSignal.timeout(60000)});
const album = await response.json();
if (!album.ok || album.result?.length !== 3) throw new Error(`Telegram image album failed (${album.error_code || response.status})`);
receipt.imageMessageIds=album.result.map(m=>m.message_id);receipt.albumSentAt=new Date().toISOString();save();
console.log(JSON.stringify({imagesSent:3,messageIds:receipt.imageMessageIds,week:file}));
}
if (!process.argv.includes('--images-only') && !receipt.summaryMessageId) {
  const sent = await api('sendMessage', {chat_id: chat, text, disable_web_page_preview:true});
  receipt.summaryMessageId=sent.message_id;receipt.summarySentAt=new Date().toISOString();save();
  console.log(JSON.stringify({sent:true, bot:bot.username, messageId:sent.message_id, week:file}));
}
console.log(JSON.stringify({week:file,imagesSent:receipt.imageMessageIds?.length || 0,summarySent:!!receipt.summaryMessageId}));
