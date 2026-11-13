/* 极简 IndexedDB 封装：只支持单键读写与遍历，够用即可。 */

const DB_NAME = 'zl';
const DB_VERSION = 1;
export const STORE_KV = 'kv';
export const STORE_ICONS = 'icons';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_ICONS)) db.createObjectStore(STORE_ICONS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
  return dbPromise;
}

function tx(store, mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        try {
          result = run(os);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export function idbGet(store, key) {
  return tx(store, 'readonly', (os) => ({ __req: os.get(key) }));
}

export function idbPut(store, key, value) {
  return tx(store, 'readwrite', (os) => os.put(value, key));
}

export function idbDel(store, key) {
  return tx(store, 'readwrite', (os) => os.delete(key));
}

export function idbClear(store) {
  return tx(store, 'readwrite', (os) => os.clear());
}

export function idbAll(store) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readonly');
        const os = t.objectStore(store);
        const out = [];
        const cursorReq = os.openCursor();
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (cur) {
            out.push({ key: cur.key, value: cur.value });
            cur.continue();
          } else {
            resolve(out);
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      })
  );
}
