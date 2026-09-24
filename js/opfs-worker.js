/*
 * OPFS 持久寫檔 worker
 *
 * 為什麼要有這支：MediaRecorder 吐出來的 chunk 如果只留在記憶體(或用
 * showSaveFilePicker 的 createWritable)，瀏覽器崩潰／當機／斷電時會整個沒了
 * ——createWritable 是寫到暫存檔、close() 才 commit。
 *
 * 這支改用 OPFS 的 createSyncAccessHandle()：每個 chunk 立刻寫進磁碟並 flush，
 * 不等 close。就算整台電腦當掉，下次打開網頁還救得回來(app.js 的「救援」區)。
 *
 * 一個 worker 可以同時持有多個檔案 handle，用 id 區分(主影片、備份音訊、分段…)。
 */

const handles = new Map(); // id -> { access, offset, name }

async function ensureDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('recordings', { create: true });
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  const reply = (extra) => self.postMessage({ rid: msg.rid, id: msg.id, ...extra });

  try {
    switch (msg.type) {
      case 'open': {
        const dir = await ensureDir();
        const fh = await dir.getFileHandle(msg.name, { create: true });
        const access = await fh.createSyncAccessHandle();
        access.truncate(0);
        handles.set(msg.id, { access, offset: 0, name: msg.name });
        reply({ ok: true, name: msg.name });
        break;
      }

      case 'write': {
        const h = handles.get(msg.id);
        if (!h) throw new Error('檔案尚未開啟 (id=' + msg.id + ')');
        const bytes = new Uint8Array(msg.buf);
        h.access.write(bytes, { at: h.offset });
        h.offset += bytes.byteLength;
        // 每塊都 flush：慢一點點，但這是「當機不掉檔」的代價，值得。
        h.access.flush();
        reply({ ok: true, bytesOnDisk: h.offset });
        break;
      }

      case 'close': {
        const h = handles.get(msg.id);
        if (!h) { reply({ ok: true, bytesOnDisk: 0 }); break; }
        try { h.access.flush(); } catch (e) { /* 已關就算了 */ }
        h.access.close();
        handles.delete(msg.id);
        reply({ ok: true, bytesOnDisk: h.offset, name: h.name });
        break;
      }

      case 'list': {
        const dir = await ensureDir();
        const out = [];
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind !== 'file') continue;
          const f = await handle.getFile();
          out.push({ name, size: f.size, lastModified: f.lastModified });
        }
        reply({ ok: true, files: out });
        break;
      }

      case 'delete': {
        const dir = await ensureDir();
        await dir.removeEntry(msg.name);
        reply({ ok: true });
        break;
      }

      default:
        throw new Error('未知指令: ' + msg.type);
    }
  } catch (err) {
    reply({ ok: false, error: String((err && err.message) || err) });
  }
};
