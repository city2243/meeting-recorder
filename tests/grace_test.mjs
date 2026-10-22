// 會議結束自動停止並存檔：單場（分頁關掉 / 重接取消 / 靜音）、多場（靜音那場自停、有聲那場繼續）
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
import { fileURLToPath as __f2p } from 'url';
const __ROOT = __f2p(new URL('../', import.meta.url)).replace(/\\/g, '/');
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3); }, 480000);
const src = readFileSync(new URL('./multi_audit.mjs', import.meta.url), 'utf8');
const FAKE = src.slice(src.indexOf('const FAKE = `') + 14, src.indexOf('`;\n\n// 從 OPFS'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ← ' + JSON.stringify(d).slice(0, 400))); };
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function single(mode, prefs) {
  const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await c.addInitScript((pr) => { try { localStorage.setItem('meetingRecorder.lang', 'zh'); localStorage.setItem('meetingRecorder.prefs', JSON.stringify(pr)); } catch (e) {} }, prefs);
  await c.addInitScript(FAKE);
  await c.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  const p = await c.newPage(); p.__err = []; p.on('pageerror', (e) => p.__err.push(String(e))); p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8801/index.html', { waitUntil: 'domcontentloaded' }); await sleep(1500);
  await p.evaluate((m) => { window.__mode = m; }, mode);
  await p.selectOption('#sourceMode', 'browser');
  await p.click('#btnPreflight');
  await p.waitForFunction(() => !document.getElementById('btnStart').disabled, null, { timeout: 60000 });
  await p.click('#btnStart');
  await p.waitForFunction(() => !document.getElementById('liveCard').hidden, null, { timeout: 20000 });
  return p;
}
const isDone = (p) => p.evaluate(() => !document.getElementById('doneCard').hidden);

// 先確認單場版偏好鍵名
const prefKey = (readFileSync(__ROOT + 'js/app.js', 'utf8').match(/PREF_KEY = '([^']+)'/) || [])[1];
console.log('單場偏好鍵：', prefKey);

/* S2 單場靜音 3 分鐘、M 多場一場靜音一場有聲 —— 兩個一起跑 */
const tS = Date.now();
const pS = await single('silent', { autoEndQuiet: true, endQuietMin: 3, quietGraceMin: 4 });
const cM = await b.newContext({ viewport: { width: 1280, height: 900 } });
await cM.addInitScript(() => { try { localStorage.setItem('meetingRecorder.lang', 'zh'); localStorage.setItem('meetingRecorder.multiPrefs', JSON.stringify({ autoQuiet: true, quietMin: 3, graceMin: 4 })); } catch (e) {} });
await cM.addInitScript(FAKE);
await cM.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
const pM = await cM.newPage(); pM.__err = []; pM.on('pageerror', (e) => pM.__err.push(String(e))); pM.on('dialog', (d) => d.accept());
await pM.goto('http://localhost:8801/multi.html', { waitUntil: 'domcontentloaded' });
await pM.waitForFunction(() => document.querySelectorAll('.slot-card').length >= 2); await sleep(800);
check('G0 設定讀到保護期 4 分、門檻 3 分', await pM.evaluate(() => document.getElementById('graceMin').value === '4' && document.getElementById('quietMin').value === '3'));
await pM.evaluate(() => { window.__mode = 'silent'; });
await pM.click('.slot-card >> nth=0 >> .sc-pick');
await pM.waitForFunction(() => document.querySelectorAll('.slot-card')[0].dataset.state === 'ready', null, { timeout: 30000 });
await pM.evaluate(() => { window.__mode = 'ok'; });
await pM.click('.slot-card >> nth=1 >> .sc-pick');
await pM.waitForFunction(() => document.querySelectorAll('.slot-card')[1].dataset.state === 'ready', null, { timeout: 30000 });
await pM.click('.slot-card >> nth=0 >> .sc-start'); await pM.click('.slot-card >> nth=1 >> .sc-start');
const tM = Date.now();
await sleep(210000);
check('G1 單場：靜音 3.5 分鐘（已超過 3 分門檻）仍在錄，因為在 4 分保護期內', !(await isDone(pS)));
check('G2 多場：靜音那場 3.5 分鐘仍在錄（保護期內）', (await pM.evaluate(() => document.querySelectorAll('.slot-card')[0].dataset.state)) === 'recording');
await pS.waitForFunction(() => !document.getElementById('doneCard').hidden, null, { timeout: 90000 }).catch(() => {});
check(`G3 單場：保護期過後自動停止並存檔（${((Date.now() - tS) / 1000).toFixed(0)} 秒）`, await isDone(pS));
await pM.waitForFunction(() => document.querySelectorAll('.slot-card')[0].dataset.state === 'done', null, { timeout: 90000 }).catch(() => {});
const st = await pM.evaluate(() => [...document.querySelectorAll('.slot-card')].map((c) => c.dataset.state));
check(`G4 多場：保護期過後靜音那場自動停止（${((Date.now() - tM) / 1000).toFixed(0)} 秒），有聲音那場繼續錄`, st.join() === 'done,recording', st);
check('M3 自動停止的那場有存檔', await pM.evaluate(() => document.querySelectorAll('.slot-card')[0].querySelectorAll('.sc-files .fn, .sc-fileline').length >= 2));
check('M4/S2c 沒有 JavaScript 錯誤', pM.__err.length === 0 && pS.__err.length === 0, [pM.__err, pS.__err]);
await b.close();
console.log(`\n${results.filter(Boolean).length} / ${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
