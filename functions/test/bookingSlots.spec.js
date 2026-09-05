/**
 * The five slot checks, which used to exist as two hand-maintained copies (one
 * in validateBookingOnCreate, one in rescheduleBooking) and now back three call
 * paths including the support panel. If these drift, the app offers slots the
 * server then refuses — so every branch is pinned here.
 *
 * No emulator, no clock dependence: checkSlot is pure and `nowMs` is injected.
 *
 * Run with: npm test
 */
const assert = require("assert");
const slots = require("../bookingSlots");

// All times below are Asia/Kolkata (UTC+5:30), the default salon timezone.
const ist = (iso) => new Date(`${iso}+05:30`).getTime();
const MIN = 60 * 1000;

const OPEN_ALL_WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
  .reduce((acc, day) => ({...acc, [day]: {open: "09:00", close: "21:00", is_closed: false}}), {});

const CLOSED_ALL_WEEK = Object.keys(OPEN_ALL_WEEK)
  .reduce((acc, day) => ({...acc, [day]: {open: "09:00", close: "21:00", is_closed: true}}), {});

const salon = (over = {}) => ({
  timezone: "Asia/Kolkata",
  working_hours: OPEN_ALL_WEEK,
  max_bookings_per_slot: 1,
  ...over,
});

const check = (over = {}) => slots.checkSlot({
  salon: salon(),
  dayContext: {bookings: [], blocked: []},
  slotStartMs: ist("2026-09-10T10:00:00"),
  slotEndMs: ist("2026-09-10T10:30:00"),
  minLeadMs: 25 * MIN,
  nowMs: ist("2026-09-10T08:00:00"),
  ...over,
});

describe("checkSlot", () => {
  it("accepts a slot inside working hours on an empty calendar", () => {
    assert.deepStrictEqual(check(), {ok: true});
  });

  it("rejects a slot inside the lead window", () => {
    const v = check({nowMs: ist("2026-09-10T09:40:00")}); // 20 min ahead, lead is 25
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.code, "SLOT_TOO_SOON");
    assert.match(v.message, /^SLOT_TOO_SOON: /);
    assert.match(v.message, /25 minutes/);
  });

  it("accepts a slot exactly at the lead boundary", () => {
    assert.strictEqual(check({nowMs: ist("2026-09-10T09:35:00")}).ok, true);
  });

  it("rejects a day the salon is closed", () => {
    const v = check({salon: salon({working_hours: CLOSED_ALL_WEEK})});
    assert.strictEqual(v.code, "SALON_CLOSED");
  });

  it("rejects a day with no working_hours entry at all", () => {
    const v = check({salon: salon({working_hours: {}})});
    assert.strictEqual(v.code, "SALON_CLOSED");
  });

  it("rejects a start before opening", () => {
    const v = check({
      slotStartMs: ist("2026-09-10T08:00:00"),
      slotEndMs: ist("2026-09-10T08:30:00"),
      nowMs: ist("2026-09-10T06:00:00"),
    });
    assert.strictEqual(v.code, "OUTSIDE_WORKING_HOURS");
  });

  it("rejects an end past closing, even when the start is inside", () => {
    const v = check({
      slotStartMs: ist("2026-09-10T20:45:00"),
      slotEndMs: ist("2026-09-10T21:15:00"),
    });
    assert.strictEqual(v.code, "OUTSIDE_WORKING_HOURS");
  });

  it("reads working hours in the salon's timezone, not the server's", () => {
    // 10:00 IST is 04:30 UTC. A UTC reading would call this outside 09:00-21:00.
    assert.strictEqual(check().ok, true);
  });

  // ── capacity ───────────────────────────────────────────────────────────────

  const booked = (id, startIso, endIso, status = "confirmed") => ({
    id, status, startMs: ist(startIso), endMs: ist(endIso),
  });

  it("rejects an overlapping booking when capacity is 1", () => {
    const v = check({
      dayContext: {bookings: [booked("b1", "2026-09-10T10:15:00", "2026-09-10T10:45:00")], blocked: []},
    });
    assert.strictEqual(v.code, "SLOT_FULL");
  });

  it("ignores cancelled bookings when counting capacity", () => {
    const v = check({
      dayContext: {
        bookings: [booked("b1", "2026-09-10T10:15:00", "2026-09-10T10:45:00", "cancelled")],
        blocked: [],
      },
    });
    assert.strictEqual(v.ok, true);
  });

  it("lets a booking be moved onto its own slot", () => {
    const v = check({
      dayContext: {bookings: [booked("b1", "2026-09-10T10:00:00", "2026-09-10T10:30:00")], blocked: []},
      excludeBookingId: "b1",
    });
    assert.strictEqual(v.ok, true);
  });

  it("allows a second booking when max_bookings_per_slot is 2", () => {
    const dayContext = {
      bookings: [booked("b1", "2026-09-10T10:15:00", "2026-09-10T10:45:00")],
      blocked: [],
    };
    assert.strictEqual(check({salon: salon({max_bookings_per_slot: 2}), dayContext}).ok, true);

    dayContext.bookings.push(booked("b2", "2026-09-10T10:00:00", "2026-09-10T10:30:00"));
    assert.strictEqual(check({salon: salon({max_bookings_per_slot: 2}), dayContext}).code, "SLOT_FULL");
  });

  it("treats a missing max_bookings_per_slot as 1", () => {
    const v = check({
      salon: salon({max_bookings_per_slot: undefined}),
      dayContext: {bookings: [booked("b1", "2026-09-10T10:15:00", "2026-09-10T10:45:00")], blocked: []},
    });
    assert.strictEqual(v.code, "SLOT_FULL");
  });

  it("does not treat back-to-back bookings as overlapping", () => {
    const v = check({
      dayContext: {
        bookings: [
          booked("before", "2026-09-10T09:30:00", "2026-09-10T10:00:00"),
          booked("after", "2026-09-10T10:30:00", "2026-09-10T11:00:00"),
        ],
        blocked: [],
      },
    });
    assert.strictEqual(v.ok, true);
  });

  it("skips bookings with missing times rather than throwing", () => {
    const v = check({
      dayContext: {bookings: [{id: "b1", status: "confirmed", startMs: null, endMs: null}], blocked: []},
    });
    assert.strictEqual(v.ok, true);
  });

  // ── blocked slots ──────────────────────────────────────────────────────────

  it("rejects a slot the salon has blocked", () => {
    const v = check({
      dayContext: {
        bookings: [],
        blocked: [{startMs: ist("2026-09-10T09:00:00"), endMs: ist("2026-09-10T12:00:00")}],
      },
    });
    assert.strictEqual(v.code, "SLOT_BLOCKED");
  });

  it("ignores a block that ends before the slot starts", () => {
    const v = check({
      dayContext: {
        bookings: [],
        blocked: [{startMs: ist("2026-09-10T09:00:00"), endMs: ist("2026-09-10T10:00:00")}],
      },
    });
    assert.strictEqual(v.ok, true);
  });

  // ── precedence ─────────────────────────────────────────────────────────────

  it("reports the lead-time failure before the capacity failure", () => {
    const v = check({
      nowMs: ist("2026-09-10T09:50:00"),
      dayContext: {bookings: [booked("b1", "2026-09-10T10:00:00", "2026-09-10T10:30:00")], blocked: []},
    });
    assert.strictEqual(v.code, "SLOT_TOO_SOON");
  });
});

describe("buildDayAvailability", () => {
  const dayStartMs = ist("2026-09-10T00:00:00");
  const build = (over = {}) => slots.buildDayAvailability({
    salon: salon(),
    dayContext: {bookings: [], blocked: []},
    fromMs: dayStartMs,
    toMs: dayStartMs + 24 * 60 * MIN,
    durationMs: 30 * MIN,
    stepMinutes: 15,
    minLeadMs: 25 * MIN,
    nowMs: ist("2026-09-10T06:00:00"),
    ...over,
  });

  it("offers only slots inside working hours", () => {
    const out = build();
    // 09:00 through 20:30 inclusive at 15-min steps = 47 candidates.
    assert.strictEqual(out.length, 47);
    assert.match(out[0].label, /^09:00\s?[ap]m$/i);
    assert.strictEqual(out[out.length - 1].start_ms, ist("2026-09-10T20:30:00"));
  });

  it("aligns candidates to the step boundary", () => {
    const minutes = build().map((s) => new Date(s.start_ms).getUTCMinutes());
    assert.ok(minutes.every((m) => m % 15 === 0), "every candidate lands on :00/:15/:30/:45");
  });

  it("returns nothing when the salon is closed that day", () => {
    assert.deepStrictEqual(build({salon: salon({working_hours: CLOSED_ALL_WEEK})}), []);
  });

  it("keeps taken slots but marks them unavailable with a reason", () => {
    const out = build({
      dayContext: {
        bookings: [{id: "b1", status: "confirmed",
          startMs: ist("2026-09-10T10:00:00"), endMs: ist("2026-09-10T11:00:00")}],
        blocked: [],
      },
    });
    const taken = out.filter((s) => !s.free);
    assert.ok(taken.length > 0);
    assert.ok(taken.every((s) => s.code === "SLOT_FULL"));
    // A 30-min service starting 09:45 runs into the 10:00 booking.
    assert.strictEqual(out.find((s) => s.start_ms === ist("2026-09-10T09:45:00")).free, false);
    assert.strictEqual(out.find((s) => s.start_ms === ist("2026-09-10T09:30:00")).free, true);
    assert.strictEqual(out.find((s) => s.start_ms === ist("2026-09-10T11:00:00")).free, true);
  });

  it("marks slots inside the lead window unavailable rather than hiding them", () => {
    const out = build({nowMs: ist("2026-09-10T10:00:00")});
    const early = out.find((s) => s.start_ms === ist("2026-09-10T09:00:00"));
    assert.strictEqual(early.free, false);
    assert.strictEqual(early.code, "SLOT_TOO_SOON");
  });

  it("frees the slots held by the booking being rescheduled", () => {
    const dayContext = {
      bookings: [{id: "me", status: "confirmed",
        startMs: ist("2026-09-10T10:00:00"), endMs: ist("2026-09-10T11:00:00")}],
      blocked: [],
    };
    assert.strictEqual(build({dayContext}).find((s) => s.start_ms === ist("2026-09-10T10:00:00")).free, false);
    assert.strictEqual(
      build({dayContext, excludeBookingId: "me"}).find((s) => s.start_ms === ist("2026-09-10T10:00:00")).free,
      true,
    );
  });

  it("shortens the offered range as the service gets longer", () => {
    const short = build({durationMs: 30 * MIN});
    const long = build({durationMs: 120 * MIN});
    assert.ok(long.length < short.length);
    assert.strictEqual(long[long.length - 1].start_ms, ist("2026-09-10T19:00:00"));
  });
});

describe("workingHoursVerdict — midnight wrap", () => {
  const ist = (iso) => new Date(`${iso}+05:30`).getTime();

  it("rejects a window that runs past local midnight", () => {
    // 23:45 → 00:15 is 1425 → 15 as minutes-from-midnight, which naively
    // compares as inside 09:00–21:00.
    const v = slots.workingHoursVerdict(
      {timezone: "Asia/Kolkata", working_hours: OPEN_ALL_WEEK},
      ist("2026-09-10T23:45:00"),
      ist("2026-09-11T00:15:00"),
    );
    assert.strictEqual(v.code, "OUTSIDE_WORKING_HOURS");
  });
});
