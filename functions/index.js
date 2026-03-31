const {setGlobalOptions} = require("firebase-functions/v2");
const {onRequest} = require("firebase-functions/v2/https");
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

// ── Cloud Function ─────────────────────────────────────────────────────────────
// onRequest instead of onCall so we own CORS headers before any IAM check.
// The Firebase callable protocol is preserved so the frontend httpsCallable
// SDK works without any changes.

exports.createSalonOwner = onRequest(
  {invoker: "public", secrets: [SMTP_USER, SMTP_PASS]},
  async (req, res) => {
    // Always attach CORS headers — even on errors and preflight
    setCorsHeaders(res);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    // Firebase callable protocol: POST only
    if (req.method !== "POST") {
      res.status(405).json({error: {status: "METHOD_NOT_ALLOWED", message: "POST only."}});
      return;
    }

    // ── Verify Firebase ID token (httpsCallable sends it as Bearer) ───────────
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

    // ── Check caller is an enabled ADMIN ──────────────────────────────────────
    const profile = await getUserProfile(decoded.uid);
    if (!profile || profile.Role !== "ADMIN" || profile.isEnabled !== true) {
      res.status(403).json({error: {status: "PERMISSION_DENIED", message: "Admin access required."}});
      return;
    }

    // ── Parse callable request body ───────────────────────────────────────────
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

    // ── Create Firebase Auth user ─────────────────────────────────────────────
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

    // ── Write Users doc ───────────────────────────────────────────────────────
    await admin.firestore().collection("Users").doc(uid).set(
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

    // ── Send credentials email ────────────────────────────────────────────────
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

    await transporter.sendMail({from: smtpUser, to: email, subject, text});

    // ── Return callable-format response ───────────────────────────────────────
    res.status(200).json({result: {uid, email}});
  },
);
