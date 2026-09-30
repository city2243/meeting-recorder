/*
 * 會議錄影守門員 —— 後端 API（Cloudflare Worker + D1 + 綠界定期定額）
 *
 * 路由：
 *   POST /api/checkout              建立訂單（回 JSON：授權碼＋要送去綠界的表單）
 *   POST /api/ecpay/return          綠界首筆付款的伺服器通知
 *   POST /api/ecpay/period          綠界第二期起每期扣款的伺服器通知
 *   GET|POST /api/result            付款完成後使用者被導回的頁面
 *   GET  /api/entitlement           前端查授權碼能用什麼
 *   POST /api/account               查訂閱狀態（授權碼＋Email）
 *   POST /api/account/cancel        取消訂閱（呼叫綠界停止後續扣款）
 *   POST /api/account/reset-devices 清空已啟用裝置
 *   GET  /api/health
 *   cron                            定時向綠界主動補查
 *
 * ══ 付款正確性的設計原則（2026-09-30 全面盤點後重寫）══
 *
 * 1. 授權開通「不能只靠綠界打進來的通知」。
 *    實測：Cloudflare 會以 error 1010 擋掉 User-Agent 為 Java/1.8.0 的請求，
 *    而綠界不公開回拋的 UA 與 IP。若綠界的通知被擋，客人扣了款、授權永遠不開。
 *    所以另有三條路：使用者被導回時主動查單、查授權時順手補查、cron 定時補查。
 *    這三條都是我們打出去的請求，不受那個過濾影響。
 * 2. 冪等：到期日由「綠界回報的已成功扣款次數」推算，同一筆通知送幾次結果都一樣。
 * 3. 模擬付款（SimulatePaid=1）在正式環境一律不開通 —— 綠界官方規定。
 * 4. 金額、特店編號都要對得上才開通。
 * 5. 測試環境發出的授權不得在正式環境使用；測試環境期間不對外開放結帳。
 *
 * ⚠ 方案差異是在使用者瀏覽器裡判斷的，懂技術的人改 JavaScript 就能解鎖。
 *   這是使用者知情後的產品決策。後端負責的是「收了錢一定給、沒收錢不給、要退隨時能退」。
 */

const PLANS = {
  pro: { amount: 299, name: '會議錄影守門員 Pro', slots: 4, unattended: true, maxDevices: 3 },
  // 站主自用：不限場數、不限裝置、不會過期。只手動發放，不經過金流。
  owner: { amount: 0, name: '站主授權', slots: 99, unattended: true, maxDevices: 99 },
};
const FREE = { plan: 'free', slots: 1, unattended: false };

const GRACE_MS = 3 * 86400000;          // 扣款延遲時的寬限期（不會逐月累加）
const DEVICE_WINDOW_MS = 30 * 86400000; // 30 天沒出現的裝置不佔名額
const CHECKOUT_LIMIT_PER_HOUR = 10;

/* ═════════════ 綠界檢查碼 ═════════════
 * 規格（官方 guides/13-checkmacvalue.md）：參數依 A→Z 排序 → 前後夾 HashKey／HashIV →
 * urlencode（空白為 +）→ 轉小寫 → 把 %2d %5f %2e %21 %2a %28 %29 換回原字元 → SHA256 → 大寫。
 *
 * Node 的 encodeURIComponent 跟 PHP urlencode 有三個差異，都要補：
 *   空白 %20→+ 、 ' 要編成 %27 、 ~ 要編成 %7E。
 * 原本漏了 ~，官方向量測出來了（見 scratchpad/cmv_test.mjs）。
 */
function ecpayUrlEncode(str) {
  return encodeURIComponent(str)
    .replace(/%20/g, '+')
    .replace(/~/g, '%7E')
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function checkMacValue(params, hashKey, hashIV) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue' && params[k] !== undefined && params[k] !== null)
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);

  let raw = `HashKey=${hashKey}&` + keys.map((k) => `${k}=${params[k]}`).join('&') + `&HashIV=${hashIV}`;

  raw = ecpayUrlEncode(raw)
    .replace(/%2D/gi, '-')
    .replace(/%5F/gi, '_')
    .replace(/%2E/gi, '.')
    .replace(/%21/gi, '!')
    .replace(/%2A/gi, '*')
    .replace(/%28/gi, '(')
    .replace(/%29/gi, ')')
    .toLowerCase();

  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** 官方要求：驗章必須用 timing-safe 比較，不可用 === */
function safeEqual(a, b) {
  a = String(a || '').toUpperCase();
  b = String(b || '').toUpperCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ═════════════ 小工具 ═════════════ */
const now = () => Date.now();
const isProd = (env) => env.ECPAY_ENV === 'production';
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' },
});
const html = (body, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' },
});
const ok = () => new Response('1|OK', { headers: { 'content-type': 'text/plain' } });

function licenseKey() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 I O 0 1
  const pick = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => abc[b % abc.length]).join('');
  return `MR-${pick(4)}-${pick(4)}-${pick(4)}`;
}

function tradeNo() {
  // 綠界限制：英數字、≤20 字元
  const r = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(36).toUpperCase()).join('');
  return ('MR' + Date.now().toString(36).toUpperCase() + r).replace(/[^A-Z0-9]/g, '').slice(0, 20);
}

function twDate(d = new Date()) {
  // 綠界要 yyyy/MM/dd HH:mm:ss，台北時間
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/** 綠界的 yyyy/MM/dd HH:mm:ss（台北時間）→ epoch ms */
function parseTwDate(s) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}

function addMonths(ms, n) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  if (d.getUTCDate() < day) d.setUTCDate(0); // 1/31 + 1 個月 → 2/28，不要跳到 3/3
  return d.getTime();
}

function ecpayBase(env) {
  return isProd(env) ? 'https://payment.ecpay.com.tw' : 'https://payment-stage.ecpay.com.tw';
}

async function formBody(request) {
  const ct = request.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) return (await request.json()) || {};
    if (ct.includes('form')) {
      const fd = await request.formData();
      const o = {};
      for (const [k, v] of fd.entries()) o[k] = typeof v === 'string' ? v : '';
      return o;
    }
  } catch (e) { /* 內容壞掉就當沒有 */ }
  return {};
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d;
}

function normKey(k) { return String(k || '').trim().toUpperCase(); }
function normEmail(e) { return String(e || '').trim().toLowerCase(); }

/* ═════════════ 向綠界主動查詢 ═════════════ */
async function ecpayPost(env, path, params) {
  const body = { MerchantID: env.ECPAY_MERCHANT_ID, TimeStamp: Math.floor(Date.now() / 1000), ...params };
  body.CheckMacValue = await checkMacValue(body, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);
  const r = await fetch(ecpayBase(env) + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return { status: r.status, text: await r.text() };
}

function parseKV(text) {
  const o = {};
  for (const part of String(text || '').split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    o[decodeURIComponent(part.slice(0, i).replace(/\+/g, ' '))] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
  }
  return o;
}

/** 查單筆交易（首筆付款）。回傳已驗章的結果物件，驗章失敗回 null */
async function queryTrade(env, mtn) {
  const { status, text } = await ecpayPost(env, '/Cashier/QueryTradeInfo/V5', { MerchantTradeNo: mtn });
  if (status !== 200) return null;
  const d = parseKV(text);
  if (!d.CheckMacValue) { console.log('queryTrade', mtn, 'no-cmv', text.slice(0, 160)); return null; }
  const mine = await checkMacValue(d, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);
  if (!safeEqual(d.CheckMacValue, mine)) { console.log('queryTrade', mtn, 'cmv-mismatch'); return null; }
  console.log('queryTrade', mtn, 'TradeStatus=' + d.TradeStatus, 'TradeAmt=' + d.TradeAmt);
  return d;
}

/** 查定期定額合約（第二期起的扣款次數、合約狀態）。回傳 JSON 或 null */
async function queryPeriod(env, mtn) {
  const { status, text } = await ecpayPost(env, '/Cashier/QueryCreditCardPeriodInfo', { MerchantTradeNo: mtn });
  if (status !== 200) { console.log('queryPeriod', mtn, 'http', status); return null; }
  try {
    const j = JSON.parse(text);
    console.log('queryPeriod', mtn, 'RtnCode=' + j.RtnCode, 'ExecStatus=' + j.ExecStatus, 'TotalSuccessTimes=' + j.TotalSuccessTimes);
    return j;
  } catch (e) { console.log('queryPeriod', mtn, 'non-json', text.slice(0, 160)); return null; }
}

/* ═════════════ 核心：記一筆付款並更新授權（冪等） ═════════════
 * 所有管道（綠界通知、導回頁、補查、cron）最後都走這裡，規則只有一份。
 */
async function applyPayment(env, lic, p) {
  // p: { ref, amount, rtn, kind, successTimes, paidAt, simulate, merchantId, raw }
  const note = [];
  let accept = p.rtn === 1;

  if (p.merchantId && p.merchantId !== env.ECPAY_MERCHANT_ID) { accept = false; note.push('特店編號不符'); }
  if (accept && Number(p.amount) !== Number(lic.period_amount)) { accept = false; note.push(`金額不符（收到 ${p.amount}，應為 ${lic.period_amount}）`); }
  if (accept && p.simulate && isProd(env)) { accept = false; note.push('模擬付款，不開通'); }

  // 唯一參照：同一筆扣款只記一次。重送的通知在這裡就被擋掉。
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO payments (license_key,merchant_no,trade_no,amount,rtn_code,rtn_msg,kind,raw,created_at,ref)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(lic.key, lic.merchant_no, p.tradeNo || null, Number(p.amount || 0), p.rtn,
    (p.rtnMsg || '') + (note.length ? '｜' + note.join('、') : ''), p.kind,
    JSON.stringify(p.raw || {}), now(), p.ref).run();
  const fresh = ins.meta && ins.meta.changes > 0;

  if (!accept) return { applied: false, fresh, note };

  // 到期日由「已成功扣款次數」推算 —— 通知重送、順序顛倒、多條管道同時到，結果都一樣
  const firstPaidAt = lic.first_paid_at || p.paidAt || now();
  const times = Math.max(Number(lic.success_times || 0), Number(p.successTimes || 1));
  const paidThrough = addMonths(firstPaidAt, times);
  const status = lic.cancelled_at ? 'cancelled' : 'active';

  await env.DB.prepare(
    `UPDATE licenses SET status=?, first_paid_at=?, success_times=?, paid_through=?, expires_at=?, updated_at=? WHERE key=?`
  ).bind(status, firstPaidAt, times, paidThrough, paidThrough + GRACE_MS, now(), lic.key).run();

  return { applied: true, fresh, times, paidThrough };
}

/** 主動向綠界補查一張授權的最新狀態 */
async function syncLicense(env, lic) {
  if (!lic || lic.plan === 'owner' || !lic.merchant_no) return lic;
  if (lic.env !== env.ECPAY_ENV) return lic;

  await env.DB.prepare('UPDATE licenses SET last_sync_at=? WHERE key=?').bind(now(), lic.key).run();

  // 首筆還沒確認 → 查單
  if (!lic.first_paid_at) {
    const t = await queryTrade(env, lic.merchant_no);
    if (t && String(t.TradeStatus) === '1') {
      await applyPayment(env, lic, {
        ref: 'T:' + t.TradeNo, tradeNo: t.TradeNo, amount: t.TradeAmt, rtn: 1, rtnMsg: '補查：已付款',
        kind: 'first-sync', successTimes: 1, paidAt: parseTwDate(t.PaymentDate),
        simulate: false, merchantId: t.MerchantID, raw: t,
      });
    }
  }

  // 已經付過首筆 → 查合約：扣了幾期、有沒有被取消（例如連續扣款失敗 6 次綠界會自動終止）
  const cur = await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(lic.key).first();
  if (cur && cur.first_paid_at) {
    const q = await queryPeriod(env, cur.merchant_no);
    if (q && Number(q.TotalSuccessTimes) > Number(cur.success_times || 0)) {
      await applyPayment(env, cur, {
        ref: `P:${cur.merchant_no}:n${q.TotalSuccessTimes}`, amount: q.PeriodAmount, rtn: 1,
        rtnMsg: '補查：定期扣款', kind: 'period-sync', successTimes: Number(q.TotalSuccessTimes),
        paidAt: cur.first_paid_at, simulate: false, merchantId: q.MerchantID || env.ECPAY_MERCHANT_ID, raw: q,
      });
    }
    if (q && String(q.ExecStatus) === '0' && !cur.cancelled_at) {
      // 合約在綠界那邊已停止（使用者取消或連續扣款失敗）。已付的期間照樣可以用到結束。
      await env.DB.prepare('UPDATE licenses SET status=?, cancelled_at=?, updated_at=? WHERE key=?')
        .bind('cancelled', now(), now(), cur.key).run();
    }
  }
  return await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(lic.key).first();
}

/* ═════════════ 建立訂單 ═════════════ */
async function handleCheckout(request, env, url) {
  // 測試環境期間不對外開放結帳：綠界測試卡號是公開的，開放的話任何人都能免費拿到 Pro
  if (!isProd(env)) {
    const t = request.headers.get('x-test-token') || '';
    if (!env.TEST_TOKEN || !safeEqual(t, env.TEST_TOKEN)) {
      return json({ error: '付費方案尚未開放，敬請期待。', closed: true }, 503);
    }
  }

  const body = await formBody(request);
  const email = normEmail(body.email);
  const planId = String(body.plan || 'pro');
  const plan = PLANS[planId];

  if (!plan || planId === 'owner') return json({ error: '沒有這個方案' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 120) {
    return json({ error: '請填一個有效的 Email（取消訂閱和查詢時要用）' }, 400);
  }
  if (body.consent !== true) {
    return json({ error: '請先勾選同意服務條款與「數位服務一經提供即不適用七日解除權」' }, 400);
  }

  // 頻率限制：同一個 IP 一小時最多建 10 張單
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const since = now() - 3600000;
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM throttle WHERE ip=? AND ts>?').bind(ip, since).first();
  if (c && c.n >= CHECKOUT_LIMIT_PER_HOUR) return json({ error: '操作太頻繁，請一小時後再試。' }, 429);
  await env.DB.prepare('INSERT INTO throttle (ip, ts) VALUES (?, ?)').bind(ip, now()).run();

  const key = licenseKey();
  const mtn = tradeNo();
  const base = `${url.protocol}//${url.host}`;

  await env.DB.prepare(
    `INSERT INTO licenses (key,email,plan,status,merchant_no,period_amount,expires_at,created_at,updated_at,env,client_ip)
     VALUES (?,?,?,'pending',?,?,NULL,?,?,?,?)`
  ).bind(key, email, planId, mtn, plan.amount, now(), now(), env.ECPAY_ENV, ip).run();

  const params = {
    MerchantID: env.ECPAY_MERCHANT_ID,
    MerchantTradeNo: mtn,
    MerchantTradeDate: twDate(),
    PaymentType: 'aio',
    TotalAmount: plan.amount,
    TradeDesc: 'Meeting Recorder Pro subscription',
    ItemName: plan.name,
    ReturnURL: `${base}/api/ecpay/return`,
    ChoosePayment: 'Credit',
    EncryptType: 1,
    // 官方規定三個網址不可共用：OrderResultURL 帶付款結果回來；ClientBackURL 是使用者在綠界按「返回」
    OrderResultURL: `${base}/api/result?k=${key}`,
    ClientBackURL: `${base}/pricing.html?back=1`,
    CustomField1: key,
    PeriodAmount: plan.amount,
    PeriodType: 'M',
    Frequency: 1,
    ExecTimes: 99,
    PeriodReturnURL: `${base}/api/ecpay/period`,
  };
  params.CheckMacValue = await checkMacValue(params, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);

  // 回 JSON：前端先把授權碼存進瀏覽器、顯示給使用者，再送出表單。
  // 這樣就算付完款直接關掉分頁，下次打開工具授權照樣會自動生效。
  return json({ key, action: ecpayBase(env) + '/Cashier/AioCheckOut/V5', params });
}

/* ═════════════ 綠界伺服器通知 ═════════════ */
async function handleEcpayCallback(request, env, kind) {
  const data = await formBody(request);
  const mine = await checkMacValue(data, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);

  if (!safeEqual(data.CheckMacValue, mine)) {
    await env.DB.prepare(
      `INSERT INTO payments (license_key,merchant_no,trade_no,amount,rtn_code,rtn_msg,kind,raw,created_at,ref)
       VALUES (NULL,?,?,?,?,?,?,?,?,NULL)`
    ).bind(data.MerchantTradeNo || null, data.TradeNo || null, Number(data.TradeAmt || data.Amount || 0),
      -1, 'CheckMacValue 驗證失敗', kind, JSON.stringify(data), now()).run();
    return new Response('0|CheckMacValue error', { status: 400 });
  }

  const mtn = data.MerchantTradeNo || '';
  const key = normKey(data.CustomField1);
  let lic = key ? await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key).first() : null;
  if (!lic && mtn) lic = await env.DB.prepare('SELECT * FROM licenses WHERE merchant_no=?').bind(mtn).first();

  if (!lic) {
    // 驗章通過卻找不到授權：記下來給人工對帳，照樣回 1|OK 免得綠界一直重送
    await env.DB.prepare(
      `INSERT OR IGNORE INTO payments (license_key,merchant_no,trade_no,amount,rtn_code,rtn_msg,kind,raw,created_at,ref)
       VALUES (NULL,?,?,?,?,?,?,?,?,?)`
    ).bind(mtn, data.TradeNo || null, Number(data.TradeAmt || data.Amount || 0), Number(data.RtnCode || 0),
      '找不到對應授權，需人工對帳', kind, JSON.stringify(data), now(),
      'ORPHAN:' + (data.TradeNo || data.gwsr || mtn)).run();
    return ok();
  }

  if (kind === 'first') {
    await applyPayment(env, lic, {
      ref: 'T:' + (data.TradeNo || mtn), tradeNo: data.TradeNo, amount: data.TradeAmt, rtn: Number(data.RtnCode || 0),
      rtnMsg: data.RtnMsg, kind: 'first', successTimes: 1, paidAt: parseTwDate(data.PaymentDate),
      simulate: String(data.SimulatePaid) === '1', merchantId: data.MerchantID, raw: data,
    });
  } else {
    // 第二期起：欄位名稱跟首筆不同（Amount 不是 TradeAmt；gwsr 是每次授權的唯一編號）
    await applyPayment(env, lic, {
      ref: `P:${mtn}:n${data.TotalSuccessTimes || ('g' + data.gwsr)}`, tradeNo: String(data.gwsr || ''),
      amount: data.Amount, rtn: Number(data.RtnCode || 0), rtnMsg: data.RtnMsg, kind: 'period',
      successTimes: Number(data.TotalSuccessTimes || 0), paidAt: lic.first_paid_at,
      simulate: String(data.SimulatePaid) === '1', merchantId: data.MerchantID, raw: data,
    });
  }
  return ok();
}

/* ═════════════ 付款完成導回頁 ═════════════ */
async function handleResult(request, env, url) {
  const key = normKey(url.searchParams.get('k'));
  let lic = key ? await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key).first() : null;

  if (!lic) return html(page('找不到這筆訂單', `<p>請確認連結是否完整。</p>${supportLine(env)}`));

  // 使用者被導回來的這一刻，主動去綠界查一次 —— 不賭綠界的伺服器通知有沒有進得來
  if (lic.status === 'pending') {
    try { lic = await syncLicense(env, lic); } catch (e) { console.error('sync on result', e); }
  }

  const saveKey = `<script>try{localStorage.setItem('meetingRecorder.licenseKey',${JSON.stringify(lic.key)});localStorage.removeItem('meetingRecorder.entitlement')}catch(e){}</script>`;

  if (lic.status === 'pending') {
    return html(page('付款確認中', `
      <p>綠界還在回報結果，通常一兩分鐘內完成。</p>
      <p class="k">${escapeHtml(lic.key)}</p>
      <p class="note">這是你的授權碼，<b>已自動存進這個瀏覽器</b>，請也另外抄下來。
        就算現在關掉這一頁，付款確認後打開工具就會自動生效。</p>
      <p><a class="btn" href="/api/result?k=${encodeURIComponent(lic.key)}">重新確認</a>
         <a class="btn ghost" href="/">回到工具</a></p>
      ${supportLine(env)}${saveKey}`));
  }

  return html(page('付款完成', `
    <p>這是你的授權碼：</p>
    <p class="k">${escapeHtml(lic.key)}</p>
    <p class="note">已自動存進這個瀏覽器，回到工具就已經解鎖。請另外抄下來，換電腦時要用。</p>
    <p class="note">目前付費期間至 ${new Date(lic.paid_through || lic.expires_at).toLocaleDateString('zh-TW')}，
      每月自動續扣後會延長。要取消隨時到「<a href="/account.html">我的訂閱</a>」自己按，不用寫信。</p>
    <p><a class="btn" href="/">回到工具</a></p>
    ${saveKey}`));
}

function supportLine(env) {
  return env.SUPPORT_EMAIL
    ? `<p class="note">有任何問題請寫信到 <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a>，並附上授權碼。</p>`
    : '';
}

function page(title, body) {
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="margin:0;background:#0E1117;color:#E7ECF3;font-family:'Microsoft JhengHei UI',system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<main style="max-width:540px;padding:32px 20px;line-height:1.75">
  <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
  ${body}
</main>
<style>
 .k{font-family:Consolas,monospace;font-size:22px;letter-spacing:2px;background:#1F2733;border:1px solid #2B3543;border-radius:8px;padding:14px;text-align:center;user-select:all}
 .note{font-size:13px;color:#8895A8}
 .btn{display:inline-block;background:#5AC8D8;color:#06222A;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:8px;margin-right:8px}
 .btn.ghost{background:transparent;color:#AFBACA;border:1px solid #2B3543}
 a{color:#5AC8D8}
</style></html>`;
}

/* ═════════════ 授權查詢 ═════════════ */
function entitled(env, lic) {
  if (!lic) return '查無這組授權碼';
  if (lic.env !== 'any' && lic.env !== env.ECPAY_ENV) return '這組授權碼來自測試環境，無法在正式環境使用';
  if (lic.status === 'pending') return '付款尚未確認，通常一兩分鐘內完成';
  if (lic.status !== 'active' && lic.status !== 'cancelled') return '這組授權碼無法使用';
  if (!lic.expires_at || lic.expires_at < now()) return lic.status === 'cancelled' ? '訂閱已取消，付費期間已結束' : '這組授權碼已過期';
  return null;
}

async function handleEntitlement(env, url) {
  const key = normKey(url.searchParams.get('key'));
  const device = String(url.searchParams.get('device') || '').slice(0, 64);
  if (!key) return json({ ...FREE, reason: '沒有授權碼' });

  let lic = await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key).first();

  // 還沒確認付款、或快到期，而且超過 2 分鐘沒補查 → 順手向綠界補查一次
  const stale = !lic || !lic.last_sync_at || now() - lic.last_sync_at > 120000;
  const needs = lic && (lic.status === 'pending' || (lic.expires_at && lic.expires_at - now() < 5 * 86400000));
  if (lic && needs && stale && lic.plan !== 'owner') {
    try { lic = await syncLicense(env, lic); } catch (e) { console.error('sync on entitlement', e); }
  }

  const why = entitled(env, lic);
  if (why) return json({ ...FREE, reason: why });

  const plan = PLANS[lic.plan] || PLANS.pro;

  if (device) {
    const seen = await env.DB.prepare('SELECT 1 AS x FROM activations WHERE license_key=? AND device_id=?')
      .bind(key, device).first();
    if (seen) {
      await env.DB.prepare('UPDATE activations SET last_seen=? WHERE license_key=? AND device_id=?')
        .bind(now(), key, device).run();
    } else {
      // 先數再寫（被擋的裝置不佔名額）；只算最近 30 天出現過的裝置，清過瀏覽器的舊裝置會自動讓位
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM activations WHERE license_key=? AND last_seen>?')
        .bind(key, now() - DEVICE_WINDOW_MS).first();
      if (c && c.n >= plan.maxDevices) {
        return json({
          ...FREE,
          reason: `這組授權碼最近 30 天已在 ${c.n} 台裝置使用，達到 ${plan.maxDevices} 台上限。` +
            '可到「我的訂閱」頁面自己清空裝置後重新啟用。',
        });
      }
      await env.DB.prepare(
        `INSERT INTO activations (license_key,device_id,first_seen,last_seen) VALUES (?,?,?,?)
         ON CONFLICT(license_key,device_id) DO UPDATE SET last_seen=excluded.last_seen`
      ).bind(key, device, now(), now()).run();
    }
  }

  return json({
    plan: lic.plan,
    slots: plan.slots,
    unattended: plan.unattended,
    expiresAt: lic.expires_at,
    cancelled: lic.status === 'cancelled',
  });
}

/* ═════════════ 我的訂閱：查詢／取消／清裝置 ═════════════
 * 需要「授權碼＋付款時填的 Email」兩樣都對。
 */
async function loadOwned(env, body) {
  const key = normKey(body.key);
  const email = normEmail(body.email);
  if (!key || !email) return { err: json({ error: '請輸入授權碼和付款時填的 Email' }, 400) };
  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key).first();
  if (!lic || !safeEqual(lic.email, email)) return { err: json({ error: '授權碼或 Email 不正確' }, 404) };
  return { lic };
}

async function handleAccount(request, env) {
  const { lic: l0, err } = await loadOwned(env, await formBody(request));
  if (err) return err;
  let lic = l0;
  try { lic = await syncLicense(env, lic); } catch (e) { console.error('sync on account', e); }

  const pays = await env.DB.prepare(
    `SELECT created_at, amount, rtn_code, kind FROM payments WHERE license_key=? AND rtn_code<>-1 ORDER BY created_at DESC LIMIT 24`
  ).bind(lic.key).all();
  const devs = await env.DB.prepare(
    `SELECT device_id, first_seen, last_seen FROM activations WHERE license_key=? ORDER BY last_seen DESC`
  ).bind(lic.key).all();

  const plan = PLANS[lic.plan] || PLANS.pro;
  const nextCharge = lic.status === 'active' && lic.paid_through ? lic.paid_through : null;

  return json({
    key: lic.key,
    email: maskEmail(lic.email),
    plan: lic.plan,
    planName: plan.name,
    amount: lic.period_amount,
    status: lic.status,
    usable: !entitled(env, lic),
    reason: entitled(env, lic),
    paidThrough: lic.paid_through,
    expiresAt: lic.expires_at,
    nextCharge,
    cancelledAt: lic.cancelled_at,
    successTimes: lic.success_times,
    payments: (pays.results || []).map((p) => ({ at: p.created_at, amount: p.amount, ok: p.rtn_code === 1, kind: p.kind })),
    devices: (devs.results || []).map((d) => ({
      id: d.device_id.slice(0, 6) + '…', lastSeen: d.last_seen,
      counted: d.last_seen > now() - DEVICE_WINDOW_MS,
    })),
    maxDevices: plan.maxDevices,
  });
}

async function handleCancel(request, env) {
  const { lic, err } = await loadOwned(env, await formBody(request));
  if (err) return err;
  if (lic.plan === 'owner') return json({ error: '站主授權不需要取消' }, 400);
  if (lic.cancelled_at) {
    return json({ ok: true, already: true, usableUntil: lic.expires_at });
  }
  if (!lic.first_paid_at) {
    // 還沒付過錢的單：本地作廢即可，綠界那邊沒有合約
    await env.DB.prepare('UPDATE licenses SET status=?, cancelled_at=?, updated_at=? WHERE key=?')
      .bind('cancelled', now(), now(), lic.key).run();
    return json({ ok: true, usableUntil: null });
  }

  // 先問綠界合約現況：若已經停止（上次取消其實成功、只是我們這邊沒記到），直接標記即可
  const pre = await queryPeriod(env, lic.merchant_no);
  if (pre && String(pre.ExecStatus) === '0') {
    await env.DB.prepare('UPDATE licenses SET status=?, cancelled_at=?, updated_at=? WHERE key=?')
      .bind('cancelled', now(), now(), lic.key).run();
    return json({ ok: true, usableUntil: lic.expires_at });
  }

  // 呼叫綠界停止後續扣款。這一步沒成功就不能說「已取消」—— 不然客人以為取消了、下個月還是被扣。
  const { status, text } = await ecpayPost(env, '/Cashier/CreditCardPeriodAction', {
    MerchantTradeNo: lic.merchant_no, Action: 'Cancel',
  });
  const r = parseKV(text);
  const success = status === 200 && String(r.RtnCode) === '1';
  console.log('periodCancel', lic.merchant_no, 'http=' + status, 'RtnCode=' + r.RtnCode, 'RtnMsg=' + (r.RtnMsg || text.slice(0, 120)));

  await env.DB.prepare(
    `INSERT INTO payments (license_key,merchant_no,trade_no,amount,rtn_code,rtn_msg,kind,raw,created_at,ref)
     VALUES (?,?,NULL,0,?,?,'cancel',?,?,NULL)`
  ).bind(lic.key, lic.merchant_no, success ? 1 : Number(r.RtnCode || 0),
    success ? '已向綠界取消定期定額' : ('取消失敗：' + (r.RtnMsg || text).slice(0, 180)),
    JSON.stringify({ status, r }), now()).run();

  if (!success) {
    return json({
      error: '綠界沒有確認取消，後續扣款可能還會發生。請稍後再試一次；若持續失敗請來信，我們會人工處理並退還取消後被扣的款項。',
      detail: r.RtnMsg || null,
    }, 502);
  }

  await env.DB.prepare('UPDATE licenses SET status=?, cancelled_at=?, updated_at=? WHERE key=?')
    .bind('cancelled', now(), now(), lic.key).run();
  return json({ ok: true, usableUntil: lic.expires_at });
}

async function handleResetDevices(request, env) {
  const { lic, err } = await loadOwned(env, await formBody(request));
  if (err) return err;
  const r = await env.DB.prepare('DELETE FROM activations WHERE license_key=?').bind(lic.key).run();
  return json({ ok: true, removed: (r.meta && r.meta.changes) || 0 });
}

/* ═════════════ 定時補查 ═════════════ */
async function sweep(env) {
  // 1) 還沒確認付款、3 天內建立的單 → 查單（綠界的首筆通知可能被擋或沒送到）
  const pend = await env.DB.prepare(
    `SELECT * FROM licenses WHERE status='pending' AND env=? AND created_at>? LIMIT 50`
  ).bind(env.ECPAY_ENV, now() - 3 * 86400000).all();
  // 2) 付費中、7 天內到期，或已過期 35 天內 → 查合約
  //    第二期起的通知「每期只送一次」，漏了要靠這裡補；
  //    扣款失敗時綠界每 3-5 天重試、最多 6 次，重試成功可能在到期好幾週後才發生。
  const due = await env.DB.prepare(
    `SELECT * FROM licenses WHERE status IN ('active','cancelled') AND plan<>'owner' AND env=?
       AND expires_at BETWEEN ? AND ? AND (last_sync_at IS NULL OR last_sync_at<?) LIMIT 50`
  ).bind(env.ECPAY_ENV, now() - 35 * 86400000, now() + 7 * 86400000, now() - 6 * 3600000).all();

  let n = 0;
  for (const lic of [...(pend.results || []), ...(due.results || [])]) {
    try { await syncLicense(env, lic); n++; } catch (e) { console.error('sweep', lic.key, e); }
  }
  // 3) 放棄的單（建了 3 天都沒付）標記起來；頻率限制表清掉一天前的
  await env.DB.prepare(`UPDATE licenses SET status='abandoned', updated_at=? WHERE status='pending' AND created_at<?`)
    .bind(now(), now() - 3 * 86400000).run();
  await env.DB.prepare('DELETE FROM throttle WHERE ts<?').bind(now() - 86400000).run();
  return n;
}

/* ═════════════ 入口 ═════════════ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    try {
      if (p === '/api/health') {
        return json({ ok: true, env: env.ECPAY_ENV, checkoutOpen: isProd(env), supportEmail: !!env.SUPPORT_EMAIL });
      }
      if (p === '/api/checkout' && m === 'POST') return await handleCheckout(request, env, url);
      if (p === '/api/ecpay/return' && m === 'POST') return await handleEcpayCallback(request, env, 'first');
      if (p === '/api/ecpay/period' && m === 'POST') return await handleEcpayCallback(request, env, 'period');
      if (p === '/api/result') return await handleResult(request, env, url);
      if (p === '/api/entitlement') return await handleEntitlement(env, url);
      if (p === '/api/account' && m === 'POST') return await handleAccount(request, env);
      if (p === '/api/account/cancel' && m === 'POST') return await handleCancel(request, env);
      if (p === '/api/account/reset-devices' && m === 'POST') return await handleResetDevices(request, env);
      if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
    } catch (e) {
      // 不把內部錯誤細節吐給外部（官方上線檢查表要求）
      console.error('unhandled', p, e && e.stack || e);
      if (p === '/api/ecpay/return' || p === '/api/ecpay/period') {
        return new Response('0|server error', { status: 500 }); // 讓綠界重送
      }
      return json({ error: '伺服器發生錯誤，請稍後再試。' }, 500);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env).then((n) => console.log('sweep synced', n)));
  },
};
