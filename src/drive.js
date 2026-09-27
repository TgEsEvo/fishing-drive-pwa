// Google Drive REST v3 access from the browser (Google Identity Services token flow).

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const TOKEN_KEY = "fishing-drive-token";

export class AuthError extends Error {}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Google script ачаалсангүй"));
    document.head.appendChild(s);
  });
}

const q = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export class GoogleDrive {
  constructor({ clientId, folderName, folderId }) {
    this.clientId = clientId;
    this.folderName = folderName || "fishing-app";
    this.folderId = folderId || "";
    this.token = null;
    this.expires = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
      if (saved && saved.expires > Date.now()) Object.assign(this, saved);
    } catch {}
  }

  get signedIn() {
    return Boolean(this.token) && this.expires > Date.now();
  }

  async init() {
    await loadScript("https://accounts.google.com/gsi/client");
    this.client = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: SCOPE,
      callback: () => {}
    });
  }

  signIn() {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error("Google нэвтрэлт бэлэн биш байна"));
      this.client.callback = (res) => {
        if (res.error) return reject(new AuthError(res.error));
        this.token = res.access_token;
        this.expires = Date.now() + (Number(res.expires_in) - 60) * 1000;
        try {
          localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: this.token, expires: this.expires }));
        } catch {}
        resolve();
      };
      this.client.error_callback = (err) => reject(new AuthError(err?.type || "popup"));
      this.client.requestAccessToken({ prompt: "" });
    });
  }

  signOut() {
    if (this.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token, () => {});
    this.token = null;
    this.expires = 0;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
  }

  async req(url, options = {}) {
    if (!this.signedIn) throw new AuthError("expired");
    const res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${this.token}` }
    });
    if (res.status === 401) {
      this.token = null;
      throw new AuthError("401");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Drive ${res.status}: ${body.slice(0, 200)}`);
    }
    return res;
  }

  async list(query, fields = "files(id,name,mimeType,modifiedTime)") {
    const url = `${API}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&pageSize=100&spaces=drive`;
    return (await (await this.req(url)).json()).files || [];
  }

  async createFolder(name, parent) {
    const res = await this.req(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parent ? [parent] : undefined })
    });
    return (await res.json()).id;
  }

  // Finds (or creates) the data folder, its CSV files and photos/ subfolder.
  async locate() {
    if (!this.folderId) {
      const found = await this.list(`name='${q(this.folderName)}' and mimeType='${FOLDER_MIME}' and trashed=false`);
      this.folderId = found[0]?.id || (await this.createFolder(this.folderName));
    }
    const files = await this.list(`'${this.folderId}' in parents and trashed=false`);
    const byName = (n) => files.find((f) => f.name === n);
    const sheet = files.find((f) => /^(trips|catches)/.test(f.name) && f.mimeType === "application/vnd.google-apps.spreadsheet");
    if (sheet && !byName("trips.csv")) {
      throw new Error("Drive CSV-г Google Sheet болгож хөрвүүлсэн байна. trips.csv, catches.csv-г CSV хэвээр нь upload хийнэ үү.");
    }
    this.files = {
      trips: byName("trips.csv")?.id || null,
      catches: byName("catches.csv")?.id || null,
      setups: byName("setups.csv")?.id || null
    };
    this.photosFolder = files.find((f) => f.name === "photos" && f.mimeType === FOLDER_MIME)?.id || null;
    return this.files;
  }

  async readText(fileId) {
    if (!fileId) return "";
    return (await this.req(`${API}/files/${fileId}?alt=media`)).text();
  }

  async multipart(metadata, blob, fields = "id") {
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", blob);
    const res = await this.req(`${UPLOAD}/files?uploadType=multipart&fields=${fields}`, { method: "POST", body: form });
    return res.json();
  }

  async writeText(key, name, text) {
    const blob = new Blob([text], { type: "text/csv" });
    const id = this.files[key];
    if (id) {
      await this.req(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "text/csv" },
        body: blob
      });
    } else {
      this.files[key] = (await this.multipart({ name, parents: [this.folderId], mimeType: "text/csv" }, blob)).id;
    }
  }

  async uploadPhoto(blob, name) {
    if (!this.photosFolder) this.photosFolder = await this.createFolder("photos", this.folderId);
    return (await this.multipart({ name, parents: [this.photosFolder] }, blob)).id;
  }

  async downloadPhoto(id) {
    return (await this.req(`${API}/files/${id}?alt=media`)).blob();
  }

  async trash(id) {
    await this.req(`${API}/files/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
  }
}

// In-browser stand-in for Drive, for development (?mock=1). Seeds from mock/*.csv if present.
export class MockDrive {
  constructor() {
    this.key = "fishing-mock-drive";
    this.signedIn = false;
    this.fail = false;
  }
  load() {
    try {
      return JSON.parse(localStorage.getItem(this.key) || "null");
    } catch {
      return null;
    }
  }
  save(fs) {
    localStorage.setItem(this.key, JSON.stringify(fs));
  }
  check() {
    if (this.fail || !navigator.onLine) throw new TypeError("Failed to fetch");
  }
  async init() {
    if (!this.load()) {
      const get = async (p) => {
        const r = await fetch(p).catch(() => null);
        return r && r.ok ? r.text() : "";
      };
      this.save({ "trips.csv": await get("mock/trips.csv"), "catches.csv": await get("mock/catches.csv"), "setups.csv": await get("mock/setups.csv"), photos: {} });
    }
  }
  async signIn() {
    this.signedIn = true;
  }
  signOut() {
    this.signedIn = false;
  }
  async locate() {
    this.check();
    this.files = { trips: "trips.csv", catches: "catches.csv", setups: "setups.csv" };
    return this.files;
  }
  async readText(id) {
    this.check();
    return this.load()[id] || "";
  }
  async writeText(key, name, text) {
    this.check();
    const fs = this.load();
    fs[name] = text;
    this.save(fs);
  }
  async uploadPhoto(blob) {
    this.check();
    const fs = this.load();
    const id = `mock-${Object.keys(fs.photos).length + 1}`;
    fs.photos[id] = await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(blob);
    });
    this.save(fs);
    return id;
  }
  async downloadPhoto(id) {
    this.check();
    return (await fetch(this.load().photos[id])).blob();
  }
  async trash(id) {
    const fs = this.load();
    delete fs.photos[id];
    this.save(fs);
  }
}
