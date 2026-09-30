-- 會議錄影守門員 · 授權與訂閱
--
-- 設計取捨：不做帳號密碼登入，改用「授權碼」。付款成功後產生一組碼，
-- 使用者貼進網頁即可解鎖。少了整套 auth 與寄信基礎建設，對單人經營的規模是對的。
-- 代價：碼可以轉傳給別人。用「同時啟用裝置數」上限來壓制（activations 表）。

CREATE TABLE IF NOT EXISTS licenses (
  key           TEXT PRIMARY KEY,        -- MR-XXXX-XXXX-XXXX
  email         TEXT NOT NULL,
  plan          TEXT NOT NULL,           -- 'pro'
  status        TEXT NOT NULL,           -- pending | active | expired | cancelled
  merchant_no   TEXT,                    -- 綠界 MerchantTradeNo（第一筆）
  period_amount INTEGER NOT NULL,
  expires_at    INTEGER,                 -- epoch ms；每期扣款成功就往後推
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
CREATE INDEX IF NOT EXISTS idx_licenses_merchant ON licenses(merchant_no);

-- 每一次綠界回拋都留原文，對帳與爭議時唯一的依據
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key   TEXT,
  merchant_no   TEXT,
  trade_no      TEXT,                    -- 綠界交易編號
  amount        INTEGER,
  rtn_code      INTEGER,                 -- 1 = 成功
  rtn_msg       TEXT,
  kind          TEXT,                    -- first | period
  raw           TEXT NOT NULL,           -- 完整回拋內容
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_license ON payments(license_key);

-- 授權碼在幾台裝置上啟用過。不是為了防駭，是為了讓「整組碼轉傳出去」有代價。
CREATE TABLE IF NOT EXISTS activations (
  license_key   TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  PRIMARY KEY (license_key, device_id)
);
