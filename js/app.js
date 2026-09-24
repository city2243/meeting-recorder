/*
 * app.js —— 主流程與介面
 *
 * 四個階段：設定 → 開錄前檢查 → 錄製中監看 → 錄完驗證＋匯出
 * 核心主張：每一個「應該沒問題吧」都要換成一個實際量到的數字。
 */

import * as S from './storage.js';
import * as M from './media.js';
import * as C from './checks.js';

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const el = {
  statusDot: $('statusDot'), statusText: $('statusText'), timer: $('timer'),
  alertBar: $('alertBar'), alertIcon: $('alertIcon'), alertTitle: $('alertTitle'),
  alertDetail: $('alertDetail'), alertMute: $('alertMute'),
  envCard: $('envCard'), envList: $('envList'), envEscape: $('envEscape'),
  directUrl: $('directUrl'), btnCopyUrl: $('btnCopyUrl'), btnOpenTab: $('btnOpenTab'), copyNote: $('copyNote'),
  recoveryCard: $('recoveryCard'), recoveryList: $('recoveryList'),
  stepper: $('stepper'), btnStopRail: $('btnStopRail'),
  setupCard: $('setupCard'), btnPickDir: $('btnPickDir'), dirLabel: $('dirLabel'),
  btnUseSaved: $('btnUseSaved'), savedName: $('savedName'), btnForgetDir: $('btnForgetDir'),
  optAutoStart: $('optAutoStart'), countdown: $('countdown'), cdNum: $('cdNum'), btnCancelAuto: $('btnCancelAuto'),
  micSelect: $('micSelect'), btnRefreshMic: $('btnRefreshMic'), qualitySelect: $('qualitySelect'),
  expectMinutes: $('expectMinutes'),
  optBackupAudio: $('optBackupAudio'), optAlarm: $('optAlarm'), optNotify: $('optNotify'),
  optWakeLock: $('optWakeLock'), optDeep: $('optDeep'),
  btnPreflight: $('btnPreflight'),
  preflightCard: $('preflightCard'), checkList: $('checkList'),
  previewWrap: $('previewWrap'), previewVideo: $('previewVideo'),
  preflightActions: $('preflightActions'), btnStart: $('btnStart'),
  btnRecheck: $('btnRecheck'), btnCancelPre: $('btnCancelPre'),
  overrideWrap: $('overrideWrap'), optOverride: $('optOverride'),
  liveCard: $('liveCard'), gVideo: $('gVideo'), vFps: $('vFps'), vRes: $('vRes'),
  gSys: $('gSys'), sysMeter: $('sysMeter'), sysHold: $('sysHold'), sysDb: $('sysDb'), sysSub: $('sysSub'),
  gMic: $('gMic'), micMeter: $('micMeter'), micHold: $('micHold'), micDb: $('micDb'), micSub: $('micSub'),
  gDisk: $('gDisk'), diskVal: $('diskVal'), diskSub: $('diskSub'),
  sysGain: $('sysGain'), micGain: $('micGain'),
  btnStop: $('btnStop'), btnReattach: $('btnReattach'), logBox: $('logBox'),
  doneCard: $('doneCard'), doneSummary: $('doneSummary'), verifyList: $('verifyList'),
  fileList: $('fileList'), resultVideo: $('resultVideo'),
  btnAgain: $('btnAgain'), btnClearTemp: $('btnClearTemp'),
};

/* ---------------- 狀態 ---------------- */
// 可以真正錄影的公開版。claude.ai 的 artifact 被放在沙箱 iframe 裡，
// 瀏覽器政策禁止它擷取螢幕，所以那邊只能把人導到這個網址。
const PUBLIC_URL = 'https://city2243.github.io/meeting-recorder/';

const MAN_KEY = 'meetingRecorder.manifest';
const PREF_KEY = 'meetingRecorder.prefs';

const st = {
  dirHandle: null,
  screenStream: null, micStream: null,
  mix: null, videoWatch: null,
  videoMime: '', audioMime: '',
  session: null,        // { sid, startedAt, segments:[], log:[] }
  seg: null,            // 目前這一段 { idx, rec, arec, writer, awriter, startedAt }
  watchdog: null, timerTick: null, deepTimer: null,
  wakeLock: null,
  alerts: new Map(),    // key -> {level, title, detail}
  muted: false,
  titleFlash: null,
  peaks: { sys: 0, mic: 0 },
  stopping: false,
};

/* ---------------- 小工具 ---------------- */
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
const fmtDur = C.fmtDur;

/**
 * 場次編號。**一定要帶到秒**：原本只到分鐘，兩個分頁在同一分鐘內按下開始就會
 * 產生一樣的檔名，第二個會把第一個正在寫的檔案 truncate 掉 —— 是會掉資料的 bug。
 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 瀏覽器本機儲存區用的隨機碼，再擋一層同秒開始的碰撞 */
function uid() { return Math.random().toString(36).slice(2, 8); }
function clockNow() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(kind, msg) {
  const line = `[${clockNow()}] ${msg}`;
  if (st.session) st.session.log.push(line);
  const d = document.createElement('div');
  d.className = 'l-' + kind;
  d.textContent = line;
  el.logBox.appendChild(d);
  el.logBox.scrollTop = el.logBox.scrollHeight;
  while (el.logBox.childNodes.length > 500) el.logBox.removeChild(el.logBox.firstChild);
}

function setStatus(text, dotClass) {
  el.statusText.textContent = text;
  el.statusDot.className = 'rec-dot' + (dotClass ? ' ' + dotClass : '');
}

/* ---------------- 警示 ---------------- */
function raiseAlert(key, level, title, detail) {
  const prev = st.alerts.get(key);
  if (prev && prev.level === level && prev.title === title) return;
  st.alerts.set(key, { level, title, detail });
  log(level === 'fatal' ? 'fail' : 'warn', `${level === 'fatal' ? '【嚴重】' : '【注意】'}${title} — ${detail}`);
  renderAlert();
  if (level === 'fatal') {
    if (prefs().optAlarm && !st.muted) M.beep(4, 950);
    notify('錄影出問題了：' + title, detail);
    startTitleFlash('⚠ 錄影異常');
  } else if (!prev) {
    if (prefs().optAlarm && !st.muted) M.beep(1, 620);
  }
}
function clearAlert(key) {
  if (!st.alerts.has(key)) return;
  const a = st.alerts.get(key);
  st.alerts.delete(key);
  log('ok', `已恢復正常：${a.title}`);
  renderAlert();
}
function renderAlert() {
  if (st.alerts.size === 0) {
    el.alertBar.hidden = true;
    stopTitleFlash();
    return;
  }
  let top = null;
  for (const a of st.alerts.values()) if (!top || (a.level === 'fatal' && top.level !== 'fatal')) top = a;
  el.alertBar.hidden = false;
  el.alertBar.className = 'alert' + (top.level === 'fatal' ? '' : ' soft');
  el.alertIcon.textContent = top.level === 'fatal' ? '✕' : '!';
  el.alertTitle.textContent = top.title;
  const others = st.alerts.size > 1 ? `（另有 ${st.alerts.size - 1} 項待處理）` : '';
  el.alertDetail.textContent = top.detail + others;
}
function notify(title, body) {
  if (!prefs().optNotify) return;
  try {
    if (window.Notification && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'meeting-recorder', requireInteraction: true });
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

/* ---------------- 偏好 ---------------- */
function prefs() {
  return {
    micId: el.micSelect.value,
    quality: el.qualitySelect.value,
    expectMinutes: Number(el.expectMinutes.value) || 90,
    optBackupAudio: el.optBackupAudio.checked,
    optAlarm: el.optAlarm.checked,
    optNotify: el.optNotify.checked,
    optWakeLock: el.optWakeLock.checked,
    optDeep: el.optDeep.checked,
    optAutoStart: el.optAutoStart.checked,
  };
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs())); } catch (e) {}
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (p.quality) el.qualitySelect.value = p.quality;
    if (p.expectMinutes) el.expectMinutes.value = p.expectMinutes;
    ['optBackupAudio', 'optAlarm', 'optNotify', 'optWakeLock', 'optDeep', 'optAutoStart'].forEach((k) => {
      if (typeof p[k] === 'boolean') el[k].checked = p[k];
    });
    return p;
  } catch (e) { return {}; }
}

/* ---------------- 檢查清單 UI ---------------- */
function ciRow(container, name) {
  const row = document.createElement('div');
  row.className = 'ci ci-run';
  row.innerHTML = '<div class="ci-mark">…</div><div class="ci-body">' +
    '<div class="ci-name"></div><div class="ci-detail"></div><div class="ci-fix" hidden></div></div>';
  row.querySelector('.ci-name').textContent = name;
  container.appendChild(row);
  return {
    set(level, detail, fix) {
      row.className = 'ci ci-' + level;
      row.querySelector('.ci-mark').textContent = level === 'pass' ? '✓' : level === 'fail' ? '✕' : level === 'warn' ? '!' : '…';
      row.querySelector('.ci-detail').textContent = detail || '';
      const f = row.querySelector('.ci-fix');
      if (fix) { f.hidden = false; f.textContent = '→ ' + fix; } else { f.hidden = true; }
    },
    addButton(label, fn) {
      const b = document.createElement('button');
      b.className = 'btn sm'; b.type = 'button'; b.textContent = label;
      b.onclick = fn;
      row.querySelector('.ci-body').appendChild(b);
      return b;
    },
  };
}

/* ================================================================
   初始化
   ================================================================ */
async function init() {
  baseTitle = document.title;

  for (const [k, q] of Object.entries(M.QUALITY)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = q.label;
    el.qualitySelect.appendChild(o);
  }
  el.qualitySelect.value = '1080p15';
  const savedPrefs = loadPrefs();

  st.videoMime = M.pickVideoMime();
  st.audioMime = M.pickAudioMime();

  // 實際寫一個測試檔，確認「當機不掉檔」的持久寫入真的能用（不是查 API 有沒有掛著）
  st.durable = await S.probeDurableWrite();

  await renderEnv();
  await restoreDir();
  await refreshMics(savedPrefs.micId);
  await renderRecovery();

  el.btnOpenTab.onclick = () => {
    const w = window.open(PUBLIC_URL, '_blank', 'noopener');
    if (!w) el.copyNote.textContent = '這個頁面被禁止開新分頁，請改用上面的網址。';
  };
  el.btnCopyUrl.onclick = async () => {
    try {
      await navigator.clipboard.writeText(PUBLIC_URL);
      el.copyNote.textContent = '已複製，貼到新分頁的網址列就可以。';
    } catch (e) {
      const r = document.createRange();
      r.selectNodeContents(el.directUrl);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      el.copyNote.textContent = '複製按鈕被擋了，網址已幫你選起來，按 Ctrl+C。';
    }
  };
  el.btnPickDir.onclick = pickDir;
  el.btnUseSaved.onclick = useSavedDir;
  el.btnForgetDir.onclick = forgetDir;
  el.btnStopRail.onclick = () => stopRecording('\u4f7f\u7528\u8005\u6309\u4e0b\u505c\u6b62');
  el.btnCancelAuto.onclick = () => { cancelCountdown(); log('info', '\u5df2\u53d6\u6d88\u81ea\u52d5\u958b\u59cb'); };
  el.btnRefreshMic.onclick = () => refreshMics();
  el.btnPreflight.onclick = startPreflight;
  el.btnRecheck.onclick = () => { cancelCountdown(); runChecks(); };
  el.btnCancelPre.onclick = () => { cancelCountdown(); cancelPreflight(); };
  el.btnStart.onclick = startRecording;
  el.btnStop.onclick = () => stopRecording('使用者按下停止');
  el.btnReattach.onclick = reattachScreen;
  el.btnAgain.onclick = () => location.reload();
  el.btnClearTemp.onclick = clearTemp;
  el.alertMute.onclick = () => { st.muted = !st.muted; el.alertMute.textContent = st.muted ? '恢復提示音' : '靜音提示音'; };
  el.optOverride.onchange = updateStartButton;
  el.sysGain.oninput = () => st.mix && st.mix.setGain('sys', Number(el.sysGain.value));
  el.micGain.oninput = () => st.mix && st.mix.setGain('mic', Number(el.micGain.value));
  [el.qualitySelect, el.expectMinutes, el.optBackupAudio, el.optAlarm, el.optNotify,
   el.optWakeLock, el.optDeep, el.optAutoStart]
    .forEach((n) => n.addEventListener('change', savePrefs));

  window.addEventListener('beforeunload', (e) => {
    if (st.seg) { e.preventDefault(); e.returnValue = '錄影還在進行中，離開會中斷錄影。'; return e.returnValue; }
  });

  setStep(1);
  setStatus('尚未開始', '');
}

/* ---------------- 步驟指示器 ---------------- */
function setStep(n) {
  [...el.stepper.children].forEach((li, i) => {
    li.className = (i + 1 < n) ? 'done' : (i + 1 === n) ? 'now' : '';
  });
}

/* ================================================================
   環境自檢：一打開就把「這個瀏覽器做得到什麼」講清楚，
   不要等使用者按下去才發現被擋。
   ================================================================ */
async function renderEnv() {
  el.envList.innerHTML = '';
  const ua = navigator.userAgent;
  const isChromium = /Chrome|Chromium|Edg\//.test(ua) && !/Firefox/.test(ua);
  const inFrame = window.self !== window.top;
  let needTab = false;

  const r1 = ciRow(el.envList, '瀏覽器');
  if (isChromium) r1.set('pass', (/Edg\//.test(ua) ? 'Edge' : 'Chrome') + '，支援螢幕與系統音訊擷取');
  else r1.set('fail', '不是 Chrome 或 Edge',
    'Firefox 抓不到 Windows 的系統音訊，Safari 不支援螢幕錄影。請用 Chrome 或 Edge 開這一頁。');

  const r2 = ciRow(el.envList, '螢幕擷取');
  const hasGDM = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  let policy = null;
  try {
    if (document.featurePolicy && document.featurePolicy.allowsFeature) {
      policy = document.featurePolicy.allowsFeature('display-capture');
    }
  } catch (e) { /* 查不到就是查不到，不要當成通過 */ }

  if (!hasGDM) {
    r2.set('fail', '這個瀏覽器沒有螢幕擷取功能', '請改用 Chrome 或 Edge。');
  } else if (policy === false) {
    r2.set('fail', '這個嵌入頁面被禁止擷取螢幕', '按下面的「在新分頁開啟」，在自己的分頁裡跑就可以。');
    needTab = true;
  } else if (inFrame) {
    r2.set('warn', '功能在，但這一頁目前是嵌在別的頁面裡',
      '嵌入的頁面常被瀏覽器擋掉螢幕擷取。建議按下面的「在新分頁開啟」再用。');
    needTab = true;
  } else {
    r2.set('pass', '可以擷取螢幕與系統音訊');
  }

  const r3 = ciRow(el.envList, '當機不掉檔');
  if (st.durable) r3.set('pass', '錄到的資料每兩秒直接寫進磁碟，當機或停電都救得回來');
  else r3.set('warn', '這個環境不給持久寫檔，錄影只能暫存在記憶體',
    '照樣能錄、能存檔，但錄製中途當掉就沒了。在自己的分頁用 Chrome 開通常就有。');

  const r4 = ciRow(el.envList, '存檔方式');
  if (S.supportsDirectoryPicker()) r4.set('pass', '可以直接存進你指定的資料夾');
  else r4.set('warn', '這個瀏覽器不能選資料夾', '錄完會用一般下載的方式給你檔案。');

  el.directUrl.textContent = PUBLIC_URL;
  el.envEscape.hidden = !needTab;
}

async function refreshMics(preferId) {
  el.micSelect.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '不錄麥克風（只錄會議聲音）';
  el.micSelect.appendChild(none);
  try {
    const mics = await M.listMics();
    mics.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || ('麥克風 ' + (i + 1));
      el.micSelect.appendChild(o);
    });
    if (preferId && mics.some((m) => m.deviceId === preferId)) el.micSelect.value = preferId;
    else if (mics.length) el.micSelect.value = mics[0].deviceId;
  } catch (e) {
    log('warn', '列舉麥克風失敗：' + e.message);
  }
  el.micSelect.addEventListener('change', savePrefs, { once: true });
}

async function pickDir() {
  try {
    st.dirHandle = await S.pickOutputDir();
    st.savedDir = st.dirHandle;
    await S.rememberDir(st.dirHandle);
    showDirReady(st.dirHandle.name);
  } catch (e) {
    if (e.name !== 'AbortError') toast('選擇資料夾失敗', e.message);
  }
}

function showDirReady(name) {
  el.dirLabel.textContent = name + '（已記住，下次直接用）';
  el.btnUseSaved.hidden = true;
  el.btnForgetDir.hidden = false;
  el.btnPickDir.textContent = '換一個資料夾';
}

/**
 * 開頁時先把上次的資料夾拿回來。
 * 權限還在就直接用；退回 'prompt' 是瀏覽器的規定（重新授權必須由使用者點一下），
 * 這時至少不要再跑一次選檔視窗，只要按「繼續用」。
 */
async function restoreDir() {
  if (!S.supportsDirectoryPicker()) return;
  const h = await S.recallDir();
  if (!h) return;
  st.savedDir = h;
  const p = await S.dirPermission(h, false);
  if (p === 'granted') {
    st.dirHandle = h;
    showDirReady(h.name);
  } else if (p === 'prompt') {
    el.savedName.textContent = h.name;
    el.btnUseSaved.hidden = false;
    el.btnForgetDir.hidden = false;
    el.btnPickDir.textContent = '換一個資料夾';
    el.dirLabel.textContent = '上次用這個資料夾，按左邊確認就能沿用';
  } else {
    await S.forgetDir();
    st.savedDir = null;
  }
}

async function useSavedDir() {
  const p = await S.dirPermission(st.savedDir, true);
  if (p === 'granted') {
    st.dirHandle = st.savedDir;
    showDirReady(st.savedDir.name);
  } else {
    toast('還是沒拿到寫入權限', '請按「換一個資料夾」重新挑一次。');
  }
}

async function forgetDir() {
  await S.forgetDir();
  st.savedDir = null;
  st.dirHandle = null;
  el.btnUseSaved.hidden = true;
  el.btnForgetDir.hidden = true;
  el.btnPickDir.textContent = '選擇資料夾';
  el.dirLabel.textContent = '尚未選擇';
}

/* ================================================================
   救援：上次留下的檔案
   ================================================================ */
function readManifest() { try { return JSON.parse(localStorage.getItem(MAN_KEY) || '[]'); } catch (e) { return []; } }
function writeManifest(m) { try { localStorage.setItem(MAN_KEY, JSON.stringify(m.slice(-30))); } catch (e) {} }
function manifestFor(opfsName) {
  for (const s of readManifest()) for (const f of s.files) if (f.opfs === opfsName) return { s, f };
  return null;
}

async function renderRecovery() {
  if (!S.supportsDurableWrite()) return;
  let files = [];
  try { files = await S.listStored(); } catch (e) { return; }
  files = files.filter((f) => f.size > 0);
  if (!files.length) { el.recoveryCard.hidden = true; return; }

  el.recoveryCard.hidden = false;
  el.recoveryList.innerHTML = '';
  for (const f of files) {
    const info = manifestFor(f.name);
    const target = info ? info.f.target : f.name;
    const exported = info && info.s.exported;
    const row = document.createElement('div');
    row.className = '';
    row.innerHTML = '<span class="fn"></span><span class="meta"></span>';
    row.querySelector('.fn').textContent = target;
    row.querySelector('.meta').textContent =
      fmtBytes(f.size) + ' · ' + new Date(f.lastModified).toLocaleString('zh-TW') + (exported ? ' · 已匯出過' : ' · 尚未匯出');

    const bSave = document.createElement('button');
    bSave.className = 'btn sm accent'; bSave.type = 'button'; bSave.textContent = '另存到資料夾';
    bSave.onclick = async () => {
      try {
        if (!st.dirHandle) await pickDir();
        if (!st.dirHandle) return;
        bSave.disabled = true; bSave.textContent = '存檔中…';
        await S.exportToDir(st.dirHandle, f.name, target);
        bSave.textContent = '已存檔 ✓';
      } catch (e) { bSave.disabled = false; bSave.textContent = '另存到資料夾'; alert('存檔失敗：' + e.message); }
    };
    const bDel = document.createElement('button');
    bDel.className = 'btn sm ghost'; bDel.type = 'button'; bDel.textContent = '刪除';
    bDel.onclick = async () => {
      if (!confirm('確定刪除「' + target + '」？刪掉就救不回來了。')) return;
      await S.deleteStored(f.name); renderRecovery();
    };
    row.appendChild(bSave); row.appendChild(bDel);
    el.recoveryList.appendChild(row);
  }
}

async function clearTemp() {
  if (!confirm('把瀏覽器裡的暫存副本全部刪除？請先確認資料夾裡的檔案可以正常播放。')) return;
  const files = await S.listStored();
  for (const f of files) { try { await S.deleteStored(f.name); } catch (e) {} }
  writeManifest([]);
  await renderRecovery();
  alert('已清除。');
}

/* ================================================================
   步驟 2：開錄前檢查
   ================================================================ */
async function startPreflight() {
  if (!S.supportsDurableWrite()) {
    toast('這個環境沒有「當機不掉檔」的保障',
      '錄影會暫存在記憶體，錄製中途當掉就沒了。建議在自己的分頁用 Chrome 開這一頁。');
  }

  try {
    if (prefs().optNotify && window.Notification && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  } catch (e) {}

  try {
    st.screenStream = await M.getScreen(prefs().quality);
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      toast('沒有取得畫面', '你取消了分享，或這個頁面被瀏覽器禁止擷取螢幕。若是後者，請先按最上方的「在新分頁開啟」。');
      return;
    }
    toast('取得畫面失敗', e.message); return;
  }

  const micId = prefs().micId;
  st.micStream = null;
  if (micId !== '') {
    try { st.micStream = await M.getMic(micId); }
    catch (e) { log('warn', '麥克風取得失敗：' + e.message); }
  }

  st.mix = new M.AudioMix();
  await st.mix.resume();
  const sysTrack = st.screenStream.getAudioTracks()[0] || null;
  const micTrack = st.micStream ? st.micStream.getAudioTracks()[0] : null;
  if (sysTrack) st.mix.addTrack('sys', sysTrack, 1.0);
  if (micTrack) st.mix.addTrack('mic', micTrack, 1.0);

  const videoTrack = st.screenStream.getVideoTracks()[0];
  st.videoWatch = new M.VideoWatch(videoTrack);

  el.previewVideo.srcObject = new MediaStream([videoTrack]);
  el.previewVideo.play().catch(() => {});
  el.previewWrap.hidden = false;

  el.setupCard.hidden = true;
  el.preflightCard.hidden = false;
  setStep(2);
  await runChecks();
}

function cancelPreflight() {
  teardownMedia();
  el.preflightCard.hidden = true;
  el.setupCard.hidden = false;
  setStep(1);
  setStatus('尚未開始', '');
}

function teardownMedia() {
  if (st.videoWatch) { st.videoWatch.stop(); st.videoWatch = null; }
  if (st.mix) { st.mix.close(); st.mix = null; }
  [st.screenStream, st.micStream].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
  st.screenStream = null; st.micStream = null;
  try { el.previewVideo.srcObject = null; } catch (e) {}
}

let checkResults = [];

async function runChecks() {
  el.checkList.innerHTML = '';
  el.preflightActions.hidden = true;
  el.overrideWrap.hidden = true;
  checkResults = [];
  setStatus('檢查中…', 'warn');

  const add = (name) => { const r = ciRow(el.checkList, name); return r; };
  const rec = (level) => checkResults.push(level);

  const videoTrack = st.screenStream && st.screenStream.getVideoTracks()[0];
  const sysTrack = st.screenStream && st.screenStream.getAudioTracks()[0];
  const micTrack = st.micStream && st.micStream.getAudioTracks()[0];

  /* 1. 瀏覽器能力 */
  {
    const r = add('瀏覽器能力');
    const miss = [];
    if (!window.MediaRecorder) miss.push('MediaRecorder');
    if (!st.videoMime) miss.push('WebM 影像編碼');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) miss.push('螢幕擷取');
    if (miss.length) { r.set('fail', '缺少：' + miss.join('、'), '請改用 Chrome 或 Edge 的最新版本。'); rec('fail'); }
    else if (!S.supportsDurableWrite()) {
      r.set('warn', '沒有持久寫檔能力（當機可能掉檔）', '建議改用 Chrome / Edge。'); rec('warn');
    } else {
      r.set('pass', `編碼 ${st.videoMime}；持久寫檔可用`); rec('pass');
    }
  }

  /* 2. 儲存空間 */
  {
    const r = add('儲存空間');
    const q = M.QUALITY[prefs().quality];
    const needBytes = (q.videoBitsPerSecond + 128000) / 8 * prefs().expectMinutes * 60 * 1.15;
    const est = await S.estimateSpace();
    await S.requestPersistent();
    if (!est) { r.set('warn', '無法查詢可用空間', '自己確認硬碟還有 ' + fmtBytes(needBytes) + ' 以上。'); rec('warn'); }
    else if (est.free < needBytes) {
      r.set('fail', `瀏覽器可用 ${fmtBytes(est.free)}，這場預估需要 ${fmtBytes(needBytes)}`,
        '清一些硬碟空間，或把畫質調低、預計長度調短。'); rec('fail');
    } else {
      const hrs = (est.free * 8) / (q.videoBitsPerSecond + 128000) / 3600;
      r.set('pass', `可用 ${fmtBytes(est.free)}，這個畫質大約可以錄 ${hrs.toFixed(1)} 小時（這場預估 ${fmtBytes(needBytes)}）`); rec('pass');
    }
  }

  /* 3. 存檔資料夾 */
  {
    const r = add('存檔資料夾可寫入');
    if (!st.dirHandle) {
      if (S.supportsDirectoryPicker()) {
        r.set('warn', '尚未選擇資料夾', '錄完會改用瀏覽器下載的方式存檔。建議先回上一步選一個資料夾。'); rec('warn');
      } else {
        r.set('warn', '這個瀏覽器不支援選資料夾', '錄完會用一般下載的方式存檔。'); rec('warn');
      }
    } else {
      try { await S.probeDirWritable(st.dirHandle); r.set('pass', `「${st.dirHandle.name}」寫入測試通過`); rec('pass'); }
      catch (e) { r.set('fail', '寫入測試失敗：' + e.message, '換一個資料夾（不要選唯讀或雲端同步中的位置）。'); rec('fail'); }
    }
  }

  /* 4. 畫面來源類型 */
  {
    const r = add('畫面來源');
    if (!videoTrack || videoTrack.readyState !== 'live') {
      r.set('fail', '沒有可用的畫面來源', '按「重新檢查」重選畫面。'); rec('fail');
    } else {
      const s = videoTrack.getSettings() || {};
      const surface = s.displaySurface || '未知';
      const nameMap = { monitor: '整個畫面', window: '單一視窗', browser: '瀏覽器分頁' };
      const detail = `${nameMap[surface] || surface}，${s.width || '?'}×${s.height || '?'}，${Math.round(s.frameRate || 0)} fps`;
      if (surface === 'monitor') { r.set('pass', detail); rec('pass'); }
      else {
        r.set('warn', detail + '（不是整個畫面）',
          'Zoom／Webex 是桌面程式，選「視窗」會抓不到系統聲音，而且對方切換視窗時也錄不到。建議重新檢查並改選「整個畫面」。');
        rec('warn');
      }
    }
  }

  /* 5. 畫面真的在更新 */
  {
    const r = add('畫面正在更新');
    const f0 = st.videoWatch.frames;
    await C.sleep(2500);
    const df = st.videoWatch.frames - f0;
    if (df < 3) {
      r.set('fail', `2.5 秒只收到 ${df} 張畫格（感測器 ${st.videoWatch.sensorInfo}）`,
        '畫面來源可能被最小化或已停止分享。按「重新檢查」重選。'); rec('fail');
    } else {
      r.set('pass', `2.5 秒收到 ${df} 張畫格（約 ${(df / 2.5).toFixed(1)} fps）`); rec('pass');
    }
  }

  /* 6. 系統音軌 */
  let sysOk = false;
  {
    const r = add('系統音訊（會議的聲音）');
    if (!sysTrack) {
      r.set('fail', '這次分享沒有帶任何系統音訊',
        '按「重新檢查」重選，在 Chrome 的分享視窗裡選「整個畫面」，並勾選左下角的「同時分享系統音訊」。');
      rec('fail');
    } else if (sysTrack.readyState !== 'live') {
      r.set('fail', '系統音訊軌已中斷', '按「重新檢查」重選。'); rec('fail');
    } else {
      sysOk = true;
      r.set('pass', '已取得系統音訊軌：' + (sysTrack.label || '（無名稱）')); rec('pass');
    }
  }

  /* 7+8+9. 實錄驗證：試錄一小段，放測試音，再把成品解碼回來看 */
  const rTrial = add('試錄並解碼驗證（最關鍵的一項）');
  const rTone = add('系統音回路（喇叭→錄音）');
  const rMic = add('麥克風訊號');
  rTrial.set('run', '試錄中，請稍候約 4 秒…');
  rTone.set('run', '正在播放測試音…');
  rMic.set('run', '量測中…');

  let trialLevels = { sys: 0, mic: 0 };
  let avBlob = null, aBlob = null;

  if (videoTrack && videoTrack.readyState === 'live') {
    const q = M.QUALITY[prefs().quality];
    const avStream = new MediaStream([videoTrack, st.mix.audioTrack].filter(Boolean));
    const sampler = (async () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 4200) {
        const a = st.mix.level('sys'), b = st.mix.level('mic');
        if (a !== null && a > trialLevels.sys) trialLevels.sys = a;
        if (b !== null && b > trialLevels.mic) trialLevels.mic = b;
        await C.sleep(40);
      }
    })();

    const pAV = C.trialRecord(avStream, 4000, st.videoMime, { video: q.videoBitsPerSecond, audio: 128000 });
    const pA = st.audioMime ? C.trialRecord(st.mix.stream, 4000, st.audioMime, { audio: 96000 }) : Promise.resolve(null);
    await C.sleep(900);
    try { await C.playTestTone(1600, 660); } catch (e) {}
    try { [avBlob, aBlob] = await Promise.all([pAV, pA]); } catch (e) { log('fail', '試錄失敗：' + e.message); }
    await sampler;
  }

  /* 7. 試錄成品 */
  {
    if (!avBlob || avBlob.size < 5000) {
      rTrial.set('fail', `試錄產出 ${avBlob ? fmtBytes(avBlob.size) : '0 B'}，等於沒錄到`,
        '換一個畫質再試；若持續失敗，重開瀏覽器。'); rec('fail');
    } else {
      const meta = await C.probeVideoMeta(avBlob);
      if (!meta.ok) { rTrial.set('fail', '試錄檔無法解碼：' + meta.error, '換一個畫質再試。'); rec('fail'); }
      else if (!meta.hasVideo) { rTrial.set('fail', '試錄檔裡沒有影像', '按「重新檢查」重選畫面來源。'); rec('fail'); }
      else {
        let audioNote = '';
        let audioLevel = 'pass';
        // 不設「檔案要夠大才驗」的門檻：Opus 把靜音壓得極小，設門檻等於在沒聲音時跳過檢查
        if (aBlob && aBlob.size > 0) {
          const stt = await C.decodeAudioStats(aBlob);
          if (!stt.ok) {
            if (aBlob.size < 1500) { audioNote = `；音訊樣本只有 ${aBlob.size} bytes 又解不開，幾乎確定沒聲音`; audioLevel = 'fail'; }
            else { audioNote = '；聲音解碼失敗（' + stt.error + '）'; audioLevel = 'warn'; }
          } else if (stt.peak < 0.005) {
            audioNote = `；但聲音是一片數位靜音（峰值 ${stt.peak < 1e-6 ? stt.peak.toExponential(1) : stt.peak.toFixed(5)}）`;
            audioLevel = 'fail';
          } else {
            audioNote = `；聲音峰值 ${stt.peak.toFixed(3)}`;
          }
        } else { audioNote = '；沒有可驗證的音訊樣本'; audioLevel = 'warn'; }

        const detail = `影像 ${meta.width}×${meta.height}、${fmtBytes(avBlob.size)} / 4 秒${audioNote}`;
        if (audioLevel === 'fail') {
          rTrial.set('fail', detail,
            '影像有了但聲音是空的。檢查：①分享時有沒有勾「同時分享系統音訊」 ②Windows 音量混音器裡瀏覽器有沒有被靜音。');
          rec('fail');
        } else if (audioLevel === 'warn') { rTrial.set('warn', detail, '聲音沒驗證成功，開錄後請盯著音量條確認有跳動。'); rec('warn'); }
        else { rTrial.set('pass', detail); rec('pass'); }
      }
    }
  }

  /* 8. 系統音回路 */
  {
    if (!sysOk) { rTone.set('fail', '沒有系統音訊軌，無法測試', '先解決上面的系統音訊項目。'); rec('fail'); }
    else if (trialLevels.sys > 0.01) { rTone.set('pass', `測試音有被錄進來（峰值 ${trialLevels.sys.toFixed(3)}）—— 會議的聲音會錄到`); rec('pass'); }
    else {
      rTone.set('warn', `測試音沒被偵測到（峰值 ${trialLevels.sys.toFixed(4)}）`,
        '可能是這台電腦的喇叭音量太小或瀏覽器被靜音。請在會議軟體裡放一段聲音，然後按下面的按鈕重測 8 秒。');
      rec('warn');
      rTone.addButton('手動重測 8 秒（請讓電腦發出聲音）', async (ev) => {
        const b = ev.target; b.disabled = true; b.textContent = '量測中…';
        const peak = await C.sampleLevel(st.mix, 'sys', 8000);
        if (peak > 0.01) { rTone.set('pass', `手動重測通過（峰值 ${peak.toFixed(3)}）`); }
        else { rTone.set('warn', `手動重測仍是靜音（峰值 ${peak.toFixed(4)}）`, '確認 Windows 音量混音器裡 Chrome 沒有被靜音，且分享時有勾「同時分享系統音訊」。'); }
        b.disabled = false; b.textContent = '再測一次';
      });
    }
  }

  /* 9. 麥克風 */
  {
    if (prefs().micId === '') { rMic.set('pass', '已選擇不錄麥克風'); rec('pass'); }
    else if (!micTrack || micTrack.readyState !== 'live') {
      rMic.set('warn', '沒有取得麥克風', '檢查瀏覽器的麥克風權限，或在上一步選「不錄麥克風」。'); rec('warn');
    } else if (trialLevels.mic > 0.008) {
      rMic.set('pass', `有收到聲音（峰值 ${trialLevels.mic.toFixed(3)}）`); rec('pass');
    } else {
      rMic.set('warn', `麥克風安靜無聲（峰值 ${trialLevels.mic.toFixed(4)}）`, '對著麥克風說話，再按下面的按鈕重測 6 秒。');
      rec('warn');
      rMic.addButton('說句話，重測 6 秒', async (ev) => {
        const b = ev.target; b.disabled = true; b.textContent = '請說話…';
        const peak = await C.sampleLevel(st.mix, 'mic', 6000);
        if (peak > 0.008) rMic.set('pass', `重測通過（峰值 ${peak.toFixed(3)}）`);
        else rMic.set('warn', `重測仍無聲（峰值 ${peak.toFixed(4)}）`, '確認選對麥克風、Windows 沒把它靜音。');
        b.disabled = false; b.textContent = '再測一次';
      });
    }
  }

  el.preflightActions.hidden = false;
  updateStartButton();
  cancelCountdown();
  const fails = checkResults.filter((x) => x === 'fail').length;
  const warns = checkResults.filter((x) => x === 'warn').length;
  setStatus(fails ? `${fails} 項未通過` : warns ? `通過（${warns} 項提醒）` : '全部通過', fails ? 'warn' : 'ok');
  if (fails) el.overrideWrap.hidden = false;
  else if (prefs().optAutoStart) startCountdown(warns);
}

/* 選了「自動開始」才會跑。倒數看得見、按得掉，不會偷偷开始錄。 */
function startCountdown(warns) {
  cancelCountdown();
  let n = 3;
  el.cdNum.textContent = n;
  el.countdown.hidden = false;
  log('info', warns ? `沒有紅色項目（${warns} 項提醒），3 秒後自動開始` : '檢查全過，3 秒後自動開始');
  st.cdTimer = setInterval(() => {
    n -= 1;
    el.cdNum.textContent = n;
    if (n <= 0) { cancelCountdown(); startRecording(); }
  }, 1000);
}

function cancelCountdown() {
  if (st.cdTimer) { clearInterval(st.cdTimer); st.cdTimer = null; }
  el.countdown.hidden = true;
}

function updateStartButton() {
  const fails = checkResults.filter((x) => x === 'fail').length;
  el.btnStart.disabled = fails > 0 && !el.optOverride.checked;
  el.btnStart.textContent = fails > 0 ? '仍要開始錄製（有未通過項目）' : '開始錄製';
}

/* ================================================================
   步驟 3：錄製
   ================================================================ */
async function startRecording() {
  const sid = stamp();
  st.session = { sid, uid: uid(), startedAt: Date.now(), segments: [], log: [], frames0: st.videoWatch.frames, deepChecks: [] };
  st.stopping = false;
  cancelCountdown();
  el.preflightCard.hidden = true;
  el.liveCard.hidden = false;
  el.timer.hidden = false;
  el.btnStopRail.hidden = false;
  setStep(3);
  el.logBox.innerHTML = '';
  log('info', `開始錄製（畫質 ${prefs().quality}，編碼 ${st.videoMime}）`);

  await acquireWakeLock();
  await startSegment(1);

  startHeartbeat();

  const vt = st.screenStream.getVideoTracks()[0];
  vt.onended = () => onScreenEnded();

  setStatus('錄製中', 'rec');
}

async function startSegment(idx) {
  const sid = st.session.sid;
  const suffix = idx > 1 ? `_第${idx}段` : '';
  const vOpfs = `${sid}_${st.session.uid}_v${idx}.webm`;
  const aOpfs = `${sid}_${st.session.uid}_a${idx}.webm`;
  const vTarget = `會議錄影_${sid}${suffix}.webm`;
  const aTarget = `會議錄影_${sid}${suffix}_音訊備份.webm`;

  const q = M.QUALITY[prefs().quality];
  const videoTrack = st.screenStream.getVideoTracks()[0];
  const combined = new MediaStream([videoTrack, st.mix.audioTrack].filter(Boolean));

  const writer = await S.makeWriter(vOpfs);

  const rec = new MediaRecorder(combined, {
    mimeType: st.videoMime,
    videoBitsPerSecond: q.videoBitsPerSecond,
    audioBitsPerSecond: 128000,
  });
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    writer.write(e.data).catch((err) => raiseAlert('write', 'fatal', '寫檔失敗', err.message));
  };
  rec.onerror = (e) => raiseAlert('recorder', 'fatal', '錄影器發生錯誤', String((e.error && e.error.name) || e));

  let awriter = null, arec = null;
  if (prefs().optBackupAudio && st.audioMime && st.mix.audioTrack) {
    awriter = await S.makeWriter(aOpfs);
    arec = new MediaRecorder(st.mix.stream, { mimeType: st.audioMime, audioBitsPerSecond: 96000 });
    arec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      awriter.write(e.data).catch((err) => log('warn', '備份音訊寫檔失敗：' + err.message));
    };
  }

  rec.start(2000);
  if (arec) arec.start(2000);

  st.seg = { idx, rec, arec, writer, awriter, startedAt: Date.now(), vOpfs, aOpfs, vTarget, aTarget, lastBytes: 0, lastGrowAt: Date.now() };
  st.session.segments.push(st.seg);

  const man = readManifest();
  const entry = man.find((m) => m.sid === st.session.sid) || { sid: st.session.sid, startedAt: st.session.startedAt, exported: false, files: [] };
  entry.files.push({ opfs: vOpfs, target: vTarget, kind: 'video' });
  if (awriter) entry.files.push({ opfs: aOpfs, target: aTarget, kind: 'audio' });
  if (!man.includes(entry)) man.push(entry);
  writeManifest(man);

  log(writer.durable ? 'ok' : 'warn',
    `第 ${idx} 段開始寫入：${vTarget}${awriter ? '（含音訊備份）' : ''}` +
    (writer.durable ? '' : '　⚠ 這個環境只能暫存在記憶體，錄製中當掉會沒有'));
}

/* ---------------- 心跳 ----------------
 * 一律走 Worker：主執行緒的 setInterval 在背景分頁會被節流，
 * 而這個分頁在錄影時本來就是背景分頁。setInterval 只當 Worker 起不來時的退路。
 */
function heartbeat() {
  updateTimer();
  watchdogTick();
  if (prefs().optDeep && Date.now() - (st.lastDeep || st.session.startedAt) > 5 * 60 * 1000) {
    st.lastDeep = Date.now();
    runDeepCheck();
  }
}

function startHeartbeat() {
  st.lastDeep = Date.now();
  try {
    st.ticker = new Worker('./js/ticker-worker.js');
    st.ticker.onmessage = heartbeat;
    st.ticker.onerror = () => {
      log('warn', '心跳 Worker 失敗，改用一般計時器（背景分頁可能被節流）');
      if (!st.watchdog) st.watchdog = setInterval(heartbeat, 1000);
    };
    st.ticker.postMessage({ type: 'start', interval: 1000 });
    log('ok', '監看心跳已啟動（不受背景分頁節流影響）');
  } catch (e) {
    log('warn', '心跳 Worker 無法建立，改用一般計時器：' + e.message);
    st.watchdog = setInterval(heartbeat, 1000);
  }
}

function stopHeartbeat() {
  if (st.ticker) { try { st.ticker.postMessage({ type: 'stop' }); st.ticker.terminate(); } catch (e) {} st.ticker = null; }
  if (st.watchdog) { clearInterval(st.watchdog); st.watchdog = null; }
}

/* ---------------- 音量表 ----------------
 * 錄音的單位是 dBFS，不是百分比。圖上的白線是峰值指示（peak hold），
 * 會慢慢往下掉——一眼就能看出剛才最大聲到哪裡。
 */
const SOUND_FLOOR = 0.0027;        // 約 -51 dBFS，低於此當作沒有聲音
const holds = { sys: 0, mic: 0 };

function dbfs(rms) { return rms > 1e-5 ? 20 * Math.log10(rms) : -Infinity; }

function meterPct(rms) {           // -60 dBFS 到 0 dBFS 對應 0~100%
  const db = dbfs(rms);
  return db === -Infinity ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function paintMeter(key, rms, dbEl, fillEl, holdEl) {
  const db = dbfs(rms);
  dbEl.innerHTML = (db === -Infinity ? '−∞' : db.toFixed(1).replace('-', '−')) + ' <i>dBFS</i>';
  const pct = meterPct(rms);
  fillEl.style.width = pct + '%';
  holds[key] = Math.max(pct, holds[key] - 3);
  holdEl.style.left = holds[key] + '%';
}

/** 輕量提示：不用 alert()，因為嵌入頁面可能被禁止跳彈窗 */
function toast(title, detail) {
  raiseAlert('ui', 'warn', title, detail || '');
  setTimeout(() => clearAlert('ui'), 9000);
}

function updateTimer() {
  if (!st.session) return;
  const sec = (Date.now() - st.session.startedAt) / 1000;
  el.timer.textContent = fmtDur(sec);
}

let lastFrames = 0, lastFrameCheck = 0;

function watchdogTick() {
  if (!st.seg || st.stopping) return;
  const now = Date.now();
  const seg = st.seg;

  /* --- 畫面 --- */
  const vt = st.screenStream.getVideoTracks()[0];
  if (st.videoWatch.poll) st.videoWatch.poll();   // 它內部的計時器也可能被節流，這裡補催一次
  const frames = st.videoWatch.frames;
  const dt = lastFrameCheck ? (now - lastFrameCheck) / 1000 : 1;
  const fps = lastFrameCheck ? (frames - lastFrames) / dt : 0;
  lastFrames = frames; lastFrameCheck = now;

  const s = st.videoWatch.settings;
  el.vFps.textContent = fps.toFixed(1) + ' fps';
  el.vRes.textContent = `${s.width || '?'}×${s.height || '?'} · 累計 ${frames} 格`;

  if (!vt || vt.readyState !== 'live') {
    el.gVideo.className = 'slot bad';
    raiseAlert('video', 'fatal', '畫面分享已中斷',
      '有人按了 Chrome 的「停止共用」，或來源視窗關了。聲音仍在錄；按「重新接上畫面」可以接著錄新的一段。');
    el.btnReattach.hidden = false;
  } else if (st.videoWatch.staleSeconds > 6) {
    el.gVideo.className = 'slot bad';
    raiseAlert('video', 'fatal', '畫面停止更新',
      `已經 ${st.videoWatch.staleSeconds.toFixed(0)} 秒沒有新畫格（感測器 ${st.videoWatch.sensorInfo}）。分享來源可能被最小化了。`);
  } else if (st.videoWatch.staleSeconds > 2.5) {
    el.gVideo.className = 'slot soft';
  } else {
    el.gVideo.className = 'slot';
    clearAlert('video');
    el.btnReattach.hidden = true;
  }

  /* --- 聲音 --- */
  const sysRms = st.mix.levelRaw('sys');
  const micRms = st.mix.levelRaw('mic');

  if (sysRms !== null) {
    if (sysRms > st.peaks.sys) st.peaks.sys = sysRms;
    paintMeter('sys', sysRms, el.sysDb, el.sysMeter, el.sysHold);
    if (sysRms > SOUND_FLOOR) seg.lastSysSound = now;
    const quiet = (now - (seg.lastSysSound || seg.startedAt)) / 1000;
    el.sysSub.textContent = quiet > 5 ? `已安靜 ${Math.round(quiet)} 秒` : '訊號正常';
    if (quiet > 120) {
      el.gSys.className = 'slot soft';
      raiseAlert('sys', 'warn', '會議聲音已經兩分鐘沒有任何波形',
        '如果會議正在講話，代表抓錯音源了，建議停下來重新開始。');
    } else { el.gSys.className = 'slot'; clearAlert('sys'); }
  } else {
    el.sysDb.textContent = '無訊號';
    el.sysSub.textContent = '這次分享沒有帶系統音訊';
    el.gSys.className = 'slot bad';
  }

  if (micRms !== null) {
    if (micRms > st.peaks.mic) st.peaks.mic = micRms;
    paintMeter('mic', micRms, el.micDb, el.micMeter, el.micHold);
    if (micRms > SOUND_FLOOR) seg.lastMicSound = now;
    const quiet = (now - (seg.lastMicSound || seg.startedAt)) / 1000;
    el.micSub.textContent = quiet > 5 ? `已安靜 ${Math.round(quiet)} 秒` : '訊號正常';
    el.gMic.className = quiet > 300 ? 'slot soft' : 'slot';
  } else {
    el.micDb.textContent = '未使用';
    el.micSub.textContent = '這場沒有錄麥克風';
  }

  /* --- 磁碟 --- */
  const bytes = seg.writer.bytesOnDisk;
  const totalBytes = st.session.segments.reduce((a, x) => a + x.writer.bytesOnDisk, 0);
  if (bytes > seg.lastBytes) { seg.lastBytes = bytes; seg.lastGrowAt = now; }
  const stall = (now - seg.lastGrowAt) / 1000;
  const recSec = (now - st.session.startedAt) / 1000;
  el.diskVal.textContent = fmtBytes(totalBytes);
  el.diskSub.textContent = `平均 ${recSec > 0 ? ((totalBytes / 1048576) / (recSec / 60)).toFixed(1) : '0'} MB/分` +
    (st.session.segments.length > 1 ? ` · ${st.session.segments.length} 段` : '');

  if (recSec > 12 && stall > 15) {
    el.gDisk.className = 'slot bad';
    raiseAlert('disk', 'fatal', '已經 ' + Math.round(stall) + ' 秒沒有新資料寫進磁碟',
      '錄影可能已經停住。建議按「停止並存檔」保住現有內容，再重新開始。');
  } else {
    el.gDisk.className = 'slot';
    clearAlert('disk');
  }
  if (seg.rec.state !== 'recording') {
    raiseAlert('recstate', 'fatal', '錄影器不在錄製狀態（' + seg.rec.state + '）', '請按「停止並存檔」保住目前內容。');
  }
  if (seg.writer.failed) {
    raiseAlert('write', 'fatal', '寫檔發生錯誤', seg.writer.failed.message);
  }
}

async function runDeepCheck() {
  if (!st.seg || st.stopping || !st.audioMime) return;
  const res = await C.deepCheck(st.mix.stream, st.audioMime);
  const t = fmtDur((Date.now() - st.session.startedAt) / 1000);
  if (!res.ok) {
    st.session.deepChecks.push(`${t} 失敗：${res.reason}`);
    raiseAlert('deep', 'fatal', '深度健檢沒過：' + res.reason, '編碼管線可能出事了，建議停止存檔後重開一場。');
  } else {
    const silent = res.stats.peak < 0.005;
    st.session.deepChecks.push(`${t} 通過（峰值 ${res.stats.peak.toFixed(3)}）`);
    log(silent ? 'warn' : 'ok', `深度健檢通過：編碼與解碼正常，1.2 秒樣本峰值 ${res.stats.peak.toFixed(3)}${silent ? '（近乎靜音）' : ''}`);
    clearAlert('deep');
  }
}

function onScreenEnded() {
  if (st.stopping || !st.seg) return;
  raiseAlert('video', 'fatal', '畫面分享已停止',
    '聲音還在錄。按「重新接上畫面」可以選新的畫面、接著錄成第 ' + (st.seg.idx + 1) + ' 段。');
  el.btnReattach.hidden = false;
}

async function reattachScreen() {
  if (!st.seg) return;
  el.btnReattach.disabled = true;
  try {
    const newStream = await M.getScreen(prefs().quality);
    log('info', '取得新的畫面來源，正在切段…');

    await finalizeSegment();

    try { st.screenStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    if (st.videoWatch) st.videoWatch.stop();

    // 換掉混音裡的系統音來源
    const newSys = newStream.getAudioTracks()[0];
    if (newSys) {
      st.mix.addTrack('sys', newSys, Number(el.sysGain.value));
      log('ok', '新的系統音訊已接上');
    } else {
      log('warn', '新的分享沒有帶系統音訊，這一段只會有麥克風');
    }
    st.screenStream = newStream;
    st.videoWatch = new M.VideoWatch(newStream.getVideoTracks()[0]);
    newStream.getVideoTracks()[0].onended = () => onScreenEnded();

    await startSegment(st.session.segments.length + 1);
    clearAlert('video');
    el.btnReattach.hidden = true;
  } catch (e) {
    log('fail', '重新接上畫面失敗：' + e.message);
    toast('重新接上畫面失敗', e.message);
  }
  el.btnReattach.disabled = false;
}

function stopRecorder(rec) {
  return new Promise((resolve) => {
    if (!rec || rec.state === 'inactive') return resolve();
    rec.onstop = () => resolve();
    try { rec.requestData(); rec.stop(); } catch (e) { resolve(); }
    setTimeout(resolve, 8000);
  });
}

async function finalizeSegment() {
  const seg = st.seg;
  if (!seg) return;
  seg.endedAt = Date.now();
  await stopRecorder(seg.rec);
  await stopRecorder(seg.arec);
  await seg.writer.close();
  if (seg.awriter) await seg.awriter.close();
  log('ok', `第 ${seg.idx} 段收檔完成：${fmtBytes(seg.writer.bytesOnDisk)}`);
  st.seg = null;
}

/* ================================================================
   步驟 4：停止、驗證、匯出
   ================================================================ */
async function stopRecording(reason) {
  if (st.stopping || !st.session) return;
  st.stopping = true;
  el.btnStop.disabled = true;
  el.btnStop.textContent = '收檔中…';
  setStatus('收檔中', 'warn');
  log('info', '停止錄製（' + reason + '）');

  stopHeartbeat();

  await finalizeSegment();
  releaseWakeLock();
  const totalSec = (Date.now() - st.session.startedAt) / 1000;
  const frames = st.videoWatch ? st.videoWatch.frames - st.session.frames0 : null;
  teardownMedia();

  el.btnStopRail.hidden = true;
  el.liveCard.hidden = true;
  el.doneCard.hidden = false;
  setStep(4);
  el.doneSummary.className = 'verdict';
  el.doneSummary.textContent = '正在驗證檔案…';
  el.verifyList.innerHTML = '';
  el.fileList.innerHTML = '';

  /* --- 驗證 --- */
  const segs = st.session.segments;
  const main = segs[0];
  let report = null;
  try {
    const vFile = await main.writer.getFile();
    const aFile = main.awriter ? await main.awriter.getFile() : null;
    report = await C.verifyFile(vFile, aFile, { seconds: (main.endedAt - main.startedAt) / 1000, frames });
    el.resultVideo.src = URL.createObjectURL(vFile);
  } catch (e) {
    report = { pass: false, warn: false, items: [{ level: 'fail', name: '讀取錄影檔', detail: e.message }] };
  }

  for (const it of report.items) {
    const r = ciRow(el.verifyList, it.name);
    r.set(it.level, it.detail);
  }

  el.doneSummary.className = 'verdict ' + (report.pass ? (report.warn ? 'warn' : 'ok') : 'bad');
  el.doneSummary.textContent = report.pass
    ? (report.warn ? `錄好了，長度 ${fmtDur(totalSec)}，有幾項提醒請看下面。` : `錄好了，長度 ${fmtDur(totalSec)}，所有驗證項目都通過。`)
    : `⚠ 驗證發現問題（長度 ${fmtDur(totalSec)}）。檔案仍已保存，請看下面哪一項沒過。`;
  setStatus(report.pass ? '完成' : '完成（有問題）', report.pass ? 'ok' : 'warn');

  /* --- 匯出 --- */
  const logText = buildLogText(totalSec, frames, report);
  const files = [];
  for (const sg of segs) {
    files.push({ writer: sg.writer, target: sg.vTarget });
    if (sg.awriter) files.push({ writer: sg.awriter, target: sg.aTarget });
  }

  if (st.dirHandle) {
    for (const f of files) {
      const row = fileRow(f.target, '存檔中…');
      try {
        const res = await S.exportFileToDir(st.dirHandle, await f.writer.getFile(), f.target);
        row.done(`已存到「${st.dirHandle.name}」 · ${fmtBytes(res.size)}`);
      } catch (e) { row.fail('存檔失敗：' + e.message); }
    }
    try {
      await S.writeTextToDir(st.dirHandle, `會議錄影_${st.session.sid}_健康紀錄.txt`, logText);
      fileRow(`會議錄影_${st.session.sid}_健康紀錄.txt`, '').done('已存檔');
    } catch (e) { log('warn', '健康紀錄存檔失敗：' + e.message); }

    const man = readManifest();
    const entry = man.find((m) => m.sid === st.session.sid);
    if (entry) { entry.exported = true; writeManifest(man); }
  } else {
    for (const f of files) {
      const row = fileRow(f.target, '');
      const b = document.createElement('button');
      b.className = 'btn sm accent'; b.type = 'button'; b.textContent = '下載';
      b.onclick = async () => S.downloadFile(await f.writer.getFile(), f.target);
      row.node.appendChild(b);
      row.done('請按下載');
    }
    const r2 = fileRow(`會議錄影_${st.session.sid}_健康紀錄.txt`, '');
    const b2 = document.createElement('button');
    b2.className = 'btn sm'; b2.type = 'button'; b2.textContent = '下載';
    b2.onclick = () => S.downloadText(`會議錄影_${st.session.sid}_健康紀錄.txt`, logText);
    r2.node.appendChild(b2); r2.done('請按下載');
  }

  await renderRecovery();
}

function fileRow(name, statusText) {
  const d = document.createElement('div');
  d.innerHTML = '<span class="fn"></span><span class="meta"></span>';
  d.querySelector('.fn').textContent = name;
  d.querySelector('.meta').textContent = statusText;
  el.fileList.appendChild(d);
  return {
    node: d,
    done: (t) => { d.querySelector('.meta').textContent = t; },
    fail: (t) => { d.querySelector('.meta').textContent = t; d.style.borderColor = 'var(--fail)'; },
  };
}

function buildLogText(totalSec, frames, report) {
  const s = st.session;
  const L = [];
  L.push('會議錄影 健康紀錄');
  L.push('='.repeat(60));
  L.push('場次編號：' + s.sid);
  L.push('開始時間：' + new Date(s.startedAt).toLocaleString('zh-TW'));
  L.push('總長度：' + fmtDur(totalSec));
  L.push('畫質設定：' + prefs().quality + '（' + M.QUALITY[prefs().quality].label + '）');
  L.push('編碼格式：' + st.videoMime + ' / ' + st.audioMime);
  L.push('分段數：' + s.segments.length);
  L.push('總畫格數：' + (frames == null ? '未知' : frames) + (totalSec > 0 && frames != null ? `（平均 ${(frames / totalSec).toFixed(1)} fps）` : ''));
  const pk = (v) => (v > 1e-5 ? (20 * Math.log10(v)).toFixed(1) + ' dBFS' : '無訊號');
  L.push('系統音峰值：' + pk(st.peaks.sys) + '　麥克風峰值：' + pk(st.peaks.mic));
  L.push('');
  L.push('檔案');
  L.push('-'.repeat(60));
  for (const sg of s.segments) {
    L.push(`  ${sg.vTarget}  ${fmtBytes(sg.writer.bytesOnDisk)}`);
    if (sg.awriter) L.push(`  ${sg.aTarget}  ${fmtBytes(sg.awriter.bytesOnDisk)}`);
  }
  L.push('');
  L.push('錄完驗證');
  L.push('-'.repeat(60));
  for (const it of report.items) L.push(`  [${it.level.toUpperCase()}] ${it.name}：${it.detail}`);
  L.push('');
  L.push('錄製期間深度健檢');
  L.push('-'.repeat(60));
  if (s.deepChecks.length) s.deepChecks.forEach((x) => L.push('  ' + x));
  else L.push('  （未啟用或時間不足 5 分鐘）');
  L.push('');
  L.push('事件紀錄');
  L.push('-'.repeat(60));
  s.log.forEach((x) => L.push('  ' + x));
  return L.join('\r\n');
}

/* ---------------- 螢幕不休眠 ---------------- */
async function acquireWakeLock() {
  if (!prefs().optWakeLock || !navigator.wakeLock) return;
  try {
    st.wakeLock = await navigator.wakeLock.request('screen');
    st.wakeLock.addEventListener('release', () => log('info', '螢幕休眠鎖被釋放'));
    log('ok', '已鎖定螢幕不休眠');
  } catch (e) { log('warn', '無法鎖定螢幕不休眠：' + e.message); }
}
function releaseWakeLock() { if (st.wakeLock) { try { st.wakeLock.release(); } catch (e) {} st.wakeLock = null; } }
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && st.seg && !st.wakeLock) await acquireWakeLock();
});

init();
