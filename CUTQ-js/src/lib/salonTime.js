/**
 * Wall-clock time in a salon's timezone, from a browser that may be in another.
 *
 * The reschedule picker mixes two clocks: the slot grid is built server-side and
 * labelled in the salon's timezone, while anything the browser computes with
 * `setHours` / `toLocaleString` is in the operator's own. In India those are the
 * same zone and nothing shows. From anywhere else they are not: typing "14:00"
 * for an Asia/Kolkata salon from a US browser books 23:30 salon time, and the
 * confirmation line reads back a time and date that are not the ones booked.
 *
 * A booking system must never show one time and store another, so every date the
 * picker builds or renders goes through here.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Numeric wall-clock parts of an instant, as read in `timeZone`. */
function partsIn(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  // en-US with hour12:false renders midnight as hour 24.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/**
 * The zone's UTC offset in ms at a given instant (east of UTC is positive).
 *
 * Truncated to whole seconds first: the reconstruction below has no
 * milliseconds, so comparing it against a millisecond-precision instant reports
 * an offset up to 999ms off true. No offset has ever been a fraction of a
 * second, so the difference is pure noise — but it is enough to make an
 * equality test between two offsets fail.
 */
function offsetAt(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = partsIn(whole, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - whole;
}

/**
 * The instant at which `timeZone` shows the given wall clock.
 *
 * Two passes: guess using the offset at the naive instant, then re-derive the
 * offset at the guess. That second pass is what makes a time near a DST change
 * land correctly; India has no DST but the salon timezone is a configurable
 * field, so this must not assume one.
 */
export function zonedWallClockToMs(
  {year, month, day, hour = 0, minute = 0}, timeZone,
) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const guess = naive - offsetAt(naive, timeZone);
  return naive - offsetAt(guess, timeZone);
}

/** The calendar date `ms` falls on in `timeZone`, as {year, month, day} numbers. */
export function zonedDateParts(ms, timeZone) {
  const {year, month, day} = partsIn(ms, timeZone);
  return {year, month, day};
}

/** Midnight in `timeZone` on the calendar day `ms` falls on, as epoch ms. */
export function startOfDayInZone(ms, timeZone) {
  const p = partsIn(ms, timeZone);
  return zonedWallClockToMs({year: p.year, month: p.month, day: p.day}, timeZone);
}

/**
 * `count` consecutive midnights in `timeZone`, starting with today's.
 *
 * Stepping by exactly 24h would drift across a DST change, so each day is
 * re-derived from the calendar rather than added to the last.
 */
export function dayStartsInZone(count, timeZone, fromMs = Date.now()) {
  const first = startOfDayInZone(fromMs, timeZone);
  return Array.from({length: count}, (_, i) => {
    const p = partsIn(first + i * MS_PER_DAY + MS_PER_DAY / 2, timeZone);
    return zonedWallClockToMs({year: p.year, month: p.month, day: p.day}, timeZone);
  });
}

/** Format an instant in the salon's zone. */
export function formatInZone(ms, timeZone, options) {
  return new Intl.DateTimeFormat("en-IN", {timeZone, ...options}).format(new Date(ms));
}

/** True when the operator's clock disagrees with the salon's — the case worth telling them about. */
export function zoneDiffersFromLocal(timeZone, atMs = Date.now()) {
  try {
    return offsetAt(atMs, timeZone) !== -new Date(atMs).getTimezoneOffset() * 60000;
  } catch {
    return false;
  }
}
