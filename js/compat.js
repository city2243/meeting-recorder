/*
 * compat.js —— 這個瀏覽器能不能錄？不能的話，頁面要好好告訴使用者，不能壞掉
 *
 * 2026-10-02 使用者要求「每個瀏覽器都可以操作這個網頁」。實際限制在瀏覽器本身：
 *   - Chrome／Edge／Brave／Opera／Vivaldi／Arc（Chromium 核心）：畫面＋分頁聲音＋系統聲音都能抓
 *   - Firefox、Safari：能抓畫面，但不開放網頁抓分頁或系統的聲音（任何網站都一樣）
 *   - 手機、平板：瀏覽器沒有螢幕擷取功能
 * 所以做法是：偵測出來 → 頁面最上方講清楚哪裡不行、該換什麼瀏覽器、一鍵複製網址；
 * 缺少的功能不要讓程式直接崩掉（曾經在缺 AudioContext 的環境整個多場頁空白）。
 */

export function detect() {
  const ua = navigator.userAgent || '';
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand);
  const md = navigator.mediaDevices;
  const chromium = brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b)) || (/Chrome\/\d+/.test(ua) && !/Firefox\//.test(ua));
  const firefox = /Firefox\//.test(ua);
  const safari = !chromium && !firefox && /Safari\//.test(ua) && /Apple/.test(navigator.vendor || '');
  const mobile = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);   // iPadOS 會假裝成 Mac
  const mac = /Macintosh|Mac OS X/.test(ua) && !mobile;
  const has = {
    capture: !!(md && md.getDisplayMedia),
    recorder: typeof window.MediaRecorder === 'function',
    audio: !!(window.AudioContext || window.webkitAudioContext),
  };
  const name = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : firefox ? 'Firefox' : safari ? 'Safari' : chromium ? 'Chrome' : '這個瀏覽器';
  let level = 'ok';
  if (mobile || !has.capture || !has.recorder || !has.audio) level = 'none';      // 根本錄不了
  else if (!chromium) level = 'noaudio';                                          // 錄得到畫面、錄不到會議聲音
  return { chromium, firefox, safari, mobile, mac, has, name, level };
}

/**
 * 在頁面最上方放說明。回傳偵測結果，呼叫端用 .level 決定要不要繼續初始化錄影功能。
 * @param {string} page 'single' | 'multi'
 */
export function mountNotice(page) {
  const d = detect();
  if (d.level === 'ok' && !(d.mac && page === 'single')) return d;

  const box = document.createElement('section');
  box.className = 'panel compat ' + (d.level === 'ok' ? 'soft' : 'bad');
  box.setAttribute('role', d.level === 'ok' ? 'note' : 'alert');
  let title, body = [];
  const sp = /^[A-Za-z]/.test(d.name) ? ' ' : '';   // 英文瀏覽器名後面空一格
  if (d.level === 'none' && d.mobile) {
    title = '手機和平板不能用這個網頁錄影';
    body = ['手機與平板上的瀏覽器（不論 Safari、Chrome 或其他）都沒有開放網頁擷取螢幕和聲音，這是系統的限制，不是網頁壞掉。', '請用電腦打開這個網址，瀏覽器用 Chrome 或 Edge。'];
  } else if (d.level === 'none') {
    title = `${d.name}${sp}缺少錄影需要的功能`;
    body = ['這個瀏覽器沒有提供螢幕擷取或錄影的功能。', '請改用電腦上的 Chrome 或 Edge 打開這個網址（Brave、Opera、Vivaldi、Arc 也可以）。'];
  } else if (d.level === 'noaudio') {
    title = `${d.name}${sp}錄不到會議的聲音`;
    body = ['這個瀏覽器不開放網頁抓取分頁或電腦的聲音（任何網站都一樣，不是這個網頁的問題）。',
      '要錄會議，請改用 Chrome 或 Edge 打開這個網址（Brave、Opera、Vivaldi、Arc 也可以）。'];
    if (page === 'multi') body.push('同時錄多場一定要分頁聲音，這個瀏覽器無法使用。');
  } else {
    title = 'Mac 上錄「整個螢幕」可能抓不到系統聲音';
    body = ['在 Mac 上，網頁版會議（Zoom、Webex、Meet、Teams 的網頁版）請把「要錄什麼」選成「瀏覽器裡的會議」，抓分頁的聲音最穩。', '桌面版會議軟體在 Mac 上不一定錄得到聲音，開錄前檢查會告訴你。'];
  }
  box.innerHTML = '<div class="compat-row"><div class="compat-ic"></div><div class="compat-txt"><h2></h2><p></p></div></div>';
  box.querySelector('.compat-ic').textContent = d.level === 'ok' ? '!' : '✕';
  box.querySelector('h2').textContent = title;
  // 每一句放在自己的 span：英文模式是逐段翻，整段拼起來的句子會對不上翻譯表
  for (const t of body) { const sp = document.createElement('span'); sp.textContent = t + ' '; box.querySelector('p').appendChild(sp); }
  if (d.level !== 'ok') {
    const row = document.createElement('div');
    row.className = 'row compat-act';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn accent'; b.textContent = '複製這個網址';
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); b.textContent = '已複製，到 Chrome 或 Edge 貼上'; }
      catch (e) { prompt('複製這個網址，到 Chrome 或 Edge 貼上：', location.href); }
    };
    row.appendChild(b);
    box.querySelector('.compat-txt').appendChild(row);
  }
  const main = document.querySelector('main') || document.body;
  main.insertBefore(box, main.firstChild);
  return d;
}
