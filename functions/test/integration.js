/**
 * End-to-end test of the OTP flow against the Firebase emulators.
 *
 *   firebase emulators:exec --only functions,firestore,auth \
 *     --project cutq-e133a "node functions/test/integration.js"
 *
 * Fast2SMS is never called: sendViaFast2Sms short-circuits under FUNCTIONS_EMULATOR.
 * The OTP is derived locally from the session nonce, exactly the way the server does it,
 * so the real derivation path is exercised rather than mocked.
 */
const admin = require("firebase-admin");
const {deriveOtp} = require("../otpcore");

const PROJECT = process.env.GCLOUD_PROJECT || "cutq-e133a";
const REGION = "us-central1";
const BASE = `http://127.0.0.1:5001/${PROJECT}/${REGION}`;
const HMAC_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

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

async function callFn(name, data, opts = {}) {
  const res = await fetch(`${BASE}/${name}`, {
    method: "POST",
    headers: Object.assign({"content-type": "application/json"}, opts.headers || {}),
    body: JSON.stringify({data}),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    return {ok: false, status: res.status, code: body.error.details && body.error.details.code,
      message: body.error.message, details: body.error.details};
  }
  return {ok: true, status: res.status, result: body.result};
}

const install = (n) => `emulator-install-${n}-aaaaaaaa`;
const reqBody = (phone, installId) => ({
  phone, purpose: "login", installId, platform: "android", appVersion: 8,
});

/** Derives the live code the same way the server does, from the stored nonce. */
async function currentOtp(phone) {
  const snap = await db.doc(`otp_sessions/${phone}`).get();
  const s = snap.data();
  return deriveOtp(HMAC_SECRET, phone, s.purpose, s.nonce);
}

async function resetPhone(phone) {
  await Promise.all([
    db.doc(`otp_sessions/${phone}`).delete(),
    db.doc(`otp_phones/${phone}`).delete(),
  ]);
}

async function seed() {
  await db.doc("auth_config/otp").set({
    sends_enabled: true,
    appcheck_mode: "off",
    wallet_min_inr: 500,
    alert_emails: [],
    limits: {},
  });
  await db.doc("otp_global/breaker").set({circuit_open_until: null, new_phones_block_until: null});
  await db.doc("otp_test_numbers/1000000001").set({
    otp: "424242",
    enabled: true,
    note: "integration test",
    expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + 86400000),
  });
}

async function main() {
  await seed();

  console.log("\nvalidation");
  {
    const bad = await callFn("authRequestOtp", reqBody("5123456789", install("a")));
    check("rejects a non-mobile leading digit", bad.code === "OTP_INVALID_PHONE", bad.code);

    const short = await callFn("authRequestOtp", reqBody("98765", install("a")));
    check("rejects a short number", short.code === "OTP_INVALID_PHONE", short.code);

    const noInstall = await callFn("authRequestOtp",
      {phone: "9876500001", purpose: "login", installId: "x", platform: "android", appVersion: 8});
    check("rejects a malformed install id", noInstall.code === "OTP_BAD_ARGUMENT", noInstall.code);

    const badPurpose = await callFn("authRequestOtp",
      {phone: "9876500001", purpose: "hack", installId: install("a"), platform: "android", appVersion: 8});
    check("rejects an unknown purpose", badPurpose.code === "OTP_BAD_ARGUMENT", badPurpose.code);

    const deleteNoAuth = await callFn("authRequestOtp",
      {purpose: "delete", installId: install("a"), platform: "android", appVersion: 8});
    check("delete OTP requires authentication", deleteNoAuth.code === "AUTH_REQUIRED", deleteNoAuth.code);
  }

  console.log("\nhappy path");
  const phone = "9876500001";
  await resetPhone(phone);
  {
    const sent = await callFn("authRequestOtp", reqBody(phone, install("a")));
    check("sends an OTP", sent.ok && sent.result.deliveredVia === "sms", JSON.stringify(sent));
    check("returns the server cooldown", sent.ok && sent.result.resendAfterSec === 30, JSON.stringify(sent.result));
    check("returns the 10-minute expiry", sent.ok && sent.result.expiresInSec === 600, JSON.stringify(sent.result));
    check("masks the number", sent.ok && sent.result.maskedPhone === "+91 98XXXXXX01", sent.result && sent.result.maskedPhone);

    const session = (await db.doc(`otp_sessions/${phone}`).get()).data();
    check("stores no recoverable OTP", session.otp === undefined && session.otp_hash === undefined &&
      typeof session.nonce === "string", Object.keys(session).join(","));
    check("binds the session to the requesting device", typeof session.install_h === "string" &&
      session.install_h.length === 32);

    const otp = await currentOtp(phone);
    const wrong = await callFn("authVerifyOtp", {phone, otp: otp === "000000" ? "111111" : "000000", installId: install("a")});
    check("rejects a wrong code with attempts left", wrong.code === "OTP_INCORRECT" &&
      wrong.details.attemptsLeft === 4, JSON.stringify(wrong.details));

    const foreign = await callFn("authVerifyOtp", {phone, otp, installId: install("b")});
    check("refuses a guess from another device", foreign.code === "OTP_SESSION_NOT_FOUND", foreign.code);
    const afterForeign = (await db.doc(`otp_sessions/${phone}`).get()).data();
    check("a foreign guess does not consume the victim's attempts", afterForeign.attempts === 1,
      `attempts=${afterForeign.attempts}`);

    const good = await callFn("authVerifyOtp", {phone, otp, installId: install("a")});
    check("accepts the correct code", good.ok && typeof good.result.customToken === "string", JSON.stringify(good));
    check("reports a new user", good.ok && good.result.isNewUser === true && good.result.profileComplete === false);
    check("returns the E.164 number", good.ok && good.result.phone === `+91${phone}`);

    const uid = good.ok ? good.result.uid : null;
    const authUser = uid ? await admin.auth().getUser(uid) : null;
    check("creates the Auth user with the phone number", authUser && authUser.phoneNumber === `+91${phone}`,
      authUser && authUser.phoneNumber);
    const userDoc = uid ? (await db.doc(`Users/${uid}`).get()).data() : null;
    check("creates the Users document server-side", userDoc && userDoc.Role === "USER" &&
      userDoc.isEnabled === true && userDoc.phone === phone, JSON.stringify(userDoc));

    const replay = await callFn("authVerifyOtp", {phone, otp, installId: install("a")});
    check("refuses to replay a consumed code", replay.code === "OTP_SESSION_NOT_FOUND", replay.code);
  }

  console.log("\nexisting user keeps their uid");
  {
    const first = (await admin.auth().getUserByPhoneNumber(`+91${phone}`)).uid;
    await resetPhone(phone);
    await callFn("authRequestOtp", reqBody(phone, install("a")));
    const otp = await currentOtp(phone);
    const again = await callFn("authVerifyOtp", {phone, otp, installId: install("a")});
    check("same uid on a second sign-in", again.ok && again.result.uid === first,
      `${again.ok ? again.result.uid : again.code} vs ${first}`);
    check("reports an existing user", again.ok && again.result.isNewUser === false);
  }

  console.log("\ncooldown and resend");
  const phone2 = "9876500002";
  await resetPhone(phone2);
  {
    await callFn("authRequestOtp", reqBody(phone2, install("c")));
    const otpA = await currentOtp(phone2);
    const immediate = await callFn("authRequestOtp", reqBody(phone2, install("c")));
    check("blocks an immediate resend", immediate.code === "OTP_COOLDOWN", immediate.code);
    check("tells the client how long to wait", immediate.details && immediate.details.retryAfterSec > 0 &&
      immediate.details.retryAfterSec <= 30, JSON.stringify(immediate.details));

    // Rewind the cooldown rather than sleeping through it.
    const doc = await db.doc(`otp_phones/${phone2}`).get();
    await db.doc(`otp_phones/${phone2}`).update({
      send_times: doc.data().send_times.map((t) => t - 31000),
    });

    const resent = await callFn("authRequestOtp", reqBody(phone2, install("c")));
    check("allows a resend after the cooldown", resent.ok, JSON.stringify(resent));
    check("escalates the next cooldown to 60 s", resent.ok && resent.result.resendAfterSec === 60,
      resent.ok && String(resent.result.resendAfterSec));
    const otpB = await currentOtp(phone2);
    check("re-sends the SAME code while it is still valid", otpA === otpB, `${otpA} vs ${otpB}`);
    const session = (await db.doc(`otp_sessions/${phone2}`).get()).data();
    check("counts the resend without resetting attempts", session.sends === 2 && session.attempts === 0,
      `sends=${session.sends} attempts=${session.attempts}`);
  }

  console.log("\nresend keeps the code the user already has");
  const phoneR = "9876500009";
  await resetPhone(phoneR);
  {
    await callFn("authRequestOtp", reqBody(phoneR, install("r")));
    const otp = await currentOtp(phoneR);
    // Rewind past the cooldown, then make the provider fail on the resend.
    const snap = await db.doc(`otp_phones/${phoneR}`).get();
    await db.doc(`otp_phones/${phoneR}`).update({
      send_times: snap.data().send_times.map((t) => t - 31000),
    });
    // NOTE: the emulator stubs Fast2SMS, so this covers the reuse path and proves the
    // session stays verifiable across a resend. The provider-failure branch itself
    // (auth.js: reused sends skip the send_failed stamp) is not reachable from here.
    const resent = await callFn("authRequestOtp", reqBody(phoneR, install("r")));
    check("resend reuses the same code", resent.ok, JSON.stringify(resent));
    const session = (await db.doc(`otp_sessions/${phoneR}`).get()).data();
    check("session is still verifiable after the resend", session.status !== "send_failed",
      `status=${session.status}`);
    const verified = await callFn("authVerifyOtp", {phone: phoneR, otp, installId: install("r")});
    check("the original code still verifies", verified.ok, JSON.stringify(verified));
  }

  console.log("\nper-number send cap");
  const phone3 = "9876500003";
  await resetPhone(phone3);
  {
    // Three sends allowed per 10 minutes. Between each one, rewind every timestamp by
    // 130 s: past the longest cooldown step (120 s) but still well inside the 10-minute
    // window the per-number cap is measured over.
    for (let i = 0; i < 3; i++) {
      const r = await callFn("authRequestOtp", reqBody(phone3, install("d")));
      check(`send ${i + 1} of 3 allowed`, r.ok, r.code);
      const snap = await db.doc(`otp_phones/${phone3}`).get();
      await db.doc(`otp_phones/${phone3}`).update({
        send_times: snap.data().send_times.map((t) => t - 130000),
      });
    }
    const fourth = await callFn("authRequestOtp", reqBody(phone3, install("d")));
    check("blocks the 4th code in 10 minutes", fourth.code === "OTP_PHONE_LIMIT", fourth.code);
  }

  console.log("\nglobal cap and circuit breaker");
  {
    // Clear this hour's counter first: earlier cases already recorded sends against it,
    // so a cap of 1 would otherwise trip on the very first call below.
    const istHourKey = (() => {
      const d = new Date(Date.now() + 5.5 * 3600000);
      const p = (n) => String(n).padStart(2, "0");
      return `h_${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
    })();
    await db.doc(`otp_global/${istHourKey}`).set({sends: 0, new_phones: 0}, {merge: true});
    await db.doc("auth_config/otp").update({limits: {global_1h: 1}});
    await new Promise((r) => setTimeout(r, 61000)); // let the 60 s config cache expire
    const phone4 = "9876500004";
    const phone5 = "9876500005";
    await resetPhone(phone4);
    await resetPhone(phone5);
    const first = await callFn("authRequestOtp", reqBody(phone4, install("e")));
    check("the send under the cap succeeds", first.ok, JSON.stringify(first));
    const over = await callFn("authRequestOtp", reqBody(phone5, install("f")));
    check("blocks the send over the global cap", over.code === "OTP_SERVICE_BUSY", over.code);
    const breaker = (await db.doc("otp_global/breaker").get()).data();
    check("opens the circuit breaker", breaker.circuit_open_until !== null &&
      breaker.circuit_reason === "GLOBAL_1H", JSON.stringify(breaker.circuit_reason));

    // Test numbers must keep working so store review can never be blocked.
    await resetPhone("1000000001");
    const testNum = await callFn("authRequestOtp", reqBody("1000000001", install("g")));
    check("test numbers still work while the breaker is open",
      testNum.ok && testNum.result.deliveredVia === "test", JSON.stringify(testNum));
    const testVerify = await callFn("authVerifyOtp",
      {phone: "1000000001", otp: "424242", installId: install("g")});
    check("test number verifies with its fixed code", testVerify.ok, JSON.stringify(testVerify));

    await db.doc("otp_global/breaker").set({circuit_open_until: null, new_phones_block_until: null});
    await db.doc("auth_config/otp").update({limits: {}});
  }

  console.log("\nkill switch");
  {
    await db.doc("auth_config/otp").update({sends_enabled: false});
    await new Promise((r) => setTimeout(r, 61000));
    const off = await callFn("authRequestOtp", reqBody("9876500006", install("h")));
    check("sends_enabled=false stops everything", off.code === "OTP_DISABLED", off.code);
    await db.doc("auth_config/otp").update({sends_enabled: true});
  }

  console.log("\nno secrets in the audit trail");
  {
    const rows = await db.collection("otp_audit").get();
    let leaks = 0;
    rows.forEach((doc) => {
      const text = JSON.stringify(doc.data());
      if (/98765000\d\d/.test(text)) leaks++;
      if (/"otp"\s*:/.test(text)) leaks++;
    });
    check(`no phone numbers or codes in ${rows.size} audit rows`, leaks === 0, `${leaks} leaks`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
