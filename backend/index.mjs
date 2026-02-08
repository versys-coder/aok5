/**
 * aok-backend (room_id-based, JSON-driven)
 *
 * Эндпоинты:
 *  - /api/rental_times
 *  - /api/rental_rooms
 *  - /api/availability_grid_elite
 *  - /api/availability_grid_comfort
 *  - /api/debug_room_status
 *  - /api/debug_room_status_table
 *  - /api/debug_day_table
 *  - /api/debug_day_table_raw
 *  - /health
 */

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import https from "https";
import fs from "fs/promises";
import path from "path";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3003);

app.use(cors());
app.use(express.json());

const httpsAgent =
  String(process.env.ALLOW_INSECURE_TLS || "").toLowerCase() === "true"
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

const SLOT_OFFSET_MINUTES = Number(process.env.SLOT_OFFSET_MINUTES || 0);
const CONFIG_PATH =
  process.env.ROOMS_SERVICES_PATH ||
  path.resolve(process.cwd(), "rooms_services.json");

// -----------------------------
// ENV / HTTP helpers
// -----------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function getAuthHeader() {
  const user = requireEnv("API_USERNAME");
  const pass = requireEnv("API_PASSWORD");
  const b64 = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function getBaseUrl() {
  return requireEnv("API_BASE_URL").replace(/\/+$/, "");
}

const RENTAL_TIMES_PATH = String(
  process.env.API_RENTAL_TIMES_PATH || "/hs/api/v3/rental_times"
);
const RENTAL_ROOMS_PATH = String(
  process.env.API_RENTAL_ROOMS_PATH || "/hs/api/v3/rental_rooms"
);

function buildUrl(pathname, queryObj = {}) {
  const url = new URL(getBaseUrl() + pathname);
  for (const [k, v] of Object.entries(queryObj)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function extractUpstreamError(json) {
  if (!json || typeof json !== "object") return null;
  if (json.result === false) {
    return {
      result: json.result,
      error: json.error ?? null,
      error_message: json.error_message ?? "Upstream returned result=false",
    };
  }
  return null;
}

async function apiGet(pathname, query) {
  const apiKey = requireEnv("API_KEY");
  const url = buildUrl(pathname, query);

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: getAuthHeader(),
      apikey: apiKey,
    },
    agent: httpsAgent,
  });

  const text = await resp.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!resp.ok) {
    const err = new Error(`Upstream error ${resp.status}`);
    err.status = resp.status;
    err.details = json || { raw: text };
    throw err;
  }

  const upstreamError = extractUpstreamError(json);
  if (upstreamError) {
    const err = new Error(
      `Upstream result=false: ${upstreamError.error_message}`
    );
    err.status = 502;
    err.details = upstreamError;
    throw err;
  }

  return json;
}

// -----------------------------
// Config (JSON)
// -----------------------------
async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const json = JSON.parse(raw);

  if (!Array.isArray(json.rooms)) {
    throw new Error("rooms_services.json: missing rooms array");
  }
  if (!json.services?.elite || !json.services?.comfort) {
    throw new Error("rooms_services.json: missing services");
  }
  return json;
}

function splitRooms(rooms) {
  const comfort = rooms.filter((r) => r.type === "comfort");
  const elite = rooms.find((r) => r.type === "elite") || null;
  return { comfort, elite };
}

function getDayType(dateIso) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const isWeekend = dow === 5 || dow === 6 || dow === 0;
  return isWeekend ? "weekend" : "weekday";
}

function getDayBand(startHHMM) {
  return startHHMM >= "08:00" && startHHMM < "16:00" ? "day" : "night";
}

function pickEliteServiceId(config, realDateIso, startHHMM) {
  const dayType = getDayType(realDateIso);
  const band = getDayBand(startHHMM);
  const id = config.services?.elite?.[dayType]?.[band];
  if (!id) {
    throw new Error(`Missing elite service_id for ${dayType}/${band}`);
  }
  return id;
}

function pickComfortServiceId(config, group, realDateIso, startHHMM) {
  const dayType = getDayType(realDateIso);
  const band = getDayBand(startHHMM);
  const id = config.services?.comfort?.[group]?.[dayType]?.[band];
  if (!id) {
    throw new Error(`Missing comfort service_id for ${group}/${dayType}/${band}`);
  }
  return id;
}

// -----------------------------
// Date helpers
// -----------------------------
function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * UI-логика: 00/02/04 относятся к D-1
 */
function realDateForStart(uiDateIso, startHHMM) {
  const hh = Number(startHHMM.slice(0, 2));
  return hh < 6 ? addDaysIso(uiDateIso, -1) : uiDateIso;
}

function shiftMinutes(hhmm, delta) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + delta + 1440) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * 2 часа окна: проверяем 2 слота (start + offset) и (start+60 + offset)
 */
function slotTime1(startHHMM) {
  return shiftMinutes(startHHMM, SLOT_OFFSET_MINUTES);
}
function slotTime2(startHHMM) {
  return shiftMinutes(startHHMM, 60 + SLOT_OFFSET_MINUTES);
}

// -----------------------------
// Rental_times parsing
// -----------------------------
function normalizeRentalTimesPayload(upstreamJson) {
  return Array.isArray(upstreamJson?.data) ? upstreamJson.data : [];
}

function normalizeRoomsPayload(upstreamJson) {
  return Array.isArray(upstreamJson?.data) ? upstreamJson.data : [];
}

function parseDateTime(item) {
  const s = String(item?.date_time || "");
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (!m) return { date: "", time: "" };
  return { date: m[1], time: m[2] };
}

function isFreeItem(it) {
  if (!it) return false;
  const rid = it.rental_id;
  return rid === null || rid === undefined || rid === "" || rid === 0;
}

function slotInfo(it, date, time) {
  if (!it) {
    return {
      date_time: `${date} ${time}`,
      found: false,
      rental_id: null,
      status: "missing",
    };
  }
  return {
    date_time: `${date} ${time}`,
    found: true,
    rental_id: it?.rental_id ?? null,
    status: isFreeItem(it) ? "free" : "busy",
  };
}

function pickPrice(it1, it2) {
  const p1 = it1 && typeof it1.price === "number" ? it1.price : null;
  if (p1 !== null) return p1;
  const p2 = it2 && typeof it2.price === "number" ? it2.price : null;
  return p2;
}

async function fetchIndexedRentalTimes({
  club_id,
  service_id,
  room_id,
  start_date,
  end_date,
}) {
  const upstream = await apiGet(RENTAL_TIMES_PATH, {
    club_id,
    service_id,
    room_id,
    start_date,
    end_date,
  });
  const items = normalizeRentalTimesPayload(upstream);

  const byKey = new Map(); // "YYYY-MM-DD|HH:MM" -> item
  for (const it of items) {
    const { date: d, time: t } = parseDateTime(it);
    if (!d || !t) continue;
    byKey.set(`${d}|${t}`, it);
  }
  return byKey;
}

async function fetchRooms(club_id) {
  const upstream = await apiGet(RENTAL_ROOMS_PATH, { club_id });
  return normalizeRoomsPayload(upstream);
}

function evaluateRoomStatus(slot1, slot2) {
  if (slot1.status === "missing" || slot2.status === "missing") {
    return { status: "missing", reason: "slot_missing" };
  }
  if (slot1.status === "busy" || slot2.status === "busy") {
    return { status: "busy", reason: "occupied" };
  }
  return { status: "free", reason: null };
}

// -----------------------------
// Slots grid
// -----------------------------
const STARTS = [
  "06:00",
  "08:00",
  "10:00",
  "12:00",
  "14:00",
  "16:00",
  "18:00",
  "20:00",
  "22:00",
  "00:00",
  "02:00",
  "04:00",
];

// -----------------------------
// Health
// -----------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// -----------------------------
// rental_times proxy
// -----------------------------
app.get("/api/rental_times", async (req, res) => {
  const { club_id, service_id, room_id, start_date, end_date } = req.query;

  if (!club_id) return res.status(400).json({ error: "Missing club_id" });
  if (!service_id) return res.status(400).json({ error: "Missing service_id" });

  const q = { club_id, service_id, room_id };
  if (start_date) {
    if (!isIsoDate(String(start_date)))
      return res.status(400).json({ error: "Invalid start_date (YYYY-MM-DD)" });
    q.start_date = String(start_date);
  }
  if (end_date) {
    if (!isIsoDate(String(end_date)))
      return res.status(400).json({ error: "Invalid end_date (YYYY-MM-DD)" });
    q.end_date = String(end_date);
  }

  try {
    const data = await apiGet(RENTAL_TIMES_PATH, q);
    return res.json(data);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message, upstream: e.details });
  }
});

// -----------------------------
// rental_rooms proxy
// -----------------------------
app.get("/api/rental_rooms", async (req, res) => {
  const { club_id } = req.query;

  if (!club_id) return res.status(400).json({ error: "Missing club_id" });

  try {
    const data = await apiGet(RENTAL_ROOMS_PATH, { club_id });
    return res.json(data);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message, upstream: e.details });
  }
});

/**
 * ELITE grid (room_id + service_id)
 * GET /api/availability_grid_elite?club_id=...&date=YYYY-MM-DD
 */
app.get("/api/availability_grid_elite", async (req, res) => {
  const club_id = req.query.club_id || process.env.DEFAULT_CLUB_ID;
  const date = req.query.date;

  if (!club_id) return res.status(400).json({ error: "Missing club_id" });
  if (!isIsoDate(String(date)))
    return res.status(400).json({ error: "Missing/invalid date (YYYY-MM-DD)" });

  const uiDate = String(date);
  const start_date = addDaysIso(uiDate, -1);
  const end_date = addDaysIso(uiDate, +1);

  try {
    const config = await loadConfig();
    const { elite } = splitRooms(config.rooms);
    if (!elite?.id)
      return res
        .status(500)
        .json({ error: "Elite room not found in rooms_services.json" });

    const meta = [];
    const pairs = new Map();

    for (const start of STARTS) {
      const realDate = realDateForStart(uiDate, start);
      const sid = pickEliteServiceId(config, realDate, start);
      const key = `${sid}|${elite.id}`;
      pairs.set(key, { service_id: sid, room_id: elite.id });
      meta.push({ start, realDate, service_id: sid, room_id: elite.id });
    }

    const idxByPair = new Map();
    await Promise.all(
      Array.from(pairs.values()).map(async (p) => {
        const byKey = await fetchIndexedRentalTimes({
          club_id,
          service_id: p.service_id,
          room_id: p.room_id,
          start_date,
          end_date,
        });
        idxByPair.set(`${p.service_id}|${p.room_id}`, byKey);
      })
    );

    const grid = {};
    for (const m of meta) {
      const t1 = slotTime1(m.start);
      const t2 = slotTime2(m.start);
      const byKey = idxByPair.get(`${m.service_id}|${m.room_id}`);

      const it1 = byKey ? byKey.get(`${m.realDate}|${t1}`) : null;
      const it2 = byKey ? byKey.get(`${m.realDate}|${t2}`) : null;

      const slot1 = slotInfo(it1, m.realDate, t1);
      const slot2 = slotInfo(it2, m.realDate, t2);

      const status = evaluateRoomStatus(slot1, slot2);
      const free = status.status === "free" ? 1 : 0;
      const price = pickPrice(it1, it2);

      grid[m.start] = {
        free,
        price,
        service_id: m.service_id,
        room_id: m.room_id,
        total_count: 1,
        reason: status.reason,
      };
    }

    return res.json({
      result: true,
      kind: "elite",
      service_name: "Элит",
      club_id,
      date: uiDate,
      slot_minutes: 120,
      slot_offset_minutes: SLOT_OFFSET_MINUTES,
      upstream_range: { start_date, end_date },
      grid,
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      error: e.message || "Backend error",
      upstream: e.details || undefined,
    });
  }
});

/**
 * COMFORT grid (room_id + service_id)
 * GET /api/availability_grid_comfort?club_id=...&date=YYYY-MM-DD
 */
app.get("/api/availability_grid_comfort", async (req, res) => {
  const club_id = req.query.club_id || process.env.DEFAULT_CLUB_ID;
  const date = req.query.date;

  if (!club_id) return res.status(400).json({ error: "Missing club_id" });
  if (!isIsoDate(String(date)))
    return res.status(400).json({ error: "Missing/invalid date (YYYY-MM-DD)" });

  const uiDate = String(date);
  const start_date = addDaysIso(uiDate, -1);
  const end_date = addDaysIso(uiDate, +1);

  try {
    const config = await loadConfig();
    const { comfort } = splitRooms(config.rooms);

    if (!comfort.length) {
      return res
        .status(500)
        .json({ error: "Comfort rooms not found in rooms_services.json" });
    }

    const meta = [];
    const pairs = new Map();

    for (const start of STARTS) {
      const realDate = realDateForStart(uiDate, start);

      for (const room of comfort) {
        const sid = pickComfortServiceId(config, room.group, realDate, start);
        const key = `${sid}|${room.id}`;
        pairs.set(key, { service_id: sid, room_id: room.id });
        meta.push({ start, realDate, service_id: sid, room_id: room.id });
      }
    }

    const idxByPair = new Map();
    await Promise.all(
      Array.from(pairs.values()).map(async (p) => {
        const byKey = await fetchIndexedRentalTimes({
          club_id,
          service_id: p.service_id,
          room_id: p.room_id,
          start_date,
          end_date,
        });
        idxByPair.set(`${p.service_id}|${p.room_id}`, byKey);
      })
    );

    const grid = {};
    for (const start of STARTS) {
      const realDate = realDateForStart(uiDate, start);
      const t1 = slotTime1(start);
      const t2 = slotTime2(start);

      let free_count = 0;
      let busy_count = 0;
      let min_price = null;

      for (const room of comfort) {
        const sid = pickComfortServiceId(config, room.group, realDate, start);
        const byKey = idxByPair.get(`${sid}|${room.id}`);

        const it1 = byKey ? byKey.get(`${realDate}|${t1}`) : null;
        const it2 = byKey ? byKey.get(`${realDate}|${t2}`) : null;

        const slot1 = slotInfo(it1, realDate, t1);
        const slot2 = slotInfo(it2, realDate, t2);

        const status = evaluateRoomStatus(slot1, slot2);
        if (status.status === "free") {
          free_count += 1;
          const price = pickPrice(it1, it2);
          if (price !== null)
            min_price = min_price === null ? price : Math.min(min_price, price);
        } else {
          busy_count += 1;
        }
      }

      grid[start] = {
        free_count,
        busy_count,
        total_count: comfort.length,
        min_price,
      };
    }

    return res.json({
      result: true,
      kind: "comfort",
      service_name: "Комфорт",
      club_id,
      date: uiDate,
      slot_minutes: 120,
      slot_offset_minutes: SLOT_OFFSET_MINUTES,
      upstream_range: { start_date, end_date },
      grid,
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      error: e.message || "Backend error",
      upstream: e.details || undefined,
    });
  }
});

/**
 * DEBUG: статус комнат на конкретный слот
 * GET /api/debug_room_status?club_id=...&date=YYYY-MM-DD&time=HH:MM&status=free|busy|all
 */
app.get("/api/debug_room_status", async (req, res) => {
  const club_id = req.query.club_id || process.env.DEFAULT_CLUB_ID;
  const date = req.query.date;
  const time = req.query.time;
  const status = String(req.query.status || "all").toLowerCase();

  if (!club_id) return res.status(400).json({ error: "Missing club_id" });
  if (!isIsoDate(String(date)))
    return res.status(400).json({ error: "Missing/invalid date (YYYY-MM-DD)" });
  if (!/^\d{2}:\d{2}$/.test(String(time)))
    return res.status(400).json({ error: "Missing/invalid time (HH:MM)" });
  if (!["all", "free", "busy"].includes(status))
    return res.status(400).json({ error: "Invalid status (all|free|busy)" });

  const uiDate = String(date);
  const start_time = String(time);
  const realDate = realDateForStart(uiDate, start_time);
  const t1 = slotTime1(start_time);
  const t2 = slotTime2(start_time);

  const start_date = addDaysIso(uiDate, -1);
  const end_date = addDaysIso(uiDate, +1);

  try {
    const config = await loadConfig();
    const { comfort, elite } = splitRooms(config.rooms);

    const result = {
      club_id,
      date: uiDate,
      time: start_time,
      real_date: realDate,
      slots: [t1, t2],
      comfort: [],
      elite: null,
    };

    for (const room of comfort) {
      const sid = pickComfortServiceId(config, room.group, realDate, start_time);
      const byKey = await fetchIndexedRentalTimes({
        club_id,
        service_id: sid,
        room_id: room.id,
        start_date,
        end_date,
      });

      const it1 = byKey.get(`${realDate}|${t1}`);
      const it2 = byKey.get(`${realDate}|${t2}`);
      const slot1 = slotInfo(it1, realDate, t1);
      const slot2 = slotInfo(it2, realDate, t2);

      const statusObj = evaluateRoomStatus(slot1, slot2);

      if (status === "free" && statusObj.status !== "free") continue;
      if (status === "busy" && statusObj.status === "free") continue;

      result.comfort.push({
        room_id: room.id,
        room_title: room.title,
        group: room.group,
        service_id: sid,
        slot1,
        slot2,
        free: statusObj.status === "free",
        reason: statusObj.reason,
      });
    }

    if (elite?.id) {
      const sid = pickEliteServiceId(config, realDate, start_time);
      const byKey = await fetchIndexedRentalTimes({
        club_id,
        service_id: sid,
        room_id: elite.id,
        start_date,
        end_date,
      });

      const it1 = byKey.get(`${realDate}|${t1}`);
      const it2 = byKey.get(`${realDate}|${t2}`);
      const slot1 = slotInfo(it1, realDate, t1);
      const slot2 = slotInfo(it2, realDate, t2);

      const statusObj = evaluateRoomStatus(slot1, slot2);

      if (
        status === "all" ||
        (status === "free" && statusObj.status === "free") ||
        (status === "busy" && statusObj.status !== "free")
      ) {
        result.elite = {
          room_id: elite.id,
          room_title: elite.title,
          service_id: sid,
          slot1,
          slot2,
          free: statusObj.status === "free",
          reason: statusObj.reason,
        };
      }
    }

    return res.json(result);
  } catch (e) {
    const statusCode = e.status || 500;
    return res.status(statusCode).json({
      error: e.message || "Backend error",
      upstream: e.details || undefined,
    });
  }
});

/**
 * DEBUG TABLE: упрощённая таблица для сравнения
 * GET /api/debug_room_status_table?club_id=...&date=YYYY-MM-DD&time=HH:MM&status=free|busy|all
 */
app.get("/api/debug_room_status_table", async (req, res) => {
  const club_id = req.query.club_id || process.env.DEFAULT_CLUB_ID;
  const date = req.query.date;
  const time = req.query.time;
  const status = String(req.query.status || "all").toLowerCase();

  if (!club_id) return res.status(400).json({ error: "Missing club_id" });
  if (!isIsoDate(String(date)))
    return res.status(400).json({ error: "Missing/invalid date (YYYY-MM-DD)" });
  if (!/^\d{2}:\d{2}$/.test(String(time)))
    return res.status(400).json({ error: "Missing/invalid time (HH:MM)" });
  if (!["all", "free", "busy"].includes(status))
    return res.status(400).json({ error: "Invalid status (all|free|busy)" });

  const uiDate = String(date);
  const start_time = String(time);
  const realDate = realDateForStart(uiDate, start_time);
  const t1 = slotTime1(start_time);
  const t2 = slotTime2(start_time);

  const start_date = addDaysIso(uiDate, -1);
  const end_date = addDaysIso(uiDate, +1);

  try {
    const config = await loadConfig();
    const { comfort } = splitRooms(config.rooms);

    const rows = [];

    for (const room of comfort) {
      const sid = pickComfortServiceId(config, room.group, realDate, start_time);
      const byKey = await fetchIndexedRentalTimes({
        club_id,
        service_id: sid,
        room_id: room.id,
        start_date,
        end_date,
      });

      const it1 = byKey.get(`${realDate}|${t1}`);
      const it2 = byKey.get(`${realDate}|${t2}`);
      const slot1 = slotInfo(it1, realDate, t1);
      const slot2 = slotInfo(it2, realDate, t2);

      const statusObj = evaluateRoomStatus(slot1, slot2);

      if (status === "free" && statusObj.status !== "free") continue;
      if (status === "busy" && statusObj.status === "free") continue;

      rows.push({
        room_title: room.title,
        room_id: room.id,
        group: room.group,
        service_id: sid,
        slot1_status: slot1.status,
        slot2_status: slot2.status,
        free: statusObj.status === "free",
        reason: statusObj.reason,
      });
    }

    return res.json({
      club_id,
      date: uiDate,
      time: start_time,
      real_date: realDate,
      slots: [t1, t2],
      rows,
    });
  } catch (e) {
    const statusCode = e.status || 500;
    return res.status(statusCode).json({
      error: e.message || "Backend error",
      upstream: e.details || undefined,
    });
  }
});

/**
 * DEBUG DAY TABLE: таблица на весь день (strict by rental_times)
 * GET /api/debug_day_table?club_id=...&date=YYYY-MM-DD
 * Ответ: text/plain
 */
app.get("/api/debug_day_table", async (req, res) => {
  const club_id = req.query.club_id || process.env.DEFAULT_CLUB_ID;
  const date = req.query.date;

  if (!club_id) return res.status(400).json({ error: "Missing club_id" });
  if (!isIsoDate(String(date)))
    return res.status(400).json({ error: "Missing/invalid date (YYYY-MM-DD)" });

  const uiDate = String(date);
  const start_date = addDaysIso(uiDate, -1);
  const end_date = addDaysIso(uiDate, +1);

  try {
    const config = await loadConfig();
    const { comfort, elite } = splitRooms(config.rooms);
    const allRooms = [...comfort, ...(elite ? [elite] : [])];

    const pairs = new Map();
    for (const start of STARTS) {
      const realDate = realDateForStart(uiDate, start);
      for (const room of allRooms) {
        const sid =
          room.type === "elite"
            ? pickEliteServiceId(config, realDate, start)
            : pickComfortServiceId(config, room.group, realDate, start);
        const key = `${sid}|${room.id}`;
        pairs.set(key, { service_id: sid, room_id: room.id });
      }
    }

    const idxByPair = new Map();
    await Promise.all(
      Array.from(pairs.values()).map(async (p) => {
        const byKey = await fetchIndexedRentalTimes({
          club_id,
          service_id: p.service_id,
          room_id: p.room_id,
          start_date,
          end_date,
        });
        idxByPair.set(`${p.service_id}|${p.room_id}`, byKey);
      })
    );

    const roomWidth = Math.max(
      16,
      ...allRooms.map((r) => String(r.title || "").length)
    );
    const timeWidth = 5;

    const pad = (s, w) => String(s).padEnd(w, " ");
    const headers = ["ROOM", ...STARTS]
      .map((h, i) => pad(h, i === 0 ? roomWidth : timeWidth))
      .join(" | ");
    const sep = "-".repeat(headers.length);

    const lines = [];
    lines.push(`DATE: ${uiDate}`);
    lines.push(`SLOT_OFFSET_MINUTES: ${SLOT_OFFSET_MINUTES}`);
    lines.push("LEGEND: F=free, B=busy, M=missing");
    lines.push(sep);
    lines.push(headers);
    lines.push(sep);

    for (const room of allRooms) {
      const row = [];
      row.push(pad(room.title, roomWidth));

      for (const start of STARTS) {
        const realDate = realDateForStart(uiDate, start);
        const t1 = slotTime1(start);
        const t2 = slotTime2(start);
        const sid =
          room.type === "elite"
            ? pickEliteServiceId(config, realDate, start)
            : pickComfortServiceId(config, room.group, realDate, start);

        const byKey = idxByPair.get(`${sid}|${room.id}`);
        const it1 = byKey ? byKey.get(`${realDate}|${t1}`) : null;
        const it2 = byKey ? byKey.get(`${realDate}|${t2}`) : null;

        const slot1 = slotInfo(it1, realDate, t1);
        const slot2 = slotInfo(it2, realDate, t2);
        const status = evaluateRoomStatus(slot1, slot2);

        const cell =
          status.status === "free"
            ? "F"
            : status.status === "busy"
              ? "B"
              : "M";
        row.push(pad(cell, timeWidth));
      }

      lines.push(row.join(" | "));
    }

    lines.push(sep);
    res.type("text/plain").send(lines.join("\n"));
  } catch (e) {
    const statusCode = e.status || 500;
    return res.status(statusCode).json({
      error: e.message || "Backend error",
      upstream: e.details || undefined,
    });
  }
});

/**
 * DEBUG DAY RAW: список всех date_time, которые реально пришли от 1C
 * GET /api/debug_day_table_raw?club_id=...&date=YYYY-MM-DD
 * Ответ: text/plain
 */
app.get("/api/debug_day_table_raw", async (req, res) => {
  const club_id = req.query.club_id || process.env.DEFAULT_CLUB_ID;
  const date = req.query.date;

  if (!club_id) return res.status(400).json({ error: "Missing club_id" });
  if (!isIsoDate(String(date)))
    return res.status(400).json({ error: "Missing/invalid date (YYYY-MM-DD)" });

  const uiDate = String(date);
  const start_date = addDaysIso(uiDate, -1);
  const end_date = addDaysIso(uiDate, +1);

  try {
    const config = await loadConfig();
    const { comfort, elite } = splitRooms(config.rooms);
    const allRooms = [...comfort, ...(elite ? [elite] : [])];

    const pairs = new Map();
    for (const start of STARTS) {
      const realDate = realDateForStart(uiDate, start);
      for (const room of allRooms) {
        const sid =
          room.type === "elite"
            ? pickEliteServiceId(config, realDate, start)
            : pickComfortServiceId(config, room.group, realDate, start);
        const key = `${sid}|${room.id}`;
        pairs.set(key, { service_id: sid, room_id: room.id });
      }
    }

    const idxByPair = new Map();
    await Promise.all(
      Array.from(pairs.values()).map(async (p) => {
        const byKey = await fetchIndexedRentalTimes({
          club_id,
          service_id: p.service_id,
          room_id: p.room_id,
          start_date,
          end_date,
        });
        idxByPair.set(`${p.service_id}|${p.room_id}`, byKey);
      })
    );

    const lines = [];
    lines.push(`DATE: ${uiDate}`);
    lines.push(`SLOT_OFFSET_MINUTES: ${SLOT_OFFSET_MINUTES}`);
    lines.push("RAW date_time values from 1C (rental_times)");
    lines.push("------------------------------------------------------------");

    for (const room of allRooms) {
      lines.push(`ROOM: ${room.title} (${room.id})`);
      const items = [];

      for (const start of STARTS) {
        const realDate = realDateForStart(uiDate, start);
        const t1 = slotTime1(start);
        const t2 = slotTime2(start);

        const sid =
          room.type === "elite"
            ? pickEliteServiceId(config, realDate, start)
            : pickComfortServiceId(config, room.group, realDate, start);

        const byKey = idxByPair.get(`${sid}|${room.id}`);
        const it1 = byKey ? byKey.get(`${realDate}|${t1}`) : null;
        const it2 = byKey ? byKey.get(`${realDate}|${t2}`) : null;

        if (it1) items.push(`${realDate} ${t1}`);
        if (it2) items.push(`${realDate} ${t2}`);
      }

      const unique = Array.from(new Set(items)).sort();
      if (!unique.length) {
        lines.push("  (no slots returned)");
      } else {
        for (const dt of unique) lines.push(`  - ${dt}`);
      }
      lines.push("");
    }

    res.type("text/plain").send(lines.join("\n"));
  } catch (e) {
    const statusCode = e.status || 500;
    return res.status(statusCode).json({
      error: e.message || "Backend error",
      upstream: e.details || undefined,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend started: http://127.0.0.1:${PORT}`);
});