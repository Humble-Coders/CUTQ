const {setGlobalOptions} = require("firebase-functions/v2");
const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated, onDocumentUpdated, onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
// Literally the same objects the `admin.firestore.*` namespace exposes, taken
// from the modular entrypoint instead. The functions emulator proxies the
// `admin` module and its proxy drops those namespace statics, so the namespaced
// form reads as `undefined` under `emulators:exec` — which made every write path
// in this file untestable. Deployed, the two forms are identical.
const {FieldValue, Timestamp} = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const sharp = require("sharp");
const ledger = require("./ledger");
const slots = require("./bookingSlots");

const {SMTP_USER, SMTP_PASS, PEXELS_API_KEY} = require("./secrets");

setGlobalOptions({maxInstances: 10});

admin.initializeApp();

// Explicit bucket — the project's only bucket is the *.firebasestorage.app one
// (there is no legacy *.appspot.com bucket), so admin.storage().bucket() must be
// given the name.
const STORAGE_BUCKET = "cutq-e133a.firebasestorage.app";

// ── helpers ───────────────────────────────────────────────────────────────────

// Throws unless the caller is a signed-in ADMIN (Users/{uid}.Role === "ADMIN").
async function assertAdmin(auth) {
  const uid = auth && auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  const snap = await admin.firestore().collection("Users").doc(uid).get();
  if (!snap.exists || snap.data().Role !== "ADMIN") {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
  return uid;
}

// Recompute a user's Storage-authorization custom claims from Firestore and
// write them to the Auth token. Storage rules read these (request.auth.token)
// because cross-service Firestore reads don't evaluate in this project's rules.
//   role   = Users/{uid}.Role  ("ADMIN" | "SALONOWNER" | "SALONTEAM" | "SUPPORT")
//   salons = ids of salons the user owns or is a team member of
// NOTE: claims only take effect after the user's next sign-in / token refresh.
async function refreshUserClaims(uid) {
  if (!uid) return null;
  const db = admin.firestore();
  const [userSnap, ownedSnap, teamSnap] = await Promise.all([
    db.collection("Users").doc(uid).get(),
    db.collection("salons").where("owner_uid", "==", uid).get(),
    db.collection("salons").where("team_uids", "array-contains", uid).get(),
  ]);
  const role = userSnap.exists ? (userSnap.data().Role || "") : "";
  const salons = Array.from(new Set([
    ...ownedSnap.docs.map((d) => d.id),
    ...teamSnap.docs.map((d) => d.id),
  ]));
  const claims = {};
  if (role) claims.role = role;
  if (salons.length) claims.salons = salons;
  await admin.auth().setCustomUserClaims(uid, claims);
  return claims;
}

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
                    <a href="https://dashboard.cutqsalons.in/signin"
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

// Keep Storage-authorization claims (role + salons) in sync whenever a salon's
// ownership or team changes — covers admin creating a salon (owner_uid set),
// team add/remove, and owner reassignment. Affected users must re-login to pick
// up the refreshed token.
exports.onSalonWrittenSyncClaims = onDocumentWritten(
  "salons/{salonId}",
  async (event) => {
    const before = event.data?.before?.data?.() || {};
    const after = event.data?.after?.data?.() || {};
    const uids = new Set();
    [before.owner_uid, after.owner_uid].forEach((u) => u && uids.add(u));
    (Array.isArray(before.team_uids) ? before.team_uids : []).forEach((u) => u && uids.add(u));
    (Array.isArray(after.team_uids) ? after.team_uids : []).forEach((u) => u && uids.add(u));
    for (const uid of uids) {
      try {
        await refreshUserClaims(uid);
      } catch (err) {
        logger.error("onSalonWrittenSyncClaims: refresh failed", {uid, err});
      }
    }
  },
);

// ── Password reset (sent by us, not Firebase Auth's mailer) ─────────────────────
//
// The dashboard "Forgot password" calls this. We generate a Firebase password-reset
// link with the Admin SDK and email it ourselves via connect@cutqsalons.in, so all
// outbound mail comes from a single branded address. Returns {ok:true} regardless of
// whether the email is registered (don't leak account existence).
function buildPasswordResetHtml(link) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <tr><td style="background:#0a0a0a;padding:32px 40px;text-align:center;">
        <div style="display:inline-flex;align-items:center;gap:10px;">
          <div style="width:10px;height:10px;border-radius:50%;background:#18B79B;display:inline-block;"></div>
          <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">CUTQ</span>
        </div></td></tr>
      <tr><td style="background:#ffffff;padding:40px;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#09090b;">Reset your password</h1>
        <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
          We received a request to reset your CutQ password. Click the button below to choose a new one. This link expires shortly for your security.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;"><tr><td>
          <a href="${link}" style="display:inline-block;background:#18B79B;color:#ffffff;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;text-decoration:none;">Reset Password &rarr;</a>
        </td></tr></table>
        <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.6;">If you didn't request this, you can safely ignore this email.</p>
      </td></tr>
      <tr><td style="background:#fafafa;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
        <p style="margin:0;font-size:12px;color:#a1a1aa;">CutQ &middot; connect@cutqsalons.in</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

exports.sendPasswordReset = onCall(
  {secrets: [SMTP_USER, SMTP_PASS]},
  async (request) => {
    const email = String(request.data?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw new HttpsError("invalid-argument", "A valid email is required.");
    }
    const smtpUser = SMTP_USER.value();
    const smtpPass = SMTP_PASS.value();
    if (!smtpUser || !smtpPass) {
      throw new HttpsError("failed-precondition", "Email service is not configured.");
    }

    let link;
    try {
      link = await admin.auth().generatePasswordResetLink(email);
    } catch (err) {
      // user-not-found / invalid — don't reveal, just no-op.
      logger.info("sendPasswordReset: no link generated", {email, code: err.code});
      return {ok: true};
    }

    try {
      await nodemailer.createTransport({
        host: "smtp.gmail.com", port: 465, secure: true, auth: {user: smtpUser, pass: smtpPass},
      }).sendMail({
        from: `"CutQ" <${smtpUser}>`,
        to: email,
        subject: "Reset your CutQ password",
        text:
          "Hello,\n\nWe received a request to reset your CutQ password. " +
          "Use the link below to set a new password:\n\n" + link +
          "\n\nIf you didn't request this, you can safely ignore this email.\n\n— CutQ",
        html: buildPasswordResetHtml(link),
      });
      logger.info("sendPasswordReset: email sent", {email});
    } catch (err) {
      logger.error("sendPasswordReset: email failed", {email, err});
      throw new HttpsError("internal", "Could not send the reset email. Please try again.");
    }
    return {ok: true};
  },
);

// ── Salon delete (cascade) ──────────────────────────────────────────────────────
// Admin-only. Deletes the salon doc + its subcollections (services, stylists, team,
// blocked_slots) and its Storage images. Bookings are intentionally NOT deleted so
// history is preserved.
exports.deleteSalonCascade = onCall(async (request) => {
  await assertAdmin(request.auth);
  const salonId = String(request.data?.salonId || "").trim();
  if (!salonId) throw new HttpsError("invalid-argument", "salonId is required.");
  const db = admin.firestore();
  await db.recursiveDelete(db.collection("salons").doc(salonId));
  try {
    await admin.storage().bucket(STORAGE_BUCKET).deleteFiles({prefix: `salons/${salonId}/`});
  } catch (err) {
    logger.error("deleteSalonCascade: storage delete failed", {salonId, err});
  }
  logger.info("deleteSalonCascade: done", {salonId});
  return {ok: true};
});

// ── Copy onboarding-submission images into a salon's own storage ──────────────────
// Admin-only. Called after a salon is created from a submission for the images the
// admin kept (did not replace). Copies objects to salons/{salonId}/..., assigns a
// fresh download token, and writes the URLs onto the salon doc.
exports.importSubmissionImages = onCall(async (request) => {
  await assertAdmin(request.auth);
  const {submissionId, salonId, fields} = request.data || {};
  if (!submissionId || !salonId) {
    throw new HttpsError("invalid-argument", "submissionId and salonId are required.");
  }
  const db = admin.firestore();
  const subSnap = await db.collection("salon_submissions").doc(String(submissionId)).get();
  if (!subSnap.exists) throw new HttpsError("not-found", "Submission not found.");
  const sub = subSnap.data();
  const bucket = admin.storage().bucket(STORAGE_BUCKET);

  async function copyOne(srcPath, destPath) {
    const token = crypto.randomUUID();
    await bucket.file(srcPath).copy(bucket.file(destPath));
    await bucket.file(destPath).setMetadata({
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000",
      metadata: {firebaseStorageDownloadTokens: token},
    });
    return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(destPath)}?alt=media&token=${token}`;
  }

  const want = fields || {logo: true, cover: true, gallery: true};
  const updates = {};
  try {
    if (want.logo && sub.logo_path) {
      updates.logo_url = await copyOne(sub.logo_path, `salons/${salonId}/logo.jpg`);
    }
    if (want.cover && sub.cover_path) {
      updates.cover_photo = await copyOne(sub.cover_path, `salons/${salonId}/cover.jpg`);
    }
    if (want.gallery && Array.isArray(sub.gallery) && sub.gallery.length) {
      const gal = [];
      for (let i = 0; i < sub.gallery.length; i++) {
        const g = sub.gallery[i];
        if (!g?.path) continue;
        const id = crypto.randomUUID();
        const url = await copyOne(g.path, `salons/${salonId}/gallery/${id}.jpg`);
        gal.push({id, url, display_order: i});
      }
      if (gal.length) updates.gallery = gal;
    }
  } catch (err) {
    logger.error("importSubmissionImages: copy failed", {submissionId, salonId, err});
    throw new HttpsError("internal", "Could not copy images. You can upload them manually.");
  }
  if (Object.keys(updates).length) {
    updates.updated_at = FieldValue.serverTimestamp();
    await db.collection("salons").doc(String(salonId)).update(updates);
  }
  return {ok: true, ...updates};
});

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

    try {
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
        res.status(401).json({error: {status: "UNAUTHENTICATED", message: "Invalid auth token. Please sign out and sign in again."}});
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
        res.status(400).json({error: {status: "INVALID_ARGUMENT", message: "A valid owner email is required."}});
        return;
      }

      // ── Create (or reuse) the owner account ──────────────────────────────────
      // Admins legitimately add multiple salons for the same owner. If the account
      // already exists, reuse it instead of failing — we just skip sending a new
      // password email so we never reset an existing owner's password.
      let uid;
      let isExistingOwner = false;
      const password = randomPassword(8);

      try {
        const userRecord = await admin.auth().createUser({
          email,
          password,
          displayName: name || undefined,
          disabled: false,
        });
        uid = userRecord.uid;
      } catch (err) {
        if (err.code === "auth/email-already-exists") {
          // Reuse the existing account.
          const existing = await admin.auth().getUserByEmail(email);
          uid = existing.uid;
          isExistingOwner = true;
        } else if (err.code === "auth/invalid-email") {
          res.status(400).json({error: {status: "INVALID_ARGUMENT", message: "The owner email address is not valid."}});
          return;
        } else {
          logger.error("createUser failed", err);
          res.status(500).json({error: {status: "INTERNAL", message: `Could not create owner account: ${err.message || "unknown error"}`}});
          return;
        }
      }

      // Ensure the Users profile exists / is marked as a salon owner.
      // For a brand-new account we set created_at; for an existing one we only merge
      // the role/contact fields so we don't clobber their existing profile.
      const profileData = {
        email,
        Role: "SALONOWNER",
        isEnabled: true,
      };
      if (name) profileData.name = name;
      if (phone) profileData.phone = phone;
      if (!isExistingOwner) {
        profileData.profile_photo = "";
        profileData.created_at = FieldValue.serverTimestamp();
      }
      await admin.firestore().collection("Users").doc(uid).set(profileData, {merge: true});

      // Set Storage-auth claims now (role); salon ids are added by the
      // onSalonWrittenSyncClaims trigger once the salon doc is created.
      try {
 await refreshUserClaims(uid);
} catch (err) {
 logger.error("createSalonOwner: claim set failed", {uid, err});
}

      // ── Send the welcome email — NON-FATAL ───────────────────────────────────
      // Email delivery must never block salon creation: the account already exists
      // at this point, so a transient SMTP error shouldn't fail the whole request
      // (and force an "already exists" failure on retry). We only email brand-new
      // owners, since we never reset an existing owner's password.
      let emailSent = false;
      if (!isExistingOwner) {
        try {
          const smtpUser = SMTP_USER.value();
          const smtpPass = SMTP_PASS.value();
          if (!smtpUser || !smtpPass) {
            logger.warn("SMTP credentials not configured — skipping welcome email", {uid});
          } else {
            await nodemailer.createTransport({
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
            });
            emailSent = true;
          }
        } catch (mailErr) {
          logger.error("Failed to send welcome email (non-fatal)", {uid, err: mailErr});
        }
      }

      res.status(200).json({result: {uid, email, isExistingOwner, emailSent}});
    } catch (err) {
      logger.error("createSalonOwner unexpected error", err);
      res.status(500).json({error: {status: "INTERNAL", message: `Unexpected server error: ${err.message || "unknown error"}`}});
    }
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

// The five slot checks themselves live in ./bookingSlots as one pure function —
// see the header there for why. What stays here is the I/O around them.

/**
 * The day's bookings and blocks for a salon, normalised to plain millis so the
 * pure checker never sees a Firestore Timestamp.
 *
 * The [fromMs, toMs) window is the caller's, deliberately: the write paths pass
 * the same window they have always used, and the availability grid passes that
 * identical window so what it shows and what a write accepts come from one set
 * of rows.
 */
async function loadDayContext(db, salonId, fromMs, toMs) {
  const from = Timestamp.fromMillis(fromMs);
  const to = Timestamp.fromMillis(toMs);

  const [bookingsSnap, blockedSnap] = await Promise.all([
    db.collection("bookings")
      .where("salon_id", "==", salonId)
      .where("slot_start", ">=", from)
      .where("slot_start", "<", to)
      .get(),
    db.collection("salons").doc(salonId)
      .collection("blocked_slots")
      .where("start", ">=", from)
      .where("start", "<", to)
      .get(),
  ]);

  return {
    bookings: bookingsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        status: d.status,
        startMs: d.slot_start?.toDate?.()?.getTime?.() ?? null,
        endMs: d.slot_end?.toDate?.()?.getTime?.() ?? null,
      };
    }),
    blocked: blockedSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        startMs: d.start?.toDate?.()?.getTime?.() ?? null,
        endMs: d.end?.toDate?.()?.getTime?.() ?? null,
      };
    }),
  };
}

/**
 * The UTC-day window the capacity and blocked-slot queries have always used.
 *
 * NOTE: setHours() is local time, and Cloud Functions run in UTC — so for an
 * IST salon this window is offset 5h30m from the salon's own day. Preserved
 * verbatim from the original inline queries; changing it changes which bookings
 * the live customer path considers, which is its own change.
 */
function utcDayWindow(slotStartMs) {
  const dayStart = new Date(slotStartMs);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return {fromMs: dayStart.getTime(), toMs: dayEnd.getTime()};
}

/** Load the day, then run the five checks. Used by every write path. */
async function validateSlotForSalon(db, {salon, salonId, slotStartMs, slotEndMs, excludeBookingId}) {
  const {fromMs, toMs} = utcDayWindow(slotStartMs);
  const dayContext = await loadDayContext(db, salonId, fromMs, toMs);
  return slots.checkSlot({
    salon,
    dayContext,
    slotStartMs,
    slotEndMs,
    excludeBookingId,
    minLeadMs: await serverMinLeadMs(),
    nowMs: Date.now(),
  });
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
        updated_at: FieldValue.serverTimestamp(),
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

      // 4-7. Lead time, working hours, capacity, blocked slots — shared with the
      // reschedule and support paths so all three agree on what a valid slot is.
      const verdict = await validateSlotForSalon(db, {
        salon,
        salonId,
        slotStartMs: slotStart.getTime(),
        slotEndMs: slotEnd.getTime(),
        excludeBookingId: bookingId,
      });
      if (!verdict.ok) return cancelBooking(verdict.message);

      // All checks passed — booking stays "pending"
      logger.info("Booking validation passed", {bookingId, salonId});
    } catch (err) {
      logger.error("Unexpected error during booking validation", {bookingId, err});
      await cancelBooking("INTERNAL_ERROR: " + (err.message || "Unknown error"));
    }
  },
);

// ── Reschedule booking ────────────────────────────────────────────────────────
// Validates the new slot (the same five checks as onCreate) then updates the
// booking in place. A "confirmed" booking reverts to "pending" and the salon
// owner is notified; a "pending" one stays pending and nobody is notified.

/**
 * Bounds on where a booking may be moved to, in both directions.
 *
 * Every timestamp maps to some weekday and hour, so without an upper bound a
 * typo'd millisecond value books a slot in the year 12025 and passes every
 * check. The lower bound only bites an ADMIN override — SLOT_TOO_SOON stops
 * everyone else — but an override moving a booking years into the past writes
 * nonsense. A day of slack keeps the legitimate case: correcting the time of a
 * visit that has just happened.
 */
const MAX_RESCHEDULE_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const MAX_RESCHEDULE_BEHIND_MS = 24 * 60 * 60 * 1000;

function assertSaneSlotStart(ms) {
  const now = Date.now();
  if (!Number.isFinite(ms) ||
      ms > now + MAX_RESCHEDULE_AHEAD_MS ||
      ms < now - MAX_RESCHEDULE_BEHIND_MS) {
    throw new HttpsError("invalid-argument", "That date is out of range.");
  }
}

/**
 * Move a booking to a new start, preserving its total duration.
 *
 * Shared by the customer's rescheduleBooking and the panel's
 * supportRescheduleBooking so the per-service re-laying and the salon
 * notification have exactly one implementation. Assumes the slot has already
 * been validated (or deliberately overridden) by the caller.
 *
 * @returns {{wasConfirmed: boolean, newSlotStartMs: number, newSlotEndMs: number}}
 */
async function applyReschedule(db, bookingRef, booking, newSlotStartMs, extraFields = null) {
  const oldStartMs = booking.slot_start?.toDate?.()?.getTime?.() ?? 0;
  const oldEndMs = booking.slot_end?.toDate?.()?.getTime?.() ?? 0;
  const totalDurationMs = oldEndMs - oldStartMs;
  const newSlotEndMs = newSlotStartMs + totalDurationMs;

  const wasConfirmed = booking.status === "confirmed";
  const isNewFormat = Array.isArray(booking.services) && booking.services.length > 0;

  // Recompute per-service windows, preserving each service's original duration.
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
        slot_start: Timestamp.fromMillis(svcStartMs),
        slot_end: Timestamp.fromMillis(svcEndMs),
      };
    });
  }

  const updateData = {
    slot_start: Timestamp.fromMillis(newSlotStartMs),
    slot_end: Timestamp.fromMillis(newSlotEndMs),
    updated_at: FieldValue.serverTimestamp(),
  };
  if (updatedServices) updateData.services = updatedServices;
  if (wasConfirmed) updateData.status = "pending";
  // The panel folds its audit entry in here rather than writing a second time:
  // one document version, one trigger firing, one thing to reason about.
  if (extraFields) Object.assign(updateData, extraFields);

  await bookingRef.update(updateData);

  // ── Notify the salon owner if the booking had already been confirmed ───────
  // A pending booking that moves needs no push: nobody has committed to it yet.
  if (wasConfirmed) {
    try {
      const salonId = booking.salon_id;
      const ownerSnap = await db.collection("salons").doc(salonId).get();
      const ownerUid = ownerSnap.exists ? ownerSnap.data()?.owner_uid : null;
      if (ownerUid) {
        const ownerProfile = await getUserProfile(ownerUid);
        const ownerToken = ownerProfile?.fcm_token;
        if (ownerToken) {
          const slotText = new Date(newSlotStartMs).toISOString().replace("T", " ").slice(0, 16);
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
              booking_id: String(bookingRef.id),
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
          logger.info("Sent reschedule notification to salon", {bookingId: bookingRef.id, ownerUid});
        }
      }
    } catch (notifErr) {
      // Non-fatal — the reschedule already succeeded.
      logger.error("Failed to send reschedule notification", {bookingId: bookingRef.id, err: notifErr});
    }
  }

  return {wasConfirmed, newSlotStartMs, newSlotEndMs};
}

/**
 * Load a booking and its salon, refusing anything that cannot be rescheduled.
 * Shared by the customer and support reschedule paths; the caller supplies the
 * ownership rule, which is the only thing that differs between them.
 */
async function loadReschedulable(db, bookingId) {
  const bookingRef = db.collection("bookings").doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bookingSnap.data();

  if (booking.status !== "pending" && booking.status !== "confirmed") {
    throw new HttpsError(
      "failed-precondition",
      "Only pending or confirmed bookings can be rescheduled.",
    );
  }

  // A reschedule preserves the visit's length, so a booking without a usable one
  // has nothing to preserve. Left unchecked the duration comes out as 0 and the
  // move writes slot_end === slot_start — a zero-length booking. The customer
  // path only ever failed here with a confusing "outside working hours"; the
  // panel's override would have written the corrupt document.
  const startMs = booking.slot_start?.toDate?.()?.getTime?.();
  const endMs = booking.slot_end?.toDate?.()?.getTime?.();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new HttpsError(
      "failed-precondition",
      "This booking has no valid time range, so it cannot be moved.",
    );
  }

  // doc(undefined) throws inside the SDK and surfaces as an opaque INTERNAL.
  if (!booking.salon_id) {
    throw new HttpsError("failed-precondition", "This booking has no salon.");
  }
  const salonSnap = await db.collection("salons").doc(booking.salon_id).get();
  if (!salonSnap.exists || salonSnap.data().is_active === false) {
    throw new HttpsError("failed-precondition", "SALON_NOT_FOUND: Salon not found or inactive.");
  }

  return {bookingRef, booking, salon: salonSnap.data()};
}

exports.rescheduleBooking = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const {bookingId, newSlotStartMs: rawMs} = request.data || {};
  const newSlotStartMs = Number(rawMs);
  if (!bookingId || !newSlotStartMs || isNaN(newSlotStartMs)) {
    throw new HttpsError("invalid-argument", "bookingId and newSlotStartMs are required.");
  }
  assertSaneSlotStart(newSlotStartMs);

  const db = admin.firestore();
  const userId = auth.uid;

  const {bookingRef, booking, salon} = await loadReschedulable(db, bookingId);

  // Ownership — a customer may only move their own booking.
  if (booking.user_id !== userId) {
    throw new HttpsError("permission-denied", "Not your booking.");
  }

  const oldStartMs = booking.slot_start?.toDate?.()?.getTime?.() ?? 0;
  const oldEndMs = booking.slot_end?.toDate?.()?.getTime?.() ?? 0;
  const verdict = await validateSlotForSalon(db, {
    salon,
    salonId: booking.salon_id,
    slotStartMs: newSlotStartMs,
    slotEndMs: newSlotStartMs + (oldEndMs - oldStartMs),
    excludeBookingId: bookingId,
  });
  if (!verdict.ok) throw new HttpsError("failed-precondition", verdict.message);

  const {wasConfirmed} = await applyReschedule(db, bookingRef, booking, newSlotStartMs);
  logger.info("Booking rescheduled", {bookingId, userId, wasConfirmed});

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
            .update({fcm_token: FieldValue.delete()})
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

// ── Review aggregation: salon ─────────────────────────────────────────────────
// On every new salon_review: recalculate avg_rating + review_count on the salon
// using an incremental transaction, then notify the reviewer.
exports.onSalonReviewCreated = onDocumentCreated(
  "salon_reviews/{reviewId}",
  async (event) => {
    const review = event.data?.data?.() || {};
    const {salon_id: salonId, user_id: userId, rating} = review;

    if (!salonId || typeof rating !== "number") {
      logger.warn("onSalonReviewCreated: missing salon_id or rating", {reviewId: event.params.reviewId});
      return;
    }

    const db = admin.firestore();
    const salonRef = db.collection("salons").doc(salonId);

    // Incremental avg inside a transaction — safe against concurrent reviews.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(salonRef);
      if (!snap.exists) return;
      const data = snap.data();
      const oldCount = data.review_count || 0;
      const oldAvg = data.avg_rating || 0;
      const newCount = oldCount + 1;
      const newAvg = (oldAvg * oldCount + rating) / newCount;
      tx.update(salonRef, {
        avg_rating: Math.round(newAvg * 10) / 10,
        review_count: newCount,
      });
    });

    logger.info("Updated salon rating", {salonId, rating});

    // Notify reviewer
    if (!userId) return;
    try {
      const userProfile = await getUserProfile(userId);
      const token = userProfile?.fcm_token;
      if (!token) return;

      await admin.messaging().send({
        token,
        notification: {
          title: "Review Submitted!",
          body: "Thank you for your feedback. Your review helps others discover great salons.",
        },
        data: {
          type: "review_submitted",
          salon_id: String(salonId),
        },
        android: {
          priority: "high",
          notification: {channelId: "cutq_bookings", sound: "default"},
        },
        apns: {payload: {aps: {sound: "default"}}},
      });
      logger.info("Sent review confirmation to user", {userId, salonId});
    } catch (err) {
      logger.error("Failed to send review confirmation", {userId, salonId, err});
    }
  },
);

// ── Review aggregation: service ───────────────────────────────────────────────
// On every new service_review: recalculate avg_rating + review_count on the
// service sub-document (salons/{salonId}/services/{serviceId}).
exports.onServiceReviewCreated = onDocumentCreated(
  "service_reviews/{reviewId}",
  async (event) => {
    const review = event.data?.data?.() || {};
    const {salon_id: salonId, service_id: serviceId, rating} = review;

    if (!salonId || !serviceId || typeof rating !== "number") {
      logger.warn("onServiceReviewCreated: missing required fields", {reviewId: event.params.reviewId});
      return;
    }

    const db = admin.firestore();
    const serviceRef = db.collection("salons").doc(salonId).collection("services").doc(serviceId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(serviceRef);
      if (!snap.exists) return;
      const data = snap.data();
      const oldCount = data.review_count || 0;
      const oldAvg = data.avg_rating || 0;
      const newCount = oldCount + 1;
      const newAvg = (oldAvg * oldCount + rating) / newCount;
      tx.update(serviceRef, {
        avg_rating: Math.round(newAvg * 10) / 10,
        review_count: newCount,
      });
    });

    logger.info("Updated service rating", {salonId, serviceId, rating});
  },
);

// ── Stock image search & attach (admin panel + salon dashboard) ─────────────────
//
// Two callables so staff can search for a royalty-free image by keyword and
// attach it instead of uploading a file:
//   - searchStockPhotos: proxies Pexels (keeps the API key server-side).
//   - attachRemoteImage: downloads the chosen image server-side (no CORS),
//       rasterizes Iconify SVGs to PNG (the mobile app can't render SVG), and
//       uploads it to a Storage path the caller is authorized to write.
// Iconify icon search is done directly from the browser (keyless, CORS-enabled).
//
// Used by: admin Categories tab (category/subcategory icon + banner) and the
// salon dashboard Services screen (service photos).

const IMAGE_CACHE_CONTROL = "public, max-age=31536000";
// Admin-only paths (category / subcategory icon + banner).
const ADMIN_IMAGE_PATH = /^service_(categories|subcategories)\/[A-Za-z0-9_-]+\/(icon|banner)\.jpg$/;
// Salon-owner path (service photo): salons/{salonId}/services/{serviceId}/{photoId}.jpg
const SALON_SERVICE_PHOTO_PATH =
  /^salons\/([A-Za-z0-9_-]+)\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.jpg$/;
const ICON_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// A signed-in, enabled staff member (ADMIN or SALONOWNER). Used to gate search.
async function requireStaff(auth) {
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const profile = await getUserProfile(auth.uid);
  const role = String(profile?.Role || profile?.role || "").toUpperCase();
  if ((role !== "ADMIN" && role !== "SALONOWNER") || profile?.isEnabled !== true) {
    throw new HttpsError("permission-denied", "Staff access required.");
  }
  return {profile, role};
}

// Authorize a write to `storagePath`: admins may write category/subcategory
// images; a salon owner may write photos only under a salon they own.
async function authorizeImagePath(auth, storagePath) {
  const {role} = await requireStaff(auth);
  const path = String(storagePath || "");

  if (ADMIN_IMAGE_PATH.test(path)) {
    if (role !== "ADMIN") throw new HttpsError("permission-denied", "Admin access required.");
    return;
  }
  const salonMatch = SALON_SERVICE_PHOTO_PATH.exec(path);
  if (salonMatch) {
    if (role === "ADMIN") return;
    const salonId = salonMatch[1];
    const salonSnap = await admin.firestore().collection("salons").doc(salonId).get();
    if (!salonSnap.exists || salonSnap.data()?.owner_uid !== auth.uid) {
      throw new HttpsError("permission-denied", "You can only add photos to your own salon.");
    }
    return;
  }
  throw new HttpsError("invalid-argument", "Invalid storage path.");
}

exports.searchStockPhotos = onCall({secrets: [PEXELS_API_KEY]}, async (request) => {
  await requireStaff(request.auth);

  const {query, page = 1, perPage = 24} = request.data || {};
  if (!query || !String(query).trim()) {
    throw new HttpsError("invalid-argument", "A search query is required.");
  }
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", String(query).trim());
  url.searchParams.set("per_page", String(Math.min(Math.max(Number(perPage) || 24, 1), 80)));
  url.searchParams.set("page", String(Math.max(Number(page) || 1, 1)));
  url.searchParams.set("orientation", "landscape");

  const res = await fetch(url, {headers: {Authorization: PEXELS_API_KEY.value()}});
  if (!res.ok) {
    logger.error("Pexels search failed", {status: res.status});
    throw new HttpsError("internal", `Image search failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const photos = (data.photos || []).map((p) => ({
    id: p.id,
    thumb: p.src?.tiny || p.src?.small,
    preview: p.src?.medium || p.src?.large,
    // src to actually store (validated by host on attach)
    full: p.src?.large2x || p.src?.large || p.src?.original,
    photographer: p.photographer,
    alt: p.alt || "",
  }));
  return {photos, page: Number(page) || 1, totalResults: data.total_results || 0};
});

exports.attachRemoteImage = onCall(async (request) => {
  const {source, storagePath, iconId, color, photoUrl} = request.data || {};
  // Authorizes the caller for this exact path (admin paths vs salon-owned paths)
  // and rejects any path outside the allowlist.
  await authorizeImagePath(request.auth, storagePath);

  let buffer;
  let contentType;

  if (source === "iconify") {
    if (!ICON_ID_RE.test(String(iconId || ""))) {
      throw new HttpsError("invalid-argument", "Invalid icon id.");
    }
    const hex = HEX_COLOR_RE.test(String(color || "")) ? String(color) : "#111827";
    const [prefix, name] = String(iconId).split(":");
    const iconUrl = new URL(`https://api.iconify.design/${prefix}/${name}.svg`);
    iconUrl.searchParams.set("width", "256");
    iconUrl.searchParams.set("height", "256");
    iconUrl.searchParams.set("color", hex);

    const res = await fetch(iconUrl);
    if (!res.ok) throw new HttpsError("internal", `Icon fetch failed (HTTP ${res.status}).`);
    const svg = Buffer.from(await res.arrayBuffer());
    // Rasterize to a transparent 256x256 PNG — the app renders raster, not SVG.
    buffer = await sharp(svg)
      .resize(256, 256, {fit: "contain", background: {r: 0, g: 0, b: 0, alpha: 0}})
      .png()
      .toBuffer();
    contentType = "image/png";
  } else if (source === "pexels") {
    let host;
    try {
      host = new URL(String(photoUrl)).host;
    } catch {
      throw new HttpsError("invalid-argument", "Invalid photo URL.");
    }
    if (host !== "images.pexels.com") {
      throw new HttpsError("invalid-argument", "Photo URL must be a Pexels image.");
    }
    const res = await fetch(photoUrl);
    if (!res.ok) throw new HttpsError("internal", `Photo fetch failed (HTTP ${res.status}).`);
    const original = Buffer.from(await res.arrayBuffer());
    // Category/subcategory icons render as large circular tiles in the app, so
    // square cover-crop them (smart-cropped to the salient region). Banners and
    // service photos stay wide.
    const isIconSlot = /\/icon\.jpg$/.test(String(storagePath));
    let img = sharp(original);
    if (isIconSlot) {
      img = img.resize(800, 800, {fit: "cover", position: sharp.strategy.attention});
    } else {
      img = img.resize(1600, 1600, {fit: "inside", withoutEnlargement: true});
    }
    buffer = await img.jpeg({quality: 82}).toBuffer();
    contentType = "image/jpeg";
  } else {
    throw new HttpsError("invalid-argument", "Unknown image source.");
  }

  const bucket = admin.storage().bucket();
  const token = crypto.randomUUID();
  await bucket.file(storagePath).save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      cacheControl: IMAGE_CACHE_CONTROL,
      metadata: {firebaseStorageDownloadTokens: token},
    },
  });
  const url =
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
  return {url};
});

// ── Customer Support Representative (admin panel) ───────────────────────────────
//
// A SUPPORT user signs into the admin panel and sees only the Bookings section.
// They call the salon + customer to confirm each booking, then mark the two
// support_called_* flags. These callables keep the logic rules-independent and
// server-side (a SUPPORT user has no direct Firestore read/write grants):
//   - supportListBookings: all bookings, joined with salon + customer name/phone.
//   - markSupportCall: set support_called_salon / support_called_customer.
//   - createSupportRep: admin creates a SUPPORT account.

// Require the caller to hold one of `roles` (and be enabled).
async function requireRole(auth, roles) {
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const profile = await getUserProfile(auth.uid);
  const role = String(profile?.Role || profile?.role || "").toUpperCase();
  if (!roles.includes(role) || profile?.isEnabled !== true) {
    throw new HttpsError("permission-denied", "Not authorized.");
  }
  return {profile, role, uid: auth.uid};
}

const toMs = (t) => t?.toDate?.()?.getTime?.() ?? (typeof t === "number" ? t : null);

exports.supportListBookings = onCall(async (request) => {
  await requireRole(request.auth, ["ADMIN", "SUPPORT"]);
  const db = admin.firestore();

  const limitN = Math.min(Math.max(Number(request.data?.limit) || 500, 1), 1000);
  const snap = await db.collection("bookings")
    .orderBy("created_at", "desc").limit(limitN).get();
  const bookings = snap.docs.map((d) => ({id: d.id, ...d.data()}));

  // Batch-join salon + customer docs.
  const salonIds = [...new Set(bookings.map((b) => b.salon_id).filter(Boolean))];
  const userIds = [...new Set(bookings.map((b) => b.user_id).filter(Boolean))];
  const [salonDocs, userDocs] = await Promise.all([
    salonIds.length ? db.getAll(...salonIds.map((id) => db.collection("salons").doc(id))) : [],
    userIds.length ? db.getAll(...userIds.map((id) => db.collection("Users").doc(id))) : [],
  ]);
  const salonMap = {};
  salonDocs.forEach((d) => {
    if (d.exists) salonMap[d.id] = d.data();
  });
  const userMap = {};
  userDocs.forEach((d) => {
    if (d.exists) userMap[d.id] = d.data();
  });

  const result = bookings.map((b) =>
    projectBooking(b.id, b, salonMap[b.salon_id] || {}, userMap[b.user_id] || {}));
  return {bookings: result};
});

/**
 * The panel's view of a booking: the document joined with its salon and customer.
 *
 * The action callables return this same shape for the single booking they
 * touched, so the client merges the result straight into its list instead of
 * reloading all 500.
 */
function projectBooking(id, b, salon = {}, user = {}) {
  const services = Array.isArray(b.services) && b.services.length ?
    b.services.map((s) => ({
      name: s.service_name || "",
      price: s.service_price || 0,
      duration_minutes: s.duration_minutes || 0,
    })) :
    (b.service_id ? [{name: b.service_name || "Service", price: b.service_price || 0}] : []);
  return {
    id,
    status: b.status || "pending",
    created_at_ms: toMs(b.created_at),
    slot_start_ms: toMs(b.slot_start),
    slot_end_ms: toMs(b.slot_end),
    salon_id: b.salon_id || "",
    salon_name: b.salon_name || salon.name || "",
    salon_phone: salon.phone || "",
    salon_city: salon.city || "",
    salon_timezone: salon.timezone || "Asia/Kolkata",
    user_id: b.user_id || "",
    // Walk-ins have no user_id; their name/phone live on the booking itself.
    customer_name: user.name || b.customer_name || "",
    customer_phone: user.phone || b.customer_phone || "",
    is_walk_in: b.is_walk_in === true,
    // "Book for someone else" — booking placed by the account holder for a
    // third party. The beneficiary is who gets served; customer_name above
    // remains the account holder (the person who actually booked).
    booked_for_other: b.booked_for_other === true,
    beneficiary_name: b.beneficiary_name || "",
    beneficiary_phone: b.beneficiary_phone || "",
    beneficiary_gender: b.beneficiary_gender || "",
    stylist_id: b.stylist_id || null,
    services,
    total_service_price: b.total_service_price ?? b.service_price ?? 0,
    booking_fee: b.booking_fee ?? 0,
    discount_amount: b.discount_amount ?? 0,
    final_amount: b.final_amount ?? 0,
    notes: b.notes || "",
    coupon_code: b.coupon_code || null,
    cancelled_by: b.cancelled_by || null,
    cancellation_reason: b.cancellation_reason || null,
    support_called_salon: b.support_called_salon === true,
    support_called_customer: b.support_called_customer === true,
    support_actions: (Array.isArray(b.support_actions) ? b.support_actions : [])
      .map(({at, ...rest}) => ({...rest, at_ms: toMs(at)})),
  };
}

/** Re-read a booking and project it with its salon + customer joined in. */
async function reprojectBooking(db, bookingId) {
  const snap = await db.collection("bookings").doc(bookingId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
  const b = snap.data();
  const [salonSnap, userSnap] = await Promise.all([
    b.salon_id ? db.collection("salons").doc(b.salon_id).get() : null,
    b.user_id ? db.collection("Users").doc(b.user_id).get() : null,
  ]);
  return projectBooking(
    bookingId,
    b,
    salonSnap && salonSnap.exists ? salonSnap.data() : {},
    userSnap && userSnap.exists ? userSnap.data() : {},
  );
}

exports.markSupportCall = onCall(async (request) => {
  await requireRole(request.auth, ["ADMIN", "SUPPORT"]);
  const {bookingId, target, done} = request.data || {};
  if (!bookingId || (target !== "salon" && target !== "customer")) {
    throw new HttpsError("invalid-argument", "bookingId and target (salon|customer) are required.");
  }
  const field = target === "salon" ? "support_called_salon" : "support_called_customer";
  const db = admin.firestore();
  const ref = db.collection("bookings").doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");

  await ref.update({
    [field]: done === true,
    updated_at: FieldValue.serverTimestamp(),
  });
  const after = (await ref.get()).data() || {};
  return {
    support_called_salon: after.support_called_salon === true,
    support_called_customer: after.support_called_customer === true,
  };
});

// ── Panel booking actions (ADMIN + SUPPORT) ───────────────────────────────────
//
// A rep on the phone can now fire every trigger a salon or a customer can, on
// that party's behalf. The panel has no direct write access to bookings
// (firestore.rules admits only the booking's own user or the salon's staff), so
// these callables are the whole surface — they run on the Admin SDK.
//
// The party matters, not the operator. onBookingStatusChanged branches on
// cancelled_by being exactly "salon" or "user" and returns silently for anything
// else, so writing "admin" there would cancel bookings that notify nobody. The
// rep picks whose behalf they are acting on, we write that value, and the
// existing notification fan-out is correct for free. Who *actually* did it is
// recorded in support_actions.

/** ADMIN may push past a refusal; SUPPORT may not. */
function assertMayOverride(role) {
  if (role !== "ADMIN") {
    throw new HttpsError(
      "permission-denied",
      "Only an admin can override booking validation.",
    );
  }
}

/**
 * One audit entry per action, appended to the booking.
 *
 * Timestamp.now() rather than FieldValue.serverTimestamp(): Firestore rejects
 * sentinel values inside array elements.
 */
function supportAuditEntry({action, actedAs, actor, reason, override, overrideCode}) {
  return {
    action,
    acted_as: actedAs || null,
    actor_uid: actor.uid,
    actor_role: actor.role,
    actor_name: actor.profile?.name || actor.profile?.email || "",
    reason: reason || null,
    override: override === true,
    override_code: overrideCode || null,
    at: Timestamp.now(),
  };
}

const STATUS_ACTIONS = {
  confirm: {
    from: ["pending"],
    actedAs: "salon",
    apply: () => ({status: "confirmed"}),
  },
  cancel_by_salon: {
    from: ["pending", "confirmed"],
    actedAs: "salon",
    apply: (reason) => ({
      status: "cancelled",
      cancelled_by: "salon",
      cancellation_reason: reason || "Cancelled by salon",
    }),
  },
  cancel_by_user: {
    from: ["pending", "confirmed"],
    actedAs: "user",
    apply: (reason) => ({
      status: "cancelled",
      cancelled_by: "user",
      cancellation_reason: reason || "Cancelled by customer",
    }),
  },
};

exports.supportUpdateBookingStatus = onCall(async (request) => {
  const actor = await requireRole(request.auth, ["ADMIN", "SUPPORT"]);

  const {bookingId, action, reason, override} = request.data || {};
  if (!bookingId) throw new HttpsError("invalid-argument", "bookingId is required.");
  const spec = Object.prototype.hasOwnProperty.call(STATUS_ACTIONS, action) ?
    STATUS_ACTIONS[action] : null;
  if (!spec) {
    throw new HttpsError(
      "invalid-argument",
      `action must be one of: ${Object.keys(STATUS_ACTIONS).join(", ")}.`,
    );
  }
  const cleanReason = String(reason || "").trim().slice(0, 500);

  const db = admin.firestore();
  const ref = db.collection("bookings").doc(bookingId);

  // In a transaction because the status decides the write: two reps on the phone
  // to the two sides of the same booking, or a rep and the salon's own
  // dashboard, otherwise both read "pending" and both write. Losing that race
  // means a customer gets a cancellation push for a booking left confirmed.
  // The transaction re-reads and re-evaluates if the document moved underneath,
  // which holds even though the dashboard writes without one.
  let overrideCode = null;
  let fromStatus = null;
  await db.runTransaction(async (tx) => {
    // Reset: a contended transaction runs this body more than once.
    overrideCode = null;

    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
    const booking = snap.data();
    const status = booking.status || "pending";
    fromStatus = status;

    // A completed booking has already posted a sale to the salon's ledger;
    // cancelling it here would leave the books showing a sale for a booking that
    // no longer happened. Reversing that is the salon's Accounts screen, not this.
    if (status === "completed") {
      throw new HttpsError(
        "failed-precondition",
        "This booking is completed and already posted to the salon's accounts. Reverse it from the salon dashboard instead.",
      );
    }

    if (!spec.from.includes(status)) {
      if (override !== true) {
        throw new HttpsError(
          "failed-precondition",
          `Cannot ${action.replace(/_/g, " ")} a ${status} booking.`,
        );
      }
      assertMayOverride(actor.role);
      overrideCode = `STATUS_${String(status).toUpperCase()}`;
    }

    tx.update(ref, {
      ...spec.apply(cleanReason),
      support_actions: FieldValue.arrayUnion(supportAuditEntry({
        action,
        actedAs: spec.actedAs,
        actor,
        reason: cleanReason,
        override: overrideCode !== null,
        overrideCode,
      })),
      updated_at: FieldValue.serverTimestamp(),
    });
  });

  logger.info("Panel booking action", {
    bookingId, action, actorUid: actor.uid, actorRole: actor.role, from: fromStatus, override: overrideCode,
  });

  return {booking: await reprojectBooking(db, bookingId)};
});

exports.supportRescheduleBooking = onCall(async (request) => {
  const actor = await requireRole(request.auth, ["ADMIN", "SUPPORT"]);

  const {bookingId, newSlotStartMs: rawMs, override} = request.data || {};
  const newSlotStartMs = Number(rawMs);
  if (!bookingId || !newSlotStartMs || isNaN(newSlotStartMs)) {
    throw new HttpsError("invalid-argument", "bookingId and newSlotStartMs are required.");
  }
  assertSaneSlotStart(newSlotStartMs);

  const db = admin.firestore();
  const {bookingRef, booking, salon} = await loadReschedulable(db, bookingId);

  const oldStartMs = booking.slot_start?.toDate?.()?.getTime?.() ?? 0;
  const oldEndMs = booking.slot_end?.toDate?.()?.getTime?.() ?? 0;
  const verdict = await validateSlotForSalon(db, {
    salon,
    salonId: booking.salon_id,
    slotStartMs: newSlotStartMs,
    slotEndMs: newSlotStartMs + (oldEndMs - oldStartMs),
    excludeBookingId: bookingId,
  });

  let overrideCode = null;
  if (!verdict.ok) {
    // The rep may have phoned the salon and agreed to squeeze this in — an admin
    // can say so, and what was overridden is recorded.
    if (override !== true) throw new HttpsError("failed-precondition", verdict.message);
    assertMayOverride(actor.role);
    overrideCode = verdict.code;
  }

  const {wasConfirmed} = await applyReschedule(db, bookingRef, booking, newSlotStartMs, {
    support_actions: FieldValue.arrayUnion(supportAuditEntry({
      action: "reschedule",
      actedAs: "user",
      actor,
      reason: null,
      override: overrideCode !== null,
      overrideCode,
    })),
  });

  logger.info("Panel booking rescheduled", {
    bookingId, actorUid: actor.uid, actorRole: actor.role, wasConfirmed, override: overrideCode,
  });

  return {wasConfirmed, booking: await reprojectBooking(db, bookingId)};
});

/**
 * Bookable start times for one salon on one day, for the reschedule picker.
 *
 * Every candidate is run through the same checkSlot that the write path uses,
 * against the same day window and the same rows — so a slot the grid shows as
 * free cannot then be refused, and one shown as taken says why.
 */
exports.supportGetSalonDayAvailability = onCall(async (request) => {
  await requireRole(request.auth, ["ADMIN", "SUPPORT"]);

  const {salonId, dayStartMs: rawDay, durationMinutes, excludeBookingId} = request.data || {};
  const dayStartMs = Number(rawDay);
  if (!salonId || !dayStartMs || isNaN(dayStartMs)) {
    throw new HttpsError("invalid-argument", "salonId and dayStartMs are required.");
  }
  const durationMin = Math.min(Math.max(Number(durationMinutes) || 30, 5), 8 * 60);

  const db = admin.firestore();
  const salonSnap = await db.collection("salons").doc(salonId).get();
  if (!salonSnap.exists) throw new HttpsError("not-found", "Salon not found.");
  const salon = salonSnap.data();

  // Candidates cover the 24 hours the rep actually picked. utcDayWindow (which
  // the write paths use) buckets by the *server's* midnight, so reusing it here
  // would hand back a window shifted by the salon's UTC offset — the rep taps
  // Thursday and is offered Wednesday teatime onwards.
  const fromMs = dayStartMs;
  const toMs = dayStartMs + 24 * 60 * 60 * 1000;

  // Rows are fetched over a padded window so a booking that starts the previous
  // evening and runs into this day still counts. That makes this a superset of
  // what the write path sees, never a subset: a slot the grid shows as free is
  // one the write path will also accept.
  const dayContext = await loadDayContext(db, salonId, fromMs - 12 * 60 * 60 * 1000, toMs + 12 * 60 * 60 * 1000);

  const availability = slots.buildDayAvailability({
    salon,
    dayContext,
    fromMs,
    toMs,
    durationMs: durationMin * 60 * 1000,
    stepMinutes: 15,
    excludeBookingId: excludeBookingId || null,
    minLeadMs: await serverMinLeadMs(),
    nowMs: Date.now(),
  });

  return {
    salon_id: salonId,
    timezone: slots.salonTimezone(salon),
    duration_minutes: durationMin,
    slots: availability,
  };
});
exports.createSupportRep = onCall(async (request) => {
  await requireRole(request.auth, ["ADMIN"]);
  const {email, name, phone} = request.data || {};
  if (!email || !String(email).trim()) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }
  const cleanEmail = String(email).trim();
  const db = admin.firestore();

  let uid;
  let password = randomPassword(10);
  let isExisting = false;
  try {
    const u = await admin.auth().createUser({
      email: cleanEmail,
      password,
      emailVerified: true,
      displayName: String(name || "").trim(),
    });
    uid = u.uid;
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      const u = await admin.auth().getUserByEmail(cleanEmail);
      uid = u.uid;
      isExisting = true;
      password = null;
    } else if (err.code === "auth/invalid-email") {
      throw new HttpsError("invalid-argument", "The email address is not valid.");
    } else {
      logger.error("createSupportRep createUser failed", err);
      throw new HttpsError("internal", `Could not create account: ${err.message || "unknown"}`);
    }
  }

  await db.collection("Users").doc(uid).set({
    name: String(name || "").trim(),
    phone: String(phone || "").trim(),
    email: cleanEmail,
    profile_photo: "",
    gender: "",
    dob: "",
    Role: "SUPPORT",
    isEnabled: true,
    created_at: FieldValue.serverTimestamp(),
  }, {merge: true});

  try {
 await refreshUserClaims(uid);
} catch (err) {
 logger.error("createSupportRep: claim set failed", {uid, err});
}

  return {uid, email: cleanEmail, password, isExisting};
});

// ── Accounting (Humble Ledger) callables ────────────────────────────────────────
//
// All ledger traffic is proxied here (the API's CORS blocks the dashboard origin).
// Each call is authorized as the salon owner (or an ADMIN). See ledger.js.

// A disabled account keeps a valid ID token until it expires, so every gate below
// re-checks the flag server-side. The dashboard applies the same test at sign-in
// (src/lib/access.js); without it here, disabling someone only takes effect when
// their token happens to lapse.
function assertEnabled(prof) {
  if (!prof?.isEnabled) {
    throw new HttpsError("permission-denied", "This account is disabled.");
  }
}

// Verify the caller owns `salonId` (or is an ADMIN). Returns the salon data.
// Owner-only — team management must never be delegable, so this stays strict.
async function assertSalonOwner(auth, salonId) {
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  if (!salonId) throw new HttpsError("invalid-argument", "salonId is required.");
  const snap = await admin.firestore().collection("salons").doc(salonId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Salon not found.");
  const salon = snap.data();
  const prof = await getUserProfile(auth.uid);
  assertEnabled(prof);
  if (salon.owner_uid !== auth.uid) {
    if (String(prof?.Role || "").toUpperCase() !== "ADMIN") {
      throw new HttpsError("permission-denied", "Not authorized for this salon.");
    }
  }
  return salon;
}

// Owner, ADMIN, or an active team member holding `moduleId` for this salon.
// The dashboard already gates its nav on the same grant (Layout.jsx NAV_ITEMS),
// so without this every ledger call from a team member was refused even when the
// owner had granted them the module.
async function assertSalonAccess(auth, salonId, moduleId) {
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  if (!salonId) throw new HttpsError("invalid-argument", "salonId is required.");
  const snap = await admin.firestore().collection("salons").doc(salonId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Salon not found.");
  const salon = snap.data();
  const prof = await getUserProfile(auth.uid);
  assertEnabled(prof);
  if (salon.owner_uid === auth.uid) return salon;
  if (String(prof?.Role || "").toUpperCase() === "ADMIN") return salon;

  const access = prof?.salon_access?.[salonId];
  const granted = Array.isArray(access?.modules) && access.modules.includes(moduleId);
  if (access && access.is_active !== false && granted) return salon;

  throw new HttpsError("permission-denied", "Not authorized for this salon.");
}

exports.ledgerProvisionSalon = onCall(async (request) => {
  const {salonId} = request.data || {};
  await assertSalonAccess(request.auth, salonId, "accounts");
  const rec = await ledger.provisionSalon(salonId);
  return {provisioned: true, companyId: rec.companyId || null, accounts: rec.accounts};
});

exports.ledgerRecordSale = onCall(async (request) => {
  const {bookingId} = request.data || {};
  if (!bookingId) throw new HttpsError("invalid-argument", "bookingId is required.");
  const bref = admin.firestore().collection("bookings").doc(bookingId);
  const bsnap = await bref.get();
  if (!bsnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bsnap.data();
  // Completion (and its retry) lives on the Bookings page.
  await assertSalonAccess(request.auth, booking.salon_id, "bookings");
  if (booking.status !== "completed") {
    throw new HttpsError("failed-precondition", "Booking is not completed.");
  }
  if (booking.ledger?.posted) return {alreadyPosted: true, ledger: booking.ledger};
  // Re-posting a reversed booking would replay the SAME (appId, sourceId) and get
  // the original — now reversed — transactions back, leaving the booking marked
  // posted while the books still show the reversal.
  if (booking.ledger?.reversed) {
    throw new HttpsError("failed-precondition",
      "This booking's accounting entry was reversed and cannot be re-posted.");
  }

  // Claim a short-lived posting lock to avoid double-posting on rapid retries.
  const claim = await admin.firestore().runTransaction(async (tx) => {
    const s = await tx.get(bref);
    if (!s.exists) return "missing";
    const l = s.data().ledger || {};
    if (l.posted) return "posted";
    const lockedAt = l.posting_at?.toMillis?.() || 0;
    if (l.posting && Date.now() - lockedAt < 60000) return "busy";
    tx.set(bref, {ledger: {...l, posting: true, posting_at: FieldValue.serverTimestamp()}}, {merge: true});
    return "claimed";
  });
  if (claim === "missing") throw new HttpsError("not-found", "Booking was deleted.");
  if (claim === "posted") return {alreadyPosted: true};
  if (claim !== "claimed") throw new HttpsError("aborted", "Posting already in progress.");

  try {
    const refs = await ledger.recordSaleForBooking(bookingId, {actorUid: request.auth?.uid});
    const update = {
      ledger: {...refs, posted: true, posting: false, error: null,
        posted_at: FieldValue.serverTimestamp()},
    };
    // Customer-facing bill (stored so the salon and, later, the app can open it).
    update.bill = {
      url: refs.billUrl || null,
      invoiceNo: refs.invoiceNumber || null,
      error: refs.billError || null,
      generated_at: FieldValue.serverTimestamp(),
    };
    await bref.set(update, {merge: true});
    return {posted: true, ledger: refs, bill: update.bill};
  } catch (err) {
    await bref.set({ledger: {posted: false, posting: false, error: String(err.message || err)}}, {merge: true});
    logger.error("ledgerRecordSale failed", {bookingId, msg: err.message});
    throw new HttpsError("internal", `Accounting post failed: ${err.message}`);
  }
});

exports.ledgerReverseSale = onCall(async (request) => {
  const {bookingId, reason} = request.data || {};
  // Guard before use: doc(undefined) throws inside the SDK and surfaces as an
  // opaque INTERNAL rather than telling the caller what was missing.
  if (!bookingId) throw new HttpsError("invalid-argument", "bookingId is required.");
  const bref = admin.firestore().collection("bookings").doc(bookingId);
  const bsnap = await bref.get();
  if (!bsnap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = bsnap.data();
  await assertSalonAccess(request.auth, booking.salon_id, "accounts");
  if (!booking.ledger?.posted) return {reversed: false, reason: "not posted"};
  const results = await ledger.reverseSaleForBooking(bookingId, booking.ledger, reason);
  await bref.set({ledger: {...booking.ledger, posted: false, reversed: true, reverse_results: results,
    reversed_at: FieldValue.serverTimestamp()}}, {merge: true});
  return {reversed: true, results};
});

// A client-supplied idempotency key, reduced to a charset safe for a ledger
// sourceId. Falls back to a timestamp when the caller sends none (older builds).
function sourceIdFrom(prefix, clientRequestId) {
  const clean = String(clientRequestId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return `${prefix}_${clean || Date.now()}`;
}

exports.ledgerRecordExpense = onCall(async (request) => {
  const {salonId, amount, expenseAccountId, paymentMethod, description, date, clientRequestId} = request.data || {};
  await assertSalonAccess(request.auth, salonId, "accounts");
  if (!(Number(amount) > 0)) throw new HttpsError("invalid-argument", "amount must be > 0.");
  if (!description) throw new HttpsError("invalid-argument", "description is required.");
  const {cred} = await ledger.ensureSalonLedger(salonId);
  let expAcct = expenseAccountId;
  if (!expAcct) {
    expAcct = cred.accounts?.operatingExpense || null;
  }
  if (!expAcct) {
    const accts = (await ledger.authed(cred, "/accounts", {query: {type: "EXPENSE", limit: 200}})).data || [];
    expAcct = (accts.find((a) => a.name === "Operating Expense") || accts[0] || {}).id;
  }
  if (!expAcct) throw new HttpsError("failed-precondition", "No expense account is available for this salon.");
  const res = await ledger.authed(cred, "/expenses", {method: "POST", body: {
    amount: Number(amount), expenseAccountId: expAcct,
    paymentMethod: paymentMethod === "BANK" ? "BANK" : "CASH",
    description, appId: ledger.APP_ID, sourceId: sourceIdFrom("exp", clientRequestId),
    date: date || ledger.istDate(),
  }});
  return {success: true, txnId: res.data?.transaction?.id || null};
});

exports.ledgerRecordCutqRemittance = onCall(async (request) => {
  const {salonId, amount, method, description, date, clientRequestId} = request.data || {};
  await assertSalonAccess(request.auth, salonId, "accounts");
  if (!(Number(amount) > 0)) throw new HttpsError("invalid-argument", "amount must be > 0.");
  const {cred} = await ledger.ensureSalonLedger(salonId);
  const sourceId = sourceIdFrom("remit", clientRequestId);

  // The ledger dedupes the payment itself; mirror that on the Firestore log so a
  // replay doesn't inflate "remitted" (and therefore deflate "owed to CutQ").
  const logRef = admin.firestore().collection("salons").doc(salonId)
    .collection("cutq_remittances").doc(sourceId);
  const priorLog = await logRef.get();
  if (priorLog.exists) {
    return {success: true, alreadyRecorded: true, txnId: priorLog.data()?.txnId || null};
  }
  const res = await ledger.authed(cred, "/vendor-payments", {method: "POST", body: {
    vendorId: cred.cutqVendorId, amount: Number(amount),
    method: method === "BANK" ? "BANK" : "CASH",
    description: description || "CutQ booking-fee remittance",
    appId: ledger.APP_ID, sourceId, date: date || ledger.istDate(),
  }});
  await logRef.set({
    amount: Number(amount), method: method === "BANK" ? "BANK" : "CASH",
    description: description || "CutQ booking-fee remittance",
    txnId: res.data?.transaction?.id || null, sourceId,
    created_at: FieldValue.serverTimestamp(),
  });
  return {success: true, txnId: res.data?.transaction?.id || null};
});

// How much the salon still owes CutQ = booking fees collected (all completed
// bookings) − already remitted. Also returns the fee collected within [from,to].
exports.ledgerCutqSummary = onCall(async (request) => {
  const {salonId, from, to} = request.data || {};
  await assertSalonAccess(request.auth, salonId, "accounts");
  const db = admin.firestore();
  const snap = await db.collection("bookings")
    .where("salon_id", "==", salonId).where("status", "==", "completed").get();
  const fromMs = from ? new Date(from).getTime() : null;
  const toMs = to ? new Date(to).getTime() + 86400000 : null;
  let allCollected = 0; let rangeCollected = 0; let count = 0; let rangeCount = 0;
  snap.forEach((d) => {
    const b = d.data();
    const fee = Number(b.booking_fee) || 0;
    allCollected += fee; count++;
    const t = b.completion?.completed_at?.toMillis?.() || b.updated_at?.toMillis?.() || 0;
    if ((!fromMs || t >= fromMs) && (!toMs || t < toMs)) {
      rangeCollected += fee; rangeCount++;
    }
  });
  const remSnap = await db.collection("salons").doc(salonId).collection("cutq_remittances").get();
  let remitted = 0;
  remSnap.forEach((d) => {
    remitted += Number(d.data().amount) || 0;
  });
  return {allCollected, remitted, owed: Math.max(0, allCollected - remitted),
    count, rangeCollected, rangeCount, from: from || null, to: to || null};
});

// Read proxy for the Accounts section — dispatches to Humble Ledger read endpoints.
exports.ledgerQuery = onCall(async (request) => {
  const {salonId, resource, params = {}} = request.data || {};
  await assertSalonAccess(request.auth, salonId, "accounts");
  const {cred} = await ledger.ensureSalonLedger(salonId);
  const q = (path, query) => ledger.authed(cred, path, {query});
  switch (resource) {
    case "meta":
      return {accounts: cred.accounts, cutqVendorId: cred.cutqVendorId, companyId: cred.companyId || null};
    case "accounts": return q("/accounts", {limit: 200, ...params});
    case "transactions": return q("/transactions", {limit: 50, ...params});
    case "ledger": return q("/ledger", {limit: 100, ...params});
    case "report_pnl": return q("/reports/pnl", params);
    case "report_trial_balance": return q("/reports/trial-balance", params);
    case "report_balance_sheet": return q("/reports/balance-sheet", params);
    case "receivables": return q("/receivables", {limit: 100, ...params});
    case "invoices": return q("/invoices", {limit: 50, ...params});
    case "vendors": return q("/vendors", {limit: 50, ...params});
    default:
      throw new HttpsError("invalid-argument", `Unknown resource: ${resource}`);
  }
});

// ── Salon team members (SALONTEAM role) ─────────────────────────────────────────
//
// A salon owner can add team members with access to a chosen set of modules
// (UI-gated only; no per-module Firestore rules). Dashboard is always included;
// the Team module itself is never grantable. A member's per-salon access lives
// on their own Users doc (`salon_access.<salonId>`) so they can read it, and on
// `salons/<salonId>/team/<uid>` so the owner can list the team.

const GRANTABLE_MODULES = [
  "dashboard", "bookings", "schedule", "services",
  "stylists", "customers", "past_bookings", "accounts", "settings",
];

function sanitizeModules(modules) {
  let m = Array.isArray(modules) ? modules.filter((x) => GRANTABLE_MODULES.includes(x)) : [];
  if (!m.includes("dashboard")) m.unshift("dashboard"); // always on, default
  m = [...new Set(m)];
  return m.length ? m : ["dashboard"];
}

exports.addSalonTeamMember = onCall({secrets: [SMTP_USER, SMTP_PASS]}, async (request) => {
  const {salonId, email, name, phone, modules} = request.data || {};
  const salon = await assertSalonOwner(request.auth, salonId);
  if (!email || !String(email).trim()) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }
  const cleanEmail = String(email).trim();
  const cleanModules = sanitizeModules(modules);
  const db = admin.firestore();

  let uid;
  let password = randomPassword(10);
  let isExisting = false;
  try {
    const u = await admin.auth().createUser({
      email: cleanEmail, password, emailVerified: true, displayName: String(name || "").trim(),
    });
    uid = u.uid;
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      const u = await admin.auth().getUserByEmail(cleanEmail);
      uid = u.uid;
      isExisting = true;
      password = null;
    } else if (err.code === "auth/invalid-email") {
      throw new HttpsError("invalid-argument", "The email address is not valid.");
    } else {
      logger.error("addSalonTeamMember createUser failed", err);
      throw new HttpsError("internal", `Could not create account: ${err.message || "unknown"}`);
    }
  }

  // Never downgrade an existing owner/admin; otherwise mark as SALONTEAM.
  const uref = db.collection("Users").doc(uid);
  const existing = await uref.get();
  const existingRole = existing.exists ? existing.data().Role : null;
  const roleToSet = (existingRole === "SALONOWNER" || existingRole === "ADMIN") ? existingRole : "SALONTEAM";

  const userDoc = {
    name: String(name || "").trim() || existing.data()?.name || "",
    phone: String(phone || "").trim(),
    email: cleanEmail,
    Role: roleToSet,
    isEnabled: true,
    salon_access: {
      [salonId]: {
        modules: cleanModules,
        is_active: true,
        salon_name: salon.name || "",
        added_at: FieldValue.serverTimestamp(),
      },
    },
  };
  if (!existing.exists) {
    Object.assign(userDoc, {profile_photo: "", gender: "", dob: "", created_at: FieldValue.serverTimestamp()});
  }

  // All three Firestore writes are committed atomically so a membership can
  // never end up half-created (e.g. salon_access set but team_uids missing).
  const batch = db.batch();
  batch.set(uref, userDoc, {merge: true});
  batch.set(db.collection("salons").doc(salonId).collection("team").doc(uid), {
    uid, name: String(name || "").trim(), email: cleanEmail, phone: String(phone || "").trim(),
    modules: cleanModules, is_active: true,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  }, {merge: true});
  batch.update(db.collection("salons").doc(salonId), {team_uids: FieldValue.arrayUnion(uid)});
  await batch.commit();

  try {
 await refreshUserClaims(uid);
} catch (err) {
 logger.error("addSalonTeamMember: claim set failed", {uid, err});
}

  let emailSent = false;
  if (!isExisting) {
    try {
      const smtpUser = SMTP_USER.value();
      const smtpPass = SMTP_PASS.value();
      if (smtpUser && smtpPass) {
        await nodemailer.createTransport({
          host: "smtp.gmail.com", port: 465, secure: true, auth: {user: smtpUser, pass: smtpPass},
        }).sendMail({
          from: `"CUTQ Salon" <${smtpUser}>`,
          to: cleanEmail,
          subject: `You've been added to ${salon.name || "a salon"} — CUTQ`,
          text:
            `Hello ${name || "there"},\n\n` +
            `You've been added to ${salon.name || "a salon"} on CUTQ.\n\n` +
            `Email: ${cleanEmail}\n` +
            `Temporary password: ${password}\n\n` +
            "Sign in to the salon dashboard and change your password.\n",
          html: buildEmailHtml(name, cleanEmail, password),
        });
        emailSent = true;
      }
    } catch (mailErr) {
      logger.error("addSalonTeamMember email failed (non-fatal)", {uid, err: mailErr});
    }
  }

  return {uid, email: cleanEmail, password, isExisting, emailSent, modules: cleanModules};
});

exports.updateSalonTeamMember = onCall(async (request) => {
  const {salonId, memberUid, modules, is_active: isActive} = request.data || {};
  await assertSalonOwner(request.auth, salonId);
  if (!memberUid) throw new HttpsError("invalid-argument", "memberUid is required.");
  const db = admin.firestore();

  const teamPatch = {updated_at: FieldValue.serverTimestamp()};
  const accessPatch = {};
  if (modules !== undefined) {
    const clean = sanitizeModules(modules);
    teamPatch.modules = clean;
    accessPatch.modules = clean;
  }
  if (isActive !== undefined) {
    teamPatch.is_active = !!isActive;
    accessPatch.is_active = !!isActive;
  }
  await db.collection("salons").doc(salonId).collection("team").doc(memberUid).set(teamPatch, {merge: true});
  await db.collection("Users").doc(memberUid).set({salon_access: {[salonId]: accessPatch}}, {merge: true});
  return {success: true};
});

exports.removeSalonTeamMember = onCall(async (request) => {
  const {salonId, memberUid} = request.data || {};
  await assertSalonOwner(request.auth, salonId);
  if (!memberUid) throw new HttpsError("invalid-argument", "memberUid is required.");
  const db = admin.firestore();
  await db.collection("salons").doc(salonId).collection("team").doc(memberUid).delete();
  await db.collection("salons").doc(salonId).update({team_uids: FieldValue.arrayRemove(memberUid)});
  await db.collection("Users").doc(memberUid).update({[`salon_access.${salonId}`]: FieldValue.delete()});
  try {
 await refreshUserClaims(memberUid);
} catch (err) {
 logger.error("removeSalonTeamMember: claim set failed", {memberUid, err});
}
  return {success: true};
});

// ── Issue reports ───────────────────────────────────────────────────────────────
//
// Users file reports from the app (reports/{id}). On create we email the admin's
// configured recipients (report_config/settings.notify_emails); when a report is
// marked resolved we push an FCM notification to the reporter.


/**
 * Minimum minutes ahead a slot may be booked, server side.
 *
 * The apps only OFFER slots `booking_min_lead_minutes` ahead (default 30). The server accepts
 * a slot LEAD_GRACE_MINUTES sooner so a customer who spends a few minutes on checkout is not
 * rejected at the last step — that five-minute gap was the original 30-vs-25 split, kept
 * deliberately. Admins change one number in app_config/settings and both sides follow.
 */
const LEAD_GRACE_MINUTES = 5;
const DEFAULT_LEAD_MINUTES = 30;

async function serverMinLeadMs() {
  let lead = DEFAULT_LEAD_MINUTES;
  try {
    const snap = await admin.firestore().collection("app_config").doc("settings").get();
    const v = snap.exists ? Number(snap.data().booking_min_lead_minutes) : NaN;
    // A misconfigured value must not make booking impossible or unguarded.
    if (Number.isFinite(v) && v >= 10 && v <= 240) lead = v;
  } catch (err) {
    logger.warn("serverMinLeadMs: falling back to default lead time", err);
  }
  return Math.max(1, lead - LEAD_GRACE_MINUTES) * 60 * 1000;
}

exports.onReportCreated = onDocumentCreated(
  {document: "reports/{reportId}", secrets: [SMTP_USER, SMTP_PASS]},
  async (event) => {
    const report = event.data?.data?.() || {};
    const reportId = event.params.reportId;
    const db = admin.firestore();

    let emails = [];
    try {
      const cfg = await db.collection("report_config").doc("settings").get();
      emails = Array.isArray(cfg.data()?.notify_emails) ? cfg.data().notify_emails.filter(Boolean) : [];
    } catch (err) {
      logger.error("onReportCreated: failed to read report_config", err);
    }
    if (emails.length === 0) {
      logger.info("onReportCreated: no notify_emails configured — skipping email", {reportId});
      return;
    }

    const smtpUser = SMTP_USER.value();
    const smtpPass = SMTP_PASS.value();
    if (!smtpUser || !smtpPass) {
      logger.warn("onReportCreated: SMTP not configured — skipping email", {reportId});
      return;
    }

    // Whether this category demands a service is resolved from the CATEGORY, not from the
    // flag the client stamped on the report. App versions that predate the requirement send
    // no flag at all, so trusting the report would make the "no service" notice below
    // unreachable for exactly the old builds it exists to explain.
    let requiresService = report.category_requires_service === true;
    if (report.category_requires_service === undefined && report.category_id) {
      try {
        const cat = await db.collection("report_categories").doc(report.category_id).get();
        requiresService = cat.data()?.requires_service === true;
      } catch (err) {
        logger.warn("onReportCreated: could not resolve category requires_service", err);
      }
    }
    // Client-written and never validated by the rules, so treat the shape as untrusted.
    const reportedServices = Array.isArray(report.reported_services) ?
      report.reported_services.map((s) => s?.service_name).filter(Boolean) : [];

    const lines = [
      `A new issue was reported on CUTQ.`,
      ``,
      `Category: ${report.category_name || "—"}`,
      `Reported by: ${report.user_name || "Unknown"}${report.user_phone ? ` (${report.user_phone})` : ""}`,
      `Filed from: ${report.platform || "app"} v${report.app_version || "?"}`,
      report.about_booking && report.booking_id ?
        `Related booking: ${report.booking_id}${report.booking_brief?.salon_name ? ` — ${report.booking_brief.salon_name}` : ""}` : null,
      // The narrower list: what the user is actually complaining about. A ticket filed
      // under a category that requires a service but carries none came from a build that
      // predates the requirement — say so rather than letting support assume a bug.
      reportedServices.length ?
        `Service(s) reported: ${reportedServices.join(", ")}` :
        (requiresService ? `Service(s) reported: (none — filed from an older app build)` : null),
      ``,
      `Description:`,
      report.description || "(none)",
      ``,
      `Report ID: ${reportId}`,
    ].filter((l) => l !== null).join("\n");

    try {
      await nodemailer.createTransport({
        host: "smtp.gmail.com", port: 465, secure: true, auth: {user: smtpUser, pass: smtpPass},
      }).sendMail({
        from: `"CUTQ Reports" <${smtpUser}>`,
        to: emails.join(", "),
        subject: `New issue reported: ${report.category_name || "General"}${
          reportedServices.length === 1 ? ` — ${reportedServices[0]}` : ""
        } — CUTQ`,
        text: lines,
      });
      logger.info("onReportCreated: notification email sent", {reportId, recipients: emails.length});
    } catch (err) {
      logger.error("onReportCreated: email failed", {reportId, err});
    }
  },
);

// ── Partner requests ────────────────────────────────────────────────────────────
//
// The public CutQ landing page writes "Become a Partner" leads to
// partner_requests/{id}. On create we email the same recipients configured for
// issue reports (report_config/settings.notify_emails).

exports.onPartnerRequestCreated = onDocumentCreated(
  {document: "partner_requests/{requestId}", secrets: [SMTP_USER, SMTP_PASS]},
  async (event) => {
    const req = event.data?.data?.() || {};
    const requestId = event.params.requestId;
    const db = admin.firestore();

    let emails = [];
    try {
      const cfg = await db.collection("report_config").doc("settings").get();
      emails = Array.isArray(cfg.data()?.notify_emails) ? cfg.data().notify_emails.filter(Boolean) : [];
    } catch (err) {
      logger.error("onPartnerRequestCreated: failed to read report_config", err);
    }
    if (emails.length === 0) {
      logger.info("onPartnerRequestCreated: no notify_emails configured — skipping email", {requestId});
      return;
    }

    const smtpUser = SMTP_USER.value();
    const smtpPass = SMTP_PASS.value();
    if (!smtpUser || !smtpPass) {
      logger.warn("onPartnerRequestCreated: SMTP not configured — skipping email", {requestId});
      return;
    }

    const lines = [
      `A new partner request was submitted on the CUTQ landing page.`,
      ``,
      `Salon: ${req.salon_name || "—"}`,
      `Owner: ${req.owner_name || "—"}`,
      `Phone: ${req.phone || "—"}`,
      `Email: ${req.email || "—"}`,
      `City: ${req.city || "—"}`,
      ``,
      `Message:`,
      req.message || "(none)",
      ``,
      `Request ID: ${requestId}`,
    ].join("\n");

    try {
      await nodemailer.createTransport({
        host: "smtp.gmail.com", port: 465, secure: true, auth: {user: smtpUser, pass: smtpPass},
      }).sendMail({
        from: `"CUTQ Partners" <${smtpUser}>`,
        to: emails.join(", "),
        subject: `New partner request: ${req.salon_name || "Salon"} — CUTQ`,
        text: lines,
      });
      logger.info("onPartnerRequestCreated: notification email sent", {requestId, recipients: emails.length});
    } catch (err) {
      logger.error("onPartnerRequestCreated: email failed", {requestId, err});
    }
  },
);

exports.onReportResolved = onDocumentUpdated(
  "reports/{reportId}",
  async (event) => {
    const before = event.data?.before?.data?.() || {};
    const after = event.data?.after?.data?.() || {};
    // Only when status transitions into "resolved".
    if (before.status === after.status || after.status !== "resolved") return;

    const reportId = event.params.reportId;
    const userId = after.user_id || "";
    if (!userId) return;

    const db = admin.firestore();
    const userSnap = await db.collection("Users").doc(userId).get();
    const token = userSnap.data()?.fcm_token;
    if (!token) {
      logger.info("onReportResolved: reporter has no fcm_token", {reportId, userId});
      return;
    }

    const message = {
      token,
      notification: {
        title: "Your issue has been resolved",
        body: `Your report about "${after.category_name || "an issue"}" has been marked resolved.`,
      },
      data: {report_id: String(reportId), type: "report_resolved"},
      android: {priority: "high", notification: {channelId: "cutq_bookings", sound: "default", priority: "high"}},
      apns: {payload: {aps: {sound: "default", badge: 1}}},
    };
    try {
      await admin.messaging().send(message);
      logger.info("onReportResolved: sent FCM", {reportId, userId});
    } catch (err) {
      if (err.code === "messaging/registration-token-not-registered" ||
          err.code === "messaging/invalid-registration-token") {
        await db.collection("Users").doc(userId).update({fcm_token: FieldValue.delete()}).catch(() => {});
      } else {
        logger.error("onReportResolved: FCM failed", {reportId, err});
      }
    }
  },
);

// ── Customer phone-OTP authentication (Fast2SMS DLT + Firebase custom tokens) ──
// Implemented in ./auth.js. Required here so `firebase deploy --only functions`
// discovers them in this codebase.
const authFns = require("./auth");

exports.authRequestOtp = authFns.authRequestOtp;
exports.authVerifyOtp = authFns.authVerifyOtp;
exports.authDeleteAccount = authFns.authDeleteAccount;
exports.authOtpWatchdog = authFns.authOtpWatchdog;
