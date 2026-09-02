/**
 * One-time (idempotent) seed for the phone-OTP backend.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json \
 *     node scripts/seedAuthConfig.js
 *
 * Creates:
 *   auth_config/otp        quota configuration and the kill switch
 *   otp_global/breaker     circuit-breaker document (closed)
 *   otp_test_numbers/*     three store-review numbers with fixed codes
 *
 * Re-running is safe: existing quota values are preserved (only missing keys are added)
 * and existing test numbers keep their codes.
 */
const admin = require("firebase-admin");
const crypto = require("crypto");
const {DEFAULT_LIMITS} = require("../otpcore");

const PROJECT_ID = process.env.GCLOUD_PROJECT || "cutq-e133a";

// Numbers starting with 1 are not allocatable to Indian mobiles, so these can never
// collide with a real customer and never reach the SMS provider.
const TEST_NUMBERS = ["1000000001", "1000000002", "1000000003"];
const TEST_NUMBER_MONTHS = 6;

const ALERT_EMAILS = ["humblecoders2024@gmail.com"];

async function main() {
  admin.initializeApp({projectId: PROJECT_ID});
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  // ── auth_config/otp ─────────────────────────────────────────────────────────
  const cfgRef = db.doc("auth_config/otp");
  const cfgSnap = await cfgRef.get();
  const existing = cfgSnap.exists ? cfgSnap.data() : {};
  const limits = Object.assign({}, DEFAULT_LIMITS, existing.limits || {});
  await cfgRef.set({
    sends_enabled: existing.sends_enabled !== undefined ? existing.sends_enabled : true,
    appcheck_mode: existing.appcheck_mode || "off",
    wallet_min_inr: existing.wallet_min_inr !== undefined ? existing.wallet_min_inr : 500,
    alert_emails: existing.alert_emails && existing.alert_emails.length ? existing.alert_emails : ALERT_EMAILS,
    limits,
    updated_at: now,
  }, {merge: true});
  console.log(cfgSnap.exists ? "auth_config/otp updated (existing values kept)" : "auth_config/otp created");

  // ── otp_global/breaker ──────────────────────────────────────────────────────
  const breakerRef = db.doc("otp_global/breaker");
  if (!(await breakerRef.get()).exists) {
    await breakerRef.set({
      circuit_open_until: null,
      new_phones_block_until: null,
      circuit_reason: null,
      circuit_opened_at: null,
    });
    console.log("otp_global/breaker created (closed)");
  } else {
    console.log("otp_global/breaker already exists — left untouched");
  }

  // ── test numbers ────────────────────────────────────────────────────────────
  const expiresAt = admin.firestore.Timestamp.fromMillis(
    Date.now() + TEST_NUMBER_MONTHS * 30 * 86400000);
  const report = [];
  for (const phone of TEST_NUMBERS) {
    const ref = db.doc(`otp_test_numbers/${phone}`);
    const snap = await ref.get();
    if (snap.exists) {
      report.push({phone, otp: snap.data().otp, status: "kept"});
      continue;
    }
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    await ref.set({
      otp,
      enabled: true,
      note: "App Store / Play review. Never sent over SMS.",
      expires_at: expiresAt,
      created_by: "seedAuthConfig",
      created_at: now,
    });
    report.push({phone, otp, status: "created"});
  }

  console.log("\nTest numbers (put one of these in the store review notes):");
  report.forEach((r) => console.log(`  +91 ${r.phone}  code ${r.otp}  (${r.status})`));
  console.log(`\nThey stop working on ${expiresAt.toDate().toDateString()} — re-run this script to renew.`);
  console.log("\nKill switch:   auth_config/otp.sends_enabled = false");
  console.log("Clear breaker: otp_global/breaker.circuit_open_until = null");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
