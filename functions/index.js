const {setGlobalOptions} = require("firebase-functions/v2");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

// ── Secrets (stored in Google Cloud Secret Manager) ──────────────────────────
// Set once via:  firebase functions:secrets:set SMTP_USER
//                firebase functions:secrets:set SMTP_PASS
//                firebase functions:secrets:set SMTP_FROM   (optional)
const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const SMTP_FROM = defineSecret("SMTP_FROM");

setGlobalOptions({maxInstances: 10});

admin.initializeApp();

function randomPassword(length = 8) {
  const all = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += all[bytes[i] % all.length];
  return out;
}

async function getUserProfile(uid) {
  const db = admin.firestore();
  const candidates = ["Users", "users"];
  for (const col of candidates) {
    const snap = await db.collection(col).doc(uid).get();
    if (snap.exists) return snap.data();
  }
  return null;
}

async function assertCallerIsEnabledAdmin(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const profile = await getUserProfile(request.auth.uid);
  if (!profile || profile.Role !== "ADMIN" || profile.isEnabled !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

// secrets array tells Firebase to inject secret values at runtime
exports.createSalonOwner = onCall(
  {cors: true, invoker: "public", secrets: [SMTP_USER, SMTP_PASS, SMTP_FROM]},
  async (request) => {
    await assertCallerIsEnabledAdmin(request);

    const data = request.data || {};
    const email = String(data.email || "").trim().toLowerCase();
    const name = String(data.name || "").trim();
    const phone = String(data.phone || "").trim();

    if (!email || !email.includes("@")) {
      throw new HttpsError("invalid-argument", "Valid email is required.");
    }

    const smtpUser = SMTP_USER.value();
    const smtpPass = SMTP_PASS.value();

    if (!smtpUser || !smtpPass) {
      throw new HttpsError(
        "failed-precondition",
        "SMTP secrets are not configured.",
      );
    }

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
      throw new HttpsError(
        "already-exists",
        "User already exists, or email invalid.",
      );
    }

    const uid = userRecord.uid;
    const db = admin.firestore();

    await db.collection("Users").doc(uid).set(
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
    );

    const from = SMTP_FROM.value() || smtpUser;
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {user: smtpUser, pass: smtpPass},
    });

    const subject = "Your Salon Owner Account";
    const text =
      `Hello${name ? " " + name : ""},\n\n` +
      "An account has been created for you.\n\n" +
      `Email: ${email}\n` +
      `Temporary password: ${password}\n\n` +
      "Please sign in and change your password.\n";

    await transporter.sendMail({from, to: email, subject, text});

    return {uid, email};
  },
);
