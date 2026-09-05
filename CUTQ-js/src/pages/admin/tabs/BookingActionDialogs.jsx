import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarDays, Loader2, ShieldAlert, Store, User, X,
} from "lucide-react";
import {
  supportUpdateBookingStatus,
  supportRescheduleBooking,
  supportGetSalonDayAvailability,
} from "../../../lib/adminFirestore";
import {
  dayStartsInZone, zonedWallClockToMs, zonedDateParts, formatInZone, zoneDiffersFromLocal,
} from "../../../lib/salonTime";

/*
 * Dialogs for the booking actions a rep can take on a salon's or a customer's
 * behalf. Split out of BookingsSupport.jsx to keep that file readable.
 *
 * The party a rep acts *as* is the whole point: it decides cancelled_by, which
 * decides who the backend notifies. So the cancel dialog states it in words
 * rather than leaving it to the button the rep happened to press.
 */

// ── shared shell ──────────────────────────────────────────────────────────────

function Modal({ title, subtitle, onClose, busy, children, footer }) {
  // Escape closes, but not mid-write — a half-applied action with the dialog
  // gone is how a rep ends up unsure whether it went through.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="bg-[#11161c] border border-white/10 w-full sm:max-w-lg sm:rounded-xl rounded-t-xl shadow-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/10 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-white">{title}</h2>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button" onClick={onClose} disabled={busy}
            className="text-gray-500 hover:text-white disabled:opacity-40 p-1 -m-1"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">{children}</div>
        <div className="px-5 py-4 border-t border-white/10 flex gap-2 justify-end bg-white/[0.02]">{footer}</div>
      </div>
    </div>
  );
}

function OverrideBox({ role, checked, onChange, code, disabled, children }) {
  if (role !== "ADMIN") return null;
  return (
    <label className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer ${
      checked ? "border-amber-500/40 bg-amber-500/10" : "border-white/10 bg-white/[0.03]"
    } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}>
      <input
        type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-amber-500"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
          <ShieldAlert size={13} /> Override{code ? ` — ${code}` : ""}
        </span>
        <span className="block text-[11px] text-gray-400 mt-0.5">{children}</span>
      </span>
    </label>
  );
}

const ghostBtn = "text-xs font-medium px-4 py-2 rounded-lg text-gray-300 hover:bg-white/5 disabled:opacity-50";
const primaryBtn = "flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-50";

// ── cancel ────────────────────────────────────────────────────────────────────

const CANCEL_AS = {
  salon: {
    action: "cancel_by_salon",
    Icon: Store,
    who: "the salon",
    fallback: "Cancelled by salon",
    notifies: "The customer is told the salon cancelled, and sees this reason.",
  },
  user: {
    action: "cancel_by_user",
    Icon: User,
    who: "the customer",
    fallback: "Cancelled by customer",
    notifies: "The customer gets a cancellation confirmation and the salon is told the customer cancelled.",
  },
};

export function CancelBookingDialog({ booking, role, initialAs = "salon", onClose, onApplied }) {
  const [as, setAs] = useState(initialAs);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);

  const spec = CANCEL_AS[as];
  const needsOverride = booking.status !== "pending" && booking.status !== "confirmed";

  async function submit() {
    setBusy(true);
    try {
      const updated = await supportUpdateBookingStatus(booking.id, spec.action, {
        reason: reason.trim(),
        override,
      });
      onApplied(updated);
      toast.success(`Booking cancelled on behalf of ${spec.who}.`);
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(err?.message || "Failed to cancel the booking.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Cancel this booking"
      subtitle="This cannot be undone. Both sides are notified."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className={ghostBtn}>Keep booking</button>
          <button
            onClick={submit}
            disabled={busy || (needsOverride && !override)}
            className={`${primaryBtn} bg-red-500 hover:bg-red-600`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <AlertTriangle size={13} />}
            {busy ? "Cancelling…" : "Cancel booking"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-gray-300">Who is cancelling?</span>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(CANCEL_AS).map(([key, opt]) => {
            const active = as === key;
            const Icon = opt.Icon;
            return (
              <button
                key={key} type="button" onClick={() => setAs(key)} disabled={busy}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
                  active
                    ? "border-[#18B79B]/60 bg-[#18B79B]/10 text-white"
                    : "border-white/10 bg-white/[0.03] text-gray-400 hover:border-white/20"
                }`}
              >
                <Icon size={14} className={active ? "text-[#18B79B]" : ""} />
                {key === "salon" ? "The salon" : "The customer"}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-gray-500">{spec.notifies}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="cancel-reason" className="text-xs font-semibold text-gray-300">
          Reason <span className="font-normal text-gray-500">(optional)</span>
        </label>
        <textarea
          id="cancel-reason" rows={3} autoFocus value={reason} disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          placeholder={as === "salon" ? "e.g. Stylist unavailable" : "e.g. Customer can't make it"}
          className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white outline-none focus:border-[#18B79B]/60 placeholder:text-gray-600"
        />
        <p className="text-[11px] text-gray-500">
          Left blank it is recorded as "{spec.fallback}". The customer sees this text.
        </p>
      </div>

      {needsOverride && (
        <OverrideBox
          role={role} checked={override} onChange={setOverride}
          code={`STATUS_${booking.status.toUpperCase()}`}
        >
          This booking is {booking.status}, which normally cannot be cancelled. Recorded against your account.
        </OverrideBox>
      )}
      {needsOverride && role !== "ADMIN" && (
        <p className="text-[11px] text-amber-300">
          A {booking.status} booking can only be cancelled by an admin.
        </p>
      )}
    </Modal>
  );
}

// ── reschedule ────────────────────────────────────────────────────────────────

/** Total minutes across the booking's services, which the new slot must fit. */
function bookingDurationMinutes(booking) {
  if (booking.slot_start_ms && booking.slot_end_ms && booking.slot_end_ms > booking.slot_start_ms) {
    return Math.round((booking.slot_end_ms - booking.slot_start_ms) / 60000);
  }
  const summed = (booking.services || []).reduce((n, s) => n + (s.duration_minutes || 0), 0);
  return summed || 30;
}

export function RescheduleBookingDialog({ booking, role, onClose, onApplied }) {
  // Everything here runs on the salon's clock, not the operator's. The grid is
  // labelled server-side in salon time; if the days, the typed time and the
  // confirmation line were computed with the browser's, a rep outside the
  // salon's zone would read one time and book another.
  const tz = booking.salon_timezone || "Asia/Kolkata";
  const days = useMemo(() => dayStartsInZone(14, tz), [tz]);
  const showZone = useMemo(() => zoneDiffersFromLocal(tz), [tz]);

  const durationMinutes = bookingDurationMinutes(booking);

  const [dayMs, setDayMs] = useState(days[0]);
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  // An empty grid means "closed that day"; a failed fetch means we do not know.
  // Telling a rep the salon is shut when the request merely failed sends them
  // back to the customer with something untrue.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState(null);
  const [manual, setManual] = useState("");
  const [override, setOverride] = useState(false);
  const [blockedCode, setBlockedCode] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setSelected(null);
    supportGetSalonDayAvailability(booking.salon_id, dayMs, durationMinutes, booking.id)
      .then((res) => { if (!cancelled) setSlots(res?.slots ?? []); })
      .catch((err) => {
        console.error(err);
        if (!cancelled) {
          setSlots([]);
          setLoadError(true);
          toast.error("Couldn't load that day's availability.");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [booking.salon_id, booking.id, dayMs, durationMinutes, reloadKey]);

  // A typed time wins over a tapped one: the grid steps every 15 minutes but the
  // app books on 5, so an exact time is the only way to reach some slots.
  const chosenMs = useMemo(() => {
    if (manual) {
      const [h, m] = manual.split(":").map(Number);
      if (Number.isFinite(h) && Number.isFinite(m)) {
        // dayMs is already midnight in the salon's zone; read the typed time as
        // that zone's wall clock so it means what the grid's labels mean. Taken
        // as structured parts, not by splitting a formatted date — field order
        // is a property of the locale, not something to rely on.
        const { year, month, day } = zonedDateParts(dayMs, tz);
        return zonedWallClockToMs({ year, month, day, hour: h, minute: m }, tz);
      }
    }
    return selected;
  }, [manual, selected, dayMs, tz]);

  async function submit() {
    if (!chosenMs) return;
    setBusy(true);
    try {
      const res = await supportRescheduleBooking(booking.id, chosenMs, { override });
      onApplied(res?.booking ?? null);
      toast.success(
        res?.wasConfirmed
          ? "Rescheduled. It is back to pending — the salon has been asked to re-confirm."
          : "Booking rescheduled.",
      );
      onClose();
    } catch (err) {
      console.error(err);
      const raw = err?.message || "Failed to reschedule.";
      const code = raw.match(/\b(SLOT_TOO_SOON|SALON_CLOSED|OUTSIDE_WORKING_HOURS|SLOT_FULL|SLOT_BLOCKED|SALON_NOT_FOUND)\b/)?.[1];
      setBlockedCode(code ?? null);
      toast.error(code ? raw.split(": ").slice(1).join(": ") || raw : raw);
    } finally {
      setBusy(false);
    }
  }

  const wasConfirmed = booking.status === "confirmed";

  return (
    <Modal
      title="Reschedule booking"
      subtitle={`On the customer's behalf · ${durationMinutes} min to fit${
        showZone ? ` · times shown in salon time (${tz})` : ""}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className={ghostBtn}>Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !chosenMs}
            className={`${primaryBtn} bg-[#18B79B] hover:bg-[#14a087]`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <CalendarDays size={13} />}
            {busy ? "Rescheduling…" : "Confirm new time"}
          </button>
        </>
      }
    >
      {wasConfirmed && (
        <p className="flex items-start gap-2 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
          This booking is confirmed. Moving it puts it back to pending and asks the salon to re-confirm — same as when a customer reschedules from the app.
        </p>
      )}

      {/* day strip — 14 days never fit, so it scrolls; a default scrollbar renders
          as a 16px light bar straight across the dialog on platforms without
          overlay scrollbars, so it is thinned and themed here. */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.18)_transparent]">
        {days.map((ms) => {
          const active = ms === dayMs;
          return (
            <button
              key={ms} type="button" onClick={() => { setDayMs(ms); setManual(""); }} disabled={busy}
              className={`flex flex-col items-center flex-shrink-0 w-14 py-2 rounded-lg border text-[11px] transition-colors ${
                active
                  ? "border-[#18B79B]/60 bg-[#18B79B]/10 text-white"
                  : "border-white/10 bg-white/[0.03] text-gray-400 hover:border-white/20"
              }`}
            >
              <span className="text-gray-500">{formatInZone(ms, tz, { weekday: "short" })}</span>
              <span className="text-sm font-semibold">{formatInZone(ms, tz, { day: "numeric" })}</span>
              <span className="text-gray-500">{formatInZone(ms, tz, { month: "short" })}</span>
            </button>
          );
        })}
      </div>

      {/* slot grid */}
      {loading ? (
        <div className="flex items-center justify-center py-10 text-gray-500 gap-2 text-xs">
          <Loader2 className="animate-spin" size={15} /> Checking availability…
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center gap-2 py-10">
          <p className="text-xs text-amber-300">Couldn't load this day's availability.</p>
          <p className="text-[11px] text-gray-500">
            This is not the same as the salon being closed — we don't know either way.
          </p>
          <button
            type="button" onClick={() => setReloadKey((k) => k + 1)}
            className="mt-1 px-3 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] text-xs text-gray-300 hover:border-[#18B79B]/50"
          >
            Try again
          </button>
        </div>
      ) : slots.length === 0 ? (
        <p className="text-center text-xs text-gray-500 py-10">
          The salon is closed on this day.
        </p>
      ) : (
        <div className="grid grid-cols-4 sm:grid-cols-5 gap-1.5">
          {slots.map((s) => {
            const active = !manual && selected === s.start_ms;
            return (
              <button
                key={s.start_ms} type="button" disabled={busy || !s.free}
                title={s.free ? undefined : s.code}
                onClick={() => { setSelected(s.start_ms); setManual(""); }}
                className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
                  active ? "border-[#18B79B] bg-[#18B79B] text-white"
                    : s.free ? "border-white/10 bg-white/[0.03] text-gray-300 hover:border-[#18B79B]/50"
                      : "border-white/5 bg-white/[0.02] text-gray-600 line-through cursor-not-allowed"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      )}

      {/* exact time escape hatch */}
      <div className="flex items-center gap-2 border-t border-white/10 pt-3">
        <label htmlFor="exact-time" className="text-xs text-gray-400 flex-shrink-0">
          Or an exact time
        </label>
        <input
          id="exact-time" type="time" step={300} value={manual} disabled={busy}
          onChange={(e) => { setManual(e.target.value); setSelected(null); }}
          className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white outline-none focus:border-[#18B79B]/60 [color-scheme:dark]"
        />
        {manual && (
          <button
            type="button" onClick={() => setManual("")}
            className="text-[11px] text-gray-500 hover:text-white"
          >
            clear
          </button>
        )}
      </div>

      {chosenMs && (
        <p className="text-xs text-gray-300">
          New time:{" "}
          <span className="font-semibold text-white">
            {formatInZone(chosenMs, tz, {
              weekday: "short", day: "2-digit", month: "short",
              hour: "2-digit", minute: "2-digit", hour12: true,
            })}
          </span>
          {showZone && <span className="text-gray-500"> · salon time ({tz})</span>}
        </p>
      )}

      {blockedCode && (
        <OverrideBox
          role={role} checked={override} onChange={setOverride} code={blockedCode}
        >
          The salon's calendar refuses this slot. Tick to place it anyway — use this only when the salon has agreed on the phone. Recorded against your account.
        </OverrideBox>
      )}
      {blockedCode && role !== "ADMIN" && (
        <p className="text-[11px] text-amber-300">
          Only an admin can place a booking the salon's calendar refuses.
        </p>
      )}
    </Modal>
  );
}
