/*
 * multi.js —— 多場同時錄的控制層
 *
 * 刻意跟單場版（app.js）分開：單場版已經在用了，不想為了實驗把它弄壞。
 * 共用的部分都在 storage / media / checks / slot 四個模組裡，沒有重複實作錄影邏輯。
 * 等這一版實測穩了再把兩頁合起來。
 */

import * as S from './storage.js';
import * as M from './media.js';
import * as C from './checks.js';
import { Slot } from './slot.js';

const $ = (id) => document.getElementById(id);
const el = {
  statusDot: $('statusDot'), statusText: $('statusText'), timer: $('timer'),
  btnMark: $('btnMark'), btnStopAll: $('btnStopAll'),
  alertBar: $('alertBar'), alertIcon: $('alertIcon'), alertTitle: $('alertTitle'),
  alertDetail: $('alertDetail'), alertMute: $('alertMute'),
  setupCard: $('setupCard'), btnPickDir: $('btnPickDir'), btnUseSaved: $('btnUseSaved'),
  savedName: $('savedName'), dirLabel: $('dirLabel'),
  qualitySelect: $('qualitySelect'), expectMinutes: $('expectMinutes'),
  optVideo: $('optVideo'), optAlarm: $('optAlarm'), optNotify: $('optNotify'),
  budget: $('budget'),
  slotsCard: $('slotsCard'), slotList: $('slotList'), btnAddSlot: $('btnAddSlot'),
  slotHint: $('slotHint'), btnStartAll: $('btnStartAll'),
  doneCard: $('doneCard'), doneList: $('doneList'), btnAgain: $('btnAgain'),
  logBox: $('logBox'),
};

const PREF_KEY = 'meetingRecorder.multiPrefs';

const st = {
  slots: [],
  audioCtx: null,
  dirHandle: null, savedDir: null,
  phase: 'setup',          // setup | recording | done
  sid: '',
  startedAt: 0,
  ticker: null, fallbackTimer: null,
  lastTickAt: 0, maxLagMs: 0,
  muted: false, nextId: 1,
  titleFlash: null,
};

/* ---------------- 小工具 ---------------- */
const fmtDur = C.fmtDur;
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function clock() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const globalLog = [];
function log(kind, msg) {
  const line = msg.startsWith('[') ? msg : `[${clock()}] ${msg}`;
  globalLog.push(line);
  const d = document.createElement('div');
  d.className = 'l-' + kind;
  d.textContent = line;
  el.logBox.appendChild(d);
  el.logBox.scrollTop = el.logBox.scrollHeight;
  while (el.logBox.childNodes.length > 600) el.logBox.removeChild(el.logBox.firstChild);
}
function setStatus(text, dot) {
  el.statusText.textContent = text;
  el.statusDot.className = 'rec-dot' + (dot ? ' ' + dot : '');
}

/* ---------------- 警示彙整 ---------------- */
function renderAlerts() {
  let top = null;
  let count = 0;
  for (const s of st.slots) {
    const a = s.worstAlert;
    if (!a) continue;
    count += s.alerts.size;
    if (!top || (a.level === 'fatal' && top.level !== 'fatal')) top = a;
  }
  if (!top) {
    el.alertBar.hidden = true;
    stopTitleFlash();
    return;
  }
  el.alertBar.hidden = false;
  el.alertBar.className = 'alert' + (top.level === 'fatal' ? '' : ' soft');
  el.alertIcon.textContent = top.level === 'fatal' ? '✕' : '!';
  el.alertTitle.textContent = top.title;
  el.alertDetail.textContent = top.detail + (count > 1 ? `（另有 ${count - 1} 項待處理）` : '');
  if (top.level === 'fatal') {
    if (el.optAlarm.checked && !st.muted) M.beep(4, 950);
    notify('錄影出問題：' + top.title, top.detail);
    startTitleFlash('⚠ 錄影異常');
  }
}
function notify(title, body) {
  if (!el.optNotify.checked) return;
  try {
    if (window.Notification && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'meeting-multi', requireInteraction: true });
    }
  } catch (e) {}
}
let baseTitle = document.title;
function startTitleFlash(txt) {
  if (st.titleFlash) return;
  let on = false;
  st.titleFlash = setInterval(() => { document.title = (on = !on) ? txt : baseTitle; }, 800);
}
function stopTitleFlash() {
  if (st.titleFlash) { clearInterval(st.titleFlash); st.titleFlash = null; document.title = baseTitle; }
}

/* ---------------- 設定 ---------------- */
function prefs() {
  return {
    quality: el.qualitySelect.value,
    expectMinutes: Number(el.expectMinutes.value) || 90,
    optVideo: el.optVideo.checked,
    optAlarm: el.optAlarm.checked,
    optNotify: el.optNotify.checked,
  };
}
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs())); } catch (e) {} }
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (p.quality) el.qualitySelect.value = p.quality;
    if (p.expectMinutes) el.expectMinutes.value = p.expectMinutes;
    ['optVideo', 'optAlarm', 'optNotify'].forEach((k) => { if (typeof p[k] === 'boolean') el[k].checked = p[k]; });
  } catch (e) {}
}

/** 容量預算：多場最容易撞到的就是這個，所以放在設定下面一直顯示 */
async function renderBudget() {
  const p = prefs();
  const q = M.QUALITY[p.quality];
  const perSlotBps = (p.optVideo ? q.videoBitsPerSecond : 0) + 96000;
  const n = Math.max(1, st.slots.length);
  const est = await S.estimateSpace();
  const perHour = perSlotBps / 8 * 3600;
  const lines = [];
  lines.push(`每場每小時約 ${fmtBytes(perHour)}${p.optVideo ? '' : '（只錄音訊）'}`);
  if (est) {
    const hours = est.free / (perHour * n);
    lines.push(`目前 ${n} 場、可用 ${fmtBytes(est.free)} → 大約可以錄 <strong>${hours.toFixed(1)} 小時</strong>`);
    const need = perHour * n * (p.expectMinutes / 60) * 1.15;
    if (need > est.free) lines.push('<span class="bad-text">⚠ 以預計長度算會超過可用空間，請降畫質或減少場次</span>');
  }
  el.budget.innerHTML = lines.join('<br>');
}

/* ---------------- 資料夾 ---------------- */
async function restoreDir() {
  if (!S.supportsDirectoryPicker()) return;
  const h = await S.recallDir();
  if (!h) return;
  st.savedDir = h;
  const p = await S.dirPermission(h, false);
  if (p === 'granted') { st.dirHandle = h; showDirReady(h.name); }
  else if (p === 'prompt') {
    el.savedName.textContent = h.name;
    el.btnUseSaved.hidden = false;
    el.dirLabel.textContent = '上次用這個資料夾，按左邊確認就能沿用';
  } else { await S.forgetDir(); st.savedDir = null; }
}
function showDirReady(name) {
  el.dirLabel.textContent = name + '（已記住）';
  el.btnUseSaved.hidden = true;
  el.btnPickDir.textContent = '換一個資料夾';
}
async function pickDir() {
  try {
    st.dirHandle = await S.pickOutputDir();
    st.savedDir = st.dirHandle;
    await S.rememberDir(st.dirHandle);
    showDirReady(st.dirHandle.name);
  } catch (e) {
    if (e.name !== 'AbortError') log('warn', '選擇資料夾失敗：' + e.message);
  }
}
async function useSavedDir() {
  const p = await S.dirPermission(st.savedDir, true);
  if (p === 'granted') { st.dirHandle = st.savedDir; showDirReady(st.savedDir.name); }
  else log('warn', '還是沒拿到資料夾寫入權限，請按「選擇資料夾」重挑。');
}

/* ================================================================
   場次卡片
   ================================================================ */
function addSlot() {
  const p = prefs();
  const id = st.nextId++;
  const slot = new Slot(id, {
    name: '',
    quality: p.quality,
    withVideo: p.optVideo,
    audioCtx: st.audioCtx,
    on: {
      state: (s) => { renderSlot(s); refreshStartButton(); },
      log: (s, kind, line) => log(kind, `${s.name}｜${line.replace(/^\[[^\]]+\]\s*/, '')}`),
      alert: () => renderAlerts(),
    },
  });
  slot.ui = {};
  st.slots.push(slot);
  buildSlotCard(slot);
  refreshStartButton();
  renderBudget();
}

function buildSlotCard(slot) {
  const card = document.createElement('div');
  card.className = 'slot-card';
  card.innerHTML = `
    <div class="sc-head">
      <input class="sc-name" type="text" placeholder="這場叫什麼？例如「台積電法說」" maxlength="40">
      <span class="sc-state">尚未選擇來源</span>
      <button type="button" class="btn sm ghost sc-remove">移除</button>
    </div>
    <div class="row sc-actions">
      <button type="button" class="btn accent sm sc-pick">選擇這場的分頁</button>
    </div>
    <div class="checks sc-checks"></div>
    <div class="sc-gauges" hidden>
      <div class="sc-g"><span class="sc-gl">畫面</span><span class="sc-gv sc-fps">–</span></div>
      <div class="sc-g">
        <span class="sc-gl">這場的聲音</span>
        <span class="sc-gv mono sc-db">−∞ <i>dBFS</i></span>
        <div class="meter"><div class="meter-fill sc-meter"></div><div class="meter-zone"></div></div>
      </div>
      <div class="sc-g"><span class="sc-gl">已安全落地</span><span class="sc-gv mono sc-bytes">0 KB</span></div>
    </div>`;
  el.slotList.appendChild(card);

  const u = slot.ui;
  u.card = card;
  u.name = card.querySelector('.sc-name');
  u.state = card.querySelector('.sc-state');
  u.remove = card.querySelector('.sc-remove');
  u.pick = card.querySelector('.sc-pick');
  u.checks = card.querySelector('.sc-checks');
  u.gauges = card.querySelector('.sc-gauges');
  u.fps = card.querySelector('.sc-fps');
  u.db = card.querySelector('.sc-db');
  u.meter = card.querySelector('.sc-meter');
  u.bytes = card.querySelector('.sc-bytes');

  u.name.value = slot.name.startsWith('會議 ') ? '' : slot.name;
  u.name.oninput = () => { slot.name = u.name.value.trim() || `會議 ${slot.id}`; };
  u.remove.onclick = () => removeSlot(slot);
  u.pick.onclick = () => pickSource(slot);
  renderSlot(slot);
}

function removeSlot(slot) {
  if (slot.state === 'recording') { log('warn', `${slot.name} 正在錄，不能移除。`); return; }
  slot.release();
  st.slots = st.slots.filter((s) => s !== slot);
  slot.ui.card.remove();
  refreshStartButton();
  renderBudget();
  renderAlerts();
}

async function pickSource(slot) {
  const p = prefs();
  slot.quality = p.quality;
  slot.withVideo = p.optVideo;
  try {
    if (slot.stream) slot.release();
    await slot.acquire();
  } catch (e) {
    if (e.name === 'NotAllowedError') log('warn', `${slot.name}：取消了分享，或瀏覽器不允許。`);
    else log('fail', `${slot.name}：取得來源失敗 —— ${e.message}`);
    renderSlot(slot);
    return;
  }
  renderSlot(slot);
  const res = await slot.runChecks(p.expectMinutes);
  renderChecks(slot, res);
  renderSlot(slot);
  refreshStartButton();
}

function renderChecks(slot, res) {
  const box = slot.ui.checks;
  box.innerHTML = '';
  for (const it of res.items) {
    const row = document.createElement('div');
    row.className = 'ci ci-' + it.level;
    row.innerHTML = '<div class="ci-mark"></div><div class="ci-body"><div class="ci-name"></div><div class="ci-detail"></div><div class="ci-fix" hidden></div></div>';
    row.querySelector('.ci-mark').textContent = it.level === 'pass' ? '✓' : it.level === 'fail' ? '✕' : '!';
    row.querySelector('.ci-name').textContent = it.name;
    row.querySelector('.ci-detail').textContent = it.detail || '';
    if (it.fix) { const f = row.querySelector('.ci-fix'); f.hidden = false; f.textContent = '→ ' + it.fix; }
    box.appendChild(row);
  }
}

function renderSlot(slot) {
  const u = slot.ui;
  if (!u || !u.card) return;
  const labels = {
    empty: '尚未選擇來源', acquiring: '等待你選擇分頁…', checking: '檢查中／未通過',
    ready: '準備好了', recording: '錄製中', finishing: '收檔中…', done: '已完成',
  };
  u.state.textContent = labels[slot.state] || slot.state;
  u.card.dataset.state = slot.state;
  u.pick.textContent = slot.stream ? '重新選擇' : '選擇這場的分頁';
  u.pick.disabled = slot.state === 'recording' || slot.state === 'finishing';
  u.remove.disabled = slot.state === 'recording' || slot.state === 'finishing';
  u.name.disabled = slot.state === 'recording' || slot.state === 'finishing';
  u.gauges.hidden = !(slot.state === 'recording' || slot.state === 'finishing' || slot.state === 'done');
}

function refreshStartButton() {
  const ready = st.slots.filter((s) => s.state === 'ready').length;
  const bad = st.slots.filter((s) => s.stream && s.state === 'checking').length;
  el.btnStartAll.disabled = ready === 0 || st.phase !== 'setup';
  el.btnStartAll.textContent = ready ? `開始錄製 ${ready} 場` : '開始錄製全部';
  el.slotHint.textContent = st.slots.length === 0
    ? '先加一場，然後選它要錄哪個分頁。'
    : bad ? `有 ${bad} 場沒通過檢查，過不了的不會開始錄。`
    : `${ready} 場準備好了。`;
}

/* ================================================================
   錄製
   ================================================================ */
async function startAll() {
  const ready = st.slots.filter((s) => s.state === 'ready');
  if (!ready.length) return;

  try {
    if (el.optNotify.checked && window.Notification && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  } catch (e) {}

  st.phase = 'recording';
  st.sid = stamp();
  st.startedAt = Date.now();
  st.maxLagMs = 0;
  el.btnStartAll.disabled = true;
  el.timer.hidden = false;
  el.btnStopAll.hidden = false;
  el.btnMark.hidden = false;
  el.setupCard.hidden = true;

  log('info', `開始錄製 ${ready.length} 場（畫質 ${prefs().quality}${prefs().optVideo ? '' : '，只錄音訊'}）`);
  for (const s of ready) {
    try { await s.start(st.sid); } catch (e) { log('fail', `${s.name} 啟動失敗：${e.message}`); }
    renderSlot(s);
  }
  await acquireWakeLock();
  startHeartbeat();
  setStatus(`錄製中 · ${ready.length} 場`, 'rec');
}

function heartbeat() {
  const now = Date.now();
  if (st.lastTickAt) {
    const lag = now - st.lastTickAt - 1000;
    if (lag > st.maxLagMs) st.maxLagMs = lag;
  }
  st.lastTickAt = now;

  el.timer.textContent = fmtDur((now - st.startedAt) / 1000);
  const hidden = document.hidden;

  for (const s of st.slots) {
    const m = s.tick(now, hidden);
    if (!m) continue;
    const u = s.ui;
    u.fps.textContent = s.withVideo ? m.fps.toFixed(1) + ' fps' : '未錄影像';
    const db = m.rms > 1e-5 ? 20 * Math.log10(m.rms) : -Infinity;
    u.db.innerHTML = (db === -Infinity ? '−∞' : db.toFixed(1).replace('-', '−')) + ' <i>dBFS</i>';
    u.meter.style.width = (db === -Infinity ? 0 : Math.max(0, Math.min(100, (db + 60) / 60 * 100))) + '%';
    u.bytes.textContent = fmtBytes(m.bytes);
    u.card.dataset.trouble = s.worstAlert ? s.worstAlert.level : '';
  }
}

function startHeartbeat() {
  st.lastTickAt = 0;
  try {
    st.ticker = new Worker('./js/ticker-worker.js');
    st.ticker.onmessage = heartbeat;
    st.ticker.onerror = () => {
      log('warn', '心跳 Worker 失敗，改用一般計時器（背景分頁可能被節流）');
      if (!st.fallbackTimer) st.fallbackTimer = setInterval(heartbeat, 1000);
    };
    st.ticker.postMessage({ type: 'start', interval: 1000 });
    log('ok', '監看心跳已啟動');
  } catch (e) {
    st.fallbackTimer = setInterval(heartbeat, 1000);
  }
}
function stopHeartbeat() {
  if (st.ticker) { try { st.ticker.postMessage({ type: 'stop' }); st.ticker.terminate(); } catch (e) {} st.ticker = null; }
  if (st.fallbackTimer) { clearInterval(st.fallbackTimer); st.fallbackTimer = null; }
}

function markAll() {
  const label = document.hidden ? '（此頁在背景）' : '（此頁在前景）';
  for (const s of st.slots) s.mark(label);
  log('info', '已標記這一刻 ' + label);
}

/* ================================================================
   停止 · 驗證 · 匯出
   ================================================================ */
async function stopAll() {
  if (st.phase !== 'recording') return;
  st.phase = 'done';
  el.btnStopAll.disabled = true;
  el.btnStopAll.textContent = '收檔中…';
  el.btnMark.hidden = true;
  setStatus('收檔中', 'warn');
  stopHeartbeat();
  releaseWakeLock();
  log('info', '停止全部錄製');

  const recording = st.slots.filter((s) => s.state === 'recording');
  for (const s of recording) { await s.stop(); renderSlot(s); }

  el.slotsCard.hidden = true;
  el.doneCard.hidden = false;
  el.doneList.innerHTML = '<p class="note">正在驗證檔案…</p>';

  const totalSec = (Date.now() - st.startedAt) / 1000;
  const results = [];
  for (const s of recording) {
    const r = await s.verify();
    results.push({ slot: s, ...r });
    s.release();
  }

  el.doneList.innerHTML = '';
  for (const r of results) renderResult(r);
  renderStressBlock(results, totalSec);

  // 匯出
  const reportText = buildReport(results, totalSec);
  if (st.dirHandle) {
    for (const r of results) {
      if (r.vFile) await exportOne(r.slot.vTarget, r.vFile);
      if (r.aFile) await exportOne(r.slot.aTarget, r.aFile);
    }
    try {
      await S.writeTextToDir(st.dirHandle, `${st.sid}_多場實測報告.txt`, reportText);
      log('ok', `已存檔：${st.sid}_多場實測報告.txt`);
    } catch (e) { log('warn', '報告存檔失敗：' + e.message); }
  } else {
    const box = document.createElement('div');
    box.className = 'rows';
    for (const r of results) {
      if (r.vFile) box.appendChild(dlRow(r.slot.vTarget, r.vFile));
      if (r.aFile) box.appendChild(dlRow(r.slot.aTarget, r.aFile));
    }
    const b = document.createElement('button');
    b.className = 'btn sm'; b.type = 'button'; b.textContent = '下載實測報告';
    b.onclick = () => S.downloadText(`${st.sid}_多場實測報告.txt`, reportText);
    box.appendChild(b);
    el.doneList.appendChild(box);
  }

  setStatus('完成', 'ok');
  el.btnStopAll.hidden = true;
}

async function exportOne(name, file) {
  try {
    await S.exportFileToDir(st.dirHandle, file, name);
    log('ok', `已存檔：${name}（${fmtBytes(file.size)}）`);
  } catch (e) { log('fail', `${name} 存檔失敗：${e.message}`); }
}
function dlRow(name, file) {
  const d = document.createElement('div');
  d.innerHTML = '<span class="fn"></span><span class="meta"></span>';
  d.querySelector('.fn').textContent = name;
  d.querySelector('.meta').textContent = fmtBytes(file.size);
  const b = document.createElement('button');
  b.className = 'btn sm accent'; b.type = 'button'; b.textContent = '下載';
  b.onclick = () => S.downloadFile(file, name);
  d.appendChild(b);
  return d;
}

function renderResult(r) {
  const wrap = document.createElement('div');
  wrap.className = 'result';
  const bad = !r.report.pass;
  wrap.innerHTML = `<div class="verdict ${bad ? 'bad' : (r.report.warn ? 'warn' : 'ok')}"></div><div class="checks"></div>`;
  wrap.querySelector('.verdict').textContent =
    `${r.slot.name} — ${fmtDur(r.seconds)}` + (bad ? '：驗證發現問題' : (r.report.warn ? '：有提醒' : '：全部通過'));
  const cbox = wrap.querySelector('.checks');
  for (const it of r.report.items) {
    const row = document.createElement('div');
    row.className = 'ci ci-' + it.level;
    row.innerHTML = '<div class="ci-mark"></div><div class="ci-body"><div class="ci-name"></div><div class="ci-detail"></div></div>';
    row.querySelector('.ci-mark').textContent = it.level === 'pass' ? '✓' : it.level === 'fail' ? '✕' : '!';
    row.querySelector('.ci-name').textContent = it.name;
    row.querySelector('.ci-detail').textContent = it.detail || '';
    cbox.appendChild(row);
  }
  el.doneList.appendChild(wrap);
}

/** 這一版的重點：把「多場到底撐不撐得住」量成數字攤出來 */
function renderStressBlock(results, totalSec) {
  const box = document.createElement('div');
  box.className = 'stress';
  const rows = [];
  rows.push(`<div class="st-line"><span>同時錄製場數</span><b>${results.length} 場</b></div>`);
  rows.push(`<div class="st-line"><span>總長度</span><b>${fmtDur(totalSec)}</b></div>`);
  rows.push(`<div class="st-line"><span>監看心跳最大延遲</span><b>${st.maxLagMs} ms</b><span class="st-note">超過 1000 ms 代表主執行緒被拖住</span></div>`);
  for (const r of results) {
    const s = r.stress;
    if (!s) continue;
    const f = (o) => o ? `中位 ${o.median} / 最低 ${o.min}` : '沒有樣本';
    rows.push(`<div class="st-block">
      <div class="st-name">${escapeHtml(r.slot.name)}</div>
      <div class="st-line"><span>目標 fps</span><b>${s.targetFps}</b></div>
      <div class="st-line"><span>此頁在前景時</span><b>${f(s.visible)}</b></div>
      <div class="st-line"><span>此頁在背景時</span><b>${f(s.hidden)}</b></div>
      <div class="st-line"><span>fps 低於目標一半的秒數</span><b>${s.lowFpsSeconds} 秒（${s.lowFpsPct}%）</b></div>
      <div class="st-line"><span>靜音秒數佔比</span><b>${s.quietPct}%</b></div>
      <div class="st-line"><span>標記點</span><b>${s.marks.length ? s.marks.map((m) => m.t + 's').join('、') : '無'}</b></div>
    </div>`);
  }
  box.innerHTML = `<h3>實測數據</h3>${rows.join('')}`;
  el.doneList.appendChild(box);
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function buildReport(results, totalSec) {
  const L = [];
  L.push('多場同時錄製 實測報告');
  L.push('='.repeat(64));
  L.push('場次編號：' + st.sid);
  L.push('開始時間：' + new Date(st.startedAt).toLocaleString('zh-TW'));
  L.push('總長度：' + fmtDur(totalSec));
  L.push('同時錄製：' + results.length + ' 場');
  L.push('畫質設定：' + prefs().quality + (prefs().optVideo ? '' : '（只錄音訊）'));
  L.push('監看心跳最大延遲：' + st.maxLagMs + ' ms');
  L.push('');
  for (const r of results) {
    const s = r.stress;
    L.push('-'.repeat(64));
    L.push('【' + r.slot.name + '】');
    L.push('  來源：' + r.slot.surfaceLabel);
    L.push('  檔案：' + r.slot.vTarget + (r.vFile ? ` (${fmtBytes(r.vFile.size)})` : ' (未錄影像)'));
    L.push('        ' + r.slot.aTarget + (r.aFile ? ` (${fmtBytes(r.aFile.size)})` : ''));
    L.push('  驗證：');
    for (const it of r.report.items) L.push(`    [${it.level.toUpperCase()}] ${it.name}：${it.detail}`);
    if (s) {
      L.push('  實測：');
      L.push(`    目標 fps ${s.targetFps}`);
      L.push(`    前景 fps ${s.visible ? `中位 ${s.visible.median} 最低 ${s.visible.min} p10 ${s.visible.p10}（${s.visible.n} 秒）` : '無樣本'}`);
      L.push(`    背景 fps ${s.hidden ? `中位 ${s.hidden.median} 最低 ${s.hidden.min} p10 ${s.hidden.p10}（${s.hidden.n} 秒）` : '無樣本'}`);
      L.push(`    fps 低於目標一半：${s.lowFpsSeconds} 秒（${s.lowFpsPct}%）`);
      L.push(`    靜音秒數佔比：${s.quietPct}%`);
      if (s.marks.length) L.push('    標記：' + s.marks.map((m) => `${m.t}s ${m.label}`).join('、'));
    }
    L.push('  事件紀錄：');
    r.slot.log.forEach((x) => L.push('    ' + x));
    L.push('');
  }
  L.push('-'.repeat(64));
  L.push('全域事件紀錄');
  globalLog.forEach((x) => L.push('  ' + x));
  return L.join('\r\n');
}

/* ---------------- 螢幕不休眠 ---------------- */
let wakeLock = null;
async function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) { log('warn', '無法鎖定螢幕不休眠：' + e.message); }
}
function releaseWakeLock() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && st.phase === 'recording' && !wakeLock) await acquireWakeLock();
});

/* ================================================================
   啟動
   ================================================================ */
async function init() {
  baseTitle = document.title;
  for (const [k, q] of Object.entries(M.QUALITY)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = q.label;
    el.qualitySelect.appendChild(o);
  }
  el.qualitySelect.value = '720p15';   // 多場預設省一點
  loadPrefs();

  st.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'playback' });
  await S.probeDurableWrite();
  await restoreDir();

  el.btnPickDir.onclick = pickDir;
  el.btnUseSaved.onclick = useSavedDir;
  el.btnAddSlot.onclick = addSlot;
  el.btnStartAll.onclick = startAll;
  el.btnStopAll.onclick = stopAll;
  el.btnMark.onclick = markAll;
  el.btnAgain.onclick = () => location.reload();
  el.alertMute.onclick = () => { st.muted = !st.muted; el.alertMute.textContent = st.muted ? '恢復提示音' : '靜音提示'; };
  [el.qualitySelect, el.expectMinutes, el.optVideo, el.optAlarm, el.optNotify].forEach((n) =>
    n.addEventListener('change', () => { savePrefs(); renderBudget(); }));

  window.addEventListener('beforeunload', (e) => {
    if (st.phase === 'recording') { e.preventDefault(); e.returnValue = '還在錄影中，離開會中斷。'; return e.returnValue; }
  });

  addSlot();
  addSlot();          // 多場版預設就給兩格
  await renderBudget();
  setStatus('尚未開始', '');
  log('info', '多場模式就緒。每一場請選一個瀏覽器分頁，並記得勾「分享分頁音訊」。');
}

init();
