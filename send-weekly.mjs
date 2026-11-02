// Send the verified weekly research summary, without recollecting or rebuilding data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const updated = research.projects.filter(p => p.note);
const c = research.coverage;
const period = c.from && c.toExclusive
  ? `${c.from.slice(5,10).replace('-', '/')}–${new Date(Date.parse(c.toExclusive)-86400000).toISOString().slice(5,10).replace('-', '/')} KST`
  : file;
const highlights = updated.slice(0, 3).map(p => `• ${p.name}: ${p.note}`);
const text = [
  `OPSHNZ 주간 업데이트 · ${period}`,
  `${research.projects.length}개 검토 · 소식 ${updated.length}건 · Trader views ${research.traderViews.items.length}건`,
  '', ...highlights, '',
  '전체 소식 → https://opshnz.com/#/overview',
  '시장 관점 → https://opshnz.com/#/trader-views'
].join('\n');
const kinds = ['benchmark', 'movers', 'signals'];
const images = kinds.map(kind => path.join(dir, 'share', `${file}-${kind}.png`));
for (const image of images) {
  if (!fs.existsSync(image) || Date.now() - fs.statSync(image).mtimeMs > 86400000)
    throw new Error('Three fresh weekly images required: ' + path.basename(image));
  if (!fs.readFileSync(image).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && !fs.readFileSync(image).subarray(0,3).equals(Buffer.from([255,216,255])))
    throw new Error('Invalid PNG: ' + path.basename(image));
}
const form = new FormData();
form.set('chat_id', chat);
form.set('media', JSON.stringify(kinds.map((kind,i) => ({type:'photo', media:`attach://${kind}`, ...(i===0 ? {caption:`OPSHNZ · ${period}\n벤치마크 · 가격 변화 · 시그널\nhttps://opshnz.com`} : {})}))));
images.forEach((image,i) => form.set(kinds[i], new Blob([fs.readFileSync(image)], {type:fs.readFileSync(image)[0]===255?'image/jpeg':'image/png'}), path.basename(image)));
const response = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {method:'POST', body:form, signal:AbortSignal.timeout(60000)});
const album = await response.json();
if (!album.ok || album.result?.length !== 3) throw new Error(`Telegram image album failed (${album.error_code || response.status})`);
console.log(JSON.stringify({imagesSent:3,messageIds:album.result.map(m=>m.message_id),week:file}));
if (!process.argv.includes('--images-only')) {
  const sent = await api('sendMessage', {chat_id: chat, text, disable_web_page_preview:true});
  console.log(JSON.stringify({sent:true, bot:bot.username, messageId:sent.message_id, week:file}));
}
