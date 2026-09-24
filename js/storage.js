/*
 * storage.js —— 落地層
 *
 * 三件事：
 *   1. DurableWriter：把 MediaRecorder 的 chunk 即時、持久地寫進 OPFS（透過 worker）
 *   2. 救援：列出／讀取／刪除 OPFS 裡上次沒收好的檔
 *   3. 匯出：把 OPFS 檔用串流寫進使用者選的資料夾（不吃記憶體）
 */

let workerPromise = null;
let rid = 0;
const pending = new Map();

function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker('./js/opfs-worker.js', { type: 'module' });
    } catch (e) {
      reject(e); return;
    }
    w.onmessage = (ev) => {
      const { rid: id } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ev.data.ok) p.resolve(ev.data);
      else p.reject(new Error(ev.data.error || '未知的寫檔錯誤'));
    };
    w.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error('寫檔 worker 崩潰：' + e.message));
      pending.clear();
    };
    resolve(w);
  });
  return workerPromise;
}

async function call(msg, transfer) {
  const w = await getWorker();
  const id = ++rid;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, rid: id }, transfer || []);
  });
}

/**
 * 環境是否支援「當機不掉檔」的持久寫入。
 *
 * 注意：不能用 'createSyncAccessHandle' in FileSystemFileHandle.prototype 判斷 ——
 * 那個方法只掛在 Worker 的 scope 裡，主執行緒查永遠是 false，會誤判成不支援。
 * 所以這裡直接開一個測試檔、寫 1KB、讀回來比對，用實測結果當答案。
 */
let durableOKCache = null;
export function supportsDurableWrite() { return durableOKCache === true; }

export async function probeDurableWrite() {
  if (durableOKCache !== null) return durableOKCache;
  const name = '.__能力測試.tmp';
  try {
    if (!(navigator.storage && navigator.storage.getDirectory)) throw new Error('沒有 OPFS');
    const w = new DurableWriter(name);
    await w.open();
    await w.write(new Blob([new Uint8Array(1024)]));
    const bytes = await w.close();
    const f = await readStored(name);
    const okSize = f.size === 1024 && bytes === 1024;
    await deleteStored(name);
    durableOKCache = okSize;
    if (!okSize) console.warn('持久寫檔測試大小不符', f.size, bytes);
  } catch (e) {
    console.warn('持久寫檔測試失敗：', e);
    durableOKCache = false;
    try { await deleteStored(name); } catch (e2) {}
  }
  return durableOKCache;
}

let writerSeq = 0;

export class DurableWriter {
  constructor(name) {
    this.id = 'w' + (++writerSeq);
    this.name = name;
    this.bytesOnDisk = 0;   // 已確認寫進磁碟的位元組（不是「已產生」）
    this.queued = 0;        // 排隊中、還沒確認落地的位元組
    this.chain = Promise.resolve();
    this.failed = null;
    this.closed = false;
  }

  async open() {
    await call({ type: 'open', id: this.id, name: this.name });
    return this;
  }

  /**
   * 丟一塊資料去寫。回傳的 promise resolve 代表「這塊已經真的在磁碟上」。
   * 內部的 chain 刻意永不 reject —— 某一塊寫失敗不能連累後面的塊，
   * 否則一次暫時性錯誤會讓剩下整場都不再落地（而且畫面上還一片正常）。
   */
  write(blob) {
    let done, fail;
    const outer = new Promise((res, rej) => { done = res; fail = rej; });
    this.queued += blob.size;
    this.chain = this.chain.then(async () => {
      if (this.closed) { done(); return; }
      try {
        const buf = await blob.arrayBuffer();
        const res = await call({ type: 'write', id: this.id, buf }, [buf]);
        this.bytesOnDisk = res.bytesOnDisk;
        done();
      } catch (err) {
        this.failed = err;
        fail(err);
      } finally {
        this.queued = Math.max(0, this.queued - blob.size);
      }
    });
    return outer;
  }

  async close() {
    try { await this.chain; } catch (e) { /* 錯誤已記在 this.failed */ }
    this.closed = true;
    const res = await call({ type: 'close', id: this.id });
    this.bytesOnDisk = res.bytesOnDisk || this.bytesOnDisk;
    return this.bytesOnDisk;
  }

  /** 收檔後把內容拿回來（驗證與匯出都走這裡） */
  async getFile() { return readStored(this.name); }
}

/**
 * 退路：環境不給持久寫檔時（例如頁面被包在沙箱 iframe 裡、Worker 或 OPFS 被擋），
 * 改成把 chunk 留在記憶體。功能一樣，但「當機不掉檔」這個保證會失效 ——
 * 所以介面上必須明講，不能讓使用者以為還有那層保險。
 */
export class MemoryWriter {
  constructor(name) {
    this.name = name;
    this.parts = [];
    this.bytesOnDisk = 0;   // 這裡其實是「已收下的位元組」，不是磁碟
    this.durable = false;
    this.failed = null;
    this.closed = false;
  }
  async open() { return this; }
  write(blob) { this.parts.push(blob); this.bytesOnDisk += blob.size; return Promise.resolve(); }
  async close() { this.closed = true; return this.bytesOnDisk; }
  async getFile() { return new File(this.parts, this.name, { type: this.parts[0] ? this.parts[0].type : 'video/webm' }); }
}

/** 依環境挑一個寫檔器 */
export async function makeWriter(name) {
  if (supportsDurableWrite()) {
    const w = new DurableWriter(name);
    try { await w.open(); w.durable = true; return w; }
    catch (e) { console.warn('持久寫檔開檔失敗，改用記憶體：', e); }
  }
  const m = new MemoryWriter(name);
  await m.open();
  return m;
}

/* ---------- 救援／讀取（主執行緒的 OPFS API，較單純） ---------- */

async function recDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('recordings', { create: true });
}

export async function listStored() {
  const dir = await recDir();
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    try {
      const f = await handle.getFile();
      out.push({ name, size: f.size, lastModified: f.lastModified });
    } catch (e) { /* 正在寫的檔會被鎖住，跳過 */ }
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}

export async function readStored(name) {
  const dir = await recDir();
  const fh = await dir.getFileHandle(name);
  return fh.getFile();
}

export async function deleteStored(name) {
  const dir = await recDir();
  await dir.removeEntry(name);
}

/* ---------- 記住使用者選的資料夾 ----------
 *
 * FileSystemDirectoryHandle 可以直接存進 IndexedDB（localStorage 不行，
 * 它只能存字串）。下次打開拿回來的 handle 本身是有效的，
 * 但權限可能退回 'prompt' —— 那就要使用者點一下才能再授權，
 * 這是瀏覽器的規定，繞不過去。所以介面上要把這一點變成
 * 「繼續用「XXX」」一顆按鈕，而不是再跑一次選檔視窗。
 */

const IDB_NAME = 'meetingRecorder';
const IDB_STORE = 'handles';
const DIR_KEY = 'outputDir';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbOp(mode, fn) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const out = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export async function rememberDir(handle) {
  try { await idbOp('readwrite', (st) => st.put(handle, DIR_KEY)); return true; }
  catch (e) { console.warn('記不住資料夾：', e); return false; }
}

export async function recallDir() {
  try { return (await idbOp('readonly', (st) => st.get(DIR_KEY))) || null; }
  catch (e) { return null; }
}

export async function forgetDir() {
  try { await idbOp('readwrite', (st) => st.delete(DIR_KEY)); } catch (e) {}
}

/**
 * 查（或要）資料夾的寫入權限。
 * request=true 必須在使用者的點擊事件裡呼叫，否則瀏覽器會拒絕。
 * 回傳 'granted' | 'prompt' | 'denied'。
 */
export async function dirPermission(handle, request) {
  if (!handle) return 'denied';
  const opts = { mode: 'readwrite' };
  try {
    let p = handle.queryPermission ? await handle.queryPermission(opts) : 'granted';
    if (p !== 'granted' && request && handle.requestPermission) p = await handle.requestPermission(opts);
    return p;
  } catch (e) {
    return 'denied';
  }
}

/* ---------- 匯出到使用者的資料夾 ---------- */

export function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function';
}

export async function pickOutputDir() {
  const dir = await window.showDirectoryPicker({ id: 'meeting-rec-out', mode: 'readwrite', startIn: 'videos' });
  return dir;
}

/** 開錄前就證明「這個資料夾真的寫得進去」，不要等錄完才發現不能寫 */
export async function probeDirWritable(dirHandle) {
  const probeName = '.__錄影工具寫入測試.tmp';
  const fh = await dirHandle.getFileHandle(probeName, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([new Uint8Array(1024)]));
  await w.close();
  const size = (await fh.getFile()).size;
  await dirHandle.removeEntry(probeName);
  if (size !== 1024) throw new Error('寫入測試檔大小不符（' + size + ' bytes）');
  return true;
}

/** 串流複製：OPFS 檔 → 使用者資料夾。2GB 影片也不會爆記憶體。 */
export async function exportToDir(dirHandle, opfsName, targetName, onProgress) {
  return exportFileToDir(dirHandle, await readStored(opfsName), targetName, onProgress);
}

/** 串流複製：任一個 File/Blob → 使用者資料夾 */
export async function exportFileToDir(dirHandle, file, targetName, onProgress) {
  const fh = await dirHandle.getFileHandle(targetName, { create: true });
  const writable = await fh.createWritable();
  const reader = file.stream().getReader();
  let done = 0;
  for (;;) {
    const { value, done: fin } = await reader.read();
    if (fin) break;
    await writable.write(value);
    done += value.byteLength;
    if (onProgress) onProgress(done, file.size);
  }
  await writable.close();
  return { name: targetName, size: file.size };
}

export async function writeTextToDir(dirHandle, targetName, text) {
  const fh = await dirHandle.getFileHandle(targetName, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  await w.close();
}

/** 沒有 showDirectoryPicker（例如 Firefox）時的退路 */
export async function downloadStored(opfsName, targetName) {
  return downloadFile(await readStored(opfsName), targetName);
}

export function downloadFile(file, targetName) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = targetName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function downloadText(targetName, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = targetName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------- 空間 ---------- */

export async function estimateSpace() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { quota, usage } = await navigator.storage.estimate();
  return { quota: quota || 0, usage: usage || 0, free: (quota || 0) - (usage || 0) };
}

export async function requestPersistent() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch (e) { return false; }
  }
  return false;
}
