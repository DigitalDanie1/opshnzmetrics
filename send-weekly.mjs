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
const lines = [`OPSHNZ · ${file}`, research.week || file, `${research.projects.length}개 프로젝트 검토 · ${updated.length}개 소식 반영`, '', ...updated.map(p => `${p.name}: ${p.note}`), '', `Trader views ${research.traderViews.items.length}건`, ...research.traderViews.items.map(v => `${v.publisher}: ${v.title}\n${v.url}`), '', '출처별 확인 한계는 웹사이트 Source coverage에서 확인하세요.', 'https://opshnz.com/#/trader-views'];
// Derive the calendar label from the research record on future runs.
const c = research.coverage;
if (c.from && c.toExclusive) lines[1] = `${c.from.slice(0,10)} ~ ${new Date(Date.parse(c.toExclusive)-86400000).toISOString().slice(0,10)} KST`;
let text = lines.join('\n');
if (text.length > 4000) text = lines.slice(0,4).join('\n') + '\n\n자세한 소식과 출처:\nhttps://opshnz.com/#/trader-views';
const sent = await api('sendMessage', {chat_id: chat, text, disable_web_page_preview:true});
console.log(JSON.stringify({sent:true, bot:bot.username, messageId:sent.message_id, week:file}));
