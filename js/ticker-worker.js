/*
 * ticker-worker.js —— 不會被節流的心跳
 *
 * 為什麼要有這支：Chrome 會把「背景分頁」的 setInterval 節流，
 * 分頁被蓋住超過 5 分鐘後可能降到「每分鐘只跑一次」。
 * 而使用者錄會議時，這個分頁正是整場都被蓋在 Zoom 後面的那一個。
 * 監看程式如果靠主執行緒的 setInterval，會在最需要它的時候睡著。
 *
 * Worker 裡的計時器不受這套節流影響，所以由它發心跳、主執行緒收到才量測。
 */
let timer = null;
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'start') {
    if (timer) clearInterval(timer);
    timer = setInterval(() => self.postMessage({ t: Date.now() }), m.interval || 1000);
  } else if (m.type === 'stop') {
    if (timer) clearInterval(timer);
    timer = null;
  }
};
