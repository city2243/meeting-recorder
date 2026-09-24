/*
 * checks.js —— 「確保真的錄得到」的三道關卡
 *
 *   1. preflight()    開錄前：用『等一下真正要錄的那一條 stream』試錄幾秒，
 *                     解碼回來驗證裡面真的有畫面與聲音。不是看設定，是看成品。
 *   2. deepCheck()    錄製中：每隔幾分鐘偷偷試錄 1.2 秒再解碼一次，
 *                     確認編碼管線到現在都還活著。
 *   3. verifyFile()   錄完後：把檔案讀回來量長度、量靜音比例，出一份驗證報告。
 *
 * 設計原則：任何一項「我看不到」都不可以被寫成「沒問題」。
 */

/* ---------- 小工具 ---------- */

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 用 MediaRecorder 對一條 stream 試錄 ms 毫秒，回傳 Blob（留在記憶體，很小） */
export function trialRecord(stream, ms, mimeType, bps) {
  return new Promise((resolve, reject) => {
    let rec;
    try {
      const opts = { mimeType };
      if (bps && bps.video) opts.videoBitsPerSecond = bps.video;
      if (bps && bps.audio) opts.audioBitsPerSecond = bps.audio;
      rec = new MediaRecorder(stream, opts);
    } catch (e) { reject(e); return; }

    const parts = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.onerror = (e) => reject(new Error('試錄失敗：' + ((e.error && e.error.name) || e)));
    rec.onstop = () => resolve(new Blob(parts, { type: mimeType || 'video/webm' }));
    rec.start(250);
    setTimeout(() => { try { rec.stop(); } catch (e) { reject(e); } }, ms);
  });
}

/** 解碼音訊並統計：峰值、RMS、靜音比例、最長連續靜音 */
export async function decodeAudioStats(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const win = Math.max(1, Math.floor(sr * 0.05)); // 50ms 一格
    const SILENCE = 0.004;                          // 約 -48 dBFS
    let peak = 0, sumsq = 0, silentWins = 0, totalWins = 0;
    let curSilent = 0, maxSilent = 0;

    for (let i = 0; i < ch.length; i += win) {
      let s = 0, p = 0;
      const end = Math.min(ch.length, i + win);
      for (let j = i; j < end; j++) {
        const v = ch[j];
        s += v * v;
        const a = Math.abs(v);
        if (a > p) p = a;
      }
      const n = end - i;
      const rms = Math.sqrt(s / n);
      sumsq += s;
      if (p > peak) peak = p;
      totalWins++;
      if (rms < SILENCE) { curSilent += n / sr; if (curSilent > maxSilent) maxSilent = curSilent; silentWins++; }
      else curSilent = 0;
    }
    return {
      ok: true,
      duration: buf.duration,
      sampleRate: sr,
      channels: buf.numberOfChannels,
      peak,
      rms: Math.sqrt(sumsq / ch.length),
      silenceRatio: totalWins ? silentWins / totalWins : 1,
      longestSilence: maxSilent,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { ctx.close(); } catch (e) {}
  }
}

/** 讀出影片長度。MediaRecorder 產出的 webm 常常 duration = Infinity，要用 seek 逼它算出來 */
export function probeVideoMeta(fileOrBlob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(fileOrBlob);
    const v = document.createElement('video');
    let settled = false;
    const finish = (res) => {
      if (settled) return; settled = true;
      URL.revokeObjectURL(url);
      try { v.src = ''; v.remove(); } catch (e) {}
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '讀取影片中繼資料逾時（檔案可能損毀或不完整）' }), 15000);

    v.preload = 'metadata';
    v.muted = true;
    v.onerror = () => { clearTimeout(timer); finish({ ok: false, error: '瀏覽器無法解碼這個檔案' }); };
    v.onloadedmetadata = () => {
      const w = v.videoWidth, h = v.videoHeight;
      if (v.duration === Infinity || isNaN(v.duration)) {
        v.currentTime = 1e101; // 逼 Chrome 掃到檔尾算出真實長度
        v.ontimeupdate = () => {
          v.ontimeupdate = null;
          clearTimeout(timer);
          finish({ ok: true, duration: v.duration, width: w, height: h, hasVideo: w > 0 });
        };
      } else {
        clearTimeout(timer);
        finish({ ok: true, duration: v.duration, width: w, height: h, hasVideo: w > 0 });
      }
    };
    v.src = url;
  });
}

/** 從喇叭放一個測試音，用來驗證「系統音回路」真的有進錄音（不靠會議剛好在講話） */
export async function playTestTone(ms = 1500, freq = 660) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.05);
  o.connect(g); g.connect(ctx.destination);
  o.start();
  await sleep(ms);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
  await sleep(120);
  o.stop();
  try { await ctx.close(); } catch (e) {}
}

/** 在一段時間內持續取樣某個音源，回傳峰值 */
export async function sampleLevel(mix, key, ms) {
  const t0 = performance.now();
  let peak = 0;
  while (performance.now() - t0 < ms) {
    const l = mix.level(key);
    if (l !== null && l > peak) peak = l;
    await sleep(40);
  }
  return peak;
}

/* ---------- 錄製中的深度健檢 ---------- */

/**
 * 對「正在用的音訊混合流」再開一個 1.2 秒的臨時錄音，解碼確認：
 *   - 編碼器還吐得出可解碼的資料
 *   - 裡面真的有波形（不是在錄一片數位靜音）
 * 回傳 {ok, reason, stats}
 */
export async function deepCheck(mixStream, audioMime) {
  try {
    const blob = await trialRecord(mixStream, 1200, audioMime, { audio: 96000 });
    if (!blob || blob.size < 500) return { ok: false, reason: '編碼器沒有產出資料', stats: null };
    const st = await decodeAudioStats(blob);
    if (!st.ok) return { ok: false, reason: '產出的資料解碼失敗：' + st.error, stats: null };
    return { ok: true, reason: '', stats: st };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), stats: null };
  }
}

/* ---------- 錄完後的驗證 ---------- */

/**
 * @param videoFile 主影片檔（File/Blob）
 * @param audioFile 備份音訊檔（File/Blob，可為 null）
 * @param expected  {seconds, frames} 錄製過程記錄到的實際狀況
 */
export async function verifyFile(videoFile, audioFile, expected) {
  const out = { items: [], pass: true, warn: false };
  const add = (level, name, detail) => {
    out.items.push({ level, name, detail });
    if (level === 'fail') out.pass = false;
    if (level === 'warn') out.warn = true;
  };

  // 1. 檔案大小
  if (!videoFile || videoFile.size < 10000) {
    add('fail', '影片檔大小', `只有 ${videoFile ? videoFile.size : 0} bytes —— 等於沒錄到`);
  } else {
    const mbPerMin = expected.seconds > 0 ? (videoFile.size / 1048576) / (expected.seconds / 60) : 0;
    add('pass', '影片檔大小', `${(videoFile.size / 1048576).toFixed(1)} MB（平均每分鐘 ${mbPerMin.toFixed(1)} MB）`);
  }

  // 2. 可解碼 + 長度 + 有畫面
  const meta = await probeVideoMeta(videoFile);
  if (!meta.ok) {
    add('fail', '影片可播放性', meta.error);
  } else {
    if (!meta.hasVideo) add('fail', '影像軌', '檔案裡沒有影像（寬高為 0）');
    else add('pass', '影像軌', `${meta.width}×${meta.height}`);

    const drift = Math.abs(meta.duration - expected.seconds);
    if (meta.duration < 1) {
      add('fail', '影片長度', `讀到 ${meta.duration.toFixed(1)} 秒，實際錄了 ${expected.seconds.toFixed(0)} 秒`);
    } else if (drift > Math.max(5, expected.seconds * 0.05)) {
      add('warn', '影片長度', `檔案 ${meta.duration.toFixed(0)} 秒 vs 實際錄製 ${expected.seconds.toFixed(0)} 秒，差 ${drift.toFixed(0)} 秒（多半是 webm 長度標記不準，用播放器拉到最後確認一下）`);
    } else {
      add('pass', '影片長度', `${fmtDur(meta.duration)}`);
    }
  }

  // 3. 聲音（用備份音訊檔驗，純音訊檔解碼最可靠）
  //
  // ⚠ 這裡不可以設「檔案要夠大才驗」的門檻：Opus 會把數位靜音壓到只剩幾百 bytes，
  //   設門檻等於在「真的沒錄到聲音」的時候自動跳過檢查。反過來，檔案異常小本身
  //   就是沒聲音的證據，所以拿它當第二條線索。
  if (audioFile && audioFile.size > 0) {
    const expectedBytes = (96000 / 8) * Math.max(1, expected.seconds); // 96kbps 的名目資料量
    const ratio = audioFile.size / expectedBytes;
    const st = await decodeAudioStats(audioFile);

    if (!st.ok) {
      if (ratio < 0.03) {
        add('fail', '聲音內容',
          `備份音訊只有 ${audioFile.size} bytes（依錄製長度預期約 ${(expectedBytes / 1024).toFixed(0)} KB）而且解不開 —— 幾乎確定整段沒有聲音`);
      } else {
        add('warn', '聲音內容', '備份音訊解碼失敗：' + st.error);
      }
    } else {
      if (st.peak < 0.005) {
        add('fail', '聲音內容',
          `整段幾乎是數位靜音（峰值 ${st.peak < 1e-6 ? st.peak.toExponential(1) : st.peak.toFixed(5)}）—— 這就是「錄到畫面沒錄到聲音」`);
      } else {
        add('pass', '聲音內容', `峰值 ${st.peak.toFixed(3)}、平均 ${st.rms.toFixed(4)}`);
      }
      const pct = (st.silenceRatio * 100);
      if (pct > 85) add('warn', '靜音佔比', `${pct.toFixed(0)}%（大半時間沒聲音，確認是不是抓錯音源）`);
      else add('pass', '靜音佔比', `${pct.toFixed(0)}%`);
      if (st.longestSilence > 120) add('warn', '最長連續靜音', `${fmtDur(st.longestSilence)}（中間可能斷過）`);
      else add('pass', '最長連續靜音', fmtDur(st.longestSilence));
      add('pass', '音訊長度', fmtDur(st.duration));
    }

    // 資料量對照：解碼成功與否都報，當作獨立的第二條線索
    const pctTxt = `${(audioFile.size / 1024).toFixed(0)} KB，約為名目碼率的 ${(ratio * 100).toFixed(0)}%`;
    if (ratio < 0.03) add('fail', '音訊資料量', pctTxt + ' —— 小到不合理，等於整段沒有聲音');
    else if (ratio < 0.15) add('warn', '音訊資料量', pctTxt + '（偏低，可能大半時間是靜音）');
    else add('pass', '音訊資料量', pctTxt);
  } else {
    add('warn', '聲音內容', '沒有備份音訊檔可驗（主影片的聲音請自己播放確認）');
  }

  // 4. 畫格
  if (expected.frames != null) {
    const fps = expected.seconds > 0 ? expected.frames / expected.seconds : 0;
    if (fps < 1) add('fail', '畫面更新', `全程平均只有 ${fps.toFixed(2)} fps —— 畫面幾乎沒在更新`);
    else add('pass', '畫面更新', `全程 ${expected.frames} 張畫格，平均 ${fps.toFixed(1)} fps`);
  }

  return out;
}

export function fmtDur(sec) {
  if (!isFinite(sec) || sec < 0) return '未知';
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
