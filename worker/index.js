/*
 * 會議錄影守門員 —— 後端 API（Cloudflare Worker + D1 + 綠界定期定額）
 *
 * 路由：
 *   POST /api/checkout        建立訂單，回傳自動送出的綠界表單
 *   POST /api/ecpay/return    綠界首筆授權的伺服器回拋
 *   POST /api/ecpay/period    綠界每期授權的伺服器回拋
 *   GET  /api/result          付款完成後使用者被導回來的頁面（顯示授權碼）
 *   GET  /api/entitlement     前端查授權碼能用什麼
 *   GET  /api/health
 *
 * 其餘路徑交給靜態檔（ASSETS binding）。
 *
 * ⚠ 誠實聲明：方案差異（同時場數、無人看管）是在使用者的瀏覽器裡判斷的，
 *   懂技術的人改 JavaScript 就能解鎖。這是使用者知情後的決定。
 *   後端做的是「發碼、記帳、到期就停止發放授權」，不是不可破解的保護。
 */

const PLANS = {
  pro: { amount: 299, name: '會議錄影守門員 Pro', slots: 4, unattended: true, maxDevices: 3 },
};
const FREE = { plan: 'free', slots: 1, unattended: false };

/* ───────────── 綠界檢查碼 ─────────────
 * 規格：參數依 A→Z 排序 → 前後夾 HashKey / HashIV → URL encode →
 * 把 %2d %5f %2e %21 %2a %28 %29 換回原字元 → 全轉小寫 → SHA256 → 轉大寫。
 * 這串規則錯一個字就整筆被退，所以照官方文件逐條實作，不憑記憶。
 */
function ecpayUrlEncode(str) {
  // .NET HttpUtility.UrlEncode 的行為：空白變 +，其餘 percent-encoding
  return encodeURIComponent(str)
    .replace(/%20/g, '+')
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

/* ───────────── 小工具 ───────────── */
const now = () => Date.now();
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' },
});
const html = (body, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' },
});

function licenseKey() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 I O 0 1
  const pick = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => abc[b % abc.length]).join('');
  return `MR-${pick(4)}-${pick(4)}-${pick(4)}`;
}

function tradeNo() {
  return 'MR' + Date.now().toString(36).toUpperCase() + [...crypto.getRandomValues(new Uint8Array(3))]
    .map((b) => b.toString(36).toUpperCase().padStart(2, '0')).join('').slice(0, 5);
}

function twDate(d = new Date()) {
  // 綠界要 yyyy/MM/dd HH:mm:ss，且以台北時間為準
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

function endpoint(env) {
  return env.ECPAY_ENV === 'production'
    ? 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'
    : 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5';
}

async function formBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await request.json();
  const fd = await request.formData();
  const o = {};
  for (const [k, v] of fd.entries()) o[k] = typeof v === 'string' ? v : '';
  return o;
}

/* ───────────── 建立訂單 ───────────── */
async function handleCheckout(request, env, url) {
  const body = await formBody(request);
  const email = String(body.email || '').trim().toLowerCase();
  const planId = String(body.plan || 'pro');
  const plan = PLANS[planId];

  if (!plan) return json({ error: '沒有這個方案' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: '請填一個有效的 Email，授權碼會寄到這裡' }, 400);

  const key = licenseKey();
  const mtn = tradeNo();
  const base = `${url.protocol}//${url.host}`;

  await env.DB.prepare(
    `INSERT INTO licenses (key,email,plan,status,merchant_no,period_amount,expires_at,created_at,updated_at)
     VALUES (?,?,?,'pending',?,?,NULL,?,?)`
  ).bind(key, email, planId, mtn, plan.amount, now(), now()).run();

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
    ClientBackURL: `${base}/api/result?k=${key}`,
    OrderResultURL: `${base}/api/result?k=${key}`,
    CustomField1: key,
    // 定期定額
    PeriodAmount: plan.amount,
    PeriodType: 'M',
    Frequency: 1,
    ExecTimes: 99,
    PeriodReturnURL: `${base}/api/ecpay/period`,
  };
  params.CheckMacValue = await checkMacValue(params, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);

  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`)
    .join('\n');

  return html(`<!doctype html><meta charset="utf-8"><title>前往付款…</title>
<body style="font-family:system-ui;background:#0E1117;color:#E7ECF3;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
  <p>正在前往綠界付款頁…</p>
  <p style="font-size:12px;color:#8895A8">如果沒有自動跳轉，請按下面的按鈕</p>
  <form id="f" method="post" action="${endpoint(env)}">
    ${inputs}
    <button type="submit" style="padding:10px 20px;border-radius:8px;border:0;background:#5AC8D8;color:#06222A;font-weight:600;cursor:pointer">前往付款</button>
  </form>
</div>
<script>document.getElementById('f').submit();</script>`);
}

/* ───────────── 綠界回拋 ───────────── */
async function handleEcpayCallback(request, env, kind) {
  const data = await formBody(request);
  const mac = data.CheckMacValue;
  const mine = await checkMacValue(data, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);

  // 驗章不過就不動資料庫。這是唯一能確認「真的是綠界打來的」的方法。
  if (!mac || mac.toUpperCase() !== mine) {
    await env.DB.prepare(
      `INSERT INTO payments (license_key,merchant_no,trade_no,amount,rtn_code,rtn_msg,kind,raw,created_at)
       VALUES (NULL,?,?,?,?,?,?,?,?)`
    ).bind(data.MerchantTradeNo || null, data.TradeNo || null, Number(data.TradeAmt || 0),
      -1, 'CheckMacValue 驗證失敗', kind, JSON.stringify(data), now()).run();
    return new Response('0|CheckMacValue error', { status: 400 });
  }

  const rtn = Number(data.RtnCode || 0);
  const mtn = data.MerchantTradeNo || '';
  const key = data.CustomField1 || null;

  const lic = key
    ? await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key).first()
    : await env.DB.prepare('SELECT * FROM licenses WHERE merchant_no=?').bind(mtn).first();

  await env.DB.prepare(
    `INSERT INTO payments (license_key,merchant_no,trade_no,amount,rtn_code,rtn_msg,kind,raw,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(lic ? lic.key : null, mtn, data.TradeNo || null, Number(data.TradeAmt || 0),
    rtn, data.RtnMsg || '', kind, JSON.stringify(data), now()).run();

  // 綠界成功碼：首筆 1，定期定額每期也是 1
  if (lic && rtn === 1) {
    // 從現有到期日往後推一個月；已過期或首筆就從現在算
    const from = lic.expires_at && lic.expires_at > now() ? lic.expires_at : now();
    const next = new Date(from);
    next.setUTCMonth(next.getUTCMonth() + 1);
    // 多給 3 天緩衝，避免扣款延遲讓人在正在錄的時候被降級
    const expires = next.getTime() + 3 * 86400000;
    await env.DB.prepare('UPDATE licenses SET status=?, expires_at=?, updated_at=? WHERE key=?')
      .bind('active', expires, now(), lic.key).run();
  }

  return new Response('1|OK', { headers: { 'content-type': 'text/plain' } });
}

/* ───────────── 付款完成頁 ───────────── */
async function handleResult(request, env, url) {
  const key = url.searchParams.get('k') || '';
  const lic = key ? await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key).first() : null;

  if (!lic) {
    return html(page('找不到這筆訂單', '<p>請確認連結是否完整，或直接聯絡我們。</p>'));
  }

  if (lic.status !== 'active') {
    return html(page('付款處理中', `
      <p>綠界還在回報結果，通常幾秒鐘就好。</p>
      <p class="k">${escapeHtml(lic.key)}</p>
      <p class="note">這是你的授權碼，請先複製起來。重新整理這一頁可以看最新狀態。</p>
      <p><a class="btn" href="/api/result?k=${encodeURIComponent(lic.key)}">重新整理</a></p>`));
  }

  return html(page('付款完成', `
    <p>這是你的授權碼，<b>請複製起來</b>：</p>
    <p class="k">${escapeHtml(lic.key)}</p>
    <p class="note">有效期限至 ${new Date(lic.expires_at).toLocaleDateString('zh-TW')}（每月自動續扣後會延長）。</p>
    <p>回到工具頁，在最下面「我有授權碼」貼上它就會解鎖。</p>
    <p><a class="btn" href="/">回到工具</a></p>`));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;background:#0E1117;color:#E7ECF3;font-family:'Microsoft JhengHei UI',system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<main style="max-width:520px;padding:32px;line-height:1.75">
  <h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
  ${body}
</main>
<style>
 .k{font-family:Consolas,monospace;font-size:22px;letter-spacing:2px;background:#1F2733;border:1px solid #2B3543;border-radius:8px;padding:14px;text-align:center;user-select:all}
 .note{font-size:13px;color:#8895A8}
 .btn{display:inline-block;background:#5AC8D8;color:#06222A;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:8px}
 a{color:#5AC8D8}
</style>`;
}

/* ───────────── 授權查詢 ───────────── */
async function handleEntitlement(env, url) {
  const key = (url.searchParams.get('key') || '').trim().toUpperCase();
  const device = (url.searchParams.get('device') || '').slice(0, 64);
  if (!key) return json({ ...FREE, reason: '沒有授權碼' });

  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key).first();
  if (!lic) return json({ ...FREE, reason: '查無這組授權碼' });
  if (lic.status !== 'active') return json({ ...FREE, reason: '這組授權碼尚未啟用' });
  if (lic.expires_at && lic.expires_at < now()) return json({ ...FREE, reason: '這組授權碼已過期' });

  const plan = PLANS[lic.plan] || PLANS.pro;

  if (device) {
    const seen = await env.DB.prepare('SELECT 1 AS x FROM activations WHERE license_key=? AND device_id=?')
      .bind(key, device).first();

    if (seen) {
      await env.DB.prepare('UPDATE activations SET last_seen=? WHERE license_key=? AND device_id=?')
        .bind(now(), key, device).run();
    } else {
      // 先數再寫。反過來寫的話，被擋下的裝置也會永久占掉一個名額，
      // 使用者試錯幾次就再也啟用不了 —— 那是會讓付費使用者流失的 bug。
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM activations WHERE license_key=?').bind(key).first();
      if (c && c.n >= plan.maxDevices) {
        return json({
          ...FREE,
          reason: `這組授權碼已在 ${c.n} 台裝置啟用，達到 ${plan.maxDevices} 台上限。請先在其他裝置按「移除授權碼」，或來信重設。`,
        });
      }
      await env.DB.prepare('INSERT INTO activations (license_key,device_id,first_seen,last_seen) VALUES (?,?,?,?)')
        .bind(key, device, now(), now()).run();
    }
  }

  return json({
    plan: lic.plan,
    slots: plan.slots,
    unattended: plan.unattended,
    expiresAt: lic.expires_at,
    email: lic.email,
  });
}

/* ───────────── 入口 ───────────── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === '/api/health') {
        return json({ ok: true, env: env.ECPAY_ENV || 'stage', merchant: env.ECPAY_MERCHANT_ID });
      }
      if (p === '/api/checkout' && request.method === 'POST') return await handleCheckout(request, env, url);
      if (p === '/api/ecpay/return' && request.method === 'POST') return await handleEcpayCallback(request, env, 'first');
      if (p === '/api/ecpay/period' && request.method === 'POST') return await handleEcpayCallback(request, env, 'period');
      if (p === '/api/result') return await handleResult(request, env, url);
      if (p === '/api/entitlement') return await handleEntitlement(env, url);
      if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }

    return env.ASSETS.fetch(request);
  },
};
