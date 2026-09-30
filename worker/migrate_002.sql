-- 002：付款正確性修正
--
-- 1. 到期日改由「已成功扣款次數」推算，天生冪等 —— 同一筆通知送幾次結果都一樣。
--    舊做法是每收到一次通知就往後推一個月，綠界重送就會多送一個月，而且寬限期會逐月累加。
-- 2. 每筆付款要有唯一參照（首筆用綠界交易編號，每期用 gwsr），重送的通知直接忽略。
-- 3. 標記授權來自哪個金流環境。測試環境發出去的授權，正式上線後不得沿用。

ALTER TABLE licenses ADD COLUMN env TEXT NOT NULL DEFAULT 'stage';
ALTER TABLE licenses ADD COLUMN first_paid_at INTEGER;
ALTER TABLE licenses ADD COLUMN success_times INTEGER NOT NULL DEFAULT 0;
ALTER TABLE licenses ADD COLUMN paid_through INTEGER;
ALTER TABLE licenses ADD COLUMN cancelled_at INTEGER;
ALTER TABLE licenses ADD COLUMN last_sync_at INTEGER;
ALTER TABLE licenses ADD COLUMN client_ip TEXT;

ALTER TABLE payments ADD COLUMN ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_ref ON payments(ref);

-- 站主授權不屬於任何金流環境
UPDATE licenses SET env='any' WHERE plan='owner';

-- 結帳頻率限制
CREATE TABLE IF NOT EXISTS throttle (
  ip   TEXT NOT NULL,
  ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_throttle ON throttle(ip, ts);
