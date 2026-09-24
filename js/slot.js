/*
 * slot.js —— 一個「錄影槽」：一場會議的完整生命週期，不碰任何 DOM
 *
 * empty → acquiring → checking → ready → recording → finishing → done / failed
 *
 * 跟單場版最大的兩個差別：
 *   1. 預設抓「瀏覽器分頁」而不是整個螢幕 —— 分頁擷取的音訊只有那個分頁的，
 *      這是多場同時錄唯一能拿到乾淨分軌的方法。
 *   2. 開錄前檢查**不放測試音**。單場版會從喇叭放一個 660Hz 測試音來驗證
 *      系統音回路，但多場時那個聲音會被其他正在錄的場次錄進去。
 *
 * 每秒會留下一筆量測（fps／音量／落地位元組／頁面是否在背景），
 * 停止後拿來回答「背景分頁會不會掉格」「幾場會開始跟不上」這類問題。
 */

import * as S from './storage.js';
import * as M from './media.js';
import * as C from './checks.js';

const SOUND_FLOOR = 0.0027;   // 約 -51 dBFS

function clock() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function uid() { return Math.random().toString(36).slice(2, 8); }

export class Slot {
  /**
   * @param {object} opts { name, quality, withVideo, audioCtx, on:{state,log,alert,tick} }
   */
  constructor(id, opts) {
    this.id = id;
    this.name = (opts.name || '').trim() || `會議 ${id}`;
    this.quality = opts.quality || '720p15';
    this.withVideo = opts.withVideo !== false;
    this.audioCtx = opts.audioCtx || null;
    this.on = opts.on || {};

    this.state = 'empty';
    this.log = [];
    this.alerts = new Map();
    this.checks = [];

    this.stream = null;
    this.mix = null;
    this.watch = null;
    this.vWriter = null; this.aWriter = null;
    this.vRec = null; this.aRec = null;

    this.startedAt = 0; this.endedAt = 0;
    this.frames0 = 0;
    this._lastFrames = 0; this._lastTickAt = 0;
    this._lastBytes = 0; this._lastGrowAt = 0;
    this._lastSoundAt = 0;

    this.samples = [];      // {t, fps, rms, bytes, hidden}
    this.marks = [];        // 使用者按「標記」的時間點
    this.peakRms = 0;
    this.videoMime = M.pickVideoMime();
    this.audioMime = M.pickAudioMime();
  }

  /* ---------- 對外通知 ---------- */
  _set(state) { this.state = state; this._emit('state'); }
  _emit(k, ...a) { if (this.on[k]) this.on[k](this, ...a); }
  say(kind, msg) {
    const line = `[${clock()}] ${msg}`;
    this.log.push(line);
    this._emit('log', kind, line);
  }
  raise(key, level, title, detail) {
    const prev = this.alerts.get(key);
    if (prev && prev.level === level && prev.title === title) return;
    this.alerts.set(key, { level, title, detail });
    this.say(level === 'fatal' ? 'fail' : 'warn', `${level === 'fatal' ? '【嚴重】' : '【注意】'}${title} — ${detail}`);
    this._emit('alert');
  }
  clear(key) {
    if (!this.alerts.has(key)) return;
    const a = this.alerts.get(key);
    this.alerts.delete(key);
    this.say('ok', '已恢復正常：' + a.title);
    this._emit('alert');
  }
  get worstAlert() {
    let top = null;
    for (const a of this.alerts.values()) if (!top || (a.level === 'fatal' && top.level !== 'fatal')) top = a;
    return top;
  }

  /* ---------- 取得來源 ---------- */
  async acquire() {
    this._set('acquiring');
    try {
      this.stream = await M.getScreen(this.quality, 'browser');
    } catch (e) {
      this._set('empty');
      throw e;
    }
    const vTrack = this.stream.getVideoTracks()[0];
    const aTrack = this.stream.getAudioTracks()[0] || null;

    this.mix = new M.AudioMix(this.audioCtx);
    await this.mix.resume();
    if (aTrack) this.mix.addTrack('sys', aTrack, 1.0);

    this.watch = new M.VideoWatch(vTrack);
    vTrack.onended = () => this._onSourceEnded();
    this.say('ok', `已接上來源：${this.surfaceLabel}`);
    this._set('checking');
    return this.stream;
  }

  get surface() {
    try { return (this.stream.getVideoTracks()[0].getSettings() || {}).displaySurface || '未知'; }
    catch (e) { return '未知'; }
  }
  get surfaceLabel() {
    return ({ browser: '瀏覽器分頁', monitor: '整個畫面', window: '單一視窗' })[this.surface] || this.surface;
  }
  get videoTrack() { return this.stream ? this.stream.getVideoTracks()[0] : null; }

  _onSourceEnded() {
    if (this.state !== 'recording') return;
    this.raise('source', 'fatal', `「${this.name}」的分享已中斷`,
      '分頁被關掉、或有人按了「停止共用」。這一場的畫面已經停了，請盡快按停止保住現有內容。');
  }

  /* ---------- 開錄前檢查（不放測試音） ---------- */
  async runChecks(expectMinutes) {
    const items = [];
    const add = (level, name, detail, fix) => items.push({ level, name, detail, fix });

    const vt = this.videoTrack;
    const at = this.stream.getAudioTracks()[0];

    // 1. 來源型態
    if (!vt || vt.readyState !== 'live') {
      add('fail', '畫面來源', '沒有可用的來源', '按「重新選擇」再挑一次。');
    } else if (this.surface === 'browser') {
      const s = vt.getSettings() || {};
      add('pass', '畫面來源', `瀏覽器分頁，${s.width || '?'}×${s.height || '?'}，${Math.round(s.frameRate || 0)} fps`);
    } else {
      add('warn', '畫面來源', `${this.surfaceLabel}（不是分頁）`,
        '非分頁來源的聲音是整台電腦的混音，會跟其他場混在一起，逐字稿會廢掉。除非這場真的只能用桌面程式，否則請重選成分頁。');
    }

    // 2. 音訊軌（分頁模式下這是硬條件）
    if (!at) {
      add('fail', '這一場的聲音', '這次分享沒有帶音訊',
        '重新選擇時，在分享視窗裡把「分享分頁音訊」勾起來。沒勾就只有畫面沒聲音。');
    } else if (at.readyState !== 'live') {
      add('fail', '這一場的聲音', '音訊軌已中斷', '按「重新選擇」再挑一次。');
    } else {
      add('pass', '這一場的聲音', '已取得這個分頁專屬的音訊軌（不會混到其他場）');
    }

    // 3. 畫面真的在更新
    const f0 = this.watch.frames;
    await C.sleep(2200);
    const df = this.watch.frames - f0;
    if (df < 3) add('fail', '畫面正在更新', `2.2 秒只收到 ${df} 張畫格（感測器 ${this.watch.sensorInfo}）`, '來源可能已經停了，請重新選擇。');
    else add('pass', '畫面正在更新', `2.2 秒收到 ${df} 張（約 ${(df / 2.2).toFixed(1)} fps）`);

    // 4. 試錄並解碼 —— 這一項才是真的證據
    let peak = 0;
    const sampler = (async () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 4200) {
        const r = this.mix.levelRaw('sys');
        if (r !== null && r > peak) peak = r;
        await C.sleep(40);
      }
    })();
    const q = M.QUALITY[this.quality];
    const avStream = new MediaStream([vt, this.mix.audioTrack].filter(Boolean));
    let avBlob = null, aBlob = null;
    try {
      [avBlob, aBlob] = await Promise.all([
        C.trialRecord(avStream, 4000, this.videoMime, { video: q.videoBitsPerSecond, audio: 128000 }),
        this.audioMime ? C.trialRecord(this.mix.stream, 4000, this.audioMime, { audio: 96000 }) : Promise.resolve(null),
      ]);
    } catch (e) {
      add('fail', '試錄並解碼驗證', '試錄失敗：' + e.message, '換一個畫質再試。');
    }
    await sampler;

    if (avBlob) {
      if (avBlob.size < 5000) {
        add('fail', '試錄並解碼驗證', `只產出 ${avBlob.size} bytes，等於沒錄到`, '換一個畫質再試。');
      } else {
        const meta = await C.probeVideoMeta(avBlob);
        if (!meta.ok) add('fail', '試錄並解碼驗證', '試錄檔無法解碼：' + meta.error, '換一個畫質再試。');
        else if (!meta.hasVideo) add('fail', '試錄並解碼驗證', '試錄檔裡沒有影像', '重新選擇來源。');
        else {
          let note = '';
          let lv = 'pass';
          if (aBlob && aBlob.size > 0) {
            const stt = await C.decodeAudioStats(aBlob);
            if (!stt.ok) {
              if (aBlob.size < 1500) { note = `；音訊樣本只有 ${aBlob.size} bytes 又解不開`; lv = 'fail'; }
              else { note = '；音訊解碼失敗（' + stt.error + '）'; lv = 'warn'; }
            } else if (stt.peak < 0.005) {
              note = '；這 4 秒完全沒有聲音';
              lv = 'quiet';
            } else {
              note = `；聲音峰值 ${stt.peak.toFixed(3)}`;
            }
          } else { note = '；沒有可驗證的音訊樣本'; lv = 'warn'; }

          const detail = `影像 ${meta.width}×${meta.height}、${(avBlob.size / 1024).toFixed(0)} KB / 4 秒${note}`;
          if (lv === 'fail') add('fail', '試錄並解碼驗證', detail, '檢查分享時有沒有勾「分享分頁音訊」。');
          else if (lv === 'quiet') {
            // 會議可能只是剛好沒人講話 —— 這是提醒，不是失敗。開錄後會持續盯。
            add('warn', '試錄並解碼驗證', detail,
              '影像沒問題，但這 4 秒沒有任何聲音。如果這場現在本來就安靜，可以照樣開始，錄製中我會繼續盯著；如果它正在講話，代表音訊沒抓到。');
          } else if (lv === 'warn') add('warn', '試錄並解碼驗證', detail, '開錄後請盯著音量條確認有跳動。');
          else add('pass', '試錄並解碼驗證', detail);
        }
      }
    }

    // 5. 空間（以這一場的預估算）
    const est = await S.estimateSpace();
    const perSec = (this.withVideo ? q.videoBitsPerSecond : 0) + 96000;
    const need = (perSec / 8) * (expectMinutes || 90) * 60 * 1.15;
    if (!est) add('warn', '儲存空間', '查不到可用空間', `自己確認還有 ${(need / 1073741824).toFixed(1)} GB 以上。`);
    else if (est.free < need) add('fail', '儲存空間', `剩 ${(est.free / 1073741824).toFixed(1)} GB，這一場預估要 ${(need / 1073741824).toFixed(1)} GB`, '降畫質、縮短預計長度，或關掉其中一場。');
    else add('pass', '儲存空間', `剩 ${(est.free / 1073741824).toFixed(1)} GB（所有場次共用），這一場預估 ${(need / 1048576).toFixed(0)} MB`);

    this.checks = items;
    const fails = items.filter((x) => x.level === 'fail').length;
    const warns = items.filter((x) => x.level === 'warn').length;
    this._set(fails ? 'checking' : 'ready');
    return { items, fails, warns };
  }

  /* ---------- 開始 ---------- */
  async start(sid) {
    const q = M.QUALITY[this.quality];
    const safe = this.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const u = uid();

    this.vTarget = `${sid}_${safe}.webm`;
    this.aTarget = `${sid}_${safe}_音訊.webm`;
    this.vOpfs = `${sid}_${u}_v.webm`;
    this.aOpfs = `${sid}_${u}_a.webm`;

    // 音訊是主要交付物，永遠錄；影像可關
    this.aWriter = await S.makeWriter(this.aOpfs);
    this.aRec = new MediaRecorder(this.mix.stream, { mimeType: this.audioMime, audioBitsPerSecond: 96000 });
    this.aRec.ondataavailable = (e) => { if (e.data && e.data.size) this.aWriter.write(e.data).catch((err) => this.raise('write', 'fatal', `「${this.name}」音訊寫檔失敗`, err.message)); };

    if (this.withVideo) {
      const combined = new MediaStream([this.videoTrack, this.mix.audioTrack].filter(Boolean));
      this.vWriter = await S.makeWriter(this.vOpfs);
      this.vRec = new MediaRecorder(combined, {
        mimeType: this.videoMime,
        videoBitsPerSecond: q.videoBitsPerSecond,
        audioBitsPerSecond: 128000,
      });
      this.vRec.ondataavailable = (e) => { if (e.data && e.data.size) this.vWriter.write(e.data).catch((err) => this.raise('write', 'fatal', `「${this.name}」影像寫檔失敗`, err.message)); };
      this.vRec.onerror = (e) => this.raise('recorder', 'fatal', `「${this.name}」錄影器錯誤`, String((e.error && e.error.name) || e));
    }

    this.aRec.start(2000);
    if (this.vRec) this.vRec.start(2000);

    this.startedAt = Date.now();
    this.frames0 = this.watch.frames;
    this._lastFrames = this.frames0;
    this._lastTickAt = this.startedAt;
    this._lastGrowAt = this.startedAt;
    this._lastSoundAt = this.startedAt;
    this._set('recording');
    this.say('ok', `開始錄製：${this.vTarget}${this.withVideo ? '' : '（只錄音訊）'}` +
      (this.aWriter.durable ? '' : '　⚠ 這個環境只能暫存在記憶體'));
  }

  /* ---------- 每秒監看 + 量測 ---------- */
  tick(now, pageHidden) {
    if (this.state !== 'recording') return null;

    if (this.watch.poll) this.watch.poll();
    const frames = this.watch.frames;
    const dt = Math.max(0.2, (now - this._lastTickAt) / 1000);
    const fps = (frames - this._lastFrames) / dt;
    this._lastFrames = frames; this._lastTickAt = now;

    const rms = this.mix.levelRaw('sys');
    if (rms !== null && rms > this.peakRms) this.peakRms = rms;
    if (rms !== null && rms > SOUND_FLOOR) this._lastSoundAt = now;

    const bytes = (this.vWriter ? this.vWriter.bytesOnDisk : 0) + (this.aWriter ? this.aWriter.bytesOnDisk : 0);
    if (bytes > this._lastBytes) { this._lastBytes = bytes; this._lastGrowAt = now; }

    const elapsed = (now - this.startedAt) / 1000;
    this.samples.push({ t: Math.round(elapsed), fps: +fps.toFixed(1), rms: rms === null ? null : +rms.toFixed(5), bytes, hidden: !!pageHidden });

    /* --- 判斷 --- */
    const vt = this.videoTrack;
    if (this.withVideo) {
      if (!vt || vt.readyState !== 'live') {
        this.raise('source', 'fatal', `「${this.name}」的分享已中斷`, '分頁被關掉或按了「停止共用」，請盡快停止保住現有內容。');
      } else if (this.watch.staleSeconds > 6) {
        this.raise('video', 'fatal', `「${this.name}」畫面停止更新`,
          `已經 ${this.watch.staleSeconds.toFixed(0)} 秒沒有新畫格（感測器 ${this.watch.sensorInfo}）。`);
      } else {
        this.clear('video');
      }
    }

    const quiet = (now - this._lastSoundAt) / 1000;
    if (quiet > 180) {
      this.raise('quiet', 'warn', `「${this.name}」已經三分鐘沒有聲音`,
        '如果這場正在講話，代表音訊沒抓到；如果本來就安靜，忽略即可。');
    } else this.clear('quiet');

    const stall = (now - this._lastGrowAt) / 1000;
    if (elapsed > 12 && stall > 15) {
      this.raise('disk', 'fatal', `「${this.name}」已經 ${Math.round(stall)} 秒沒有新資料落地`, '建議按停止保住現有內容。');
    } else this.clear('disk');

    if (this.aRec && this.aRec.state !== 'recording') {
      this.raise('recstate', 'fatal', `「${this.name}」錄音器不在錄製狀態（${this.aRec.state}）`, '請按停止保住目前內容。');
    }

    return { fps, rms, bytes, elapsed, quiet, stale: this.watch.staleSeconds };
  }

  mark(label) {
    if (this.state !== 'recording') return;
    const t = Math.round((Date.now() - this.startedAt) / 1000);
    this.marks.push({ t, label });
    this.say('info', `標記 @ ${t}s：${label}`);
  }

  /* ---------- 停止 ---------- */
  async stop() {
    if (this.state !== 'recording') return;
    this._set('finishing');
    this.endedAt = Date.now();

    const stopRec = (rec) => new Promise((res) => {
      if (!rec || rec.state === 'inactive') return res();
      rec.onstop = () => res();
      try { rec.requestData(); rec.stop(); } catch (e) { res(); }
      setTimeout(res, 8000);
    });
    await stopRec(this.vRec);
    await stopRec(this.aRec);
    if (this.vWriter) await this.vWriter.close();
    if (this.aWriter) await this.aWriter.close();
    this.say('ok', `收檔完成：影像 ${fmtB(this.vWriter ? this.vWriter.bytesOnDisk : 0)}、音訊 ${fmtB(this.aWriter.bytesOnDisk)}`);
    this._set('done');
  }

  release() {
    if (this.watch) { this.watch.stop(); this.watch = null; }
    if (this.mix) { this.mix.close(); this.mix = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  }

  /* ---------- 驗證 + 壓測摘要 ---------- */
  async verify() {
    const seconds = (this.endedAt - this.startedAt) / 1000;
    const frames = this.watch ? this.watch.frames - this.frames0 : null;
    const aFile = this.aWriter ? await this.aWriter.getFile() : null;
    const vFile = this.vWriter ? await this.vWriter.getFile() : null;

    let report;
    if (vFile) {
      report = await C.verifyFile(vFile, aFile, { seconds, frames });
    } else {
      // 只錄音訊時，用音訊檔自己驗
      report = { items: [], pass: true, warn: false };
      const stt = aFile ? await C.decodeAudioStats(aFile) : { ok: false, error: '沒有音訊檔' };
      if (!stt.ok) { report.items.push({ level: 'fail', name: '聲音內容', detail: stt.error }); report.pass = false; }
      else if (stt.peak < 0.005) { report.items.push({ level: 'fail', name: '聲音內容', detail: `整段幾乎是數位靜音（峰值 ${stt.peak.toExponential(1)}）` }); report.pass = false; }
      else {
        report.items.push({ level: 'pass', name: '聲音內容', detail: `峰值 ${stt.peak.toFixed(3)}、長度 ${C.fmtDur(stt.duration)}` });
        report.items.push({ level: stt.silenceRatio > 0.85 ? 'warn' : 'pass', name: '靜音佔比', detail: `${(stt.silenceRatio * 100).toFixed(0)}%` });
        if (stt.silenceRatio > 0.85) report.warn = true;
      }
    }
    return { report, seconds, frames, vFile, aFile, stress: this.stressSummary() };
  }

  /**
   * 壓測摘要 —— 這次做多場版的重點就是要量出這幾個數字。
   * 分頁在前景與背景時的 fps 分開統計，才看得出「背景會不會掉格」。
   */
  stressSummary() {
    const s = this.samples.filter((x) => x.t > 3); // 前 3 秒還在暖機，不算
    if (!s.length) return null;
    const pick = (arr) => {
      if (!arr.length) return null;
      const v = arr.slice().sort((a, b) => a - b);
      return {
        n: v.length,
        min: v[0],
        p10: v[Math.floor(v.length * 0.1)],
        median: v[Math.floor(v.length * 0.5)],
        max: v[v.length - 1],
      };
    };
    const vis = pick(s.filter((x) => !x.hidden).map((x) => x.fps));
    const hid = pick(s.filter((x) => x.hidden).map((x) => x.fps));
    const target = M.QUALITY[this.quality].frameRate;
    const lowSecs = s.filter((x) => x.fps < target * 0.5).length;
    const quietSecs = s.filter((x) => x.rms !== null && x.rms < SOUND_FLOOR).length;
    return {
      targetFps: target,
      visible: vis,
      hidden: hid,
      lowFpsSeconds: lowSecs,
      lowFpsPct: +(lowSecs / s.length * 100).toFixed(1),
      quietPct: +(quietSecs / s.length * 100).toFixed(1),
      marks: this.marks,
      seconds: s.length,
    };
  }
}

function fmtB(b) {
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
