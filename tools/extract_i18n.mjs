// 抽出會議錄影守門員全站所有「使用者看得到」的中文字串。
// 程式註解不抽（用 acorn 解析，只拿字串字面值與樣板字串）。
// 輸出 units.json：[{ id, zh, kind: 'exact'|'pattern', src }]
//   exact   = 整段固定文字
//   pattern = 樣板字串，${...} 以 {1} {2} 佔位
import { readFileSync, writeFileSync } from 'fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = 'D:/claude code/meeting-recorder/';
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

const units = new Map(); // key: kind + '\u0000' + zh
function add(zh, kind, src) {
  if (!zh) return;
  // 標籤裡的 placeholder / title / aria-label 也是使用者看得到的文字
  for (const m of String(zh).matchAll(/\s(?:placeholder|title|aria-label)="([^"]*)"/g)) {
    if (CJK.test(m[1])) add(m[1], 'exact', src + '@attr');
  }
  // 以 HTML 標籤切段：innerHTML 字串在執行時會拆成多個文字節點
  const pieces = String(zh).split(/<[^>]+>/);
  for (let piece of pieces) {
    piece = piece.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!piece || !CJK.test(piece)) continue;
    const k = kind + '\u0000' + piece;
    if (!units.has(k)) units.set(k, { zh: piece, kind: kind === 'pattern' && /\{\d+\}/.test(piece) ? 'pattern' : 'exact', src: [] });
    const u = units.get(k);
    if (u.src.length < 3) u.src.push(src);
  }
}

function fromJS(code, file) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowReturnOutsideFunction: true });
  } catch (e) {
    console.error('PARSE FAIL', file, e.message);
    return;
  }
  walk.full(ast, (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string' && CJK.test(n.value)) {
      add(n.value, 'exact', `${file}:${n.loc.start.line}`);
    }
    if (n.type === 'TemplateLiteral') {
      const text = n.quasis.map((q, i) => q.value.cooked + (i < n.expressions.length ? `{${i + 1}}` : '')).join('');
      if (CJK.test(text)) add(text, n.expressions.length ? 'pattern' : 'exact', `${file}:${n.loc.start.line}`);
    }
  });
}

// ── HTML：文字節點＋可見屬性；內嵌 <script> 交給 JS 解析
function fromHTML(html, file) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const m of scripts) fromJS(m[1], file + '<script>');
  let body = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  // 屬性
  for (const m of body.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g)) {
    if (CJK.test(m[1])) add(m[1], 'exact', file + '@attr');
  }
  // <title>
  const t = body.match(/<title>([\s\S]*?)<\/title>/);
  if (t) add(t[1], 'exact', file + '@title');
  // 文字節點：以標籤切開
  const text = body.replace(/<title>[\s\S]*?<\/title>/, ' ');
  for (const piece of text.split(/<[^>]+>/)) {
    const p = piece.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    if (p && CJK.test(p)) add(p, 'exact', file);
  }
}

const HTML = ['artifact.html', 'multi.html', 'pricing.html', 'account.html', 'terms.html'];
const JS = ['js/app.js', 'js/multi.js', 'js/slot.js', 'js/checks.js', 'js/media.js', 'js/storage.js', 'js/license.js', 'worker/index.js'];

for (const f of HTML) fromHTML(readFileSync(ROOT + f, 'utf8'), f);
for (const f of JS) fromJS(readFileSync(ROOT + f, 'utf8'), f);

// 伺服器端 console.log 只給開發者看，不必翻
const out = [...units.values()]
  .filter((u) => !u.src.every((s) => s.startsWith('worker/index.js')) || !/^(queryTrade|queryPeriod|periodCancel|sweep|unhandled)/.test(u.zh))
  .map((u, i) => ({ id: 'u' + String(i + 1).padStart(4, '0'), ...u }));

writeFileSync(process.argv[2] || 'units.json', JSON.stringify(out, null, 1), 'utf8');
const pat = out.filter((u) => u.kind === 'pattern').length;
const chars = out.reduce((a, u) => a + u.zh.length, 0);
console.log(`units: ${out.length} (exact ${out.length - pat}, pattern ${pat}), total chars ${chars}`);
