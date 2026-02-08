import { useEffect, useState } from "react";
import type { Slot } from "./LeftScheduleV4";
import { tariffSlotStartIso, todayIso } from "../utils/date";
import LeftScheduleV4 from "./LeftScheduleV4";
import BookingModal from "./BookingModal";

export default function App() {
  const [dateIso, setDateIso] = useState<string>(() => todayIso());
  const [bookingOpen, setBookingOpen] = useState(false);

  // Стартовый слот — просто чтобы модалка имела структуру.
  const [slot, setSlot] = useState<Slot | null>({
    start_date: `${todayIso()}T10:00:00`,
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
