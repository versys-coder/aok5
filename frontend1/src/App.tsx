import { useEffect, useState } from "react";
import type { Slot } from "./LeftScheduleV4";
import { tariffSlotStartIso } from "../utils/date";
import LeftScheduleV4 from "./LeftScheduleV4";
import BookingModal from "./BookingModal";

function todayIsoMoscow(): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

export default function App() {
  const [dateIso, setDateIso] = useState<string>(() => todayIsoMoscow());
  const [bookingOpen, setBookingOpen] = useState(false);

  // Стартовый слот — просто чтобы модалка имела структуру.
  const [slot, setSlot] = useState<Slot | null>({
    start_date: `${todayIsoMoscow()}T10:00:00`,
    appointment_id: null,
    serviceId: "comfort_elite",
    serviceName: "Комфорт + Элит",
    free: 0,
    total: 0,
  });

  // При смене даты сохраняем выбранное время.
  useEffect(() => {
    setSlot((prev) => {
      if (!prev) return prev;
      const time = prev.start_date.slice(11, 16) || "10:00";
      return { ...prev, start_date: tariffSlotStartIso(dateIso, time) };
    });
  }, [dateIso]);

  return (
    <div style={{ padding: 12 }}>
      <div className="v3-shell">
        <div className="v3-center">
          <LeftScheduleV4
            dateIso={dateIso}
            onDateChange={setDateIso}
            selected={slot}
            onSelect={(s) => setSlot(s as any)}
            // фейковые колонки оставляем (lux/premium/sauna), фильтры/конструктор убран
            allowedServiceIds={undefined}
            filtersCount={0}
            onSlotClick={(s) => {
              setSlot(s as any);
              setBookingOpen(true);
            }}
          />
        </div>
      </div>

      <BookingModal
        open={bookingOpen}
        slot={slot as any}
        onClose={() => setBookingOpen(false)}
      />
    </div>
  );
}
