// 빠른 재빌드: 시세는 다시 받지 않고, 마지막 스냅샷 + 지금 data.json 의 글(메모·딥다이브)로 index.html 만 다시 만든다.
// 편집기(editor.mjs)가 저장할 때 부른다.  단독 실행:  node rebuild.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// 스냅샷 위에 덮어쓸 "사람이 쓰는" 칸들
const TEXT_FIELDS = ['what', 'keywords', 'note', 'deep', 'points', 'pointsUrl', 'status', 'lineage', 'origin', 'home', 'site', 'x', 'logo', 'core', 'app', 'since', 'isNew', 'backers'];

export function rebuild() {
  const read = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const data = read('data.json');
  const snapDir = path.join(DIR, 'snapshots');
  const files = fs.readdirSync(snapDir).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).sort();
  if (!files.length) throw new Error('스냅샷이 없습니다. 먼저 node publish.mjs --dry');
  const snap = JSON.parse(fs.readFileSync(path.join(snapDir, files[files.length - 1]), 'utf8'));
  const byName = Object.fromEntries(data.projects.map(p => [p.name, p]));
  // 사람이 지울 수 있는 칸만 지운다. 로고·체인 같은 건 data.json 에 없으면 스냅샷 값(자동 수집)을 그대로 둔다
  const ERASABLE = new Set(['note', 'deep', 'points', 'pointsUrl', 'status']);
  snap.projects = snap.projects.map(p => { const c = byName[p.name]; if (!c) return p; const o = { ...p }; for (const k of TEXT_FIELDS) if (k in c) o[k] = c[k]; else if (ERASABLE.has(k)) delete o[k]; return o; });
  snap.headline = data.headline || snap.headline;
  if (fs.existsSync(path.join(DIR, 'sentiment.json'))) snap.sentLog = read('sentiment.json');
  const history = files.map(f => JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')))
    .map(({ race, fund, signals, dm, macro, sentLog, majorsHist, ...s }) => ({ ...s, projects: s.projects.map(({ spark, ...p }) => p) }));
  const opt = f => fs.existsSync(path.join(DIR, f)) ? read(f) : null;
  const content = opt('content.json') || { items: [] }, refs = opt('refs.json') || { refs: {}, farms: [] }, shots = opt('shots/index.json') || {};
  const inline = o => JSON.stringify(o).replace(/</g, '\\u003c');
  const tpl = fs.readFileSync(path.join(DIR, 'template.html'), 'utf8');
  const collectSrc = fs.readFileSync(path.join(DIR, 'collect.js'), 'utf8');
  const html = tpl.replace('/*__COLLECT__*/', () => collectSrc)
    .replace('/*__DATA__*/null', () => inline({ snapshot: snap, history, config: data, content, refs, shots }));
  if (!html.includes('"snapshot"')) throw new Error('빌드 실패: 데이터 자리표시자를 못 찾음');
  fs.writeFileSync(path.join(DIR, 'index.html'), html);
  return path.join(DIR, 'index.html');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('✓ 재빌드', rebuild());
