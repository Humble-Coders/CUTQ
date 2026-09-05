/**
 * Slot validation, shared by every path that puts a booking on a salon's calendar.
 *
 * There were two copies of these five checks — validateBookingOnCreate and
 * rescheduleBooking — and the support panel needed a third. A third copy is how
 * the app's picker and the server's verdict drift apart, so the rules live here
 * instead, as one pure function.
 *
 * Pure on purpose: no firebase-admin, no I/O, plain numbers and objects. The
 * caller loads the day's bookings and blocks once (see loadDayContext in
 * index.js) and hands them in. That is what lets the availability grid check 96
 * candidate slots against a single pair of Firestore reads, and it is what makes
 * every branch testable without an emulator.
 */

/** Half-open interval overlap. Touching ends (10:00–10:30, 10:30–11:00) do not. */
function overlaps(aStartMs, aEndMs, bStartMs, bEndMs) {
  return aStartMs < bEndMs && aEndMs > bStartMs;
}

function parseTimeToMinutes(timeStr) {
  const parts = (timeStr || "0:0").split(":");
  return parseInt(parts[0] || "0") * 60 + parseInt(parts[1] || "0");
}

/**
 * { weekday, totalMinutes } for an instant, in the given IANA timezone.
 * weekday is lowercase ("monday"); totalMinutes is hours*60 + minutes, local.
 *
 * Cloud Functions run in UTC while working_hours strings are in the salon's own
 * time, so every comparison against working_hours must come through here.
 */
function getLocalTimeParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = parseInt(get("hour")); // 0–23
  const minute = parseInt(get("minute"));
  const weekday = get("weekday").toLowerCase();
  return {weekday, totalMinutes: hour * 60 + minute};
}

/** A salon's timezone, defaulting the way every existing call site defaults it. */
function salonTimezone(salon) {
  return (salon && salon.timezone) || "Asia/Kolkata";
}

/** "09:15 am" in the salon's local time. */
function formatLocalTime(ms, timezone) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

const fail = (code, message) => ({ok: false, code, message: `${code}: ${message}`});

/**
 * Is [start, end) inside the salon's opening hours for that day?
 *
 * Separate from checkSlot because the availability grid needs this answer on its
 * own: checkSlot short-circuits on the lead time, so an 06:00 candidate reports
 * SLOT_TOO_SOON and never reveals that the salon is also shut. The grid must
 * drop closed hours regardless of why the slot is unbookable, and it must use
 * this exact test to do it — not a second reading of working_hours.
 */
function workingHoursVerdict(salon, slotStartMs, slotEndMs) {
  const tz = salonTimezone(salon);
  const {weekday, totalMinutes: startMin} = getLocalTimeParts(new Date(slotStartMs), tz);
  const {totalMinutes: endMin} = getLocalTimeParts(new Date(slotEndMs), tz);
  const dayHours = salon && salon.working_hours ? salon.working_hours[weekday] : null;
  if (!dayHours || dayHours.is_closed === true) {
    return fail("SALON_CLOSED", "Salon is closed on this day");
  }
  const openMin = parseTimeToMinutes(dayHours.open);
  const closeMin = parseTimeToMinutes(dayHours.close);
  // Both are minutes-from-midnight with no date attached, so a window that runs
  // past local midnight (23:45 → 00:15) would compare as 1425 → 15 and slip
  // inside 09:00–21:00. A slot that ends on the next local day is outside the
  // hours of this one, whatever the arithmetic says.
  if (endMin <= startMin) {
    return fail("OUTSIDE_WORKING_HOURS", "Slot is outside salon working hours");
  }
  if (startMin < openMin || endMin > closeMin) {
    return fail("OUTSIDE_WORKING_HOURS", "Slot is outside salon working hours");
  }
  return {ok: true, openMin, closeMin};
}

/**
 * The five checks, in the order the customer-facing paths have always run them.
 *
 * Codes are part of the contract: both apps strip the "CODE: " prefix off the
 * message before showing it, so renaming one changes what a customer reads.
 *
 * @param salon            the salon document (working_hours, timezone,
 *                         max_bookings_per_slot)
 * @param dayContext       {bookings, blocked} from loadDayContext — bookings are
 *                         {id, startMs, endMs, status}, blocks are {startMs, endMs}
 * @param slotStartMs      proposed start
 * @param slotEndMs        proposed end
 * @param excludeBookingId booking to ignore when counting capacity — a booking
 *                         being rescheduled must not block its own new slot
 * @param minLeadMs        from serverMinLeadMs()
 * @param nowMs            injected so tests are not clock-dependent
 * @returns {{ok: true}} or {{ok: false, code, message}}
 */
function checkSlot({
  salon,
  dayContext,
  slotStartMs,
  slotEndMs,
  excludeBookingId = null,
  minLeadMs = 0,
  nowMs = Date.now(),
}) {
  // 1. Far enough in the future.
  if (slotStartMs < nowMs + minLeadMs) {
    return fail(
      "SLOT_TOO_SOON",
      `Slot must be at least ${Math.round(minLeadMs / 60000)} minutes from now`,
    );
  }

  // 2. Inside the salon's working hours for that day, in the salon's own timezone.
  const hours = workingHoursVerdict(salon, slotStartMs, slotEndMs);
  if (!hours.ok) return hours;

  // 3. Capacity — count non-cancelled bookings overlapping the proposed window.
  const maxBookings = (salon && salon.max_bookings_per_slot) ?? 1;
  const overlapping = (dayContext.bookings || []).filter((b) => {
    if (excludeBookingId && b.id === excludeBookingId) return false;
    if (b.status === "cancelled") return false;
    if (!b.startMs || !b.endMs) return false;
    return overlaps(b.startMs, b.endMs, slotStartMs, slotEndMs);
  });
  if (overlapping.length >= maxBookings) {
    return fail("SLOT_FULL", "This time slot is fully booked");
  }

  // 4. Not inside a block the salon put on its own calendar.
  const isBlocked = (dayContext.blocked || []).some((bl) => {
    if (!bl.startMs || !bl.endMs) return false;
    return overlaps(bl.startMs, bl.endMs, slotStartMs, slotEndMs);
  });
  if (isBlocked) {
    return fail("SLOT_BLOCKED", "This time slot is blocked by the salon");
  }

  return {ok: true};
}

/**
 * Every start time worth offering in [fromMs, toMs), each already run through
 * checkSlot so the grid cannot disagree with the write path that follows it.
 *
 * Candidates the salon is closed for are dropped rather than shown disabled —
 * a rep does not need to see 3am. Slots that are merely taken are kept, marked
 * unavailable with their reason, because "why can't I have 4pm" is the question
 * they are on the phone about.
 */
function buildDayAvailability({
  salon,
  dayContext,
  fromMs,
  toMs,
  durationMs,
  stepMinutes = 15,
  excludeBookingId = null,
  minLeadMs = 0,
  nowMs = Date.now(),
}) {
  const tz = salonTimezone(salon);
  const stepMs = stepMinutes * 60 * 1000;
  const slots = [];

  // Align the first candidate to a step boundary in local time so the grid reads
  // :00/:15/:30/:45 rather than whatever offset the day window happens to start on.
  const {totalMinutes: fromLocalMin} = getLocalTimeParts(new Date(fromMs), tz);
  const alignmentMs = (Math.ceil(fromLocalMin / stepMinutes) * stepMinutes - fromLocalMin) * 60 * 1000;

  for (let startMs = fromMs + alignmentMs; startMs < toMs; startMs += stepMs) {
    const endMs = startMs + durationMs;
    // Hours first and on its own: checkSlot would report SLOT_TOO_SOON for an
    // early-morning candidate and never tell us the salon is shut then.
    if (!workingHoursVerdict(salon, startMs, endMs).ok) continue;

    const verdict = checkSlot({
      salon, dayContext, slotStartMs: startMs, slotEndMs: endMs,
      excludeBookingId, minLeadMs, nowMs,
    });
    slots.push({
      start_ms: startMs,
      label: formatLocalTime(startMs, tz),
      free: verdict.ok === true,
      code: verdict.ok ? null : verdict.code,
    });
  }
  return slots;
}

module.exports = {
  overlaps,
  workingHoursVerdict,
  parseTimeToMinutes,
  getLocalTimeParts,
  salonTimezone,
  formatLocalTime,
  checkSlot,
  buildDayAvailability,
};
