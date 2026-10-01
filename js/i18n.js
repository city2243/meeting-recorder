/*
 * i18n.js —— 中文／英文即時切換
 *
 * 做法：頁面程式照舊寫中文；這支用 MutationObserver 盯著畫面上的文字，
 * 語言是英文時，把每一段文字換成英文。切回中文時把原文還回去。
 *
 * 為什麼不改成每個字串都包 t()：全站近九百段中文，散在五個頁面、七支程式、
 * 伺服器產生的頁面裡。在「顯示」這一層統一翻，漏網的最多是某段維持中文，
 * 不會讓功能壞掉；而且切換不用重新載入，錄影中切換也不會中斷。
 *
 * 不在畫面上的字串（確認視窗、桌面通知、存檔檔名、報告檔內容）才需要呼叫 t()／tText()。
 *
 * 翻譯表在 i18n-en.js（由 tools/build_i18n.py 從抽出的字串與翻譯產生）。
 */

const LANG_KEY = 'meetingRecorder.lang';
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const NO_CJK = '[^\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]';
// 這些地方是檔名、授權碼、使用者自己輸入的東西，不翻
const SKIP = '[translate="no"], .fn, .sc-fileline, .k, .urlbox, code, script, style, textarea';
const ATTRS = ['placeholder', 'title', 'aria-label'];

let lang = detect();
let EXACT = null;          // Map zh → en
let PIECES = [];           // [zh, en] 依長度由長到短，給片段替換用
let PATS = [];             // [{ re, reLoose, en }]
const cache = new Map();

const origText = new WeakMap();   // Text 節點 → 中文原文
const wroteText = new WeakMap();  // Text 節點 → 我們寫進去的英文（用來分辨是不是自己觸發的變動）
const origAttr = new WeakMap();   // Element → { attr: 中文原文 }
let observer = null;
let origTitle = null;

function detect() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch (e) {}
  return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
}

export function getLang() { return lang; }

/* ─────────── 翻譯表 ─────────── */
async function loadDict() {
  if (EXACT) return;
  // 網路抖一下翻譯表就載不到，整頁會停在中文。實測兩種：連線被重設（直接失敗），
  // 以及請求卡住永遠不回（import 一直 pending）。所以每次都限時 4 秒，失敗或逾時就換網址重試，最多四次。
  const limit = (pr, ms) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('i18n dict timeout')), ms))]);
  let mod = null, lastErr = null;
  for (let i = 0; i < 4 && !mod; i++) {
    try { mod = await limit(import(i ? `./i18n-en.js?retry=${i}_${Date.now()}` : './i18n-en.js'), 4000); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  if (!mod) throw lastErr;
  EXACT = new Map(Object.entries(mod.EXACT));
  PIECES = [...EXACT.entries()].filter(([zh]) => zh.length >= 2)
    .map(([zh, en]) => [zh, /[：:]$/.test(zh) && !/\s$/.test(en) ? en + ' ' : en])
    .sort((a, b) => b[0].length - a[0].length);
  PATS = mod.PATTERNS.map(([zh, en]) => {
    const parts = zh.split(/\{(\d+)\}/);   // 奇數位置是佔位編號
    let re = '^', loose = '';
    const order = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        const lit = parts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re += lit; loose += lit;
      } else {
        order.push(parts[i]);
        const last = i === parts.length - 2 && parts[parts.length - 1] === '';
        re += '(.+?)';
        loose += last ? `(${NO_CJK}+)` : `(${NO_CJK}+?)`;
      }
    }
    re += '$';
    const lit = zh.replace(/\{\d+\}/g, '');
    return { re: new RegExp(re), loose: new RegExp(loose, 'g'), order, en, litLen: lit.length, strong: /[\u3400-\u9fff]/.test(lit) };
  }).filter((p) => p.strong).sort((a, b) => b.litLen - a.litLen);
}

function fill(en, order, groups, deep) {
  return en.replace(/\{(\d+)\}/g, (m, n) => {
    const i = order.indexOf(n);
    const g = i >= 0 ? groups[i] : '';
    return deep ? tr(g) : g;
  });
}

/** 把一段中文換成英文。找不到就原樣回傳。 */
function tr(s) {
  if (lang !== 'en' || !EXACT || !s || !CJK.test(s)) return s;
  if (cache.has(s)) return cache.get(s);

  const lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
  // HTML 原始碼裡的段落常有換行縮排，翻譯表的 key 是壓成單一空白的版本
  const core = s.trim().replace(/\s+/g, ' ');
  let out = null;

  // 1. 整段完全吻合
  if (EXACT.has(core)) out = EXACT.get(core);

  // 2. 事件紀錄的時間戳、多場版的「場次名｜訊息」：先拆開，各自翻
  if (out === null) {
    const m = /^(\[\d\d:\d\d:\d\d\]\s*)(.+)$/.exec(core);
    if (m) out = m[1] + tr(m[2]);
  }
  // 3. 樣板整段吻合（變數位置可以重排，變數本身再翻一次）；要比「｜」拆段先做，
  //    否則像「fps 目標 …｜前景 …」這種本身含「｜」的樣板會被當成場次名拆掉
  if (out === null) {
    for (const p of PATS) {
      const m = p.re.exec(core);
      if (m) { out = fill(p.en, p.order, m.slice(1), true); break; }
    }
  }
  if (out === null && core.includes('｜')) {
    const i = core.indexOf('｜');
    out = core.slice(0, i) + ' | ' + tr(core.slice(i + 1));   // 場次名是使用者取的，不翻
  }

  // 4. 片段替換（字串相接產生的句子），再用寬鬆樣板收尾，最後整理標點
  if (out === null) {
    let x = core;
    for (const [zh, en] of PIECES) if (x.includes(zh)) x = x.split(zh).join(en);
    if (CJK.test(x)) for (const p of PATS) { p.loose.lastIndex = 0; x = x.replace(p.loose, (...m) => fill(p.en, p.order, m.slice(1, 1 + p.order.length), false)); }
    out = tidy(x);
  }

  const res = lead + out + tail;
  cache.set(s, res);
  return res;
}

/** 片段拼起來後的標點整理：全形換半形、冒號後與括號前補空格 */
function tidy(x) {
  return x.replace(/，/g, ', ').replace(/。/g, '. ').replace(/：/g, ': ').replace(/；/g, '; ')
    .replace(/（/g, ' (').replace(/）/g, ') ').replace(/「|」/g, '"').replace(/、/g, ', ')
    .replace(/！/g, '! ').replace(/？/g, '? ').replace(/　/g, ' ')
    .replace(/上午\s*(\d{1,2}:\d\d(?::\d\d)?)/g, '$1 AM').replace(/下午\s*(\d{1,2}:\d\d(?::\d\d)?)/g, '$1 PM')
    .replace(/([A-Za-z0-9])\(/g, '$1 (')          // webm(including → webm (including
    .replace(/:(?=[A-Za-z])/g, ': ')                // captured:Media → captured: Media（網址的 :// 不受影響）
    .replace(/\s+([,.;:)!?])/g, '$1').replace(/\(\s+/g, '(').replace(/\s{2,}/g, ' ').trim();
}

/** 日期時間：用中英通用的 2026-09-30 16:05，不必翻譯，也不會冒出「下午」 */
export function fmtWhen(ms, withTime = true) {
  if (!ms) return '—';
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
}

/** 給程式用：不在畫面上的字串（確認視窗、通知、檔名） */
export function t(s) { return tr(s); }

/**
 * 檔名用詞。檔名在錄影開始那一刻就決定，不能等翻譯表載入，所以寫死在這裡。
 * 用開始錄影當下的語言：中文介面錄的檔名是中文，英文介面錄的是英文。
 */
const FILE_WORDS = {
  '會議錄影': 'Meeting', '音訊備份': 'audio-backup', '健康紀錄': 'health-log',
  '音訊': 'audio', '實測報告': 'test-report', '會議': 'Meeting',
};
export function fw(zh) { return lang === 'en' ? (FILE_WORDS[zh] || zh) : zh; }
export function partSuffix(n) { return lang === 'en' ? `_part${n}` : `_第${n}段`; }

/** 給程式用：多行文字（報告檔），逐行翻 */
export function tText(text) {
  if (lang !== 'en') return text;
  return String(text).split(/\r?\n/).map((l) => tr(l)).join(text.includes('\r\n') ? '\r\n' : '\n');
}

/* ─────────── 套用到畫面 ─────────── */
function skip(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !el || !!el.closest(SKIP);
}

function doText(node) {
  if (skip(node)) return;
  const cur = node.data;
  if (lang === 'en') {
    if (wroteText.get(node) === cur) return;          // 是我們自己剛寫進去的，不要再翻一次
    if (!CJK.test(cur)) return;
    origText.set(node, cur);
    const en = tr(cur);
    if (en !== cur) { wroteText.set(node, en); node.data = en; }
  } else if (origText.has(node)) {
    const zh = origText.get(node);
    origText.delete(node); wroteText.delete(node);
    if (node.data !== zh) node.data = zh;
  }
}

const wroteAttr = new WeakMap();  // Element → { attr: 我們寫進去的英文 }

/*
 * 屬性一定要有防重入保護：setAttribute 就算值完全沒變也會觸發 MutationObserver。
 * 曾經因為一段沒有譯文的 placeholder（翻完仍含中文）→ 寫回 → 觸發 → 再翻 → 再寫回，
 * 把整頁主執行緒卡死（英文模式下的多場版）。
 */
function doAttrs(el) {
  if (skip(el)) return;
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const saved = origAttr.get(el) || {};
    const wrote = wroteAttr.get(el) || {};
    const cur = el.getAttribute(a);
    if (lang === 'en') {
      if (wrote[a] === cur) continue;               // 自己剛寫的
      if (!CJK.test(cur)) continue;
      const en = tr(cur);
      if (en === cur) continue;   // 沒翻到（例如翻譯表還在載）就不要記成「處理過」，翻譯表到了之後還要再翻
      saved[a] = cur; origAttr.set(el, saved);
      wrote[a] = en; wroteAttr.set(el, wrote);   // 記住是自己寫的：setAttribute 會再觸發 observer，靠這個擋掉無限迴圈
      el.setAttribute(a, en);
    } else if (saved[a] != null) {
      const zh = saved[a];
      delete saved[a]; delete wrote[a];
      if (el.getAttribute(a) !== zh) el.setAttribute(a, zh);
    }
  }
}

function walkTree(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  if (root.nodeType === 1) doAttrs(root);
  let n;
  while ((n = w.nextNode())) {
    if (n.nodeType === 3) doText(n); else doAttrs(n);
  }
}

function applyTitle() {
  if (origTitle === null) origTitle = document.title;
  if (lang === 'en') document.title = tr(origTitle);
  else document.title = origTitle;
}

function observe() {
  if (observer) return;
  observer = new MutationObserver((muts) => {
    if (lang !== 'en') return;
    for (const m of muts) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else for (const n of m.addedNodes) walkTree(n);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  // 頁面自己改標題時（例如錄影異常閃爍）也要跟著翻
  const titleEl = document.querySelector('title');
  if (titleEl) new MutationObserver(() => {
    if (lang !== 'en') return;
    const cur = document.title;
    if (!CJK.test(cur)) return;
    origTitle = cur; document.title = tr(cur);
  }).observe(titleEl, { childList: true, characterData: true, subtree: true });
}

export async function setLang(next) {
  if (next !== 'en' && next !== 'zh') return;
  lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch (e) {}
  if (next === 'en') await loadDict();
  cache.clear();
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-Hant';
  walkTree(document.body);
  applyTitle();
  paintToggle();
  window.dispatchEvent(new CustomEvent('mr-lang', { detail: next }));
}

/* ─────────── 切換鈕：頂欄右側「中文｜EN」 ─────────── */
let toggle = null;
const TOGGLE_CSS = `
.langswitch{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:#080B10;border:1px solid #2B3543;flex:none}
.langswitch button{font:inherit;font-size:12px;font-weight:500;line-height:1;padding:6px 10px;border:0;border-radius:7px;
  background:transparent;color:#8895A8;cursor:pointer;font-family:"IBM Plex Sans","Microsoft JhengHei UI",system-ui,sans-serif}
.langswitch button:hover{color:#E7ECF3}
.langswitch button.on{background:#2A3442;color:#E7ECF3;box-shadow:0 1px 2px rgba(0,0,0,.4);cursor:default}
.langswitch button:focus-visible{outline:2px solid #5AC8D8;outline-offset:1px}
.langswitch.floating{position:fixed;top:14px;right:16px;z-index:50}`;

function mountToggle() {
  if (toggle) return;
  if (!document.getElementById('langswitch-css')) {
    const st = document.createElement('style');
    st.id = 'langswitch-css';
    st.textContent = TOGGLE_CSS;
    document.head.appendChild(st);
  }
  toggle = document.createElement('div');
  toggle.className = 'langswitch';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Language');
  toggle.setAttribute('translate', 'no');
  toggle.innerHTML = '<button type="button" data-l="zh">中文</button><button type="button" data-l="en">EN</button>';
  toggle.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-l]');
    if (b && b.dataset.l !== lang) setLang(b.dataset.l);
  });
  const right = document.querySelector('.rail-right');
  if (right) right.prepend(toggle);
  else { toggle.classList.add('floating'); document.body.appendChild(toggle); }
  paintToggle();
}
function paintToggle() {
  if (!toggle) return;
  for (const b of toggle.querySelectorAll('button')) {
    const on = b.dataset.l === lang;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function reveal() { document.documentElement.classList.remove('i18n-pending'); }

// 翻譯表一載入就開始抓，不等 DOMContentLoaded；兩秒保險：翻譯表載不到也不能讓頁面一直空白
const dictReady = lang === 'en' ? loadDict().catch((e) => console.warn('i18n dict', e)) : Promise.resolve();
setTimeout(reveal, 2000);

async function boot() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
  mountToggle();
  observe();
  if (lang === 'en') {
    await dictReady;
    walkTree(document.body);
    applyTitle();
  }
  reveal();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
