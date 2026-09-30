/*
 * license.js —— 授權碼與方案判定（前端側）
 *
 * ⚠ 老實話：這一層擋不住懂技術的人。錄影完全發生在使用者的瀏覽器裡，
 *   沒有任何東西可以扣在伺服器上。改一行 JavaScript 就能解鎖。
 *   這是產品決策（付費綁在同時場數與無人看管），不是安全機制。
 *   後端做的是發碼、記帳、到期停止發放；不是不可破解的保護。
 */

const API = '/api/entitlement';
const CACHE_KEY = 'meetingRecorder.entitlement';
const KEY_KEY = 'meetingRecorder.licenseKey';
const DEVICE_KEY = 'meetingRecorder.deviceId';
const TTL = 12 * 3600 * 1000;   // 12 小時內不重打 API，離線也還能用

export const FREE = { plan: 'free', slots: 1, unattended: false };

function deviceId() {
  let d = null;
  try { d = localStorage.getItem(DEVICE_KEY); } catch (e) {}
  if (!d) {
    d = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { localStorage.setItem(DEVICE_KEY, d); } catch (e) {}
  }
  return d;
}

export function savedKey() {
  try { return localStorage.getItem(KEY_KEY) || ''; } catch (e) { return ''; }
}

export function forgetKey() {
  try { localStorage.removeItem(KEY_KEY); localStorage.removeItem(CACHE_KEY); } catch (e) {}
}

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && c.at && Date.now() - c.at < TTL) return c.ent;
  } catch (e) {}
  return null;
}

function writeCache(ent) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), ent })); } catch (e) {}
}

/**
 * 查這台裝置目前能用什麼。
 * @param force 略過快取，直接問伺服器（使用者剛貼上授權碼時用）
 */
export async function getPlan(force) {
  const key = savedKey();
  if (!key) return { ...FREE };
  if (!force) {
    const c = readCache();
    if (c) return c;
  }
  try {
    const r = await fetch(`${API}?key=${encodeURIComponent(key)}&device=${encodeURIComponent(deviceId())}`, { cache: 'no-store' });
    const ent = await r.json();
    writeCache(ent);
    return ent;
  } catch (e) {
    // 連不上就沿用上次的結果，不要因為網路斷掉把付費使用者降級
    const c = readCache();
    return c || { ...FREE, reason: '連不上授權伺服器' };
  }
}

export async function applyKey(raw) {
  const key = String(raw || '').trim().toUpperCase();
  if (!/^MR-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) {
    return { ok: false, message: '授權碼格式不對，應該像 MR-XXXX-XXXX-XXXX' };
  }
  try { localStorage.setItem(KEY_KEY, key); } catch (e) {}
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
  const ent = await getPlan(true);
  if (ent.plan === 'free') {
    forgetKey();
    return { ok: false, message: ent.reason || '這組授權碼無法使用' };
  }
  return { ok: true, ent };
}

/** 在頁面底部掛一塊「方案 / 我有授權碼」的區塊，兩個頁面共用 */
export function mountLicenseBox(container, onChange) {
  const box = document.createElement('section');
  box.className = 'panel license-box';
  box.innerHTML = `
    <div class="panel-head">
      <span class="eyebrow">方案</span>
      <h2 id="licPlanTitle">目前：免費版</h2>
    </div>
    <p class="note" id="licDesc"></p>
    <div class="row">
      <input type="text" id="licInput" placeholder="MR-XXXX-XXXX-XXXX" maxlength="17" spellcheck="false">
      <button type="button" class="btn accent" id="licApply">啟用</button>
      <button type="button" class="btn ghost sm" id="licForget" hidden>移除授權碼</button>
      <a class="btn" href="./pricing.html">看方案與升級</a>
    </div>
    <p class="note" id="licMsg"></p>`;
  container.appendChild(box);

  const $ = (id) => box.querySelector('#' + id);
  const title = $('licPlanTitle'), desc = $('licDesc'), msg = $('licMsg');
  const input = $('licInput'), apply = $('licApply'), forget = $('licForget');

  function paint(ent) {
    const pro = ent.plan !== 'free';
    title.textContent = pro ? '目前：Pro' : '目前：免費版';
    desc.textContent = pro
      ? `同時最多 ${ent.slots} 場、可用無人看管保護` +
        (ent.expiresAt ? `。有效至 ${new Date(ent.expiresAt).toLocaleDateString('zh-TW')}` : '')
      : '同時 1 場、無人看管保護未開放。升級後可同時錄 4 場。';
    input.value = pro ? savedKey() : '';
    input.hidden = pro;
    apply.hidden = pro;
    forget.hidden = !pro;
    if (!pro && ent.reason && savedKey()) msg.textContent = ent.reason;
  }

  apply.onclick = async () => {
    apply.disabled = true; msg.textContent = '查詢中…';
    const r = await applyKey(input.value);
    apply.disabled = false;
    msg.textContent = r.ok ? '已啟用' : r.message;
    const ent = r.ok ? r.ent : { ...FREE };
    paint(ent);
    if (onChange) onChange(ent);
  };
  forget.onclick = async () => {
    forgetKey();
    msg.textContent = '已移除，回到免費版。';
    paint({ ...FREE });
    if (onChange) onChange({ ...FREE });
  };

  return { paint };
}
