# -*- coding: utf-8 -*-
"""
付款流程完整驗收（對線上部署 + 綠界測試環境跑）。任何一項失敗 exit 1。

用法：python worker/test_payments.py
需要：.test_token.txt（測試環境結帳通行碼）

模擬綠界回拋用的是綠界公開的測試金鑰（3002607），不是正式金鑰。
"""
import hashlib, io, json, os, re, subprocess, sys, time, urllib.parse, urllib.request

BASE = "https://meeting-recorder.etfswing-site.workers.dev"
HASH_KEY, HASH_IV, MID = "pwFHCqoQZGmho4w6", "EkRm7iFT261dpevs", "3002607"
UA = {"user-agent": "Mozilla/5.0 (payment-test)"}
HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = io.open(os.path.join(HERE, "..", ".test_token.txt"), encoding="utf-8").read().strip()
# 站主授權碼只放在本機（.gitignore），絕不能寫進這個公開 repo
OWNER_KEY = io.open(os.path.join(HERE, "..", ".owner_key.txt"), encoding="utf-8").read().strip()

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "   ← " + str(detail)[:300]))


def enc(s):  # 綠界官方規則的 Python 參考實作（已對官方向量驗過）
    return urllib.parse.quote_plus(str(s)).replace("~", "%7E")


def mac(params):
    keys = sorted([k for k in params if k != "CheckMacValue"], key=lambda x: x.lower())
    raw = "HashKey=%s&" % HASH_KEY + "&".join("%s=%s" % (k, params[k]) for k in keys) + "&HashIV=%s" % HASH_IV
    raw = enc(raw)
    for a, b in (("%2d", "-"), ("%5f", "_"), ("%2e", "."), ("%21", "!"), ("%2a", "*"), ("%28", "("), ("%29", ")")):
        raw = raw.replace(a, b).replace(a.upper(), b)
    return hashlib.sha256(raw.lower().encode()).hexdigest().upper()


def req(method, path, data=None, form=False, headers=None):
    h = dict(UA)
    if headers: h.update(headers)
    body = None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode(); h["content-type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode(); h["content-type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=body, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(r, timeout=60)
        return resp.getcode(), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def jget(path):
    c, b = req("GET", path)
    return c, json.loads(b) if b.strip().startswith("{") else {}


def d1(sql):
    out = subprocess.run(["npx.cmd", "--yes", "wrangler@latest", "d1", "execute", "meeting-recorder", "--remote",
                          "--json", "--command", sql], capture_output=True, text=True, encoding="utf-8",
                         cwd=os.path.join(HERE, ".."))
    try:
        return json.loads(out.stdout)[0]["results"]
    except Exception:
        raise RuntimeError("d1 failed: " + out.stdout[-400:] + out.stderr[-400:])


def lic(key):
    r = d1("SELECT status,success_times,first_paid_at,paid_through,expires_at,cancelled_at,env,last_sync_at "
           "FROM licenses WHERE key='%s'" % key)
    return r[0] if r else None


def new_order(email="test@example.com"):
    c, b = req("POST", "/api/checkout", {"email": email, "plan": "pro", "consent": True},
               headers={"x-test-token": TOKEN})
    return c, (json.loads(b) if b.strip().startswith("{") else {})


def month_add(ms, n):
    import datetime as dt
    d = dt.datetime.utcfromtimestamp(ms / 1000)
    y, m = d.year + (d.month - 1 + n) // 12, (d.month - 1 + n) % 12 + 1
    import calendar
    day = min(d.day, calendar.monthrange(y, m)[1])
    return int(dt.datetime(y, m, day, d.hour, d.minute, d.second, d.microsecond).timestamp() * 1000 + 0) \
        - int((dt.datetime(1970, 1, 1) - dt.datetime.utcfromtimestamp(0)).total_seconds() * 1000)


# ───────────────────────── 結帳入口 ─────────────────────────
c, h = jget("/api/health")
check("T1 測試環境不對外開放結帳", c == 200 and h.get("checkoutOpen") is False, h)

c, b = req("POST", "/api/checkout", {"email": "a@b.co", "plan": "pro", "consent": True})
check("T2 沒有通行碼 → 503 拒絕", c == 503 and "尚未開放" in b, (c, b))

c, b = req("POST", "/api/checkout", {"email": "a@b.co", "plan": "pro"}, headers={"x-test-token": TOKEN})
check("T3 沒勾同意條款 → 400", c == 400 and "同意" in b, (c, b))

c, b = req("POST", "/api/checkout", {"email": "a@b.co", "plan": "owner", "consent": True}, headers={"x-test-token": TOKEN})
check("T3b 不能用結帳買站主方案", c == 400, (c, b))

c, o = new_order()
KEY = o.get("key"); P = o.get("params", {})
check("T4 結帳回傳授權碼與綠界表單", c == 200 and KEY and P.get("CheckMacValue"), o)
check("T4b ClientBackURL 與 OrderResultURL 不同", P.get("ClientBackURL") != P.get("OrderResultURL"), P)
check("T4c 我們自己產的表單簽章正確", P.get("CheckMacValue") == mac(P), (P.get("CheckMacValue"), mac(P)))
MTN = P.get("MerchantTradeNo")

# 把表單真的送去綠界測試環境
data = urllib.parse.urlencode(P).encode()
r = urllib.request.Request(o["action"], data=data, method="POST",
                           headers={"content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0"})
page = urllib.request.urlopen(r, timeout=60).read()
txt = page.decode("utf-8", "replace")
check("T5 綠界接受表單（沒有 CheckMacValue 錯誤、出現付款頁）",
      b"CheckMacValue" not in page and len(page) > 20000, txt[:200])

# ───────────────────────── 主動補查（綠界真實 API） ─────────────────────────
c, e = jget("/api/entitlement?key=%s&device=t-dev-0" % KEY)
row = lic(KEY)
check("T6 未付款：授權不開、而且有主動向綠界補查", e.get("plan") == "free" and "尚未確認" in e.get("reason", "")
      and row and row["last_sync_at"], (e, row))

# ───────────────────────── 綠界伺服器通知 ─────────────────────────
forged = {"MerchantID": MID, "MerchantTradeNo": MTN, "RtnCode": "1", "TradeAmt": "299",
          "TradeNo": "X1", "CustomField1": KEY, "CheckMacValue": "0" * 64}
c, b = req("POST", "/api/ecpay/return", forged, form=True)
check("T7 偽造簽章 → 400、不開通", c == 400 and lic(KEY)["status"] == "pending", (c, b))

first = {"MerchantID": MID, "MerchantTradeNo": MTN, "PaymentDate": "2026/09/30 10:00:00",
         "PaymentType": "Credit_CreditCard", "PaymentTypeChargeFee": "8", "RtnCode": "1",
         "RtnMsg": "Succeeded", "SimulatePaid": "0", "TradeAmt": "299", "TradeDate": "2026/09/30 09:59:00",
         "TradeNo": "2609301000000001", "CustomField1": KEY, "StoreID": "", "CustomField2": "",
         "CustomField3": "", "CustomField4": ""}
first["CheckMacValue"] = mac(first)
c, b = req("POST", "/api/ecpay/return", first, form=True)
r1 = lic(KEY)
check("T8 正確通知 → 1|OK、開通、第 1 期", c == 200 and b.strip() == "1|OK" and r1["status"] == "active"
      and r1["success_times"] == 1, (c, b, r1))
# 2026/09/30 10:00 台北 = 02:00 UTC
FIRST_MS = 1790733600000
check("T8b 首期付款時間照綠界的時間記（台北時區換算正確）", r1["first_paid_at"] == FIRST_MS, r1["first_paid_at"])
check("T8c 付費到 +1 個月、寬限 3 天", r1["expires_at"] - r1["paid_through"] == 3 * 86400000, r1)

for _ in range(3):
    req("POST", "/api/ecpay/return", first, form=True)
r2 = lic(KEY)
n = d1("SELECT COUNT(*) AS n FROM payments WHERE ref='T:2609301000000001'")[0]["n"]
check("T9 同一筆通知重送 3 次 → 不會多送月份、只記一筆", r2["success_times"] == 1 and r2["paid_through"] == r1["paid_through"]
      and n == 1, (r2, n))

per = {"MerchantID": MID, "MerchantTradeNo": MTN, "StoreID": "", "RtnCode": "1", "RtnMsg": "Succeeded",
       "PeriodType": "M", "Frequency": "1", "ExecTimes": "99", "Amount": "299", "gwsr": "11112222",
       "ProcessDate": "2026/10/30 10:00:00", "AuthCode": "777777", "FirstAuthAmount": "299",
       "TotalSuccessTimes": "2", "CustomField1": KEY, "CustomField2": "", "CustomField3": "", "CustomField4": ""}
per["CheckMacValue"] = mac(per)
c, b = req("POST", "/api/ecpay/period", per, form=True)
r3 = lic(KEY)
check("T10 第 2 期通知（欄位是 Amount/gwsr/TotalSuccessTimes）→ 第 2 期", c == 200 and r3["success_times"] == 2
      and r3["paid_through"] > r2["paid_through"], (c, b, r3))

req("POST", "/api/ecpay/period", per, form=True); req("POST", "/api/ecpay/period", per, form=True)
r4 = lic(KEY)
check("T11 第 2 期通知重送 → 不變", r4["success_times"] == 2 and r4["paid_through"] == r3["paid_through"], r4)

bad_amt = dict(per); bad_amt.update({"Amount": "1", "TotalSuccessTimes": "3", "gwsr": "33334444"}); bad_amt.pop("CheckMacValue")
bad_amt["CheckMacValue"] = mac(bad_amt)
req("POST", "/api/ecpay/period", bad_amt, form=True)
r5 = lic(KEY)
check("T12 金額不符（1 元）→ 不延長", r5["success_times"] == 2, r5)

bad_mid = dict(per); bad_mid.update({"MerchantID": "9999999", "TotalSuccessTimes": "3", "gwsr": "55556666"}); bad_mid.pop("CheckMacValue")
bad_mid["CheckMacValue"] = mac(bad_mid)
req("POST", "/api/ecpay/period", bad_mid, form=True)
check("T13 特店編號不符 → 不延長", lic(KEY)["success_times"] == 2, lic(KEY))

fail_per = dict(per); fail_per.update({"RtnCode": "10100248", "RtnMsg": "拒絕交易", "TotalSuccessTimes": "2", "gwsr": "77778888"}); fail_per.pop("CheckMacValue")
fail_per["CheckMacValue"] = mac(fail_per)
c, b = req("POST", "/api/ecpay/period", fail_per, form=True)
check("T14 扣款失敗的通知 → 照樣回 1|OK、不延長", b.strip() == "1|OK" and lic(KEY)["success_times"] == 2, (b, lic(KEY)))

# ───────────────────────── 前端授權查詢 ─────────────────────────
c, e = jget("/api/entitlement?key=%s&device=t-dev-1" % KEY)
check("T15 付費中 → Pro 4 場", e.get("plan") == "pro" and e.get("slots") == 4, e)
check("T15b 授權查詢不再回傳 Email", "email" not in e, e)

# ───────────────────────── 我的訂閱 ─────────────────────────
c, b = req("POST", "/api/account", {"key": KEY, "email": "wrong@example.com"})
check("T16 Email 不對 → 查不到", c == 404, (c, b))
c, b = req("POST", "/api/account", {"key": KEY, "email": "TEST@example.com "})
a = json.loads(b) if c == 200 else {}
check("T16b Email 對（大小寫與空白不影響）→ 看得到、Email 遮罩", c == 200 and a.get("email", "").startswith("te***@")
      and a.get("successTimes") == 2 and len(a.get("payments", [])) >= 2, (c, b[:300]))

# ───────────────────────── 裝置上限 ─────────────────────────
# 注意：T6 時授權還在「付款確認中」，那台裝置不會被登記（未付款不佔名額 —— 這是對的行為）
for d in ("t-dev-2", "t-dev-3"):
    jget("/api/entitlement?key=%s&device=%s" % (KEY, d))
reg = d1("SELECT COUNT(*) AS n FROM activations WHERE license_key='%s'" % KEY)[0]["n"]
check("T17a 未付款時查詢不佔裝置名額；付款後 3 台已登記", reg == 3, reg)
c, e = jget("/api/entitlement?key=%s&device=t-dev-9" % KEY)  # 第 4 台
check("T17 第 4 台裝置被擋、訊息指向自助清空", e.get("plan") == "free" and "我的訂閱" in e.get("reason", ""), e)
c, b = req("POST", "/api/account/reset-devices", {"key": KEY, "email": "test@example.com"})
c2, e2 = jget("/api/entitlement?key=%s&device=t-dev-9" % KEY)
check("T17b 自助清空裝置後可重新啟用", c == 200 and e2.get("plan") == "pro", (b, e2))

# 30 天沒出現的裝置不佔名額
d1("UPDATE activations SET last_seen=%d WHERE license_key='%s'" % (int(time.time() * 1000) - 31 * 86400000, KEY))
for d in ("t-dev-4", "t-dev-5"):
    jget("/api/entitlement?key=%s&device=%s" % (KEY, d))
c, e = jget("/api/entitlement?key=%s&device=t-dev-6" % KEY)
check("T17c 超過 30 天沒用的裝置自動讓位", e.get("plan") == "pro", e)

# ───────────────────────── 取消 ─────────────────────────
# 這筆在綠界那邊沒有真的付款合約 → 綠界不會確認取消 → 我們必須「不能」宣稱已取消
c, b = req("POST", "/api/account/cancel", {"key": KEY, "email": "test@example.com"})
check("T18 綠界沒確認取消 → 回錯誤、不標記為已取消（避免客人以為取消了卻繼續被扣）",
      c == 502 and lic(KEY)["cancelled_at"] is None, (c, b, lic(KEY)))

c, o2 = new_order("cancel@example.com")
K2 = o2.get("key")
c, b = req("POST", "/api/account/cancel", {"key": K2, "email": "cancel@example.com"})
check("T19 還沒付款的單可直接取消", c == 200 and lic(K2)["status"] == "cancelled", (c, b))

# 取消後、期間未滿：仍可使用
d1("UPDATE licenses SET status='cancelled', cancelled_at=%d WHERE key='%s'" % (int(time.time() * 1000), KEY))
c, e = jget("/api/entitlement?key=%s&device=t-dev-4" % KEY)
check("T20 已取消但付費期間還沒到 → 照樣可以用", e.get("plan") == "pro" and e.get("cancelled") is True, e)
c, b = req("POST", "/api/ecpay/period", dict(per, TotalSuccessTimes="2"), form=True)
check("T20b 取消後收到的通知不會把狀態改回付費中", lic(KEY)["status"] == "cancelled", lic(KEY))

# ───────────────────────── 站主授權 ─────────────────────────
c, e = jget("/api/entitlement?key=%s&device=owner-test" % OWNER_KEY)
check("T21 站主授權照常可用（不受環境檢查影響）", e.get("plan") == "owner" and e.get("slots") == 99, e)

# ───────────────────────── 導回頁 ─────────────────────────
c, b = req("GET", "/api/result?k=%s" % K2)
check("T22 導回頁會把授權碼自動存進瀏覽器", "localStorage.setItem" in b and K2 in b, b[:200])
c, b = req("GET", "/api/result?k=MR-NOPE-NOPE-NOPE")
check("T22b 不存在的授權碼 → 找不到，不報錯", c == 200 and "找不到" in b, (c, b[:120]))

# ───────────────────────── 錯誤不外洩 ─────────────────────────
c, b = req("POST", "/api/account", None)
check("T23 壞掉的請求不吐內部錯誤細節", c in (400, 500) and "stack" not in b.lower() and "d1_" not in b.lower(), (c, b))

# ───────────────────────── 收尾：清掉測試資料 ─────────────────────────
d1("DELETE FROM activations WHERE license_key IN ('%s','%s')" % (KEY, K2))

passed = sum(1 for _, ok in results if ok)
print("\n%d / %d passed" % (passed, len(results)))
print("TEST_KEY=%s  MTN=%s" % (KEY, MTN))
sys.exit(0 if passed == len(results) else 1)
