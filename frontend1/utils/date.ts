// utils/date.ts
// -----------------------------------------------------------------------------
// ВАЖНО: расписание ориентируется на время Казани.
// Казань находится в часовом поясе MSK (Europe/Moscow, UTC+03:00).
// -----------------------------------------------------------------------------

export const KAZAN_TZ = "Europe/Moscow";

/** Возвращает {y,m,d} как строковые части даты в заданном TZ. */
function partsInTz(d: Date, timeZone: string): { y: string; m: string; d: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return { y, m, d: day };
}

/** ISO YYYY-MM-DD “сегодня” в Казани. */
export function todayIso(): string {
  const { y, m, d } = partsInTz(new Date(), KAZAN_TZ);
  return `${y}-${m}-${d}`;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function parseIso(iso: string): { y: number; m: number; d: number } {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { y: 1970, m: 1, d: 1 };
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** +N дней к ISO-дате (чистая календарная арифметика, без TZ эффектов). */
export function addDays(iso: string, deltaDays: number): string {
  const { y, m, d } = parseIso(iso);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Человекочитаемо: “Пн, 19 янв” (по Казани). */
export function formatRu(iso: string) {
  const { y, m, d } = parseIso(iso);
  // Берём полдень UTC, чтобы гарантированно попасть в нужный календарный день
  // при форматировании в другом timeZone.
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: KAZAN_TZ,
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(dt);
}

/**
 * Конвертация “локального времени Казани” в UTC ms, чтобы сравнивать корректно
 * независимо от часового пояса браузера.
 *
 * dateIso: YYYY-MM-DD
 * hhmm: "06:00"
 */
export function kaz_local_to_utc_ms(dateIso: string, hhmm: string): number {
  const { y, m, d } = parseIso(dateIso);
  const mm = hhmm.match(/^(\d{2}):(\d{2})$/);
  const hh = mm ? Number(mm[1]) : 0;
  const mi = mm ? Number(mm[2]) : 0;

  // MSK = UTC+3 => чтобы получить UTC: вычитаем 3 часа
  const offsetMin = 180;
  const utc = Date.UTC(y, m - 1, d, hh, mi, 0) - offsetMin * 60000;
  return utc;
}

// -----------------------------------
// Старые хелперы (оставлены для совместимости)
// -----------------------------------

export function tariffSlotDateIso(dateIso: string, startHHMM: string) {
  // если 00:00—06:00 → относим к предыдущему дню (как раньше)
  const hh = Number(startHHMM.slice(0, 2));
  if (hh < 6) return addDays(dateIso, -1);
  return dateIso;
}

export function tariffSlotStartIso(dateIso: string, startHHMM: string) {
  const real = tariffSlotDateIso(dateIso, startHHMM);
  return `${real}T${startHHMM}:00`;
}
