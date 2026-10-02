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
import * as L from './license.js';
import * as R from './recovery.js';
import { mountNotice } from './compat.js';
import { t, tText, fw, fmtWhen } from './i18n.js';

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
  optAutoQuiet: $('optAutoQuiet'), quietMin: $('quietMin'),
  budget: $('budget'),
  slotsCard: $('slotsCard'), slotList: $('slotList'), btnAddSlot: $('btnAddSlot'), planNote: $('planNote'),
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
      new Notification(t(title), { body: t(body), tag: 'meeting-multi', requireInteraction: true });
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
    autoQuiet: el.optAutoQuiet.checked,
    quietMin: Math.max(3, Number(el.quietMin.value) || 10),
  };
}
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs())); } catch (e) {} }
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (p.quality) el.qualitySelect.value = p.quality;
    if (p.expectMinutes) el.expectMinutes.value = p.expectMinutes;
    ['optVideo', 'optAlarm', 'optNotify'].forEach((k) => { if (typeof p[k] === 'boolean') el[k].checked = p[k]; });
    if (typeof p.autoQuiet === 'boolean') el.optAutoQuiet.checked = p.autoQuiet;
    if (p.quietMin) el.quietMin.value = p.quietMin;
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
function slotLimit() { return (st.plan && st.plan.slots) || 1; }

function activeSlots() { return st.slots.filter((x) => x.state !== 'done'); }

function applyPlan() {
  const max = slotLimit();
  const n = activeSlots().length;
  el.btnAddSlot.disabled = n >= max;
  el.btnAddSlot.textContent = n >= max ? `已達同時 ${max} 場上限` : '＋ 加一場';
  const pro = st.plan && st.plan.plan !== 'free';
  el.planNote.hidden = pro && max >= 4;
  // 靜音自動收檔屬於 Pro 的「無人看管保護」（方案頁寫的），免費版鎖起來並標 Pro
  const una = !!(st.plan && st.plan.unattended);
  el.optAutoQuiet.disabled = !una; el.quietMin.disabled = !una;
  if (!una) el.optAutoQuiet.checked = false;
  {
    const w = el.optAutoQuiet.closest('label');
    let tag = w && w.querySelector('.pro-tag');
    if (w) w.classList.toggle('locked', !una);
    if (w && !una && !tag) { tag = document.createElement('a'); tag.className = 'pro-tag'; tag.href = './pricing.html'; tag.textContent = 'Pro'; w.appendChild(tag); }
    else if (una && tag) tag.remove();
  }
  el.planNote.innerHTML = pro
    ? `你的方案可同時錄 ${max} 場。`
    : `免費版一次只能錄 <b>1 場</b>。要同時錄多場請<a class="link" href="./pricing.html">升級 Pro</a>（同時 4 場）。`;
  // 降級時移掉多出來、而且沒在錄的格子（正在錄的絕不動）
  let extra = activeSlots().length - max;
  for (let i = st.slots.length - 1; i >= 0 && extra > 0; i--) {
    const x = st.slots[i];
    if (x.state === 'done' || x.state === 'recording' || x.state === 'finishing') continue;
    removeSlot(x); extra--;
  }
}

function addSlot() {
  if (activeSlots().length >= slotLimit()) { applyPlan(); return; }
  const p = prefs();
  const id = st.nextId++;
  const slot = new Slot(id, {
    name: '',
    quality: p.quality,
    withVideo: p.optVideo,
    audioCtx: st.audioCtx,
    on: {
      state: (s) => {
        if (s.state === 'failed' && s.checks.length) renderChecks(s, { items: s.checks });
        renderSlot(s); refreshStartButton();
      },
      log: (s, kind, line) => log(kind, `${s.name}｜${line.replace(/^\[[^\]]+\]\s*/, '')}`),
      alert: () => renderAlerts(),
    },
  });
  slot.ui = {};
  st.slots.push(slot);
  buildSlotCard(slot);
  refreshStartButton();
  renderBudget();
  applyPlan();
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
      <button type="button" class="btn sm sc-pick">選擇這場的分頁</button>
      <button type="button" class="btn accent sc-start" hidden>開始錄這一場</button>
      <button type="button" class="btn stop sc-stop" hidden>停止這一場</button>
      <span class="sc-timer mono" hidden>00:00</span>
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
    </div>
    <div class="sc-result" hidden></div>`;
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
  u.start = card.querySelector('.sc-start');
  u.stop = card.querySelector('.sc-stop');
  u.timer = card.querySelector('.sc-timer');
  u.result = card.querySelector('.sc-result');

  u.name.value = slot.name.startsWith('會議 ') ? '' : slot.name;
  u.name.oninput = () => { slot.name = u.name.value.trim() || `會議 ${slot.id}`; slot.named = !!u.name.value.trim(); };
  u.remove.onclick = () => removeSlot(slot);
  u.pick.onclick = () => pickSource(slot);
  u.start.onclick = () => startSlot(slot);
  u.stop.onclick = () => stopSlot(slot);
  renderSlot(slot);
}

function removeSlot(slot) {
  if (slot.state === 'recording' || slot.state === 'finishing') { log('warn', `${slot.name} 正在錄或收檔，不能移除。`); return; }
  slot.release();
  st.slots = st.slots.filter((s) => s !== slot);
  slot.ui.card.remove();
  refreshStartButton();
  if (el.btnAddSlot) applyPlan();
  renderBudget();
  renderAlerts();
}

async function pickSource(slot) {
  if (slot.state === 'acquiring' || slot.state === 'checking') return;   // 上一輪還沒跑完
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
  if (!st.slots.includes(slot)) { slot.release(); return; }   // 選分頁的時候這格被移除了
  renderSlot(slot);
  const res = await slot.runChecks(p.expectMinutes);
  if (!res || !st.slots.includes(slot)) return;               // 這輪檢查作廢（重選、移除、分享已結束）
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
    empty: '尚未選擇來源', acquiring: '等待你選擇分頁…', checking: '檢查中…', failed: '未通過檢查',
    ready: '準備好了', recording: '錄製中', finishing: '收檔與驗證中…', done: '已完成',
  };
  const busy = slot.state === 'recording' || slot.state === 'finishing';
  u.state.textContent = labels[slot.state] || slot.state;
  u.card.dataset.state = slot.state;

  u.pick.textContent = slot.stream ? '重新選擇' : '選擇這場的分頁';
  u.pick.hidden = busy || slot.state === 'done';
  u.pick.disabled = slot.state === 'acquiring' || slot.state === 'checking';
  u.pick.classList.toggle('accent', slot.state === 'empty' || slot.state === 'failed');   // 沒通過時，該按的就是「重新選擇」   // 只切換，不能覆寫整個 class（會把 sc-pick 洗掉）
  // 選過分頁之後，開始鈕一直留在原位：沒通過時變灰、寫明原因，不要整顆消失讓人找不到
  u.start.hidden = !slot.stream || busy || slot.state === 'done';
  u.start.disabled = slot.state !== 'ready';
  u.start.textContent = slot.state === 'ready' ? '開始錄這一場'
    : slot.state === 'failed' ? '還不能開始：先修好下面打 ✕ 的項目'
    : '檢查中…';
  u.stop.hidden = slot.state !== 'recording';
  u.stop.disabled = false;
  u.timer.hidden = !busy;
  u.remove.disabled = busy;
  u.remove.textContent = slot.state === 'done' ? '清除這一格' : '移除';
  u.name.disabled = busy || slot.state === 'done';
  u.checks.hidden = busy || slot.state === 'done';
  u.gauges.hidden = !busy;
  u.result.hidden = slot.state !== 'done' && slot.state !== 'finishing';
}

function refreshStartButton() {
  const ready = st.slots.filter((x) => x.state === 'ready').length;
  const rec = recordingCount();
  const bad = st.slots.filter((x) => x.stream && x.state === 'failed').length;
  el.btnStartAll.disabled = ready === 0;
  el.btnStartAll.textContent = ready > 1 ? `準備好的 ${ready} 場一起開始` : '準備好的一起開始';
  el.btnStartAll.hidden = ready < 2;   // 只有一場準備好時，用那一格自己的按鈕就好
  el.slotHint.textContent = st.slots.length === 0
    ? '先加一場，然後選它要錄哪個分頁。'
    : bad ? `有 ${bad} 場沒通過檢查，要先修好才能開始。`
    : rec ? `${rec} 場錄製中。每一格可以各自停止；也可以隨時再加一場、各自開始。`
    : ready ? '每一格準備好就可以各自按「開始錄這一場」。'
    : '替每一格選好分頁，檢查通過就能開始。';
  renderRail();
}

/* ================================================================
   錄製（每一格各自開始、各自停止）
   ================================================================ */
function recordingCount() { return st.slots.filter((x) => x.state === 'recording').length; }
function anyBusy() { return st.slots.some((x) => x.state === 'recording' || x.state === 'finishing'); }

/** 頂欄：有任何一場在錄，就顯示「幾場錄製中」、標記鍵與全部停止 */
function renderRail() {
  const n = recordingCount();
  el.timer.hidden = true;
  el.btnStopAll.hidden = n === 0;
  el.btnStopAll.disabled = false;
  el.btnStopAll.textContent = n > 1 ? `全部停止（${n} 場）` : '全部停止';
  el.btnMark.hidden = n === 0;
  if (n) setStatus(`錄製中 · ${n} 場`, 'rec');
  else if (st.slots.some((x) => x.state === 'finishing')) setStatus('收檔中', 'warn');
  else if (st.slots.some((x) => x.state === 'done')) setStatus('已完成的場次在下方', 'ok');
  else setStatus('尚未開始', '');
}

async function startSlot(slot) {
  if (slot.state !== 'ready') return;
  if (recordingCount() >= slotLimit()) {
    log('warn', `你的方案同時最多錄 ${slotLimit()} 場。`);
    return;
  }
  // 通知權限絕對不能 await 在開錄前面：Chrome 會跳出詢問泡泡，使用者沒回答之前錄影就一直不開始
  // （實測多場時每按一場都排隊等，頭幾秒全部沒錄到）。先開錄，再在背景問。
  const askNotify = () => {
    try {
      if (el.optNotify.checked && window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    } catch (e) {}
  };

  // 每一場用自己開始的時間命名 —— 各場本來就不一定同時開始
  slot.sid = stamp();
  slot.ui.start.disabled = true;
  try {
    await slot.start(slot.sid);
  } catch (e) {
    log('fail', `${slot.name} 啟動失敗：${e.message}`);
    slot.ui.start.disabled = false;
    renderSlot(slot); refreshStartButton();
    return;
  }
  slot.ui.start.disabled = false;
  const taken = new Set(st.slots.filter((x) => x !== slot && x.vTarget).flatMap((x) => [x.vTarget, x.aTarget]));
  if (taken.has(slot.vTarget) || taken.has(slot.aTarget)) {
    slot.vTarget = slot.vTarget.replace(/\.webm$/, `_${slot.id}.webm`);
    slot.aTarget = slot.aTarget.replace(/\.webm$/, `_${slot.id}.webm`);
  }
  if (slot.aWriter && slot.aWriter.durable) {
    R.registerFiles(slot.sid, slot.startedAt, [
      ...(slot.vWriter ? [{ opfs: slot.vOpfs, target: slot.vTarget, kind: 'video' }] : []),
      { opfs: slot.aOpfs, target: slot.aTarget, kind: 'audio' },
    ]);
  }
  renderSlot(slot);
  ensureHeartbeat();
  askNotify();
  await acquireWakeLock();
  refreshStartButton();
}

async function startAllReady() {
  const ready = st.slots.filter((x) => x.state === 'ready');
  for (const x of ready) await startSlot(x);
}

async function stopSlot(slot) {
  if (slot.state !== 'recording') return;
  slot.ui.stop.disabled = true;
  log('info', `停止「${slot.name}」`);
  await slot.stop();                // → finishing → done（Slot 內部）
  slot.state = 'finishing';         // 收檔完先維持「驗證中」，驗證完才算 done
  renderSlot(slot);
  refreshStartButton();
  maybeStopHeartbeat();

  slot.ui.result.hidden = false;
  slot.ui.result.innerHTML = '<p class="note">正在驗證這一場的檔案…</p>';

  const r = await slot.verify();
  slot.release();                   // 放掉這個分頁的擷取，Chrome 的「正在共用」提示列也會消失
  slot.state = 'done';
  renderSlot(slot);
  renderResult(slot, r);
  await exportSlot(slot, r);
  refreshStartButton();
}

async function stopAllRecording() {
  const rec = st.slots.filter((x) => x.state === 'recording');
  if (!rec.length) return;
  el.btnStopAll.disabled = true;
  await Promise.all(rec.map((x) => stopSlot(x)));
}

function heartbeat() {
  const now = Date.now();
  if (st.lastTickAt) {
    const lag = now - st.lastTickAt - 1000;
    if (lag > st.maxLagMs) st.maxLagMs = lag;
  }
  st.lastTickAt = now;
  const hidden = document.hidden;

  const pro = !!(st.plan && st.plan.unattended);
  const p = prefs();
  for (const x of st.slots) {
    const m = x.tick(now, hidden);
    if (!m) continue;
    // 會議結束自動收檔：分頁關掉（等 3 秒讓最後一段資料寫完）；或分頁還開著但連續 N 分鐘完全沒聲音
    if (x.sourceEndedAt && now - x.sourceEndedAt > 3000) {
      log('warn', `「${x.name}」的分享已中斷，自動停止並保存已錄到的內容`);
      stopSlot(x);
      continue;
    }
    if (pro && p.autoQuiet && m.quiet > p.quietMin * 60) {
      log('warn', `「${x.name}」連續 ${p.quietMin} 分鐘沒有聲音，判定會議已結束，自動停止並存檔`);
      stopSlot(x);
      continue;
    }
    const u = x.ui;
    u.timer.textContent = fmtDur(m.elapsed);
    u.fps.textContent = x.withVideo ? m.fps.toFixed(1) + ' fps' : '未錄影像';
    const db = m.rms > 1e-5 ? 20 * Math.log10(m.rms) : -Infinity;
    u.db.innerHTML = (db === -Infinity ? '−∞' : db.toFixed(1).replace('-', '−')) + ' <i>dBFS</i>';
    u.meter.style.width = (db === -Infinity ? 0 : Math.max(0, Math.min(100, (db + 60) / 60 * 100))) + '%';
    u.bytes.textContent = fmtBytes(m.bytes);
    u.card.dataset.trouble = x.worstAlert ? x.worstAlert.level : '';
  }
}

function ensureHeartbeat() {
  if (st.ticker || st.fallbackTimer) return;
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
function maybeStopHeartbeat() {
  if (recordingCount() > 0) return;
  if (st.ticker) { try { st.ticker.postMessage({ type: 'stop' }); st.ticker.terminate(); } catch (e) {} st.ticker = null; }
  if (st.fallbackTimer) { clearInterval(st.fallbackTimer); st.fallbackTimer = null; }
  releaseWakeLock();
}

function markAll() {
  const label = document.hidden ? '（此頁在背景）' : '（此頁在前景）';
  for (const x of st.slots) x.mark(label);
  log('info', '已標記這一刻 ' + label);
}

/* ================================================================
   單場收檔：驗證 → 存檔 → 結果直接顯示在那一格
   ================================================================ */
async function exportSlot(slot, r) {
  const base = slot.vTarget.replace(/\.webm$/, '');
  const reportName = `${base}_${fw('實測報告')}.txt`;
  const report = tText(buildReport(slot, r));
  const box = slot.ui.result.querySelector('.sc-files');

  if (st.dirHandle) {
    const lines = [], failed = [];
    for (const [name, file] of [[slot.vTarget, r.vFile], [slot.aTarget, r.aFile]]) {
      if (!file) continue;
      const res = await exportOne(name, file);
      lines.push(res.line);
      if (!res.ok) failed.push([name, file]);
    }
    try {
      await S.writeTextToDir(st.dirHandle, reportName, report);
      lines.push(`✓ ${reportName}`);
    } catch (e) { lines.push(`✕ ${reportName}：${e.message}`); }
    box.innerHTML = `<p class="note">已存進「${escapeHtml(st.dirHandle.name)}」：</p>` +
      lines.map((l) => `<div class="mono sc-fileline">${escapeHtml(l)}</div>`).join('');
    if (failed.length) {
      // 存進資料夾失敗（權限被收回、磁碟滿…）：檔案還在瀏覽器裡，改給下載鈕，不能讓這場就這樣不見
      const p = document.createElement('p');
      p.className = 'note bad-text';
      p.textContent = '有檔案沒存進資料夾，請按下面的「下載」另存：';
      const rows = document.createElement('div');
      rows.className = 'rows';
      for (const [name, file] of failed) rows.appendChild(dlRow(name, file));
      box.appendChild(p); box.appendChild(rows);
    } else {
      R.markExported(slot.sid);
    }
  } else {
    box.innerHTML = '';
    const rows = document.createElement('div');
    rows.className = 'rows';
    // 每個檔都按過下載，才標記成「已匯出」（之後救援清單裡才可以一鍵清掉）
    const want = [r.vFile, r.aFile].filter(Boolean).length, got = new Set();
    const onDl = (name) => { got.add(name); if (got.size >= want) R.markExported(slot.sid); };
    if (r.vFile) rows.appendChild(dlRow(slot.vTarget, r.vFile, onDl));
    if (r.aFile) rows.appendChild(dlRow(slot.aTarget, r.aFile, onDl));
    const b = document.createElement('button');
    b.className = 'btn sm'; b.type = 'button'; b.textContent = '下載實測報告';
    b.onclick = () => S.downloadText(reportName, report);
    rows.appendChild(b);
    box.appendChild(rows);
  }
}

async function exportOne(name, file) {
  try {
    await S.exportFileToDir(st.dirHandle, file, name);
    log('ok', `已存檔：${name}（${fmtBytes(file.size)}）`);
    return { ok: true, line: `✓ ${name}（${fmtBytes(file.size)}）` };
  } catch (e) {
    log('fail', `${name} 存檔失敗：${e.message}`);
    return { ok: false, line: `✕ ${name}：${e.message}` };
  }
}

function dlRow(name, file, onDl) {
  const d = document.createElement('div');
  d.innerHTML = '<span class="fn"></span><span class="meta"></span>';
  d.querySelector('.fn').textContent = name;
  d.querySelector('.meta').textContent = fmtBytes(file.size);
  const b = document.createElement('button');
  b.className = 'btn sm accent'; b.type = 'button'; b.textContent = '下載';
  b.onclick = () => { S.downloadFile(file, name); if (onDl) onDl(name); };
  d.appendChild(b);
  return d;
}

function renderResult(slot, r) {
  const bad = !r.report.pass;
  const s = r.stress;
  const f = (o) => o ? `中位 ${o.median}／最低 ${o.min}` : '—';
  slot.ui.result.hidden = false;
  slot.ui.result.innerHTML = `
    <div class="verdict ${bad ? 'bad' : (r.report.warn ? 'warn' : 'ok')}">
      ${escapeHtml(fmtDur(r.seconds))}${bad ? '　驗證發現問題，請看下面哪一項沒過' : (r.report.warn ? '　有提醒' : '　全部通過')}
    </div>
    <div class="checks sc-verify"></div>
    ${s ? `<div class="sc-stress mono">fps 目標 ${s.targetFps}｜前景 ${f(s.visible)}｜背景 ${f(s.hidden)}｜低於一半 ${s.lowFpsPct}%｜靜音 ${s.quietPct}%</div>` : ''}
    <div class="sc-files"><p class="note">存檔中…</p></div>`;
  const box = slot.ui.result.querySelector('.sc-verify');
  for (const it of r.report.items) {
    const row = document.createElement('div');
    row.className = 'ci ci-' + it.level;
    row.innerHTML = '<div class="ci-mark"></div><div class="ci-body"><div class="ci-name"></div><div class="ci-detail"></div></div>';
    row.querySelector('.ci-mark').textContent = it.level === 'pass' ? '✓' : it.level === 'fail' ? '✕' : '!';
    row.querySelector('.ci-name').textContent = it.name;
    row.querySelector('.ci-detail').textContent = it.detail || '';
    box.appendChild(row);
  }
}

function escapeHtml(x) { return String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function buildReport(slot, r) {
  const s = r.stress;
  const L = [];
  L.push('多場錄製 單場實測報告');
  L.push('='.repeat(64));
  L.push('場次：' + slot.name);
  L.push('場次編號：' + slot.sid);
  L.push('開始時間：' + fmtWhen(slot.startedAt));
  L.push('長度：' + fmtDur(r.seconds));
  L.push('來源：' + slot.surfaceLabel);
  L.push('畫質設定：' + slot.quality + (slot.withVideo ? '' : '（只錄音訊）'));
  L.push('整頁監看心跳最大延遲：' + st.maxLagMs + ' ms');
  L.push('');
  L.push('檔案：' + slot.vTarget + (r.vFile ? ` (${fmtBytes(r.vFile.size)})` : ' (未錄影像)'));
  L.push('      ' + slot.aTarget + (r.aFile ? ` (${fmtBytes(r.aFile.size)})` : ''));
  L.push('');
  L.push('驗證：');
  for (const it of r.report.items) L.push(`  [${it.level.toUpperCase()}] ${it.name}：${it.detail}`);
  if (s) {
    L.push('');
    L.push('實測：');
    L.push(`  目標 fps ${s.targetFps}`);
    L.push(`  前景 fps ${s.visible ? `中位 ${s.visible.median} 最低 ${s.visible.min} p10 ${s.visible.p10}（${s.visible.n} 秒）` : '無樣本'}`);
    L.push(`  背景 fps ${s.hidden ? `中位 ${s.hidden.median} 最低 ${s.hidden.min} p10 ${s.hidden.p10}（${s.hidden.n} 秒）` : '無樣本'}`);
    L.push(`  fps 低於目標一半：${s.lowFpsSeconds} 秒（${s.lowFpsPct}%）`);
    L.push(`  靜音秒數佔比：${s.quietPct}%`);
    if (s.marks.length) L.push('  標記：' + s.marks.map((m) => `${m.t}s ${m.label}`).join('、'));
  }
  L.push('');
  L.push('事件紀錄：');
  slot.log.forEach((x) => L.push('  ' + x));
  return L.join('\r\n');
}

/* ---------------- 螢幕不休眠 ---------------- */
let wakeLock = null;
async function acquireWakeLock() {
  if (!navigator.wakeLock || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) { log('warn', '無法鎖定螢幕不休眠：' + e.message); }
}
function releaseWakeLock() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && recordingCount() > 0 && !wakeLock) await acquireWakeLock();
});

/* ================================================================
   啟動
   ================================================================ */
async function init() {
  baseTitle = document.title;
  // 多場一定要分頁聲音：Firefox／Safari／手機都不行。講清楚就停，不要往下初始化（缺 AudioContext 會整頁壞掉）
  const env = mountNotice('multi');
  if (env.level !== 'ok') {
    if (el.setupCard) el.setupCard.hidden = true;
    if (el.slotsCard) el.slotsCard.hidden = true;
    setStatus('這個瀏覽器無法同時錄多場', '');
    log('warn', '這個瀏覽器無法同時錄多場：請改用電腦上的 Chrome 或 Edge。');
    return;
  }
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
  await R.renderRecovery({
    card: $('recoveryCard'), list: $('recoveryList'),
    getDir: () => st.dirHandle, pickDir,
    skip: new Set(st.slots.flatMap((x) => [x.vOpfs, x.aOpfs]).filter(Boolean)),
  });

  el.btnPickDir.onclick = pickDir;
  el.btnUseSaved.onclick = useSavedDir;
  el.btnAddSlot.onclick = addSlot;
  el.btnStartAll.onclick = startAllReady;
  el.btnStopAll.onclick = stopAllRecording;
  el.btnMark.onclick = markAll;
  if (el.btnAgain) el.btnAgain.onclick = () => location.reload();
  el.alertMute.onclick = () => { st.muted = !st.muted; el.alertMute.textContent = st.muted ? '恢復提示音' : '靜音提示'; };
  [el.qualitySelect, el.expectMinutes, el.optVideo, el.optAlarm, el.optNotify, el.optAutoQuiet, el.quietMin].forEach((n) =>
    n.addEventListener('change', () => { savePrefs(); renderBudget(); }));

  window.addEventListener('beforeunload', (e) => {
    if (anyBusy()) { e.preventDefault(); e.returnValue = '還有場次在錄影或收檔，離開會中斷。'; return e.returnValue; }
  });

  st.plan = await L.getPlan();
  L.mountLicenseBox(document.querySelector('main'), (ent) => { st.plan = ent; applyPlan(); });
  addSlot();
  if (slotLimit() >= 2) addSlot();   // 有額度就預設給兩格
  applyPlan();
  await renderBudget();
  setStatus('尚未開始', '');
  log('info', '多場模式就緒。每一場請選一個瀏覽器分頁，並確認分享視窗底部「分享分頁音訊」的開關是開的。');
}

init();
