// 텔레그램 봇 연결 (한 번만)
//   1) 텔레그램에서 @BotFather → /newbot → 토큰 받기
//   2) node setup-bot.mjs <토큰>
//   3) 새 봇 채팅방에서 아무 말이나 보내기 → .env 에 채팅방이 저장된다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const token = process.argv[2];
if (!token || !/^\d+:[\w-]+$/.test(token)) { console.error('사용법: node setup-bot.mjs <BotFather 토큰>'); process.exit(1); }
const api = (m, p = {}) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
}).then(r => r.json());

const me = await api('getMe');
if (!me.ok) { console.error('✗ 토큰이 맞지 않습니다:', me.description); process.exit(1); }
console.log(`✓ 봇 @${me.result.username}`);
console.log(`→ 텔레그램에서 t.me/${me.result.username} 를 열고 아무 메시지나 보내세요. (3분 대기)`);

let chat = null, offset = 0;
const until = Date.now() + 180e3;
while (!chat && Date.now() < until) {
  const u = await api('getUpdates', { offset, timeout: 25 });
  for (const x of u.result || []) {
    offset = x.update_id + 1;
    const c = (x.message || x.channel_post || {}).chat;
    if (c) chat = c;
  }
}
if (!chat) { console.error('✗ 메시지를 못 받았습니다. 다시 실행하세요.'); process.exit(1); }
await api('getUpdates', { offset });   // 받은 메시지 소진

const envPath = path.join(DIR, '.env');
const keep = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n').filter(l => l && !/^TELEGRAM_(BOT_TOKEN|CHAT_ID)=/.test(l)) : [];
fs.writeFileSync(envPath, [`TELEGRAM_BOT_TOKEN=${token}`, `TELEGRAM_CHAT_ID=${chat.id}`, ...keep].join('\n') + '\n', { mode: 0o600 });
await api('sendMessage', { chat_id: chat.id, text: 'Connected. Korean Opshnz weekly reports will arrive here.' });
console.log(`✓ 채팅방 ${chat.title || chat.first_name || ''} (${chat.id}) 저장 → .env`);
console.log('이제: node publish.mjs');
