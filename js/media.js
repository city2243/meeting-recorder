/*
 * media.js —— 取得畫面／麥克風、混音、即時量測
 *
 * 量測是重點：不是「有沒有 track」，而是「這一秒真的有畫面更新、真的有聲音能量」。
 * track 存在但全黑／全靜音，是最陰險的失敗模式。
 */

export const QUALITY = {
  '720p15':  { width: 1280, height: 720,  frameRate: 15, videoBitsPerSecond: 1_200_000, label: '720p / 15fps（最省，文字仍清楚）' },
  '1080p15': { width: 1920, height: 1080, frameRate: 15, videoBitsPerSecond: 2_500_000, label: '1080p / 15fps（推薦：簡報會議）' },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 4_000_000, label: '1080p / 30fps（有動畫或影片時）' },
  'native30':{ width: 0,    height: 0,    frameRate: 30, videoBitsPerSecond: 6_000_000, label: '原生解析度 / 30fps（檔案最大）' },
};

export function pickVideoMime() {
  const cands = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

export function pickAudioMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

/**
 * 取得畫面來源。使用者會看到 Chrome 的分享選單。
 * @param surface 'monitor'（整個畫面，抓系統混音）或 'browser'（單一分頁，只抓那個分頁的聲音）
 *
 * 多場同時錄一定要用 'browser'：系統音是整台電腦的混音，多場會混在一起分不開。
 */
export async function getScreen(qualityKey, surface, opts) {
  const q = QUALITY[qualityKey] || QUALITY['1080p15'];
  const video = { frameRate: { ideal: q.frameRate, max: q.frameRate }, displaySurface: surface || 'monitor' };
  if (q.width) { video.width = { ideal: q.width }; video.height = { ideal: q.height }; }

  const audio = {
    // 會議聲音要原汁原味，不要被當成「麥克風」處理掉
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
  };
  // 錄分頁但不要從這台電腦的喇叭放出來。
  // 用途：電腦在旁邊靜靜地錄，你用手機開會 —— 不這樣做會互相回授。
  if (opts && opts.silent) audio.suppressLocalAudioPlayback = true;

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video,
    audio,
    // 提示瀏覽器預設選「整個螢幕」——Zoom/Webex 是桌面 App，只有整螢幕抓得到系統音
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  });
  return stream;
}

export async function listMics() {
  // 沒授權過的話 label 會是空的；先要一次權限再列，名稱才看得懂
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (e) { /* 使用者可能拒絕，照樣列（label 會是空的） */ }
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter((d) => d.kind === 'audioinput');
}

export async function getMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

/* ---------------- 混音 ---------------- */

export class AudioMix {
  /** @param sharedCtx 多場同時錄時共用一個 AudioContext，不要每場開一個 */
  constructor(sharedCtx) {
    this.ownsCtx = !sharedCtx;
    this.ctx = sharedCtx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'playback' });
    this.dest = this.ctx.createMediaStreamDestination();
    this.sources = {}; // key -> {node, gain, analyser, buf}
  }

  /** 加一路音源。key 用 'sys' / 'mic'。 */
  addTrack(key, track, gainValue = 1.0) {
    if (!track) return null;
    // 同一個 key 重新接上時（例如中途重選畫面），要先把舊的斷開，否則舊音源會留在混音裡
    const old = this.sources[key];
    if (old) { try { old.node.disconnect(); old.gain.disconnect(); old.analyser.disconnect(); } catch (e) {} }
    const stream = new MediaStream([track]);
    const node = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = gainValue;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;

    node.connect(gain);
    gain.connect(analyser);      // 量測點在增益之後 = 量到的就是進錄音的東西
    gain.connect(this.dest);

    this.sources[key] = { node, gain, analyser, buf: new Float32Array(analyser.fftSize), peak: 0 };
    return this.sources[key];
  }

  setGain(key, v) { if (this.sources[key]) this.sources[key].gain.gain.value = v; }

  /** 原始 RMS（0~1）。錄音世界的單位是 dBFS，換算交給呼叫端。 */
  levelRaw(key) {
    const s = this.sources[key];
    if (!s) return null;
    s.analyser.getFloatTimeDomainData(s.buf);
    let sum = 0;
    for (let i = 0; i < s.buf.length; i++) sum += s.buf[i] * s.buf[i];
    return Math.sqrt(sum / s.buf.length);
  }

  /** 給儀表條用的 0~1 值（放大過，視覺上好判讀） */
  level(key) {
    const r = this.levelRaw(key);
    return r === null ? null : Math.min(1, r * 3);
  }

  get stream() { return this.dest.stream; }
  get audioTrack() { return this.dest.stream.getAudioTracks()[0]; }

  async resume() { if (this.ctx.state === 'suspended') await this.ctx.resume(); }

  close() {
    for (const k of Object.keys(this.sources)) {
      const s = this.sources[k];
      try { s.node.disconnect(); s.gain.disconnect(); s.analyser.disconnect(); } catch (e) {}
    }
    this.sources = {};
    try { this.dest.disconnect(); } catch (e) {}
    if (this.ownsCtx) { try { this.ctx.close(); } catch (e) {} }
  }
}

/* ---------------- 畫面更新量測 ---------------- */

/**
 * 數「畫面真的送出了幾張畫格」。
 *
 * ⚠ 這裡踩過一個大坑：原本用 requestVideoFrameCallback，結果分頁被蓋住
 *   （＝使用者全螢幕在看 Zoom 的那個當下）它完全不會觸發，watchdog 會整場誤報
 *   「畫面停止更新」。實測：分頁 hidden 時 rVFC = 0 張，而下面兩個方法照常計數。
 *
 * 所以改用兩個彼此獨立、都不依賴畫面繪製的感測器：
 *   A. MediaStreamTrackProcessor —— 直接從 track 讀出 VideoFrame，純資料管線
 *   B. <video> 的 getVideoPlaybackQuality().totalVideoFrames —— 收到幾張就算幾張
 * 只要任一個有進展就判定「畫面活著」，避免單一感測器安靜就誤報。
 */
export class VideoWatch {
  constructor(track) {
    this.track = track;
    this._a = 0;              // MediaStreamTrackProcessor 的計數
    this._b = 0;              // video element 的計數
    this._lastA = performance.now();
    this._lastB = performance.now();
    this._stopped = false;

    // --- 感測器 A ---
    this._clone = null; this._reader = null;
    if (typeof window.MediaStreamTrackProcessor !== 'undefined') {
      try {
        this._clone = track.clone();
        const proc = new MediaStreamTrackProcessor({ track: this._clone });
        this._reader = proc.readable.getReader();
        (async () => {
          for (;;) {
            let r;
            try { r = await this._reader.read(); } catch (e) { break; }
            if (r.done || this._stopped) { if (r.value) r.value.close(); break; }
            this._a++;
            this._lastA = performance.now();
            r.value.close();
          }
        })();
      } catch (e) { this._clone = null; this._reader = null; }
    }

    // --- 感測器 B ---
    this.el = document.createElement('video');
    this.el.muted = true;
    this.el.playsInline = true;
    this.el.srcObject = new MediaStream([track]);
    this.el.style.cssText = 'position:fixed;left:-10000px;top:0;width:160px;height:90px;opacity:0;';
    document.body.appendChild(this.el);
    this.el.play().catch(() => {});
    this._lastTime = -1;
    this._timer = setInterval(() => this.poll(), 250);
  }

  /** 取樣感測器 B。外部（watchdog）也會呼叫，因為這個計時器在背景分頁會被節流。 */
  poll() {
    if (this._stopped) return;
    let n = this._b;
    if (this.el.getVideoPlaybackQuality) {
      const q = this.el.getVideoPlaybackQuality();
      if (q && q.totalVideoFrames > n) n = q.totalVideoFrames;
    }
    if (this.el.currentTime !== this._lastTime) { this._lastTime = this.el.currentTime; n = Math.max(n, this._b + 1); }
    if (n > this._b) { this._b = n; this._lastB = performance.now(); }
  }

  /** 累計畫格數（取兩個感測器的較大值） */
  get frames() { return Math.max(this._a, this._b); }

  /** 距離「上一次任一感測器看到新畫格」幾秒 */
  get staleSeconds() {
    return (performance.now() - Math.max(this._lastA, this._lastB)) / 1000;
  }

  /** 哪些感測器有在動，出問題時要寫進紀錄 */
  get sensorInfo() { return `A=${this._a} B=${this._b}`; }

  get settings() { try { return this.track.getSettings() || {}; } catch (e) { return {}; } }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    try { if (this._reader) this._reader.cancel(); } catch (e) {}
    try { if (this._clone) this._clone.stop(); } catch (e) {}
    try { this.el.pause(); this.el.srcObject = null; this.el.remove(); } catch (e) {}
  }
}

/* ---------------- 提醒音 ---------------- */

let alarmCtx = null;
export function beep(times = 3, freq = 880) {
  try {
    alarmCtx = alarmCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (alarmCtx.state === 'suspended') alarmCtx.resume();
    for (let i = 0; i < times; i++) {
      const t = alarmCtx.currentTime + i * 0.28;
      const o = alarmCtx.createOscillator();
      const g = alarmCtx.createGain();
      o.frequency.value = freq;
      o.type = 'square';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g); g.connect(alarmCtx.destination);
      o.start(t); o.stop(t + 0.22);
    }
  } catch (e) { /* 沒聲音就算了，畫面警示還在 */ }
}
