import { parseCSV, toCSV } from "./csv.js";

export const TRIP_COLS = [
  "trip_id", "startDate", "endDate", "location", "companions", "notes",
  "catch_count", "importedSource", "createdAt", "updatedAt"
];

export const CATCH_COLS = [
  "trip_id", "startDate", "endDate", "location", "companions",
  "catch_id", "date", "fish", "lengthCm", "weightKg", "lure", "color", "water",
  "photo_count", "photos", "notes", "createdAt", "updatedAt"
];

const splitList = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const toNum = (s) => {
  if (s === "" || s === null || s === undefined) return null;
  const n = Number(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const pick = (row, keys) => Object.fromEntries(keys.filter((k) => row[k] !== "").map((k) => [k, row[k]]));

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function tripFromRow(row, extras) {
  return {
    id: row.trip_id || uid(),
    startDate: row.startDate || "",
    endDate: row.endDate || row.startDate || "",
    location: row.location || "",
    companions: splitList(row.companions),
    notes: row.notes || "",
    importedSource: row.importedSource || "",
    createdAt: row.createdAt || "",
    updatedAt: row.updatedAt || "",
    extra: pick(row, extras),
    catches: []
  };
}

export function parseData(tripsText, catchesText) {
  const t = parseCSV(tripsText);
  const c = parseCSV(catchesText);
  const tripExtras = t.header.filter((h) => h && !TRIP_COLS.includes(h));
  const catchExtras = c.header.filter((h) => h && !CATCH_COLS.includes(h));

  const trips = t.rows.map((row) => tripFromRow(row, tripExtras));
  const byId = new Map(trips.map((trip) => [trip.id, trip]));

  for (const row of c.rows) {
    let trip = byId.get(row.trip_id);
    if (!trip) {
      // catch row without a trip row: rebuild the trip from the denormalized columns
      trip = tripFromRow(row, []);
      trips.push(trip);
      byId.set(trip.id, trip);
    }
    trip.catches.push({
      id: row.catch_id || uid(),
      date: row.date || "",
      fish: row.fish || "",
      lengthCm: toNum(row.lengthCm),
      weightKg: toNum(row.weightKg),
      lure: row.lure || "",
      color: row.color || "",
      water: splitList(row.water),
      photos: (row.photos || "").split("|").map((x) => x.trim()).filter(Boolean),
      notes: row.notes || "",
      createdAt: row.createdAt || "",
      updatedAt: row.updatedAt || "",
      extra: pick(row, catchExtras)
    });
  }
  return sortTrips(trips);
}

export function sortTrips(trips) {
  trips.sort((a, b) => (b.startDate || "").localeCompare(a.startDate || "") || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  for (const trip of trips) trip.catches.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return trips;
}

export function serializeData(trips) {
  const tripExtras = [...new Set(trips.flatMap((t) => Object.keys(t.extra || {})))];
  const catchExtras = [...new Set(trips.flatMap((t) => t.catches.flatMap((c) => Object.keys(c.extra || {}))))];
  const tripHeader = [...TRIP_COLS, ...tripExtras];
  const catchHeader = [...CATCH_COLS, ...catchExtras];

  const tripRows = [];
  const catchRows = [];
  for (const trip of [...trips].sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""))) {
    const shared = {
      trip_id: trip.id,
      startDate: trip.startDate,
      endDate: trip.endDate,
      location: trip.location,
      companions: trip.companions.join(", ")
    };
    tripRows.push({
      ...trip.extra,
      ...shared,
      notes: trip.notes,
      catch_count: trip.catches.length,
      importedSource: trip.importedSource,
      createdAt: trip.createdAt,
      updatedAt: trip.updatedAt
    });
    for (const c of trip.catches) {
      catchRows.push({
        ...c.extra,
        ...shared,
        catch_id: c.id,
        date: c.date,
        fish: c.fish,
        lengthCm: c.lengthCm ?? "",
        weightKg: c.weightKg ?? "",
        lure: c.lure,
        color: c.color,
        water: c.water.join(", "),
        photo_count: c.photos.length,
        photos: c.photos.join("|"),
        notes: c.notes,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      });
    }
  }
  return {
    trips: toCSV(tripHeader, tripRows),
    catches: toCSV(catchHeader, catchRows)
  };
}

// Offline-queue operations. Applied to the local copy immediately and replayed
// on top of the latest Drive copy during sync, so edits from other devices survive.
export function applyOp(trips, op) {
  const find = (id) => trips.find((t) => t.id === id);
  switch (op.type) {
    case "upsertTrip": {
      const existing = find(op.trip.id);
      if (existing) Object.assign(existing, op.trip, { catches: existing.catches });
      else trips.push({ ...op.trip, catches: [] });
      break;
    }
    case "deleteTrip": {
      const i = trips.findIndex((t) => t.id === op.id);
      if (i >= 0) trips.splice(i, 1);
      break;
    }
    case "upsertCatch": {
      let trip = find(op.tripId);
      if (!trip) break;
      const i = trip.catches.findIndex((c) => c.id === op.catch.id);
      if (i >= 0) trip.catches[i] = { ...trip.catches[i], ...op.catch };
      else trip.catches.push({ ...op.catch });
      trip.updatedAt = op.catch.updatedAt || trip.updatedAt;
      break;
    }
    case "deleteCatch": {
      const trip = find(op.tripId);
      if (!trip) break;
      trip.catches = trip.catches.filter((c) => c.id !== op.id);
      break;
    }
  }
  return sortTrips(trips);
}

// ---------- setups (setups.csv) ----------

export const SETUP_COLS = ["setup_id", "name", "notes", "extra_setup", "createdAt", "updatedAt"];

export function parseSetups(text) {
  const { header, rows } = parseCSV(text);
  const extras = header.filter((h) => h && !SETUP_COLS.includes(h));
  return sortSetups(
    rows.map((row) => ({
      id: row.setup_id || uid(),
      name: row.name || "",
      notes: row.notes || "",
      addon: row.extra_setup || "",
      createdAt: row.createdAt || "",
      updatedAt: row.updatedAt || "",
      extra: pick(row, extras)
    }))
  );
}

export function sortSetups(setups) {
  return setups.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.name.localeCompare(b.name));
}

export function serializeSetups(setups) {
  const extras = [...new Set(setups.flatMap((s) => Object.keys(s.extra || {})))];
  const rows = [...setups]
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
    .map((s) => ({ ...s.extra, setup_id: s.id, name: s.name, notes: s.notes, extra_setup: s.addon || "", createdAt: s.createdAt, updatedAt: s.updatedAt }));
  return toCSV([...SETUP_COLS, ...extras], rows);
}

export const isSetupOp = (op) => op.type === "upsertSetup" || op.type === "deleteSetup";

export function applySetupOp(setups, op) {
  if (op.type === "upsertSetup") {
    const i = setups.findIndex((s) => s.id === op.setup.id);
    if (i >= 0) setups[i] = { ...setups[i], ...op.setup };
    else setups.push({ ...op.setup });
  } else if (op.type === "deleteSetup") {
    const i = setups.findIndex((s) => s.id === op.id);
    if (i >= 0) setups.splice(i, 1);
  }
  return sortSetups(setups);
}

// ---------- merging extra CSV sources ----------

// Google Sheets may export dates as 10/1/2017 or 2017/10/01; bring them back to ISO.
export function normalizeDate(v) {
  const s = (v || "").trim();
  let m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(.*)$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}${m[4].replace(/^\s+/, "T")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}${m[4].replace(/^\s+/, "T")}`;
  return s;
}

// Adds rows from extra CSV texts whose key is not already present. Returns { text, added }.
export function mergeCsvTexts(mainText, extraTexts, key) {
  const main = parseCSV(mainText);
  const header = [...main.header];
  const seen = new Set(main.rows.map((r) => r[key]).filter(Boolean));
  const rows = [...main.rows];
  let added = 0;
  for (const text of extraTexts) {
    const extra = parseCSV(text);
    if (!extra.header.includes(key)) continue;
    for (const h of extra.header) if (h && !header.includes(h)) header.push(h);
    for (const r of extra.rows) {
      if (!r[key] || seen.has(r[key])) continue;
      for (const d of ["startDate", "endDate", "date"]) if (r[d]) r[d] = normalizeDate(r[d]);
      seen.add(r[key]);
      rows.push(r);
      added++;
    }
  }
  return { text: toCSV(header.length ? header : [key], rows), added };
}
