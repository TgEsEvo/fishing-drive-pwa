// Local IndexedDB: cached copy of the Drive data, the offline edit queue, and photo blobs.

const DB_NAME = "fishing-drive";
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("kv");
        req.result.createObjectStore("blobs");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const kv = {
  get: (key) => run("kv", "readonly", (s) => s.get(key)),
  set: (key, value) => run("kv", "readwrite", (s) => s.put(value, key)),
  del: (key) => run("kv", "readwrite", (s) => s.delete(key))
};

export const blobs = {
  get: (key) => run("blobs", "readonly", (s) => s.get(key)),
  set: (key, value) => run("blobs", "readwrite", (s) => s.put(value, key)),
  del: (key) => run("blobs", "readwrite", (s) => s.delete(key))
};
