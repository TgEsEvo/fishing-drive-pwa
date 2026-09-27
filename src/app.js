import { parseData, serializeData, applyOp, sortTrips, uid, parseSetups, serializeSetups, applySetupOp, isSetupOp, sortSetups } from "./model.js";
import { GoogleDrive, MockDrive, AuthError } from "./drive.js";
import { kv, blobs } from "./store.js";

const CFG = { folderName: "fishing-app", ...(window.FISHING_CONFIG || {}) };
const params = new URLSearchParams(location.search);
const MOCK = params.has("mock") || CFG.mock;
const lsGet = (k) => {
  try {
    return localStorage.getItem(k) || "";
  } catch {
    return "";
  }
};
const lsSet = (k, v) => {
  try {
    v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
  } catch {}
};

const DEFAULTS = {
  locations: ["Онон", "Эг", "Шишгэд", "Хэрлэн", "Орхон", "Чулуут", "Тамир", "Үгий", "Балж", "Гичгэнэ"],
  companions: ["Mb", "Galaa", "Hatnaa", "Erka", "Bayaraa", "Tsogoo", "Manlai", "Nyamaa"],
  fish: ["Тул", "Зэвэг", "Хадран", "Цурхай", "Алгана", "Улаан нүдэн", "Налим", "Сазан"],
  lures: ["Westin Swim", "Rapala X-Rap", "Mouse", "Streamer", "Nymph", "Jig", "Vobler", "Халбага", "Тэжээл"],
  colors: ["White", "Brown", "Black", "Шар", "Ногоон", "Цагаан", "Хар", "Улаан"]
};

const WATER = [
  ["Clear", "Тунгалаг"],
  ["Mud", "Булингартай"],
  ["High", "Их ус"],
  ["Low", "Бага ус"],
  ["BlackWater", "Хар уснаас"],
  ["SmallRapid", "Жижиг харгианаас"],
  ["Pool", "Цүнхээлээс"]
];
const WATER_LABEL = Object.fromEntries(WATER);

const STATUS_TEXT = {
  idle: "…",
  setup: "Тохиргоо",
  signin: "Нэвтрэх",
  syncing: "Sync хийж байна…",
  online: "Онлайн",
  offline: "Офлайн",
  error: "Алдаа"
};

const state = {
  trips: [],
  setups: [],
  queue: [],
  status: "idle",
  error: "",
  search: "",
  lastSync: 0,
  draft: null
};

let drive = null;
const $app = document.querySelector("#app");
const $pill = document.querySelector("#statusPill");

// ---------- helpers ----------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const now = () => new Date().toISOString();
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
const fmtDate = (d) => (d || "").replace(/-/g, ".").replace("T", " ");
const dateRange = (t) => (t.endDate && t.endDate !== t.startDate ? `${fmtDate(t.startDate)} - ${fmtDate(t.endDate)}` : fmtDate(t.startDate));

function topValue(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = "";
  let max = 0;
  for (const [v, n] of counts) if (n > max) [best, max] = [v, n];
  return best;
}

function uniqueValues(defaults, values) {
  const seen = new Set();
  const out = [];
  for (const v of [...defaults, ...values]) {
    const key = (v || "").trim();
    if (key && !seen.has(key.toLowerCase())) {
      seen.add(key.toLowerCase());
      out.push(key);
    }
  }
  return out;
}

const allCatches = () => state.trips.flatMap((t) => t.catches);
const findTrip = (id) => state.trips.find((t) => t.id === id);
const datalist = (id, values) => `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;

function toast(msg) {
  const el = document.querySelector("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

function setStatus(status, error = "") {
  state.status = status;
  state.error = error;
  renderPill();
}

function renderPill() {
  const pending = state.queue.length;
  let text = STATUS_TEXT[state.status] || state.status;
  if (pending && state.status !== "syncing") text += ` · ${pending} хүлээгдэж байна`;
  $pill.textContent = text;
  $pill.dataset.status = state.status;
  $pill.title = state.error || "";
}

// ---------- sync ----------

let syncing = null;

function sync() {
  if (!syncing) syncing = doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync() {
  if (!drive) return setStatus("setup");
  if (!drive.signedIn) {
    setStatus("signin");
    return renderIfSafe();
  }
  if (!navigator.onLine) return setStatus("offline");
  setStatus("syncing");
  try {
    await drive.locate();
    const [tripsText, catchesText, setupsText] = await Promise.all([
      drive.readText(drive.files.trips),
      drive.readText(drive.files.catches),
      drive.readText(drive.files.setups)
    ]);
    const trips = parseData(tripsText, catchesText);
    const setups = parseSetups(setupsText);
    const batch = state.queue.slice();

    if (batch.length) {
      const photoMap = (await kv.get("photoMap")) || {};
      const toTrash = [];
      for (const op of batch) {
        await uploadOpPhotos(op, photoMap);
        applyAny(trips, setups, clone(op));
        toTrash.push(...(op.trashPhotos || []).filter((p) => !p.startsWith("local:")));
      }
      if (batch.some((op) => !isSetupOp(op))) {
        const csv = serializeData(trips);
        await drive.writeText("catches", "catches.csv", csv.catches);
        await drive.writeText("trips", "trips.csv", csv.trips);
      }
      if (batch.some(isSetupOp)) await drive.writeText("setups", "setups.csv", serializeSetups(setups));
      state.queue = state.queue.slice(batch.length);
      await kv.set("queue", state.queue);
      for (const id of toTrash) drive.trash(id).catch(() => {});
    }

    // edits made while this sync was running stay queued; show them on top
    for (const op of state.queue) applyAny(trips, setups, clone(op));
    state.trips = trips;
    state.setups = setups;
    state.lastSync = Date.now();
    await kv.set("trips", trips);
    await kv.set("setups", setups);
    await kv.set("lastSync", state.lastSync);
    setStatus("online");
    renderIfSafe();
    if (state.queue.length) sync();
  } catch (err) {
    console.error(err);
    if (err instanceof AuthError) setStatus("signin", "Google-ийн нэвтрэлт дууссан. Дахин нэвтэрнэ үү.");
    else if (err instanceof TypeError || !navigator.onLine) setStatus("offline", "Сүлжээ алга");
    else setStatus("error", err.message);
    renderIfSafe();
  }
}

async function uploadOpPhotos(op, photoMap) {
  if (op.type !== "upsertCatch") return;
  const out = [];
  let n = 0;
  for (const p of op.catch.photos) {
    n++;
    if (!p.startsWith("local:")) {
      out.push(p);
      continue;
    }
    if (photoMap[p]) {
      out.push(photoMap[p]);
      continue;
    }
    const blob = await blobs.get(p);
    if (!blob) continue;
    const name = `${op.catch.date || today()}_${op.catch.fish || "fish"}_${n}.jpg`.replace(/[\\/:*?"<>|\s]+/g, "-");
    const id = await drive.uploadPhoto(blob, name);
    photoMap[p] = id;
    await kv.set("photoMap", photoMap);
    await blobs.set(`photo:${id}`, blob);
    await blobs.del(p);
    out.push(id);
  }
  op.catch.photos = out;
}

function applyAny(trips, setups, op) {
  if (isSetupOp(op)) applySetupOp(setups, op);
  else applyOp(trips, op);
}

async function mutate(op) {
  applyAny(state.trips, state.setups, clone(op));
  state.queue.push(op);
  await kv.set("queue", state.queue);
  await kv.set("trips", state.trips);
  await kv.set("setups", state.setups);
  renderPill();
  sync();
}

// ---------- photos ----------

const objectUrls = new Map();

async function photoBlob(id) {
  if (id.startsWith("local:")) {
    const local = await blobs.get(id);
    if (local) return local;
    const map = (await kv.get("photoMap")) || {};
    return map[id] ? photoBlob(map[id]) : null;
  }
  const cached = await blobs.get(`photo:${id}`);
  if (cached) return cached;
  if (!drive?.signedIn || !navigator.onLine) return null;
  const blob = await drive.downloadPhoto(id);
  await blobs.set(`photo:${id}`, blob);
  return blob;
}

async function hydratePhotos(root = $app) {
  for (const img of root.querySelectorAll("img[data-photo]")) {
    const id = img.dataset.photo;
    try {
      if (!objectUrls.has(id)) {
        const blob = await photoBlob(id);
        if (!blob) continue;
        objectUrls.set(id, URL.createObjectURL(blob));
      }
      img.src = objectUrls.get(id);
      img.classList.add("loaded");
    } catch (err) {
      console.warn("photo", id, err);
    }
  }
}

async function resizeImage(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((r) => canvas.toBlob((b) => r(b || file), "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

// ---------- routing ----------

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "new") return { view: "tripForm" };
  if (parts[0] === "setups") {
    if (parts[1]) return { view: "setupForm", setupId: parts[1] === "new" ? null : parts[1] };
    return { view: "setups" };
  }
  if (parts[0] === "trip" && parts[1]) {
    if (parts[2] === "edit") return { view: "tripForm", tripId: parts[1] };
    if (parts[2] === "catch") return { view: "catchForm", tripId: parts[1], catchId: parts[3] === "new" ? null : parts[3] };
    return { view: "trip", tripId: parts[1] };
  }
  return { view: "list" };
}

const go = (hash) => (location.hash = hash);

// Background refreshes must not wipe a form the user is typing into.
function renderIfSafe() {
  if (!route().view.endsWith("Form")) render();
}

function render() {
  const r = route();
  if (!drive && !MOCK && r.view !== "settings") return renderSetup();
  const views = { list: renderList, trip: renderTrip, tripForm: renderTripForm, catchForm: renderCatchForm, settings: renderSettings, setups: renderSetups, setupForm: renderSetupForm };
  views[r.view](r);
  hydratePhotos();
}

// ---------- views ----------

function banner() {
  if (state.status === "signin") {
    return `<div class="banner">
      <p>${esc(state.error || "Drive дээрх датагаа харах, хадгалахын тулд Google-ээр нэвтэрнэ үү.")}</p>
      <button class="primary" data-action="signin" type="button">Google-ээр нэвтрэх</button>
    </div>`;
  }
  if (state.status === "error") {
    return `<div class="banner error"><p>${esc(state.error)}</p><button data-action="sync" type="button">Дахин оролдох</button></div>`;
  }
  return "";
}

function renderSetup() {
  $app.innerHTML = `
    <section class="card setup">
      <h2>Эхний тохиргоо</h2>
      <p>Google Cloud Console дээр үүсгэсэн <b>OAuth Client ID</b>-гаа оруулна уу. Заавар нь README.md файлд бий.</p>
      <form id="setupForm" class="form">
        <label>Client ID<input name="clientId" required placeholder="xxxx.apps.googleusercontent.com" /></label>
        <label>Drive хавтасны нэр<input name="folderName" value="${esc(CFG.folderName)}" /></label>
        <button class="primary" type="submit">Хадгалах</button>
      </form>
    </section>`;
  $app.querySelector("#setupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    lsSet("fishing-client-id", f.get("clientId").trim());
    lsSet("fishing-folder-name", f.get("folderName").trim());
    location.reload();
  });
}

function matches(trip, query) {
  if (!query) return true;
  const hay = [
    trip.location,
    trip.companions.join(" "),
    trip.notes,
    trip.startDate,
    ...trip.catches.flatMap((c) => [c.fish, c.lure, c.color, c.notes, ...c.water.map((w) => WATER_LABEL[w] || w)])
  ]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

function tripCard(t) {
  const fish = [...new Set(t.catches.map((c) => c.fish).filter(Boolean))];
  const longest = Math.max(0, ...t.catches.map((c) => c.lengthCm || 0));
  const lure = topValue(t.catches.map((c) => c.lure));
  const photo = t.catches.flatMap((c) => c.photos)[0];
  const badge = t.catches.length ? `<span class="badge caught">${t.catches.length} загас</span>` : `<span class="badge missed">Цайрсан</span>`;
  return `
    <a class="trip-card" href="#/trip/${esc(t.id)}">
      <div class="thumb">${photo ? `<img data-photo="${esc(photo)}" alt="" />` : "🎣"}</div>
      <div class="trip-body">
        <div class="trip-top"><span class="date">${esc(dateRange(t))}</span>${badge}</div>
        <h3>${esc(t.location || "Байршилгүй")}</h3>
        <dl class="meta">
          <div><dt>Хамт явсан</dt><dd>${esc(t.companions.join(", ") || "-")}</dd></div>
          <div><dt>Загас</dt><dd>${esc(fish.join(", ") || "Цайрсан")}</dd></div>
          <div><dt>Хамгийн урт</dt><dd>${longest ? `${fmtNum(longest)} см` : "-"}</dd></div>
          <div><dt>Топ өгөөш</dt><dd>${esc(lure || "-")}</dd></div>
        </dl>
      </div>
    </a>`;
}

function renderList() {
  const catches = allCatches();
  const longest = Math.max(0, ...catches.map((c) => c.lengthCm || 0));
  const stats = [
    ["Аялал", state.trips.length],
    ["Барьсан загас", catches.length],
    ["Хамгийн урт", longest ? `${fmtNum(longest)} см` : "-"],
    ["Топ өгөөш", topValue(catches.map((c) => c.lure)) || "-"]
  ];
  $app.innerHTML = `
    ${banner()}
    <section class="list-head">
      <div><small>Миний аяллууд</small><h2>Аяллын жагсаалт</h2></div>
      <a class="icon-btn" href="#/settings" aria-label="Тохиргоо">⚙︎</a>
    </section>
    <a class="primary big" href="#/new">+ Шинэ аялал</a>
    <section class="stats">
      ${stats.map(([l, v]) => `<article><span>${esc(l)}</span><strong>${esc(v)}</strong></article>`).join("")}
      <a class="stat-link" href="#/setups">
        <span>Миний setup-ууд</span>
        <strong>${state.setups.length}</strong>
        <em>${esc(state.setups.slice(0, 3).map((x) => x.name).join(", ") || "Шинэ setup нэмэх")} ›</em>
      </a>
    </section>
    <label class="search">Хайх
      <input id="searchInput" type="search" value="${esc(state.search)}" placeholder="Газар, хүн, загас, өгөөш..." autocomplete="off" />
    </label>
    <p id="resultCount" class="muted small"></p>
    <div id="tripList" class="trip-list"></div>`;
  const input = $app.querySelector("#searchInput");
  input.addEventListener("input", () => {
    state.search = input.value;
    renderTripList();
  });
  renderTripList();
}

function renderTripList() {
  const list = state.trips.filter((t) => matches(t, state.search.trim()));
  const el = $app.querySelector("#tripList");
  $app.querySelector("#resultCount").textContent = state.search.trim() ? `${list.length} аялал олдлоо` : "";
  el.innerHTML = list.length
    ? list.map(tripCard).join("")
    : `<p class="empty">${state.trips.length ? "Хайлтад тохирох аялал алга." : state.status === "syncing" ? "Drive-аас ачаалж байна…" : "Одоогоор аялал алга."}</p>`;
  hydratePhotos(el);
}

function catchCard(t, c) {
  const facts = [
    c.lengthCm ? `${fmtNum(c.lengthCm)} см` : "",
    c.weightKg ? `${fmtNum(c.weightKg)} кг` : "",
    c.lure,
    c.color
  ].filter(Boolean);
  return `
    <article class="catch-card">
      <div class="catch-top">
        <div><strong>${esc(c.fish || "Загас")}</strong><span class="muted small"> ${esc(fmtDate(c.date))}</span></div>
        <a class="link" href="#/trip/${esc(t.id)}/catch/${esc(c.id)}">Засах</a>
      </div>
      ${facts.length ? `<p class="facts">${facts.map(esc).join(" · ")}</p>` : ""}
      ${c.water.length ? `<div class="tags">${c.water.map((w) => `<span class="tag">${esc(WATER_LABEL[w] || w)}</span>`).join("")}</div>` : ""}
      ${c.photos.length ? `<div class="photos">${c.photos.map((p) => `<img data-photo="${esc(p)}" alt="" />`).join("")}</div>` : ""}
      ${c.notes ? `<p class="notes">${esc(c.notes)}</p>` : ""}
    </article>`;
}

function renderTrip({ tripId }) {
  const t = findTrip(tripId);
  if (!t) {
    $app.innerHTML = `<a class="back" href="#/">← Жагсаалт</a><p class="empty">Аялал олдсонгүй.</p>`;
    return;
  }
  $app.innerHTML = `
    <a class="back" href="#/">← Жагсаалт</a>
    <section class="card">
      <div class="trip-top"><span class="date">${esc(dateRange(t))}</span>
        ${t.catches.length ? `<span class="badge caught">${t.catches.length} загас</span>` : `<span class="badge missed">Цайрсан</span>`}</div>
      <h2>${esc(t.location || "Байршилгүй")}</h2>
      ${t.companions.length ? `<p class="muted">Хамт: ${esc(t.companions.join(", "))}</p>` : ""}
      ${t.notes ? `<h3>Аяллын тэмдэглэл</h3><p class="notes">${esc(t.notes)}</p>` : ""}
      <div class="row">
        <a class="secondary" href="#/trip/${esc(t.id)}/edit">Аялал засах</a>
        <button class="danger" data-action="deleteTrip" data-id="${esc(t.id)}" type="button">Устгах</button>
      </div>
    </section>
    <section class="list-head"><h2>Барьсан загас</h2><a class="primary" href="#/trip/${esc(t.id)}/catch/new">+ Загас</a></section>
    <div class="catch-list">${t.catches.length ? t.catches.map((c) => catchCard(t, c)).join("") : `<p class="empty">Загас бүртгээгүй байна.</p>`}</div>`;
}

function chipsHtml(name, options, selected) {
  return options
    .map(([v, l]) => `<button class="chip${selected.includes(v) ? " on" : ""}" type="button" data-chip="${esc(name)}" data-value="${esc(v)}" aria-pressed="${selected.includes(v)}">${esc(l)}</button>`)
    .join("");
}

function renderTripForm({ tripId }) {
  const t = tripId ? findTrip(tripId) : null;
  if (tripId && !t) return go("#/");
  const locations = uniqueValues(DEFAULTS.locations, state.trips.map((x) => x.location));
  const people = uniqueValues(DEFAULTS.companions, state.trips.flatMap((x) => x.companions));
  const selected = t ? [...t.companions] : [];
  $app.innerHTML = `
    <a class="back" href="${t ? `#/trip/${esc(t.id)}` : "#/"}">← Буцах</a>
    <form id="tripForm" class="card form">
      <h2>${t ? "Аялал засах" : "Шинэ аялал"}</h2>
      <div class="two">
        <label>Эхэлсэн<input name="startDate" type="date" required value="${esc(t?.startDate || today())}" /></label>
        <label>Дууссан<input name="endDate" type="date" value="${esc(t?.endDate || t?.startDate || today())}" /></label>
      </div>
      <label>Гол / байршил<input name="location" list="locList" required value="${esc(t?.location || "")}" placeholder="Хэрлэн, Онон..." /></label>
      ${datalist("locList", locations)}
      <fieldset><legend>Хамт явсан</legend>
        <div class="chips" id="peopleChips">${chipsHtml("people", uniqueValues(people, selected).map((p) => [p, p]), selected)}</div>
        <div class="add-row"><input id="newPerson" placeholder="Өөр хүн нэмэх" /><button type="button" data-action="addPerson" class="secondary">Нэмэх</button></div>
      </fieldset>
      <label>Тэмдэглэл<textarea name="notes" rows="6" placeholder="Зам, цаг агаар, тооцоо, ерөнхий үр дүн...">${esc(t?.notes || "")}</textarea></label>
      <button class="primary big" type="submit">Хадгалах</button>
    </form>`;

  $app.querySelector("#tripForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const companions = [...$app.querySelectorAll('[data-chip="people"].on')].map((b) => b.dataset.value);
    const start = f.get("startDate");
    let end = f.get("endDate") || start;
    if (end < start) end = start;
    const trip = {
      id: t?.id || uid(),
      startDate: start,
      endDate: end,
      location: f.get("location").trim(),
      companions,
      notes: f.get("notes"),
      importedSource: t?.importedSource || "",
      createdAt: t?.createdAt || now(),
      updatedAt: now(),
      extra: t?.extra || {}
    };
    await mutate({ type: "upsertTrip", trip });
    toast("Хадгаллаа");
    go(`#/trip/${trip.id}`);
  });
}

function renderCatchForm({ tripId, catchId }) {
  const t = findTrip(tripId);
  if (!t) return go("#/");
  const c = catchId ? t.catches.find((x) => x.id === catchId) : null;
  if (catchId && !c) return go(`#/trip/${tripId}`);
  const key = `${tripId}/${catchId || "new"}`;
  if (!state.draft || state.draft.key !== key) {
    state.draft = { key, photos: c ? [...c.photos] : [], removed: [] };
  }
  const catches = allCatches();
  const [d, time] = (c?.date || "").split("T");
  const fishList = uniqueValues(DEFAULTS.fish, catches.map((x) => x.fish));
  const selectedWater = c?.water || [];

  $app.innerHTML = `
    <a class="back" href="#/trip/${esc(t.id)}">← Аялал</a>
    <form id="catchForm" class="card form">
      <h2>${c ? "Загас засах" : "Загас нэмэх"}</h2>
      <p class="muted small">${esc(t.location)} · ${esc(dateRange(t))}</p>
      <div class="two">
        <label>Огноо<input name="date" type="date" required value="${esc(d || (today() <= t.endDate && today() >= t.startDate ? today() : t.startDate))}" /></label>
        <label>Цаг<input name="time" type="time" value="${esc(time || "")}" /></label>
      </div>
      <label>Загас<input name="fish" list="fishList" required value="${esc(c?.fish || "")}" /></label>
      ${datalist("fishList", fishList)}
      <div class="chips">${fishList.slice(0, 8).map((f) => `<button class="chip" type="button" data-fill="fish" data-value="${esc(f)}">${esc(f)}</button>`).join("")}</div>
      <div class="two">
        <label>Урт (см)<input name="lengthCm" type="number" inputmode="decimal" min="0" step="0.1" value="${esc(c?.lengthCm ?? "")}" /></label>
        <label>Жин (кг)<input name="weightKg" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(c?.weightKg ?? "")}" /></label>
      </div>
      <div class="two">
        <label>Өгөөш<input name="lure" list="lureList" value="${esc(c?.lure || "")}" /></label>
        <label>Өнгө<input name="color" list="colorList" value="${esc(c?.color || "")}" /></label>
      </div>
      ${datalist("lureList", uniqueValues(DEFAULTS.lures, catches.map((x) => x.lure)))}
      ${datalist("colorList", uniqueValues(DEFAULTS.colors, catches.map((x) => x.color)))}
      <fieldset><legend>Усны нөхцөл / газар</legend><div class="chips">${chipsHtml("water", WATER, selectedWater)}</div></fieldset>
      <fieldset><legend>Зураг</legend>
        <div class="photos edit" id="draftPhotos"></div>
        <label class="secondary file-btn">📷 Зураг нэмэх<input id="photoInput" type="file" accept="image/*" multiple hidden /></label>
      </fieldset>
      <label>Тэмдэглэл<textarea name="notes" rows="4">${esc(c?.notes || "")}</textarea></label>
      <button class="primary big" type="submit">Хадгалах</button>
      ${c ? `<button class="danger" type="button" data-action="deleteCatch" data-trip="${esc(t.id)}" data-id="${esc(c.id)}">Загас устгах</button>` : ""}
    </form>`;

  const renderDraftPhotos = () => {
    const box = $app.querySelector("#draftPhotos");
    box.innerHTML = state.draft.photos
      .map((p) => `<figure><img data-photo="${esc(p)}" alt="" /><button type="button" data-action="removePhoto" data-id="${esc(p)}" aria-label="Устгах">×</button></figure>`)
      .join("");
    hydratePhotos(box);
  };
  renderDraftPhotos();

  $app.querySelector("#photoInput").addEventListener("change", async (e) => {
    for (const file of e.target.files) {
      const id = `local:${uid()}`;
      await blobs.set(id, await resizeImage(file));
      state.draft.photos.push(id);
    }
    e.target.value = "";
    renderDraftPhotos();
  });
  $app.querySelector("#draftPhotos").addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="removePhoto"]');
    if (!btn) return;
    const id = btn.dataset.id;
    state.draft.photos = state.draft.photos.filter((p) => p !== id);
    if (id.startsWith("local:")) blobs.del(id);
    else state.draft.removed.push(id);
    renderDraftPhotos();
  });

  $app.querySelector("#catchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const num = (v) => (v === "" || v === null ? null : Number(v));
    const catchItem = {
      id: c?.id || uid(),
      date: f.get("time") ? `${f.get("date")}T${f.get("time")}` : f.get("date"),
      fish: f.get("fish").trim(),
      lengthCm: num(f.get("lengthCm")),
      weightKg: num(f.get("weightKg")),
      lure: f.get("lure").trim(),
      color: f.get("color").trim(),
      water: [...$app.querySelectorAll('[data-chip="water"].on')].map((b) => b.dataset.value),
      photos: [...state.draft.photos],
      notes: f.get("notes"),
      createdAt: c?.createdAt || now(),
      updatedAt: now(),
      extra: c?.extra || {}
    };
    await mutate({ type: "upsertCatch", tripId: t.id, catch: catchItem, trashPhotos: state.draft.removed });
    state.draft = null;
    toast("Хадгаллаа");
    go(`#/trip/${t.id}`);
  });
}

function renderSetups() {
  $app.innerHTML = `
    <a class="back" href="#/">← Жагсаалт</a>
    <section class="list-head">
      <div><small>Хэрэгсэл</small><h2>Миний setup-ууд</h2></div>
    </section>
    <a class="primary big" href="#/setups/new">+ Шинэ setup</a>
    <div class="setup-list">
      ${
        state.setups.length
          ? state.setups
              .map(
                (x) => `
        <a class="setup-card" href="#/setups/${esc(x.id)}">
          <h3>${esc(x.name || "Нэргүй setup")}</h3>
          ${x.notes ? `<p class="notes clamp">${esc(x.notes)}</p>` : ""}
        </a>`
              )
              .join("")
          : `<p class="empty">Одоогоор setup алга.</p>`
      }
    </div>`;
}

function renderSetupForm({ setupId }) {
  const x = setupId ? state.setups.find((s) => s.id === setupId) : null;
  if (setupId && !x) return go("#/setups");
  $app.innerHTML = `
    <a class="back" href="#/setups">← Setup-ууд</a>
    <form id="setupItemForm" class="card form">
      <h2>${x ? "Setup засах" : "Шинэ setup"}</h2>
      <label>Нэр<input name="name" required value="${esc(x?.name || "")}" placeholder="Тулын spinning, зэвэгний fly..." /></label>
      <label>Тайлбар<textarea name="notes" rows="10" placeholder="Саваа, ороогуур, шугам, лидер, өгөөш...">${esc(x?.notes || "")}</textarea></label>
      <button class="primary big" type="submit">Хадгалах</button>
      ${x ? `<button class="danger" type="button" data-action="deleteSetup" data-id="${esc(x.id)}">Setup устгах</button>` : ""}
    </form>`;
  $app.querySelector("#setupItemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const setup = {
      id: x?.id || uid(),
      name: f.get("name").trim(),
      notes: f.get("notes"),
      createdAt: x?.createdAt || now(),
      updatedAt: now(),
      extra: x?.extra || {}
    };
    await mutate({ type: "upsertSetup", setup });
    toast("Хадгаллаа");
    go("#/setups");
  });
}

function renderSettings() {
  const last = state.lastSync ? new Date(state.lastSync).toLocaleString("mn-MN") : "хэзээ ч";
  $app.innerHTML = `
    <a class="back" href="#/">← Жагсаалт</a>
    <section class="card form">
      <h2>Тохиргоо</h2>
      <p><b>Төлөв:</b> ${esc(STATUS_TEXT[state.status])}${state.error ? ` (${esc(state.error)})` : ""}</p>
      <p><b>Сүүлд sync хийсэн:</b> ${esc(last)}</p>
      <p><b>Drive руу илгээгээгүй өөрчлөлт:</b> ${state.queue.length}</p>
      <p><b>Drive хавтас:</b> ${esc(MOCK ? "mock" : lsGet("fishing-folder-name") || CFG.folderName)}</p>
      <div class="row">
        <button class="primary" data-action="sync" type="button">Одоо sync хийх</button>
        ${drive?.signedIn ? `<button class="secondary" data-action="signout" type="button">Гарах</button>` : `<button class="secondary" data-action="signin" type="button">Нэвтрэх</button>`}
      </div>
      ${
        MOCK || CFG.clientId
          ? ""
          : `<button class="danger" data-action="resetClient" type="button">Client ID солих</button>`
      }
    </section>`;
}

// ---------- global actions ----------

document.addEventListener("click", async (e) => {
  const chip = e.target.closest("[data-chip]");
  if (chip) {
    chip.classList.toggle("on");
    chip.setAttribute("aria-pressed", chip.classList.contains("on"));
    return;
  }
  const fill = e.target.closest("[data-fill]");
  if (fill) {
    const input = $app.querySelector(`[name="${fill.dataset.fill}"]`);
    input.value = fill.dataset.value;
    return;
  }
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === "signin") {
    try {
      await drive.signIn();
      sync();
    } catch (err) {
      toast("Нэвтэрч чадсангүй");
      console.error(err);
    }
  } else if (action === "signout") {
    drive.signOut();
    setStatus("signin");
    render();
  } else if (action === "sync") {
    sync();
  } else if (action === "resetClient") {
    lsSet("fishing-client-id", "");
    location.reload();
  } else if (action === "addPerson") {
    const input = $app.querySelector("#newPerson");
    const name = input.value.trim();
    if (!name) return;
    const box = $app.querySelector("#peopleChips");
    const existing = [...box.querySelectorAll("[data-chip]")].find((b) => b.dataset.value.toLowerCase() === name.toLowerCase());
    if (existing) existing.classList.add("on");
    else box.insertAdjacentHTML("beforeend", chipsHtml("people", [[name, name]], [name]));
    input.value = "";
  } else if (action === "deleteTrip") {
    const t = findTrip(btn.dataset.id);
    if (!t || !confirm(`"${t.location}" аяллыг ${t.catches.length} загастай нь устгах уу?`)) return;
    await mutate({ type: "deleteTrip", id: t.id, trashPhotos: t.catches.flatMap((c) => c.photos) });
    toast("Устгалаа");
    go("#/");
  } else if (action === "deleteSetup") {
    const x = state.setups.find((s) => s.id === btn.dataset.id);
    if (!x || !confirm(`"${x.name}" setup-ийг устгах уу?`)) return;
    await mutate({ type: "deleteSetup", id: x.id });
    toast("Устгалаа");
    go("#/setups");
  } else if (action === "deleteCatch") {
    const t = findTrip(btn.dataset.trip);
    const c = t?.catches.find((x) => x.id === btn.dataset.id);
    if (!c || !confirm(`${c.fish || "Загас"}-ыг устгах уу?`)) return;
    await mutate({ type: "deleteCatch", tripId: t.id, id: c.id, trashPhotos: c.photos });
    state.draft = null;
    toast("Устгалаа");
    go(`#/trip/${t.id}`);
  }
});

$pill.addEventListener("click", () => {
  if (state.status === "signin" && drive) drive.signIn().then(sync).catch(() => toast("Нэвтэрч чадсангүй"));
  else if (state.status === "setup") go("#/settings");
  else sync();
});

window.addEventListener("hashchange", () => {
  if (!route().view.endsWith("Form")) state.draft = null;
  render();
  window.scrollTo(0, 0);
});
window.addEventListener("online", () => sync());
window.addEventListener("offline", () => setStatus("offline", "Сүлжээ алга"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.status !== "syncing") sync();
});

// ---------- boot ----------

async function boot() {
  state.trips = sortTrips((await kv.get("trips")) || []);
  state.setups = sortSetups((await kv.get("setups")) || []);
  state.queue = (await kv.get("queue")) || [];
  state.lastSync = (await kv.get("lastSync")) || 0;

  const clientId = CFG.clientId || lsGet("fishing-client-id");
  if (MOCK) drive = new MockDrive();
  else if (clientId) {
    drive = new GoogleDrive({
      clientId,
      folderName: lsGet("fishing-folder-name") || CFG.folderName,
      folderId: CFG.folderId
    });
  }
  setStatus(drive ? (navigator.onLine ? "idle" : "offline") : "setup");
  render();

  if ("serviceWorker" in navigator && !MOCK) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!drive) return;
  try {
    await drive.init();
  } catch (err) {
    setStatus("offline", err.message);
    return;
  }
  if (MOCK && params.has("autologin")) await drive.signIn();
  sync();
}

window.__app = { state, sync, get drive() { return drive; } };
boot();
