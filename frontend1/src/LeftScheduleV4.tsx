import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDays, formatRu, kaz_local_to_utc_ms, todayIso } from "../utils/date";

export type Slot = {
  start_date: string; // realDateIso + time
  appointment_id: string | null;
  serviceId: "comfort" | "elite" | string;
  serviceName: string;
  free: number;
  total: number;
  price?: number | null; // only for elite
};

type Props = {
  dateIso: string;
  onDateChange?: (iso: string) => void;
  selected?: Slot | null;
  onSelect: (slot: Slot) => void;
  onSlotClick?: (slot: Slot) => void;
  allowedServiceIds?: string[] | null; // column keys (comfort_elite, lux, premium, sauna)
  filtersCount?: number;
};

type Service = { id: string; title: string; total: number };
type V3Column = { key: string; title: string; totalLabel: string; svcIds: string[]; img: string };

// ===== UI CONSTS (оставил твой стиль) =====
const V3_ACCENT = "#0EA5A4";
const V3_BG = "linear-gradient(180deg, rgba(189, 189, 189, 0.78), rgba(255,255,255,0.92))";
const V3_CARD = "rgba(255,255,255,0.62)";
const V3_RADIUS = 22;
const V3_FONT_SIZE = 15;
const V3_FONT = "Lora";
const V3_STAGGER_STEP_MS = 10;
const V3_STAGGER_CAP_MS = 240;

const BASE = (import.meta as any).env?.BASE_URL ?? "/";
const p = (path: string) => `${BASE}${path.replace(/^\//, "")}`;
const V3_BG_PHOTO_URL = p("img/schedule-bg.jpg");

// ===== API =====
const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "/aok5/api";
const CLUB_ID = (import.meta as any).env?.VITE_CLUB_ID ?? "63fbc47b-d691-11ec-840b-00155d0a6605";
const apiUrl = (path: string) => `${API_BASE.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;

type EliteGridCell = {
  free: number;
  price: number | null;
  service_id?: string;
  room_id?: string;
  total_count?: number;
  reason?: string | null;
};
type EliteAvailabilityGridResponse = {
  result: boolean;
  club_id: string;
  date: string;
  slot_minutes: number;
  grid: Record<string, EliteGridCell>;
};

type ComfortGridCell = {
  free_count: number;
  total_count: number;
  busy_count?: number;
  min_price: number | null;
};
type ComfortAvailabilityGridResponse = {
  result: boolean;
  club_id: string;
  date: string;
  slot_minutes: number;
  grid: Record<string, ComfortGridCell>;
};

const BASE_SERVICES: Service[] = [
  { id: "comfort", title: "Комфорт", total: 0 },
  { id: "elite", title: "Элит", total: 0 },
  { id: "lux", title: "Люкс", total: 18 },
  { id: "premium", title: "Премиум", total: 6 },
  { id: "sauna", title: "Сауна", total: 4 },
];

const COMFORT_TOTAL = 8;
const ELITE_TOTAL = 1;

const V3_COLUMNS: V3Column[] = [
  {
    key: "comfort_elite",
    title: "КОМФОРТ \n + \n ЭЛИТ",
    totalLabel: "—",
    svcIds: ["comfort", "elite"],
    img: p("rooms/svc-1.jpg"),
  },
  { key: "lux", title: "ЛЮКС", totalLabel: "18", svcIds: ["lux"], img: p("rooms/svc-2.jpg") },
  { key: "premium", title: "ПРЕМИУМ", totalLabel: "6", svcIds: ["premium"], img: p("rooms/svc-3.jpg") },
  { key: "sauna", title: "САУНА", totalLabel: "4", svcIds: ["sauna"], img: p("rooms/svc-4.jpg") },
];

// УТРО/НОЧЬ — секции, 10–22 — всегда
const MORNING_STARTS = ["06:00", "08:00"] as const;
const DAY_STARTS = ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00"] as const;
const NIGHT_STARTS = ["22:00", "00:00", "02:00", "04:00"] as const;
type SectionKey = "morning" | "night";

const SERVICE_DESCRIPTIONS: Partial<Record<string, string>> = {
  comfort: `Комфорт (8 номеров):
• Комфорт №1
• Комфорт №2
• Комфорт №3
• Комфорт №4
• Комфорт №5
• Комфорт №6
• Комфорт №7
• Комфорт №8`,
  elite: `Элит (1 номер):
• Элит №9`,
};

function capFirst(s: string) {
  if (!s) return s;
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

function formatDayPillParts(iso: string) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { date: iso, weekday: "" };

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));

  const dd = String(d).padStart(2, "0");
  const mm = String(mo).padStart(2, "0");
  const weekday = capFirst(new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "Europe/Moscow" }).format(dt));
  return { date: `${dd}.${mm}`, weekday };
}

function rangeLabel(startHHMM: string) {
  const [h, m] = startHHMM.split(":").map(Number);
  const endH = (h + 2) % 24;
  // На мобильной версии включаем CSS white-space: pre-line для .xls-time,
  // чтобы получить формат:
  // 12:00
  // 14:00
  return `${startHHMM}\n${String(endH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function renderTitleWithBreaks(title: string) {
  if (!title.includes("\n")) return title;
  return title.split("\n").map((t, i, arr) => (
    <React.Fragment key={i}>
      {t}
      {i < arr.length - 1 && <br />}
    </React.Fragment>
  ));
}

/** 00/02/04 относятся к D-1 */
function cellDateIso(dateIso: string, startHHMM: string) {
  const hh = Number(startHHMM.slice(0, 2));
  if (hh < 6) return addDays(dateIso, -1);
  return dateIso;
}

function cellStartIso(realDateIso: string, startHHMM: string) {
  return `${realDateIso}T${startHHMM}:00`;
}

function isPastSlotKazan(realDateIso: string, startHHMM: string) {
  const slotUtcMs = kaz_local_to_utc_ms(realDateIso, startHHMM);
  return slotUtcMs < Date.now();
}

/** фейк только для остальных колонок */
function fakeFree(dateIso: string, startHHMM: string, service: Service) {
  const weekday = new Date(`${dateIso}T00:00:00`).getDay();
  if (service.id === "lux" && startHHMM === "12:00") return 0;
  if (service.id === "sauna" && startHHMM === "18:00") return 0;
  if (service.id === "premium" && weekday === 5 && startHHMM === "20:00") return 0;

  const seed =
    (Number(dateIso.slice(-2)) +
      Number(startHHMM.slice(0, 2)) * 3 +
      Number(startHHMM.slice(3, 5)) +
      service.id.length * 7) %
    11;

  const base = Math.max(0, service.total - (seed % Math.max(1, Math.floor(service.total / 2))));
  return Math.min(service.total, base);
}

export default function LeftScheduleV4({
  dateIso,
  onDateChange,
  selected,
  onSelect,
  onSlotClick,
  allowedServiceIds,
  filtersCount = 0,
}: Props) {
  const today = useMemo(() => todayIso(), []);
  const [stripStartIso, setStripStartIso] = useState(() => dateIso || today);

  useEffect(() => {
    if (stripStartIso > dateIso) setStripStartIso(dateIso);
  }, [dateIso, stripStartIso]);

  const [openKey, setOpenKey] = useState<SectionKey | null>(null);
  // Фон: оставляем только градиент (переключатель убран)
  const bgMode: "gradient" = "gradient";

  const [tip, setTip] = useState<null | { x: number; y: number; col: V3Column; dateIso: string; start: string; freeText: string }>(null);
  const hoverTimer = useRef<number | null>(null);

  const [svcInfo, setSvcInfo] = useState<null | { title: string; text: string }>(null);

  useEffect(() => {
    if (!svcInfo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSvcInfo(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [svcInfo]);

  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    setSwitching(true);
    const t = window.setTimeout(() => setSwitching(false), 180);
    return () => window.clearTimeout(t);
  }, [dateIso]);

  // ===== ELITE GRID =====
  const [eliteGrid, setEliteGrid] = useState<Record<string, EliteGridCell>>({});
  const [eliteGridDate, setEliteGridDate] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function loadEliteGrid() {
      try {
        setEliteGridDate(dateIso);
        const url =
          `${apiUrl("/availability_grid_elite")}` +
          `?club_id=${encodeURIComponent(CLUB_ID)}` +
          `&date=${encodeURIComponent(dateIso)}`;
        const r = await fetch(url, { method: "GET" });
        if (!r.ok) throw new Error(`elite grid http ${r.status}`);
        const j = (await r.json()) as EliteAvailabilityGridResponse;
        if (!cancelled && j?.result && j?.grid) setEliteGrid(j.grid);
        else if (!cancelled) setEliteGrid({});
      } catch {
        if (!cancelled) setEliteGrid({});
      }
    }
    loadEliteGrid();
    return () => {
      cancelled = true;
    };
  }, [dateIso]);

  // ===== COMFORT GRID =====
  const [comfortGrid, setComfortGrid] = useState<Record<string, ComfortGridCell>>({});
  const [comfortGridDate, setComfortGridDate] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function loadComfortGrid() {
      try {
        setComfortGridDate(dateIso);
        const url =
          `${apiUrl("/availability_grid_comfort")}` +
          `?club_id=${encodeURIComponent(CLUB_ID)}` +
          `&date=${encodeURIComponent(dateIso)}`;
        const r = await fetch(url, { method: "GET" });
        if (!r.ok) throw new Error(`comfort grid http ${r.status}`);
        const j = (await r.json()) as ComfortAvailabilityGridResponse;
        if (!cancelled && j?.result && j?.grid) setComfortGrid(j.grid);
        else if (!cancelled) setComfortGrid({});
      } catch {
        if (!cancelled) setComfortGrid({});
      }
    }
    loadComfortGrid();
    return () => {
      cancelled = true;
    };
  }, [dateIso]);

  const eliteFreeForStart = (start: string) => (eliteGridDate !== dateIso ? 0 : eliteGrid[start]?.free ?? 0);
  const elitePriceForStart = (start: string) => (eliteGridDate !== dateIso ? null : eliteGrid[start]?.price ?? null);

  const comfortFreeForStart = (start: string) => (comfortGridDate !== dateIso ? 0 : comfortGrid[start]?.free_count ?? 0);

  const comfortEliteTotalLabel = useMemo(() => `${COMFORT_TOTAL}+${ELITE_TOTAL}`, []);

  // 7 дней
  const weekDays = useMemo(() => {
    const out: { iso: string; isToday: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      const iso = addDays(stripStartIso, i);
      out.push({ iso, isToday: iso === today });
    }
    return out;
  }, [stripStartIso, today]);

  const baseById = useMemo(() => {
    const m = new Map<string, Service>();
    for (const s of BASE_SERVICES) m.set(s.id, s);
    return m;
  }, []);

  const visibleSet = useMemo(() => {
    if (!allowedServiceIds || allowedServiceIds.length === 0) return null;
    return new Set(allowedServiceIds);
  }, [allowedServiceIds]);

  const allColumns = V3_COLUMNS;
  const isVisible = (col: V3Column) => (!visibleSet ? true : visibleSet.has(col.key));
  // Важно: без горизонтальных скроллов. Колонки услуг тянем флексом (1fr),
  // фиксируем только колонку времени.
  const gridCols = useMemo(() => `var(--v3-timeColW) repeat(${allColumns.length}, var(--v3-colW))`, [allColumns.length]);

  const hideTip = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setTip(null);
  };

  const showTip = (e: React.MouseEvent, col: V3Column, slotRealDateIso: string, start: string, freeText: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = 320;
    const h = 270;
    const padPx = 16;
    const x = Math.min(window.innerWidth - w - padPx, r.right + 14);
    const y = Math.min(window.innerHeight - h - padPx, r.top);
    setTip({ x: Math.max(padPx, x), y: Math.max(padPx, y), col, dateIso: slotRealDateIso, start, freeText });
  };

  const openServiceInfo = (serviceId: string) => {
    const text = SERVICE_DESCRIPTIONS[serviceId];
    if (!text) return;
    const title = serviceId === "comfort" ? "Комфорт" : serviceId === "elite" ? "Элит" : serviceId;
    setSvcInfo({ title, text });
  };

  const computeFree = (col: V3Column, realDateIso: string, start: string) => {
    let sum = 0;
    for (const id of col.svcIds) {
      const svc = baseById.get(id);
      if (!svc) continue;
      sum += fakeFree(realDateIso, start, svc);
    }
    return sum;
  };

  const shiftWindow = (dirWeeks: number) => {
    const nextStart = addDays(stripStartIso, dirWeeks * 7);
    const clamped = nextStart < today ? today : nextStart;
    setStripStartIso(clamped);
    onDateChange?.(clamped);
  };

  const hasFilters = filtersCount > 0;
  const morningOpen = openKey === "morning";
  const nightOpen = openKey === "night";

  const renderTimeRows = (starts: readonly string[], rowBaseIndex: number) =>
    starts.map((start, rowIndex) => (
      <div key={start} className="xls-row" style={{ ["--grid-cols" as any]: gridCols } as React.CSSProperties}>
        <div className="xls-time">{rangeLabel(start)}</div>

        {allColumns.map((col, colIndex) => {
          const visible = isVisible(col);

          if (!visible) {
            return (
              <div key={col.key} className="xls-cell">
                <div className="xls-card ghost" aria-hidden />
              </div>
            );
          }

          const realDateIso = cellDateIso(dateIso, start);
          const start_date = cellStartIso(realDateIso, start);
          const past = isPastSlotKazan(realDateIso, start);

          const idx = (rowBaseIndex + rowIndex) * allColumns.length + colIndex;
          const delay = Math.min(idx * V3_STAGGER_STEP_MS, V3_STAGGER_CAP_MS);

          // ===== КОМФОРТ + ЭЛИТ =====
          if (col.key === "comfort_elite") {
            const comfortFree = comfortFreeForStart(start);
            const eliteFree = eliteFreeForStart(start);
            const elitePrice = elitePriceForStart(start);

            const comfortDisabled = comfortFree <= 0 || past;
            const eliteDisabled = eliteFree <= 0 || past;

            const freeText = `${comfortFree} + ${eliteFree}`;
            const hasAny = comfortFree > 0 || eliteFree > 0;
            const availability = hasAny ? "free" : "busy";

            // активность по выбранной услуге
            const activeComfort = selected?.start_date === start_date && selected?.serviceId === "comfort";
            const activeElite = selected?.start_date === start_date && selected?.serviceId === "elite";
            const activeAny = activeComfort || activeElite;

            const bookComfort = () => {
              if (comfortDisabled) return;
              const s: Slot = {
                start_date,
                appointment_id: null,
                serviceId: "comfort",
                serviceName: "Комфорт",
                free: comfortFree,
                total: COMFORT_TOTAL,
              };
              onSelect(s);
              onSlotClick?.(s);
            };

            const bookElite = () => {
              if (eliteDisabled) return;
              const s: Slot = {
                start_date,
                appointment_id: null,
                serviceId: "elite",
                serviceName: "Элит",
                free: eliteFree,
                total: ELITE_TOTAL,
                price: elitePrice,
              };
              onSelect(s);
              onSlotClick?.(s);
            };

            return (
              <div key={col.key} className="xls-cell">
                <div
                  className={`ls-card xls-card ${activeAny ? "active" : ""} ${availability} ${past ? "past" : ""}`}
                  style={{ animationDelay: `${delay}ms` }}
                  onMouseEnter={(e) => {
                    const ev = e;
                    hoverTimer.current = window.setTimeout(() => showTip(ev, col, realDateIso, start, freeText), 160);
                  }}
                  onMouseLeave={hideTip}
                  role="group"
                  aria-label="Комфорт и Элит"
                >
                  <div className="xls-timebar" aria-hidden />
                  <div className="xls-card-main">
                    <div className="v4-free-split" aria-label="Свободно">
                      <button
                        type="button"
                        className={`v4-split-num ${activeComfort ? "is-active" : ""}`}
                        disabled={comfortDisabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          bookComfort();
                        }}
                        title="Бронирование: Комфорт"
                      >
                        {comfortFree}
                      </button>

                      <span className="v4-split-plus">+</span>

                      <button
                        type="button"
                        className={`v4-split-num ${activeElite ? "is-active" : ""}`}
                        disabled={eliteDisabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          bookElite();
                        }}
                        title={elitePrice ? `Бронирование: Элит (${elitePrice} ₽/ч)` : "Бронирование: Элит"}
                      >
                        {eliteFree}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          // ===== остальные колонки (пока фейк) =====
          const free = computeFree(col, realDateIso, start);
          const disabled = free <= 0 || past;
          const availability = free > 0 ? "free" : "busy";
          const active = selected?.serviceId === col.key && selected?.start_date === start_date;

          const totalNum = col.svcIds.reduce((sum, id) => sum + (baseById.get(id)?.total ?? 0), 0);

          return (
            <div key={col.key} className="xls-cell">
              <div
                className={`ls-card xls-card ${active ? "active" : ""} ${availability} ${past ? "past" : ""}`}
                style={{ animationDelay: `${delay}ms` }}
                onClick={() => {
                  if (disabled) return;
                  const s: Slot = {
                    start_date,
                    appointment_id: null,
                    serviceId: col.key,
                    serviceName: col.title,
                    free,
                    total: totalNum,
                  };
                  onSelect(s);
                  onSlotClick?.(s);
                }}
                onMouseEnter={(e) => {
                  const ev = e;
                  hoverTimer.current = window.setTimeout(() => showTip(ev, col, realDateIso, start, String(free)), 160);
                }}
                onMouseLeave={hideTip}
                role="button"
                aria-disabled={disabled}
              >
                <div className="xls-timebar" aria-hidden />
                <div className="xls-card-main">
                  <div className="xls-free xls-free--num">{free}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    ));

  return (
    <div
      className={`ls-root is-v3 is-v4 ${hasFilters ? "has-filters" : ""}`}
      data-bg={bgMode}
      style={
        {
          ["--v3-accent" as any]: V3_ACCENT,
          ["--v3-bg" as any]: V3_BG,
          ["--v3-card" as any]: V3_CARD,
          ["--v3-radius" as any]: `${V3_RADIUS}px`,
          ["--v3-fontSize" as any]: `${V3_FONT_SIZE}px`,
          ["--v3-font" as any]: `${V3_FONT}, ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial`,
          ["--v3-photo-url" as any]: `url("${V3_BG_PHOTO_URL}")`,
        } as React.CSSProperties
      }
    >
      <div className="ls-topbar">
        <div className="ls-title">Свободно</div>

        <div className="ls-week">
          <button className="ui-btn ui-btn--circle" onClick={() => shiftWindow(-1)} disabled={!onDateChange || stripStartIso <= today}>
            ‹
          </button>

          <div className="ls-days" role="tablist" aria-label="Дни">
            {weekDays.map((d) => {
              const lbl = formatDayPillParts(d.iso);
              const active = d.iso === dateIso;
              return (
                <button
                  key={d.iso}
                  className={`ls-daypill ${active ? "active" : ""}`}
                  onClick={() => onDateChange?.(d.iso)}
                  disabled={!onDateChange}
                >
                  <span className={`ls-daypill-label ${d.isToday ? "today" : ""}`}>
                    <span className="ls-daypill-date">{lbl.date}</span>
                    <span className="ls-daypill-weekday">{lbl.weekday}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <button className="ui-btn ui-btn--circle" onClick={() => shiftWindow(+1)} disabled={!onDateChange}>
            ›
          </button>
        </div>

        {/* Переключатель фон/градиент убран: по умолчанию используется градиент */}
      </div>

      <div className={`xls-wrap v3-wrap ${switching ? "v3-swap" : ""}`}>
        <div className="xls-sticky">
          <div className="xls-row xls-head xls-head--merged" style={{ ["--grid-cols" as any]: gridCols } as React.CSSProperties}>
            <div className="xls-corner xls-corner--merged">
              Временные
              <br />
              регламенты
            </div>

            {allColumns.map((c) => {
              const visible = isVisible(c);

              if (c.key === "comfort_elite") {
                return (
                  <div key={c.key} className={`xls-headcell xls-headcell--merged xls-headcell--${c.key} ${visible ? "" : "is-hidden"}`}>
                    <div className="xls-headcell__title">{renderTitleWithBreaks(c.title)}</div>

                    {/* Totals from API grid (fallback to dash while loading) */}
                    <div className="xls-headcell__total v4-total-split" aria-label="Комфорт Элит (всего)">
                      <button
                        type="button"
                        className="v4-split-num"
                        onClick={(e) => {
                          e.stopPropagation();
                          openServiceInfo("comfort");
                        }}
                        aria-label="Описание номеров Комфорт"
                      >
                        {COMFORT_TOTAL}
                      </button>
                      <span className="v4-split-plus">+</span>
                      <button
                        type="button"
                        className="v4-split-num"
                        onClick={(e) => {
                          e.stopPropagation();
                          openServiceInfo("elite");
                        }}
                        aria-label="Описание номера Элит"
                      >
                        {ELITE_TOTAL}
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div key={c.key} className={`xls-headcell xls-headcell--merged xls-headcell--${c.key} ${visible ? "" : "is-hidden"}`}>
                  <div className="xls-headcell__title">{renderTitleWithBreaks(c.title)}</div>
                  <div className="xls-headcell__total">{c.totalLabel}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className={`xls-body ${switching ? "switching" : ""}`} key={dateIso}>
          <div className="xls-section" onClick={() => setOpenKey((prev) => (prev === "morning" ? null : "morning"))} role="button">
            <span className={`xls-arrow ${openKey === "morning" ? "open" : ""}`}>▾</span>
            УТРО
          </div>
          <div className={`xls-acc ${morningOpen ? "open" : ""}`}>{renderTimeRows(MORNING_STARTS, 0)}</div>

          {renderTimeRows(DAY_STARTS, 10)}

          <div className="xls-section" onClick={() => setOpenKey((prev) => (prev === "night" ? null : "night"))} role="button">
            <span className={`xls-arrow ${openKey === "night" ? "open" : ""}`}>▾</span>
            НОЧЬ
          </div>
          <div className={`xls-acc ${nightOpen ? "open" : ""}`}>{renderTimeRows(NIGHT_STARTS, 40)}</div>
        </div>
      </div>

      {tip &&
        createPortal(
          <div className="ls-tooltip" style={{ left: tip.x, top: tip.y }}>
            <img src={tip.col.img} alt="" />
            <div style={{ fontWeight: 900 }}>{tip.col.title}</div>
            <div className="ls-tip-sub">
              {formatRu(tip.dateIso)} • {rangeLabel(tip.start)} • свободно: {tip.freeText} • всего:{" "}
              {tip.col.key === "comfort_elite" ? comfortEliteTotalLabel : tip.col.totalLabel}
            </div>
          </div>,
          document.body
        )}

      {svcInfo &&
        createPortal(
          <div
            className="ls-modal ls-modal--top"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSvcInfo(null);
            }}
            role="dialog"
            aria-modal="true"
          >
            <div className="ls-modal__card">
              <button type="button" className="ls-modal__close" aria-label="Закрыть" onClick={() => setSvcInfo(null)}>
                ×
              </button>
              <div className="ls-modal__text ls-modal__text--only">
                <div style={{ fontWeight: 900, marginBottom: 10 }}>{svcInfo.title}</div>
                {svcInfo.text}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
