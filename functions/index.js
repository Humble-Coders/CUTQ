const {setGlobalOptions} = require("firebase-functions/v2");
const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated, onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");

setGlobalOptions({maxInstances: 10});

admin.initializeApp();

// ── helpers ───────────────────────────────────────────────────────────────────

function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function randomPassword(length = 8) {
  const all = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += all[bytes[i] % all.length];
  return out;
}

async function getUserProfile(uid) {
  const db = admin.firestore();
  for (const col of ["Users", "users"]) {
    const snap = await db.collection(col).doc(uid).get();
    if (snap.exists) return snap.data();
  }
  return null;
}

function buildEmailHtml(displayName, email, password) {
  const name = displayName || "there";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Your Salon Owner Account</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          <tr>
            <td style="background:#0a0a0a;padding:32px 40px;text-align:center;">
              <div style="display:inline-flex;align-items:center;gap:10px;">
                <div style="width:10px;height:10px;border-radius:50%;background:#18B79B;display:inline-block;"></div>
                <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">CUTQ</span>
              </div>
              <p style="color:#a1a1aa;font-size:13px;margin:6px 0 0;">Salon Management Platform</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:40px 40px 32px;">
              <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#09090b;">
                Welcome, ${name}!
              </h1>
              <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
                Your salon owner account has been created. You can now sign in to the platform using the credentials below.
              </p>

              <!-- Credentials box -->
              <table width="100%" cellpadding="0" cellspacing="0"
                style="background:#f9fafb;border:1px solid #e4e4e7;border-radius:8px;margin-bottom:28px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:1px;color:#a1a1aa;text-transform:uppercase;">
                      Email
                    </p>
                    <p style="margin:0 0 20px;font-size:15px;color:#18B79B;font-weight:600;">
                      ${email}
                    </p>
                    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:1px;color:#a1a1aa;text-transform:uppercase;">
                      Temporary Password
                    </p>
                    <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:3px;color:#09090b;font-family:monospace;">
                      ${password}
                    </p>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <a href="#"
                      style="display:inline-block;background:#18B79B;color:#ffffff;font-size:15px;font-weight:600;
                             padding:14px 32px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;">
                      Sign In to CUTQ &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6;">
                For security, please change your password after your first sign-in.
                If you did not expect this email, please contact your administrator.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f4f4f5;padding:20px 40px;text-align:center;border-top:1px solid #e4e4e7;">
              <p style="margin:0;font-size:12px;color:#a1a1aa;">
                This is an automated message from CUTQ Salon Management. Please do not reply to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Cloud Function ────────────────────────────────────────────────────────────

exports.createSalonOwner = onRequest(
  {invoker: "public", secrets: [SMTP_USER, SMTP_PASS]},
  async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({error: {status: "METHOD_NOT_ALLOWED", message: "POST only."}});
      return;
    }

    // Verify Firebase ID token
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({error: {status: "UNAUTHENTICATED", message: "Missing auth token."}});
      return;
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      res.status(401).json({error: {status: "UNAUTHENTICATED", message: "Invalid auth token."}});
      return;
    }

    // Check ADMIN access
    const profile = await getUserProfile(decoded.uid);
    if (!profile || profile.Role !== "ADMIN" || profile.isEnabled !== true) {
      res.status(403).json({error: {status: "PERMISSION_DENIED", message: "Admin access required."}});
      return;
    }

    const data = (req.body && req.body.data) || {};
    const email = String(data.email || "").trim().toLowerCase();
    const name = String(data.name || "").trim();
    const phone = String(data.phone || "").trim();

    if (!email || !email.includes("@")) {
      res.status(400).json({error: {status: "INVALID_ARGUMENT", message: "Valid email is required."}});
      return;
    }

    const smtpUser = SMTP_USER.value();
    const smtpPass = SMTP_PASS.value();

    const password = randomPassword(8);

    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email,
        password,
        displayName: name || undefined,
        disabled: false,
      });
    } catch (err) {
      logger.error("createUser failed", err);
      res.status(409).json({error: {status: "ALREADY_EXISTS", message: "User already exists or email invalid."}});
      return;
    }

    const uid = userRecord.uid;

    // Write Users doc + send email in parallel
    await Promise.all([
      admin.firestore().collection("Users").doc(uid).set(
        {
          name: name || "",
          phone: phone || "",
          email,
          profile_photo: "",
          created_at: admin.firestore.FieldValue.serverTimestamp(),
          Role: "SALONOWNER",
          isEnabled: true,
        },
        {merge: true},
      ),
      nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {user: smtpUser, pass: smtpPass},
      }).sendMail({
        from: `"CUTQ Salon" <${smtpUser}>`,
        to: email,
        subject: "Your Salon Owner Account — CUTQ",
        text:
          `Hello ${name || "there"},\n\n` +
          "Your salon owner account has been created.\n\n" +
          `Email: ${email}\n` +
          `Temporary password: ${password}\n\n` +
          "Please sign in and change your password.\n",
        html: buildEmailHtml(name, email, password),
      }),
    ]);

    res.status(200).json({result: {uid, email}});
  },
);

// ── Booking notifications ───────────────────────────────────────────────────
// Sends an FCM message to the salon owner when a new booking is created.
exports.onBookingCreatedNotifySalonOwner = onDocumentCreated(
  "bookings/{bookingId}",
  async (event) => {
    const bookingId = event.params.bookingId;
    const bookingData = event.data?.data?.() || {};

    const salonId = bookingData.salon_id;
    if (!salonId) {
      logger.warn("Booking missing salon_id", {bookingId});
      return;
    }

    try {
      const salonSnap = await admin
        .firestore()
        .collection("salons")
        .doc(salonId)
        .get();

      const salonData = salonSnap.exists ? salonSnap.data() : null;
      const ownerUid = salonData?.owner_uid;
      if (!ownerUid) {
        logger.warn("Salon missing owner_uid", {bookingId, salonId});
        return;
      }

      // We store fcm_token under Users/{owner_uid} (your app does this).
      const ownerProfile = await getUserProfile(ownerUid);
      const fcmToken = ownerProfile?.fcm_token;
      if (!fcmToken) {
        logger.warn("Owner has no fcm_token", {bookingId, salonId, ownerUid});
        return;
      }

      // Format a short slot time for the message body (optional).
      let slotText = "";
      const slotStart = bookingData.slot_start;
      if (slotStart?.toDate) {
        const d = slotStart.toDate();
        // Avoid locale quirks; keep it short.
        slotText = ` at ${d.toISOString().replace("T", " ").slice(0, 16)}`;
      }

      const title = "New booking";
      const body = `A new booking was created${slotText}.`;

      // Android: use our app's channel id so it plays the custom sound if channel exists.
      const channelId = "chat_messages";

      const message = {
        token: fcmToken,
        android: {
          priority: "high",
          notification: {
            channelId,
          },
        },
        // Data-first so your Capacitor foreground handler can read title/body from payload.data.
        data: {
          title,
          body,
          bookingId: String(bookingId || ""),
          salonId: String(salonId || ""),
          type: "booking_created",
        },
        notification: {
          title,
          body,
        },
      };

      await admin.messaging().send(message);
      logger.info("Sent booking notification", {bookingId, ownerUid, salonId});
    } catch (err) {
      logger.error("Failed to send booking notification", {bookingId, salonId, err});
    }
  },
);

// ── Booking validation ─────────────────────────────────────────────────────────
// Triggered on every new booking document.
// Validates slot timing, working hours, capacity, blocked slots, and booking fee.
// On failure: sets status = "cancelled" with a reason.
// On success: does nothing — booking stays "pending" for salon owner to manage.

function parseTimeToMinutes(timeStr) {
  const parts = (timeStr || "0:0").split(":");
  return parseInt(parts[0] || "0") * 60 + parseInt(parts[1] || "0");
}

// Extract { weekday, totalMinutes } in the given IANA timezone.
// weekday is lowercase ("monday", "tuesday", …).
// totalMinutes is hours*60 + minutes in local time.
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

exports.validateBookingOnCreate = onDocumentCreated(
  "bookings/{bookingId}",
  async (event) => {
    const bookingId = event.params.bookingId;
    const booking = event.data?.data?.() || {};

    // Only validate pending bookings created by the app
    if (booking.status !== "pending") return;

    const db = admin.firestore();

    const cancelBooking = async (reason) => {
      logger.warn("Cancelling booking", {bookingId, reason});
      await db.collection("bookings").doc(bookingId).update({
        status: "cancelled",
        cancellation_reason: reason,
        cancelled_by: "system",
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    };

    try {
      const salonId = booking.salon_id;
      const slotStart = booking.slot_start?.toDate?.();
      const slotEnd = booking.slot_end?.toDate?.();

      // Support both new format (services array) and old format (service_id at top level)
      const isNewFormat = Array.isArray(booking.services) && booking.services.length > 0;
      const legacyServiceId = booking.service_id;

      if (!salonId || !slotStart || !slotEnd || (!isNewFormat && !legacyServiceId)) {
        return cancelBooking("INVALID_BOOKING: Missing required fields (salon_id, slot_start, slot_end, services/service_id)");
      }

      // 1. Salon must exist and be active
      const salonSnap = await db.collection("salons").doc(salonId).get();
      if (!salonSnap.exists || salonSnap.data().is_active === false) {
        return cancelBooking("SALON_NOT_FOUND: Salon not found or inactive");
      }
      const salon = salonSnap.data();

      // 2. All services must exist and be active
      if (isNewFormat) {
        for (const svc of booking.services) {
          if (!svc.service_id) continue;
          const svcSnap = await db.collection("salons").doc(salonId)
            .collection("services").doc(svc.service_id).get();
          if (!svcSnap.exists || svcSnap.data().is_active === false) {
            return cancelBooking(`SERVICE_NOT_FOUND: Service ${svc.service_id} not found or inactive`);
          }
        }
      } else {
        const serviceSnap = await db.collection("salons").doc(salonId)
          .collection("services").doc(legacyServiceId).get();
        if (!serviceSnap.exists || serviceSnap.data().is_active === false) {
          return cancelBooking("SERVICE_NOT_FOUND: Service not found or inactive");
        }
      }

      // 3. Booking fee snapshot must match current global fee (only checked when fee > 0)
      if ((booking.booking_fee || 0) > 0) {
        const settingsSnap = await db.collection("app_config").doc("settings").get();
        const currentFee = settingsSnap.exists ? (settingsSnap.data().booking_fee ?? 0) : 0;
        if (booking.booking_fee !== currentFee) {
          return cancelBooking(`BOOKING_FEE_MISMATCH: Booking fee has changed to ₹${currentFee}. Please restart and try again.`);
        }
      }

      // 4. Slot must be at least 25 minutes in the future
      const now = new Date();
      const minTime = new Date(now.getTime() + 25 * 60 * 1000);
      if (slotStart < minTime) {
        return cancelBooking("SLOT_TOO_SOON: Slot must be at least 25 minutes from now");
      }

      // 5. Working hours — slot must be within salon open hours on that day.
      // Cloud Functions run in UTC; working_hours strings are in the salon's local time,
      // so we must convert using the salon's timezone (defaults to Asia/Kolkata).
      const tz = salon.timezone || "Asia/Kolkata";
      const {weekday: dayKey, totalMinutes: startMin} = getLocalTimeParts(slotStart, tz);
      const {totalMinutes: endMin} = getLocalTimeParts(slotEnd, tz);
      const dayHours = salon.working_hours?.[dayKey];
      if (!dayHours || dayHours.is_closed === true) {
        return cancelBooking("SALON_CLOSED: Salon is closed on this day");
      }
      const openMin = parseTimeToMinutes(dayHours.open);
      const closeMin = parseTimeToMinutes(dayHours.close);
      if (startMin < openMin || endMin > closeMin) {
        return cancelBooking("OUTSIDE_WORKING_HOURS: Slot is outside salon working hours");
      }

      // 6. Capacity check — count non-cancelled bookings overlapping this slot
      const dayStart = new Date(slotStart);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const bookingsSnap = await db.collection("bookings")
        .where("salon_id", "==", salonId)
        .where("slot_start", ">=", admin.firestore.Timestamp.fromDate(dayStart))
        .where("slot_start", "<", admin.firestore.Timestamp.fromDate(dayEnd))
        .get();

      const maxBookings = salon.max_bookings_per_slot ?? 1;
      const overlapping = bookingsSnap.docs.filter((doc) => {
        if (doc.id === bookingId) return false;
        const d = doc.data();
        if (d.status === "cancelled") return false;
        const bStart = d.slot_start?.toDate?.();
        const bEnd = d.slot_end?.toDate?.();
        if (!bStart || !bEnd) return false;
        return bStart < slotEnd && bEnd > slotStart; // interval overlap
      });
      if (overlapping.length >= maxBookings) {
        return cancelBooking("SLOT_FULL: This time slot is fully booked");
      }

      // 7. Blocked slots — fetch day's blocks and check overlap in memory
      const blockedSnap = await db.collection("salons").doc(salonId)
        .collection("blocked_slots")
        .where("start", ">=", admin.firestore.Timestamp.fromDate(dayStart))
        .where("start", "<", admin.firestore.Timestamp.fromDate(dayEnd))
        .get();

      const isBlocked = blockedSnap.docs.some((doc) => {
        const d = doc.data();
        const bStart = d.start?.toDate?.();
        const bEnd = d.end?.toDate?.();
        if (!bStart || !bEnd) return false;
        return bStart < slotEnd && bEnd > slotStart;
      });
      if (isBlocked) {
        return cancelBooking("SLOT_BLOCKED: This time slot is blocked by the salon");
      }

      // All checks passed — booking stays "pending"
      logger.info("Booking validation passed", {bookingId, salonId});
    } catch (err) {
      logger.error("Unexpected error during booking validation", {bookingId, err});
      await cancelBooking("INTERNAL_ERROR: " + (err.message || "Unknown error"));
    }
  },
);

// ── Reschedule booking ────────────────────────────────────────────────────────
// Validates new slot (same 5 checks as onCreate) then updates the booking in-place.
// If booking was "confirmed", status reverts to "pending" and salon owner is notified.
// If booking was "pending", status stays "pending" and no notification is sent.
exports.rescheduleBooking = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const {bookingId, newSlotStartMs: rawMs} = request.data || {};
  const newSlotStartMs = Number(rawMs);
  if (!bookingId || !newSlotStartMs || isNaN(newSlotStartMs)) {
    throw new HttpsError("invalid-argument", "bookingId and newSlotStartMs are required.");
  }

  const db = admin.firestore();
  const userId = auth.uid;

  // Fetch booking
  const bookingRef = db.collection("bookings").doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data();

  // Ownership check
  if (booking.user_id !== userId) {
    throw new HttpsError("permission-denied", "Not your booking.");
  }

  // Status check — only pending / confirmed can be rescheduled
  if (booking.status !== "pending" && booking.status !== "confirmed") {
    throw new HttpsError(
      "failed-precondition",
      "Only pending or confirmed bookings can be rescheduled.",
    );
  }

  // Compute new end by preserving total duration
  const oldStartMs = booking.slot_start?.toDate?.()?.getTime?.() ?? 0;
  const oldEndMs = booking.slot_end?.toDate?.()?.getTime?.() ?? 0;
  const totalDurationMs = oldEndMs - oldStartMs;

  const newSlotStart = new Date(newSlotStartMs);
  const newSlotEnd = new Date(newSlotStartMs + totalDurationMs);

  // ── 1. At least 25 min in the future ────────────────────────────────────
  const now = new Date();
  const minTime = new Date(now.getTime() + 25 * 60 * 1000);
  if (newSlotStart < minTime) {
    throw new HttpsError(
      "failed-precondition",
      "SLOT_TOO_SOON: New slot must be at least 25 minutes from now.",
    );
  }

  const salonId = booking.salon_id;

  // ── 2. Salon exists and is active ────────────────────────────────────────
  const salonSnap = await db.collection("salons").doc(salonId).get();
  if (!salonSnap.exists || salonSnap.data().is_active === false) {
    throw new HttpsError("failed-precondition", "SALON_NOT_FOUND: Salon not found or inactive.");
  }
  const salon = salonSnap.data();

  // ── 3. Working hours ─────────────────────────────────────────────────────
  const tz = salon.timezone || "Asia/Kolkata";
  const {weekday: dayKey, totalMinutes: startMin} = getLocalTimeParts(newSlotStart, tz);
  const {totalMinutes: endMin} = getLocalTimeParts(newSlotEnd, tz);
  const dayHours = salon.working_hours?.[dayKey];
  if (!dayHours || dayHours.is_closed === true) {
    throw new HttpsError("failed-precondition", "SALON_CLOSED: Salon is closed on this day.");
  }
  const openMin = parseTimeToMinutes(dayHours.open);
  const closeMin = parseTimeToMinutes(dayHours.close);
  if (startMin < openMin || endMin > closeMin) {
    throw new HttpsError(
      "failed-precondition",
      "OUTSIDE_WORKING_HOURS: Slot is outside salon working hours.",
    );
  }

  // ── 4. Capacity check ────────────────────────────────────────────────────
  const dayStart = new Date(newSlotStart);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const bookingsSnap = await db.collection("bookings")
    .where("salon_id", "==", salonId)
    .where("slot_start", ">=", admin.firestore.Timestamp.fromDate(dayStart))
    .where("slot_start", "<", admin.firestore.Timestamp.fromDate(dayEnd))
    .get();

  const maxBookings = salon.max_bookings_per_slot ?? 1;
  const overlapping = bookingsSnap.docs.filter((doc) => {
    if (doc.id === bookingId) return false; // exclude the booking being rescheduled
    const d = doc.data();
    if (d.status === "cancelled") return false;
    const bStart = d.slot_start?.toDate?.();
    const bEnd = d.slot_end?.toDate?.();
    if (!bStart || !bEnd) return false;
    return bStart < newSlotEnd && bEnd > newSlotStart;
  });
  if (overlapping.length >= maxBookings) {
    throw new HttpsError("failed-precondition", "SLOT_FULL: This time slot is fully booked.");
  }

  // ── 5. Blocked slots ─────────────────────────────────────────────────────
  const blockedSnap = await db.collection("salons").doc(salonId)
    .collection("blocked_slots")
    .where("start", ">=", admin.firestore.Timestamp.fromDate(dayStart))
    .where("start", "<", admin.firestore.Timestamp.fromDate(dayEnd))
    .get();

  const isBlocked = blockedSnap.docs.some((doc) => {
    const d = doc.data();
    const bStart = d.start?.toDate?.();
    const bEnd = d.end?.toDate?.();
    if (!bStart || !bEnd) return false;
    return bStart < newSlotEnd && bEnd > newSlotStart;
  });
  if (isBlocked) {
    throw new HttpsError("failed-precondition", "SLOT_BLOCKED: This time slot is blocked by the salon.");
  }

  // ── All checks passed — build the update ─────────────────────────────────
  const wasConfirmed = booking.status === "confirmed";
  const isNewFormat = Array.isArray(booking.services) && booking.services.length > 0;

  // Recompute per-service windows preserving original durations
  let updatedServices = null;
  if (isNewFormat) {
    let cursor = newSlotStartMs;
    updatedServices = booking.services.map((svc) => {
      const durMs = (svc.duration_minutes || 0) * 60_000;
      const svcStartMs = cursor;
      const svcEndMs = cursor + durMs;
      cursor = svcEndMs;
      return {
        ...svc,
        slot_start: admin.firestore.Timestamp.fromMillis(svcStartMs),
        slot_end: admin.firestore.Timestamp.fromMillis(svcEndMs),
      };
    });
  }

  const updateData = {
    slot_start: admin.firestore.Timestamp.fromDate(newSlotStart),
    slot_end: admin.firestore.Timestamp.fromDate(newSlotEnd),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (updatedServices) updateData.services = updatedServices;
  if (wasConfirmed) updateData.status = "pending";

  await bookingRef.update(updateData);
  logger.info("Booking rescheduled", {bookingId, userId, wasConfirmed});

  // ── Notify salon owner if booking was confirmed ───────────────────────────
  if (wasConfirmed) {
    try {
      const ownerSnap = await db.collection("salons").doc(salonId).get();
      const ownerUid = ownerSnap.exists ? ownerSnap.data()?.owner_uid : null;
      if (ownerUid) {
        const ownerProfile = await getUserProfile(ownerUid);
        const ownerToken = ownerProfile?.fcm_token;
        if (ownerToken) {
          const slotText = newSlotStart.toISOString().replace("T", " ").slice(0, 16);
          const svcLabel = isNewFormat ?
            booking.services.map((s) => s.service_name).join(", ") :
            (booking.service_name || "appointment");
          await admin.messaging().send({
            token: ownerToken,
            notification: {
              title: "Booking Rescheduled",
              body: `A customer rescheduled their ${svcLabel} to ${slotText}.`,
            },
            data: {
              booking_id: String(bookingId),
              salonId: String(salonId),
              type: "booking_rescheduled",
              new_slot_start: String(newSlotStartMs),
            },
            android: {
              priority: "high",
              notification: {channelId: "cutq_bookings", sound: "default"},
            },
            apns: {payload: {aps: {sound: "default", badge: 1}}},
          });
          logger.info("Sent reschedule notification to salon", {bookingId, ownerUid});
        }
      }
    } catch (notifErr) {
      // Non-fatal — the reschedule already succeeded
      logger.error("Failed to send reschedule notification", {bookingId, err: notifErr});
    }
  }

  return {success: true, wasConfirmed};
});

// ── Booking status notifications ─────────────────────────────────────────────
// USER notifications:
//   • pending  → confirmed  : "Booking Confirmed!"
//   • confirmed → completed : "How was your experience?" (review prompt)
//   • any      → cancelled (by salon) : "Booking Cancelled"
//   • any      → cancelled (by user)  : "Booking Cancelled" (confirmation)
// SALON notifications:
//   • any      → cancelled (by user)  : "Booking Cancelled by Customer"
exports.onBookingStatusChanged = onDocumentUpdated(
  "bookings/{bookingId}",
  async (event) => {
    const before = event.data?.before?.data?.() || {};
    const after = event.data?.after?.data?.() || {};

    // Bail out if status didn't change.
    if (before.status === after.status) return;

    const bookingId = event.params.bookingId;
    const userId = after.user_id || "";
    const salonId = after.salon_id || "";
    const salonName = after.salon_name || "your salon";
    const service = after.service_name || "your service";

    // ── Helper: build and send an FCM message ────────────────────────────────
    async function sendFcm(token, title, body, recipientId, recipientType) {
      const message = {
        token,
        notification: {title, body},
        data: {
          booking_id: String(bookingId),
          type: "booking_status_changed",
          new_status: String(after.status),
        },
        android: {
          priority: "high",
          notification: {channelId: "cutq_bookings", sound: "default", priority: "high"},
        },
        apns: {payload: {aps: {sound: "default", badge: 1}}},
      };
      try {
        await admin.messaging().send(message);
        logger.info("Sent booking status notification", {bookingId, recipientId, recipientType, newStatus: after.status});
      } catch (err) {
        if (
          err.code === "messaging/registration-token-not-registered" ||
          err.code === "messaging/invalid-registration-token"
        ) {
          logger.warn("Stale FCM token — removing", {recipientId, recipientType});
          await admin.firestore().collection("Users").doc(recipientId)
            .update({fcm_token: admin.firestore.FieldValue.delete()})
            .catch(() => {});
        } else {
          logger.error("Failed to send booking status notification", {bookingId, recipientId, err});
        }
      }
    }

    // ── Determine user notification content ──────────────────────────────────
    let userTitle = "";
    let userBody = "";
    let notifyUser = false;
    let notifySalon = false;

    if (before.status === "pending" && after.status === "confirmed") {
      userTitle = "Booking Confirmed!";
      userBody = `Your ${service} at ${salonName} is confirmed. See you soon!`;
      notifyUser = true;
    } else if (before.status === "confirmed" && after.status === "completed") {
      userTitle = "How was your experience?";
      userBody = `Your ${service} at ${salonName} is done. Tap to leave a review!`;
      notifyUser = true;
    } else if (after.status === "cancelled" && after.cancelled_by === "salon") {
      const reason = after.cancellation_reason || "No reason provided.";
      userTitle = "Booking Cancelled";
      userBody = `${salonName} has cancelled your ${service} appointment. Reason: ${reason}`;
      notifyUser = true;
    } else if (after.status === "cancelled" && after.cancelled_by === "user") {
      userTitle = "Booking Cancelled";
      userBody = `Your ${service} booking at ${salonName} has been successfully cancelled.`;
      notifyUser = true;
      notifySalon = true;
    } else {
      return;
    }

    // ── Notify user ───────────────────────────────────────────────────────────
    if (notifyUser) {
      if (!userId) {
        logger.warn("Booking missing user_id", {bookingId});
      } else {
        const userProfile = await getUserProfile(userId);
        const userToken = userProfile?.fcm_token;
        if (!userToken) {
          logger.warn("User has no fcm_token", {bookingId, userId});
        } else {
          await sendFcm(userToken, userTitle, userBody, userId, "user");
        }
      }
    }

    // ── Notify salon owner (user cancellation only) ───────────────────────────
    if (notifySalon) {
      if (!salonId) {
        logger.warn("Booking missing salon_id for salon notification", {bookingId});
        return;
      }
      const salonSnap = await admin.firestore().collection("salons").doc(salonId).get();
      const ownerUid = salonSnap.exists ? salonSnap.data()?.owner_uid : null;
      if (!ownerUid) {
        logger.warn("Salon missing owner_uid for cancellation notification", {bookingId, salonId});
        return;
      }
      const ownerProfile = await getUserProfile(ownerUid);
      const ownerToken = ownerProfile?.fcm_token;
      if (!ownerToken) {
        logger.warn("Salon owner has no fcm_token", {bookingId, salonId, ownerUid});
        return;
      }
      const salonTitle = "Booking Cancelled by Customer";
      const salonBody = `A customer has cancelled their ${service} booking at ${salonName}.`;
      await sendFcm(ownerToken, salonTitle, salonBody, ownerUid, "salon_owner");
    }
  },
);
