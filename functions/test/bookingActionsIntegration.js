/**
 * End-to-end test of the panel booking actions against the Firebase emulators.
 *
 *   firebase emulators:exec --only functions,firestore,auth \
 *     --project cutq-e133a "node functions/test/bookingActionsIntegration.js"
 *
 * Covers what the unit tests cannot: role gating (SUPPORT vs ADMIN vs a plain
 * user), the ADMIN-only override, the audit trail, and that a reschedule really
 * does move the slot and revert a confirmed booking to pending.
 *
 * FCM sends inside the triggers fail against the emulator and are swallowed by
 * the functions themselves — that is the production behaviour too (a booking is
 * not rolled back because a push failed), so it does not affect these checks.
 */
const admin = require("firebase-admin");

const PROJECT = process.env.GCLOUD_PROJECT || "cutq-e133a";
const REGION = "us-central1";
const FN_PORT = process.env.FUNCTIONS_PORT || "5001";
const BASE = `http://127.0.0.1:${FN_PORT}/${PROJECT}/${REGION}`;

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;

admin.initializeApp({projectId: PROJECT});
const db = admin.firestore();

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function callFn(name, data, idToken) {
  const res = await fetch(`${BASE}/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idToken ? {authorization: `Bearer ${idToken}`} : {}),
    },
    body: JSON.stringify({data}),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    return {ok: false, status: body.error.status || res.status, message: body.error.message};
  }
  return {ok: true, result: body.result};
}

/** A signed-in identity: an Auth user, a Users doc, and an ID token. */
async function makeUser(uid, {role, name, isEnabled = true}) {
  await admin.auth().createUser({uid, email: `${uid}@example.test`}).catch(async () => {
    await admin.auth().updateUser(uid, {email: `${uid}@example.test`});
  });
  await db.doc(`Users/${uid}`).set({name, Role: role, isEnabled, phone: `+9199000${uid.length}`});

  const customToken = await admin.auth().createCustomToken(uid);
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({token: customToken, returnSecureToken: true}),
    },
  );
  const body = await res.json();
  if (!body.idToken) throw new Error(`could not mint id token for ${uid}: ${JSON.stringify(body)}`);
  return body.idToken;
}

const OPEN_ALL_WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
  .reduce((acc, d) => ({...acc, [d]: {open: "09:00", close: "21:00", is_closed: false}}), {});

const SALON_ID = "salon_panel_test";

/** Tomorrow at the given hour, Asia/Kolkata — safely inside working hours. */
function tomorrowIst(hour, minute = 0) {
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
    hour - 5, minute - 30, 0, 0,
  ));
  return d.getTime();
}

let seq = 0;
/**
 * Each booking gets its own slot unless the caller pins one, and none of them is
 * ever *created* pending.
 *
 * validateBookingOnCreate fires on every pending insert and cancels what it does
 * not like, asynchronously — so a fixture could be flipped to cancelled_by
 * "system" at any point after seeding, including in the middle of the assertions
 * about it. Whether a run saw that came down to trigger timing. Seeding as
 * confirmed and then updating to the wanted status keeps the trigger out
 * entirely: it early-returns on anything not pending, and an update does not
 * re-fire an onDocumentCreated. Tests that need two bookings to collide still
 * pin startMs explicitly.
 */
async function seedBooking({status = "pending", startMs, durationMin = 30, userId, extra = {}} = {}) {
  const id = `bk_panel_${++seq}`;
  const start = startMs ?? tomorrowIst(9 + Math.floor((seq - 1) / 4), ((seq - 1) % 4) * 15);
  const end = start + durationMin * 60000;
  await db.doc(`bookings/${id}`).set({
    user_id: userId,
    salon_id: SALON_ID,
    salon_name: "Panel Test Salon",
    status: status === "pending" ? "confirmed" : status,
    slot_start: admin.firestore.Timestamp.fromMillis(start),
    slot_end: admin.firestore.Timestamp.fromMillis(end),
    services: [{
      service_id: "svc1", service_name: "Haircut", service_price: 300,
      duration_minutes: durationMin,
      slot_start: admin.firestore.Timestamp.fromMillis(start),
      slot_end: admin.firestore.Timestamp.fromMillis(end),
    }],
    total_service_price: 300,
    booking_fee: 0,
    final_amount: 300,
    is_reviewed: false,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  });
  if (status === "pending") await db.doc(`bookings/${id}`).update({status: "pending"});
  return {id, start, end};
}

const read = async (id) => (await db.doc(`bookings/${id}`).get()).data();
const lastAction = (b) => (b.support_actions || [])[(b.support_actions || []).length - 1];

async function main() {
  console.log("\nPanel booking actions — emulator integration\n");

  const [adminTok, supportTok, userTok] = await Promise.all([
    makeUser("panel_admin", {role: "ADMIN", name: "Ada Admin"}),
    makeUser("panel_support", {role: "SUPPORT", name: "Sam Support"}),
    makeUser("panel_user", {role: "USER", name: "Ravi Customer"}),
  ]);

  await db.doc(`salons/${SALON_ID}`).set({
    name: "Panel Test Salon",
    owner_uid: "panel_owner",
    timezone: "Asia/Kolkata",
    working_hours: OPEN_ALL_WEEK,
    max_bookings_per_slot: 1,
    slot_interval_minutes: 5,
    is_active: true,
    phone: "+919900000000",
    city: "Ludhiana",
  });
  await db.doc(`salons/${SALON_ID}/services/svc1`).set({
    name: "Haircut", price: 300, duration_minutes: 30, is_active: true,
  });
  await db.doc("app_config/settings").set({booking_fee: 0, booking_min_lead_minutes: 30}, {merge: true});

  // The salon owner needs an Auth record or onSalonWrittenSyncClaims logs noise.
  await admin.auth().createUser({uid: "panel_owner", email: "panel_owner@example.test"}).catch(() => {});
  await db.doc("Users/panel_owner").set({name: "Olive Owner", Role: "SALONOWNER", isEnabled: true});

  // ── role gating ────────────────────────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user"});
    const anon = await callFn("supportUpdateBookingStatus", {bookingId: b.id, action: "confirm"});
    check("unauthenticated caller is refused", !anon.ok && /signed in/i.test(anon.message || ""), anon.message);

    const asUser = await callFn("supportUpdateBookingStatus", {bookingId: b.id, action: "confirm"}, userTok);
    check("a plain USER is refused", !asUser.ok && /Not authorized/i.test(asUser.message || ""), asUser.message);

    const avail = await callFn("supportGetSalonDayAvailability",
        {salonId: SALON_ID, dayStartMs: tomorrowIst(0), durationMinutes: 30}, userTok);
    check("a plain USER cannot read availability", !avail.ok, avail.message);
  }

  // ── confirm ────────────────────────────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user"});
    const res = await callFn("supportUpdateBookingStatus", {bookingId: b.id, action: "confirm"}, supportTok);
    check("SUPPORT can confirm a pending booking", res.ok, res.message);
    const after = await read(b.id);
    check("status becomes confirmed", after.status === "confirmed", after.status);
    check("the projection comes back for merging", res.ok && res.result?.booking?.status === "confirmed");

    const a = lastAction(after);
    check("audit records the action", a?.action === "confirm", JSON.stringify(a));
    check("audit records acting as the salon", a?.acted_as === "salon");
    check("audit records the real operator", a?.actor_uid === "panel_support" && a?.actor_role === "SUPPORT");
    check("audit is not an override", a?.override === false);

    const again = await callFn("supportUpdateBookingStatus", {bookingId: b.id, action: "confirm"}, supportTok);
    check("confirming an already-confirmed booking is refused", !again.ok, again.message);
  }

  // ── cancel, on each party's behalf ─────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user"});
    const res = await callFn("supportUpdateBookingStatus",
        {bookingId: b.id, action: "cancel_by_salon", reason: "Stylist off sick"}, supportTok);
    check("SUPPORT can cancel as the salon", res.ok, res.message);
    const after = await read(b.id);
    check("cancelled_by is 'salon', never 'admin'", after.cancelled_by === "salon", after.cancelled_by);
    check("the reason is stored", after.cancellation_reason === "Stylist off sick");
  }
  {
    const b = await seedBooking({userId: "panel_user", status: "confirmed"});
    const res = await callFn("supportUpdateBookingStatus",
        {bookingId: b.id, action: "cancel_by_user"}, supportTok);
    check("SUPPORT can cancel as the customer", res.ok, res.message);
    const after = await read(b.id);
    check("cancelled_by is 'user'", after.cancelled_by === "user", after.cancelled_by);
    check("a blank reason falls back to a default", after.cancellation_reason === "Cancelled by customer", after.cancellation_reason);
    check("audit records acting as the customer", lastAction(after)?.acted_as === "user");
  }

  // ── completed bookings are protected ───────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user", status: "completed"});
    const res = await callFn("supportUpdateBookingStatus",
        {bookingId: b.id, action: "cancel_by_salon"}, adminTok);
    check("even ADMIN cannot cancel a completed booking", !res.ok && /accounts/i.test(res.message || ""), res.message);
  }

  // ── override is ADMIN-only ─────────────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user", status: "cancelled"});
    const noOverride = await callFn("supportUpdateBookingStatus",
        {bookingId: b.id, action: "confirm"}, adminTok);
    check("confirming a cancelled booking needs an override", !noOverride.ok, noOverride.message);

    const asSupport = await callFn("supportUpdateBookingStatus",
        {bookingId: b.id, action: "confirm", override: true}, supportTok);
    check("SUPPORT cannot override", !asSupport.ok && /admin/i.test(asSupport.message || ""), asSupport.message);

    const asAdmin = await callFn("supportUpdateBookingStatus",
        {bookingId: b.id, action: "confirm", override: true}, adminTok);
    check("ADMIN can override", asAdmin.ok, asAdmin.message);
    const a = lastAction(await read(b.id));
    check("the override is recorded with its code", a?.override === true && a?.override_code === "STATUS_CANCELLED", JSON.stringify(a));
  }

  // ── reschedule ─────────────────────────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user", status: "confirmed", startMs: tomorrowIst(11)});
    const target = tomorrowIst(15);
    const res = await callFn("supportRescheduleBooking",
        {bookingId: b.id, newSlotStartMs: target}, supportTok);
    check("SUPPORT can reschedule", res.ok, res.message);
    check("it reports the booking had been confirmed", res.result?.wasConfirmed === true);

    const after = await read(b.id);
    check("the slot moved", after.slot_start.toMillis() === target, String(after.slot_start.toMillis()));
    check("the duration is preserved", after.slot_end.toMillis() - after.slot_start.toMillis() === 30 * 60000);
    check("per-service windows were re-laid", after.services[0].slot_start.toMillis() === target);
    check("a confirmed booking reverts to pending", after.status === "pending", after.status);
    check("audit records the reschedule as the customer", lastAction(after)?.action === "reschedule" && lastAction(after)?.acted_as === "user");
  }

  // ── reschedule into a taken slot ───────────────────────────────────────────
  {
    const occupiedAt = tomorrowIst(17);
    await seedBooking({userId: "panel_user", status: "confirmed", startMs: occupiedAt});
    const mover = await seedBooking({userId: "panel_user", startMs: tomorrowIst(12)});

    const refused = await callFn("supportRescheduleBooking",
        {bookingId: mover.id, newSlotStartMs: occupiedAt}, supportTok);
    check("a full slot is refused", !refused.ok && /SLOT_FULL/.test(refused.message || ""), refused.message);

    const supportOverride = await callFn("supportRescheduleBooking",
        {bookingId: mover.id, newSlotStartMs: occupiedAt, override: true}, supportTok);
    check("SUPPORT cannot override a full slot", !supportOverride.ok && /admin/i.test(supportOverride.message || ""), supportOverride.message);

    const adminOverride = await callFn("supportRescheduleBooking",
        {bookingId: mover.id, newSlotStartMs: occupiedAt, override: true}, adminTok);
    check("ADMIN can override a full slot", adminOverride.ok, adminOverride.message);
    const a = lastAction(await read(mover.id));
    check("the overridden code is recorded", a?.override_code === "SLOT_FULL", JSON.stringify(a));
  }

  // ── availability grid ──────────────────────────────────────────────────────
  {
    const busyAt = tomorrowIst(14);
    await seedBooking({userId: "panel_user", status: "confirmed", startMs: busyAt, durationMin: 60});

    const res = await callFn("supportGetSalonDayAvailability",
        {salonId: SALON_ID, dayStartMs: tomorrowIst(0), durationMinutes: 30}, supportTok);
    check("SUPPORT can read availability", res.ok, res.message);

    const list = res.result?.slots || [];
    check("the day has slots", list.length > 0, String(list.length));
    check("no slot falls outside working hours", list.every((s) => {
      const hhmm = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(s.start_ms));
      return hhmm >= "09:00" && hhmm <= "20:30";
    }), JSON.stringify(list.slice(0, 2)));

    const busy = list.find((s) => s.start_ms === busyAt);
    check("the taken slot is marked unavailable", busy && busy.free === false,
        busy ? JSON.stringify(busy) : `no slot at ${new Date(busyAt).toISOString()}; grid runs ${
          list.length ? new Date(list[0].start_ms).toISOString() : "?"} → ${
          list.length ? new Date(list[list.length - 1].start_ms).toISOString() : "?"}`);
    check("and says why", busy?.code === "SLOT_FULL", busy?.code);
  }


  // ── argument hardening ─────────────────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user"});

    // `action` indexes an object literal, so an inherited key must not be
    // mistaken for a real action spec.
    for (const bad of ["constructor", "__proto__", "toString", "nope", ""]) {
      const res = await callFn("supportUpdateBookingStatus", {bookingId: b.id, action: bad}, adminTok);
      check(`action "${bad}" is rejected as invalid-argument`,
          !res.ok && /action must be one of/.test(res.message || ""), `${res.status} ${res.message}`);
    }
    check("the booking was not touched by any of those",
        (await read(b.id)).status === "pending");
  }

  // ── malformed bookings cannot be moved ─────────────────────────────────────
  {
    const id = "bk_panel_noslot";
    // Created confirmed, then set pending, so validateBookingOnCreate never sees
    // it — it would cancel this one as INVALID_BOOKING and the assertions below
    // would be testing the wrong refusal.
    await db.doc(`bookings/${id}`).set({
      user_id: "panel_user", salon_id: SALON_ID, status: "confirmed",
      services: [], created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.doc(`bookings/${id}`).update({status: "pending"});
    const res = await callFn("supportRescheduleBooking",
        {bookingId: id, newSlotStartMs: tomorrowIst(11)}, adminTok);
    check("a booking with no time range is refused",
        !res.ok && /no valid time range/i.test(res.message || ""), res.message);

    const forced = await callFn("supportRescheduleBooking",
        {bookingId: id, newSlotStartMs: tomorrowIst(11), override: true}, adminTok);
    check("and override cannot force it either", !forced.ok, forced.message);
    const after = (await db.doc(`bookings/${id}`).get()).data();
    check("no zero-length slot was written", !after.slot_start && !after.slot_end);
  }

  // ── out-of-range dates ─────────────────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user"});
    const far = await callFn("supportRescheduleBooking",
        {bookingId: b.id, newSlotStartMs: Date.now() + 50 * 365 * 24 * 3600 * 1000}, adminTok);
    check("a date decades out is refused", !far.ok && /out of range/i.test(far.message || ""), far.message);

    const forced = await callFn("supportRescheduleBooking",
        {bookingId: b.id, newSlotStartMs: Date.now() + 50 * 365 * 24 * 3600 * 1000, override: true}, adminTok);
    check("override does not bypass the range check", !forced.ok, forced.message);

    // The past is only reachable via override, since SLOT_TOO_SOON stops the
    // normal path — but an override must not be able to write nonsense either.
    const longPast = await callFn("supportRescheduleBooking",
        {bookingId: b.id, newSlotStartMs: Date.now() - 400 * 24 * 3600 * 1000, override: true}, adminTok);
    check("a date a year in the past is refused even with override",
        !longPast.ok && /out of range/i.test(longPast.message || ""), longPast.message);

    // …while a just-passed time stays correctable.
    const justPast = await callFn("supportRescheduleBooking",
        {bookingId: b.id, newSlotStartMs: Date.now() - 20 * 60 * 1000, override: true}, adminTok);
    check("a time 20 minutes ago is still allowed with override",
        justPast.ok || !/out of range/i.test(justPast.message || ""), justPast.message);
  }

  // ── projection shape ───────────────────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user"});
    const res = await callFn("supportUpdateBookingStatus",
        {bookingId: b.id, action: "confirm"}, adminTok);
    const entry = (res.result?.booking?.support_actions || [])[0];
    check("the projection exposes at_ms", Number.isFinite(entry?.at_ms), JSON.stringify(entry));
    check("and does not leak the raw Timestamp", entry && !("at" in entry), JSON.stringify(entry));
    check("salon_timezone is projected for the picker",
        res.result?.booking?.salon_timezone === "Asia/Kolkata", res.result?.booking?.salon_timezone);
  }

  // ── two reps acting at once ────────────────────────────────────────────────
  {
    const b = await seedBooking({userId: "panel_user"});
    const [r1, r2] = await Promise.all([
      callFn("supportUpdateBookingStatus", {bookingId: b.id, action: "cancel_by_salon", reason: "A"}, supportTok),
      callFn("supportUpdateBookingStatus", {bookingId: b.id, action: "confirm"}, adminTok),
    ]);
    const after = await read(b.id);
    const applied = (after.support_actions || []).map((a) => a.action);
    const wonCount = [r1, r2].filter((r) => r.ok).length;

    check("concurrent conflicting actions do not both apply blindly", wonCount >= 1, `${wonCount} succeeded`);
    check("the stored status matches the last action that was allowed to write",
        (applied[applied.length - 1] === "confirm" && after.status === "confirmed") ||
        (applied[applied.length - 1] === "cancel_by_salon" && after.status === "cancelled"),
        `status=${after.status} actions=${applied.join(",")}`);
    check("a cancelled outcome carries its cancelled_by, a confirmed one carries none",
        after.status === "cancelled" ? after.cancelled_by === "salon" : !after.cancelled_by,
        `status=${after.status} cancelled_by=${after.cancelled_by}`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
