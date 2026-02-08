import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

export type Slot = {
  start_date: string; // "YYYY-MM-DDTHH:mm:ss"
  appointment_id: string | null;
  serviceId: string; // "elite" | "comfort" | ...
  serviceName: string; // "Элит" | ...
  free: number;
  total: number;
  price?: number | null; // цена из availability_grid_elite
  service_upstream_id?: string; // реальный service_id (если передаёшь)
};

const BASE = (import.meta as any).env?.BASE_URL ?? "/";
const p = (path: string) => `${BASE}${path.replace(/^\//, "")}`;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/** Без Date(): чтобы TZ браузера не ломал дату */
function fmtDateFromStartIso(startIso: string) {
  const m = String(startIso).match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return startIso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** "HH:MM - HH:MM" из startIso, без Date() */
function fmtRangeFromStartIso(startIso: string) {
  const hhmm = String(startIso).slice(11, 16);
  const [h, m] = hhmm.split(":").map(Number);
  const endH = (h + 2) % 24;
  return `${hhmm} - ${pad2(endH)}:${pad2(m)}`;
}

function formatRUB(amount: number) {
  return new Intl.NumberFormat("ru-RU").format(amount) + " ₽";
}

function normalizePhoneDigits(s: string) {
  return s.replace(/\D/g, "");
}

function formatPhoneRu(raw: string) {
  // ожидаем 10 цифр (без +7)
  const d = normalizePhoneDigits(raw).slice(0, 10);
  const a = d.slice(0, 3);
  const b = d.slice(3, 6);
  const c = d.slice(6, 8);
  const e = d.slice(8, 10);

  let out = "";
  if (a) out += a;
  if (b) out += (out ? " " : "") + b;
  if (c) out += (out ? "-" : "") + c;
  if (e) out += (out ? "-" : "") + e;
  return out;
}

export default function BookingModal({
  open,
  slot,
  onClose,
  onRequestSms,
}: {
  open: boolean;
  slot: Slot | null;
  onClose: () => void;
  /** хук под твой бек: отправка СМС */
  onRequestSms?: (p: {
    phoneE164: string; // +7999...
    slot: Slot;
  }) => Promise<void> | void;
}) {
  const photoByService: Record<string, string> = useMemo(
    () => ({
      comfort_elite: p("rooms/svc-1.jpg"),
      comfort: p("rooms/svc-1.jpg"),
      elite: p("rooms/svc-5.jpg"),
      lux: p("rooms/svc-2.jpg"),
      premium: p("rooms/svc-3.jpg"),
      sauna: p("rooms/svc-4.jpg"),
    }),
    []
  );

  const photo = useMemo(() => {
    const sid = slot?.serviceId || "elite";
    return photoByService[sid] ?? p("rooms/svc-5.jpg");
  }, [slot?.serviceId, photoByService]);

  const [imgOk, setImgOk] = useState(true);
  useEffect(() => setImgOk(true), [photo, open]);

  const price = useMemo(() => {
    if (!slot) return null;
    return typeof slot.price === "number" && Number.isFinite(slot.price) ? slot.price : null;
  }, [slot]);

  // phone (10 digits after +7)
  const [phone10, setPhone10] = useState("");
  useEffect(() => {
    if (!open) return;
    setPhone10("");
    setStatus("idle");
    setErrorText("");
  }, [open]);

  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorText, setErrorText] = useState("");

  const canSend = useMemo(() => {
    const d = normalizePhoneDigits(phone10);
    return d.length === 10 && status !== "sending";
  }, [phone10, status]);

  const phoneE164 = useMemo(() => {
    const d = normalizePhoneDigits(phone10).slice(0, 10);
    return `+7${d}`;
  }, [phone10]);

  // ESC + lock scroll
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  async function handleSend() {
    if (!slot) return;
    if (!canSend) return;

    setStatus("sending");
    setErrorText("");

    try {
      await onRequestSms?.({ phoneE164, slot });
      setStatus("sent");
    } catch (e: any) {
      setStatus("error");
      setErrorText(e?.message || "Не удалось забронировать");
    }
  }

  if (!open || !slot) return null;

  const titleLine =
    slot.serviceName ||
    (slot.serviceId === "elite" ? "Элит" : slot.serviceId === "comfort" ? "Комфорт" : slot.serviceId);

  return createPortal(
    <div className="bm-overlay" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div className="bm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bm-head">
          <div className="bm-title">БРОНИРОВАНИЕ</div>
          <button className="bm-close" onClick={onClose} aria-label="Закрыть" type="button">
            ✕
          </button>
        </div>

        <div className="bm-photo">
          {imgOk ? (
            <img src={photo} alt="" onError={() => setImgOk(false)} />
          ) : (
            <div className="bm-photo__placeholder">
              Нет фото. Проверь файлы в <b>public/rooms</b>
            </div>
          )}

          {price != null && <div className="bm-price">{formatRUB(price)}</div>}
        </div>

        <div className="bm-sub">
          <div className="bm-line">{titleLine}</div>
          <div className="bm-line">
            {fmtDateFromStartIso(slot.start_date)}, {fmtRangeFromStartIso(slot.start_date)}
          </div>
          <div className="bm-line">Свободно: {slot.free}</div>

          {/* полезно для отладки: какой upstream service_id выбран */}
          {slot.service_upstream_id && (
            <div className="bm-line bm-line--muted">service_id: {slot.service_upstream_id}</div>
          )}

          {price == null && <div className="bm-line bm-line--warn">Цена не получена из API</div>}
        </div>

        <div className="bm-form">
          <div className={`bm-phone ${status === "error" ? "is-error" : ""}`}>
            <span className="bm-plus">+7</span>
            <input
              className="bm-input"
              inputMode="tel"
              value={formatPhoneRu(phone10)}
              onChange={(e) => setPhone10(e.target.value)}
              placeholder="999 123-45-67"
              aria-label="Телефон"
              autoFocus
            />
          </div>

          {errorText && <div className="bm-error">{errorText}</div>}
          {status === "sent" && <div className="bm-ok">Заявка отправлена</div>}

          <button className="bm-btn" type="button" disabled>
            {status === "sending" ? "БРОНИРОВАНИЕ..." : "ЗАБРОНИРОВАТЬ"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
