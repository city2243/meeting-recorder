/*
 * recovery.js —— 瀏覽器本機暫存（OPFS）裡留下來的錄影檔：清單、另存、清除
 *
 * 錄影時資料每兩秒寫進 OPFS。當機、關頁、停電之後，檔案還在那裡，
 * 下次開頁時靠這裡把它們列出來救回去。
 *
 * 清單用的「這個暫存檔原本叫什麼名字」記在 localStorage 的 manifest，
 * 單場版（app.js）與多場版共用同一份格式，所以兩頁都看得到彼此的檔案名稱。
 */
import * as S from './storage.js';
import { t, fmtWhen } from './i18n.js';

const MAN_KEY = 'meetingRecorder.manifest';

export function readManifest() { try { return JSON.parse(localStorage.getItem(MAN_KEY) || '[]'); } catch (e) { return []; } }
export function writeManifest(m) { try { localStorage.setItem(MAN_KEY, JSON.stringify(m.slice(-60))); } catch (e) {} }

/** 開錄時登記：哪個暫存檔將來要存成什麼名字 */
export function registerFiles(sid, startedAt, files) {
  const man = readManifest();
  let entry = man.find((m) => m.sid === sid);
  if (!entry) { entry = { sid, startedAt, exported: false, files: [] }; man.push(entry); }
  for (const f of files) if (!entry.files.some((x) => x.opfs === f.opfs)) entry.files.push(f);
  writeManifest(man);
}

/** 匯出成功後標記（之後可以放心清掉暫存） */
export function markExported(sid) {
  const man = readManifest();
  const entry = man.find((m) => m.sid === sid);
  if (entry) { entry.exported = true; writeManifest(man); }
}

function lookup(opfsName) {
  for (const s of readManifest()) for (const f of s.files) if (f.opfs === opfsName) return { s, f };
  return null;
}

function fmtBytes(b) {
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

/**
 * 把暫存清單畫進 card/list。
 * @param {object} o { card, list, getDir: () => handle|null, pickDir: async () => void, skip: Set<opfsName> }
 *   skip：這一頁正在用的暫存檔（剛錄完、還在畫面上的），不要列成「上次留下來的」
 */
export async function renderRecovery(o) {
  if (!S.supportsDurableWrite()) { o.card.hidden = true; return; }
  let files = [];
  try { files = await S.listStored(); } catch (e) { o.card.hidden = true; return; }
  files = files.filter((f) => f.size > 0 && !(o.skip && o.skip.has(f.name)));
  if (!files.length) { o.card.hidden = true; return; }

  o.card.hidden = false;
  o.list.innerHTML = '';
  let exportedCount = 0;
  for (const f of files) {
    const info = lookup(f.name);
    const target = info ? info.f.target : f.name;
    const exported = !!(info && info.s.exported);
    if (exported) exportedCount++;
    const row = document.createElement('div');
    row.innerHTML = '<span class="fn"></span><span class="meta"></span>';
    row.querySelector('.fn').textContent = target;
    row.querySelector('.meta').textContent =
      fmtBytes(f.size) + ' · ' + fmtWhen(f.lastModified) + (exported ? ' · 已匯出過' : ' · 尚未匯出');

    const bSave = document.createElement('button');
    bSave.className = 'btn sm' + (exported ? '' : ' accent'); bSave.type = 'button';
    bSave.textContent = S.supportsDirectoryPicker() ? '另存到資料夾' : '下載';
    bSave.onclick = async () => {
      try {
        if (!S.supportsDirectoryPicker()) { await S.downloadStored(f.name, target); return; }
        if (!o.getDir()) await o.pickDir();
        const dir = o.getDir();
        if (!dir) return;
        bSave.disabled = true; bSave.textContent = '存檔中…';
        await S.exportToDir(dir, f.name, target);
        bSave.textContent = '已存檔 ✓';
      } catch (e) { bSave.disabled = false; bSave.textContent = '另存到資料夾'; alert(t('存檔失敗：') + e.message); }
    };
    const bDel = document.createElement('button');
    bDel.className = 'btn sm ghost'; bDel.type = 'button'; bDel.textContent = '刪除';
    bDel.onclick = async () => {
      if (!confirm(t('確定刪除「' + target + '」？刪掉就救不回來了。'))) return;
      try { await S.deleteStored(f.name); } catch (e) {}
      renderRecovery(o);
    };
    row.appendChild(bSave); row.appendChild(bDel);
    o.list.appendChild(row);
  }

  if (exportedCount) {
    const bClear = document.createElement('button');
    bClear.className = 'btn sm ghost'; bClear.type = 'button';
    bClear.textContent = `清除已匯出過的 ${exportedCount} 個暫存檔`;
    bClear.onclick = async () => {
      if (!confirm(t('只刪掉「已匯出過」的暫存副本，尚未匯出的會留著。請先確認資料夾裡的檔案可以正常播放。'))) return;
      for (const f of files) {
        const info = lookup(f.name);
        if (info && info.s.exported) { try { await S.deleteStored(f.name); } catch (e) {} }
      }
      renderRecovery(o);
    };
    const wrap = document.createElement('div');
    wrap.className = 'row';
    wrap.appendChild(bClear);
    o.list.appendChild(wrap);
  }
}
