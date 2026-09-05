import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Phone, RefreshCw, ChevronDown, Check, Loader2, ArrowDownWideNarrow,
  ArrowUpWideNarrow, Store, User, Clock, CalendarDays, BadgeCheck,
  CheckCircle2, XCircle, CalendarClock, ShieldAlert,
} from "lucide-react";
import { supportListBookings, markSupportCall, supportUpdateBookingStatus } from "../../../lib/adminFirestore";
import { CancelBookingDialog, RescheduleBookingDialog } from "./BookingActionDialogs";
import { formatInZone, zoneDiffersFromLocal } from "../../../lib/salonTime";

/*
 * ADMIN / SUPPORT bookings view.
 *
 * Shows every booking across all salons/users. Three panes:
 *   - "Active"    → pending + confirmed (the ones to call about)
 *   - "Completed" → completed
 *   - "Cancelled" → cancelled, with who cancelled and why
 * Default sort: newest at the BOTTOM (ascending by created_at); toggle to flip.
 *
 * Per booking, the rep sees salon + customer name & phone and two tasks -
 * "Call salon" and "Call customer". Marking both done sets support_called_salon
 * and support_called_customer on the booking; when both are true the salon
 * dashboard shows a "Customer Confirmed" badge.
 *
 * A rep can also fire any trigger the salon or the customer could, on that
 * party's behalf: confirm (as the salon), cancel (as either), and reschedule
 * (as the customer). Every one goes through a Cloud Function — the panel has no
 * direct write access to bookings — and is recorded in support_actions, shown
 * under Details. Completing a booking is deliberately absent: it posts a sale to
 * the salon's ledger, and that stays with the salon.
 *
 * `role` is "ADMIN" or "SUPPORT". Both get every action; only ADMIN may override
 * a refusal, and the server enforces that regardless of what this file renders.
 */

const STATUS_STYLE = {
  pending:   "bg-amber-500/15 text-amber-300 border-amber-500/30",
  confirmed: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  cancelled: "bg-gray-500/15 text-gray-400 border-gray-500/30",
};

const DATETIME = {
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
};

/** When something happened, on the reader's own clock. Right for created_at and
 *  for the audit trail: those are events, not appointments. */
function fmtDateTime(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("en-IN", DATETIME);
}

/**
 * When the customer is due at the salon, on the salon's clock.
 *
 * An appointment belongs to the salon's timezone, not the reader's — and the
 * reschedule dialog labels its slots that way, so showing the card in browser
 * time would have the same booking reading as two different times on one screen.
 */
function fmtSlot(ms, tz) {
  if (!ms) return "-";
  return formatInZone(ms, tz || "Asia/Kolkata", DATETIME);
}

function CallTask({ label, done, busy, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
        done
          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
          : "bg-white/5 text-gray-300 border-white/10 hover:border-[#18B79B]/50"
      }`}
    >
      {busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : done ? (
        <Check size={13} />
      ) : (
        <span className="w-3 h-3 rounded-sm border border-gray-500 inline-block" />
      )}
      {done ? label.replace("Call", "Called") : label}
    </button>
  );
}

function BookingRow({ b, onMark, onCancel, onReschedule }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null); // "salon" | "customer" | "confirm" | null
  const bothDone = b.support_called_salon && b.support_called_customer;
  const actionable = b.status === "pending" || b.status === "confirmed";

  async function toggle(target) {
    const current = target === "salon" ? b.support_called_salon : b.support_called_customer;
    setBusy(target);
    try {
      const res = await markSupportCall(b.id, target, !current);
      onMark(b.id, res);
    } catch (err) {
      console.error(err);
      toast.error("Failed to update. Try again.");
    } finally {
      setBusy(null);
    }
  }

  // Confirming is the one action with nothing to fill in, so it writes directly
  // rather than opening a dialog. Cancel and reschedule both need input.
  async function confirmBooking() {
    setBusy("confirm");
    try {
      const updated = await supportUpdateBookingStatus(b.id, "confirm");
      onMark(b.id, updated);
      toast.success("Booking confirmed on behalf of the salon.");
    } catch (err) {
      console.error(err);
      toast.error(err?.message || "Failed to confirm the booking.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5">
      <div className="p-4 flex flex-col gap-3">
        {/* top row: status + confirmed chip */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_STYLE[b.status] || STATUS_STYLE.pending}`}>
            {b.status}
          </span>
          {bothDone && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-emerald-500/15 text-emerald-300 border-emerald-500/40 flex items-center gap-1">
              <BadgeCheck size={12} /> Customer Confirmed
            </span>
          )}
          <span className="ml-auto text-[11px] text-gray-500 flex items-center gap-1">
            <CalendarDays size={12} /> {fmtSlot(b.slot_start_ms, b.salon_timezone)}
            {zoneDiffersFromLocal(b.salon_timezone || "Asia/Kolkata") && (
              <span className="text-gray-600">salon time</span>
            )}
          </span>
        </div>

        {/* customer + salon */}
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="flex items-start gap-2">
            <User size={15} className="text-[#18B79B] mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              {b.booked_for_other ? (
                <>
                  <p className="text-sm text-white truncate">
                    {b.beneficiary_name || "Guest"}
                    <span className="ml-1 text-[10px] text-amber-300">· for someone else</span>
                    {b.beneficiary_gender && <span className="ml-1 text-[10px] text-gray-500">· {b.beneficiary_gender}</span>}
                  </p>
                  {b.beneficiary_phone ? (
                    <a href={`tel:${b.beneficiary_phone}`} className="text-xs text-[#18B79B] hover:underline flex items-center gap-1">
                      <Phone size={11} /> {b.beneficiary_phone}
                    </a>
                  ) : <p className="text-xs text-gray-500">No phone</p>}
                  <p className="text-[11px] text-gray-500 truncate mt-0.5">
                    Booked by {b.customer_name || "Unknown"}
                    {b.customer_phone ? ` · ${b.customer_phone}` : ""}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-white truncate">
                    {b.customer_name || "Unknown customer"}
                    {b.is_walk_in && <span className="ml-1 text-[10px] text-emerald-300">· walk-in</span>}
                  </p>
                  {b.customer_phone ? (
                    <a href={`tel:${b.customer_phone}`} className="text-xs text-[#18B79B] hover:underline flex items-center gap-1">
                      <Phone size={11} /> {b.customer_phone}
                    </a>
                  ) : <p className="text-xs text-gray-500">No phone</p>}
                </>
              )}
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Store size={15} className="text-[#18B79B] mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm text-white truncate">{b.salon_name || "Unknown salon"}
                {b.salon_city && <span className="text-gray-500"> · {b.salon_city}</span>}
              </p>
              {b.salon_phone ? (
                <a href={`tel:${b.salon_phone}`} className="text-xs text-[#18B79B] hover:underline flex items-center gap-1">
                  <Phone size={11} /> {b.salon_phone}
                </a>
              ) : <p className="text-xs text-gray-500">No phone</p>}
            </div>
          </div>
        </div>

        {/* why it was cancelled */}
        {b.status === "cancelled" && (b.cancellation_reason || b.cancelled_by) && (
          <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
            <span className="font-semibold capitalize">Cancelled by {b.cancelled_by || "unknown"}</span>
            {b.cancellation_reason ? <>: {b.cancellation_reason}</> : null}
          </div>
        )}

        {/* call tasks + expand */}
        <div className="flex items-center gap-2 flex-wrap">
          <CallTask label="Call salon" done={b.support_called_salon} busy={busy === "salon"} onToggle={() => toggle("salon")} />
          <CallTask label="Call customer" done={b.support_called_customer} busy={busy === "customer"} onToggle={() => toggle("customer")} />
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="ml-auto flex items-center gap-1 text-xs text-gray-400 hover:text-white px-2 py-1"
          >
            Details <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>

        {/* actions taken on the salon's or the customer's behalf */}
        {actionable && (
          <div className="flex items-center gap-2 flex-wrap border-t border-white/10 pt-3">
            {b.status === "pending" && (
              <button
                type="button" onClick={confirmBooking} disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
              >
                {busy === "confirm"
                  ? <Loader2 size={13} className="animate-spin" />
                  : <CheckCircle2 size={13} />}
                {busy === "confirm" ? "Confirming…" : "Confirm as salon"}
              </button>
            )}
            <button
              type="button" onClick={() => onReschedule(b)} disabled={busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 text-gray-300 border border-white/10 hover:border-[#18B79B]/50 transition-colors disabled:opacity-50"
            >
              <CalendarClock size={13} /> Reschedule
            </button>
            <button
              type="button" onClick={() => onCancel(b, "salon")} disabled={busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20 transition-colors disabled:opacity-50"
            >
              <XCircle size={13} /> Cancel…
            </button>
          </div>
        )}

        {/* details */}
        {open && (
          <div className="border-t border-white/10 pt-3 grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            <div className="sm:col-span-2">
              <span className="text-gray-500">Services: </span>
              <span className="text-gray-200">
                {b.services?.length ? b.services.map((s) => `${s.name} (₹${s.price})`).join(", ") : "-"}
              </span>
            </div>
            <div><span className="text-gray-500">Slot: </span><span className="text-gray-200">{fmtSlot(b.slot_start_ms, b.salon_timezone)} → {fmtSlot(b.slot_end_ms, b.salon_timezone)}</span></div>
            <div><span className="text-gray-500">Booked at: </span><span className="text-gray-200">{fmtDateTime(b.created_at_ms)}</span></div>
            <div><span className="text-gray-500">Service total: </span><span className="text-gray-200">₹{b.total_service_price}</span></div>
            <div><span className="text-gray-500">Booking fee: </span><span className="text-gray-200">₹{b.booking_fee}</span></div>
            {b.discount_amount > 0 && <div><span className="text-gray-500">Discount: </span><span className="text-gray-200">−₹{b.discount_amount} {b.coupon_code ? `(${b.coupon_code})` : ""}</span></div>}
            <div><span className="text-gray-500">Final amount: </span><span className="text-emerald-300 font-semibold">₹{b.final_amount}</span></div>
            {b.notes && <div className="sm:col-span-2"><span className="text-gray-500">Notes: </span><span className="text-gray-200">{b.notes}</span></div>}
            {b.support_actions?.length > 0 && (
              <div className="sm:col-span-2 flex flex-col gap-1 mt-1">
                <span className="text-gray-500">Panel actions</span>
                {b.support_actions.map((a, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px] text-gray-300">
                    {a.override && <ShieldAlert size={12} className="text-amber-400 mt-0.5 flex-shrink-0" />}
                    <span>
                      <span className="font-semibold capitalize">{String(a.action || "").replace(/_/g, " ")}</span>
                      {a.acted_as ? <span className="text-gray-500"> as {a.acted_as === "user" ? "customer" : "salon"}</span> : null}
                      {" · "}
                      <span className="text-gray-400">{a.actor_name || a.actor_uid} ({a.actor_role})</span>
                      {a.at_ms ? <span className="text-gray-600"> · {fmtDateTime(a.at_ms)}</span> : null}
                      {a.override_code ? <span className="text-amber-400"> · overrode {a.override_code}</span> : null}
                      {a.reason ? <span className="text-gray-500"> — "{a.reason}"</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="sm:col-span-2 text-gray-600">Booking ID: {b.id}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function BookingsSupport({ role }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pane, setPane] = useState("active"); // "active" | "completed" | "cancelled"
  const [asc, setAsc] = useState(true); // newest at bottom by default
  const [cancelling, setCancelling] = useState(null); // { booking, as } | null
  const [rescheduling, setRescheduling] = useState(null); // booking | null

  async function load() {
    setLoading(true);
    try {
      const data = await supportListBookings(500);
      setBookings(data);
    } catch (err) {
      console.error(err);
      toast.error("Failed to load bookings. Are the support functions deployed?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Both markSupportCall (a two-field patch) and the action callables (a whole
  // re-projected booking) merge through here, so the list never needs reloading.
  function applyMark(id, res) {
    if (!res) return;
    setBookings((prev) => prev.map((b) => b.id === id ? { ...b, ...res } : b));
  }

  const filtered = useMemo(() => {
    const inPane = (b) => {
      if (pane === "active") return b.status === "pending" || b.status === "confirmed";
      if (pane === "completed") return b.status === "completed";
      return b.status === "cancelled";
    };
    const sorted = [...bookings.filter(inPane)].sort((a, b) =>
      asc ? (a.created_at_ms || 0) - (b.created_at_ms || 0) : (b.created_at_ms || 0) - (a.created_at_ms || 0)
    );
    return sorted;
  }, [bookings, pane, asc]);

  const activeCount = bookings.filter((b) => b.status === "pending" || b.status === "confirmed").length;
  const completedCount = bookings.filter((b) => b.status === "completed").length;
  const cancelledCount = bookings.filter((b) => b.status === "cancelled").length;

  const EMPTY_LABEL = {
    active: "pending or confirmed",
    completed: "completed",
    cancelled: "cancelled",
  };

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      {/* header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white">Bookings</h2>
          <p className="text-xs text-gray-500">Call the salon and customer to confirm each booking.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAsc((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/10 text-xs text-gray-300 hover:bg-white/5"
            title="Toggle sort order"
          >
            {asc ? <ArrowDownWideNarrow size={14} /> : <ArrowUpWideNarrow size={14} />}
            {asc ? "Newest at bottom" : "Newest on top"}
          </button>
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/10 text-xs text-gray-300 hover:bg-white/5"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* panes */}
      <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-lg p-1 w-fit">
        {[
          { id: "active", label: `Pending & Confirmed (${activeCount})` },
          { id: "completed", label: `Completed (${completedCount})` },
          { id: "cancelled", label: `Cancelled (${cancelledCount})` },
        ].map((p) => (
          <button
            key={p.id}
            onClick={() => setPane(p.id)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              pane === p.id ? "bg-[#18B79B] text-white" : "text-gray-400 hover:text-white"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* list */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
          <Loader2 className="animate-spin" size={18} /> Loading bookings…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Clock className="w-8 h-8 text-gray-600 mb-2" />
          <p className="text-sm text-gray-400">No {EMPTY_LABEL[pane]} bookings.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {filtered.map((b) => (
            <BookingRow
              key={b.id}
              b={b}
              onMark={applyMark}
              onCancel={(booking, as) => setCancelling({ booking, as })}
              onReschedule={(booking) => setRescheduling(booking)}
            />
          ))}
        </div>
      )}

      {cancelling && (
        <CancelBookingDialog
          booking={cancelling.booking}
          role={role}
          initialAs={cancelling.as}
          onClose={() => setCancelling(null)}
          onApplied={(updated) => applyMark(cancelling.booking.id, updated)}
        />
      )}

      {rescheduling && (
        <RescheduleBookingDialog
          booking={rescheduling}
          role={role}
          onClose={() => setRescheduling(null)}
          onApplied={(updated) => applyMark(rescheduling.id, updated)}
        />
      )}
    </div>
  );
}
