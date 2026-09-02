/**
 * CutQ customer authentication.
 *
 * Replaces Firebase Phone Auth with our own OTP flow:
 *   authRequestOtp     reserve quota in one transaction, then send the OTP via the
 *                      Fast2SMS DLT route (sender CTQPRV, approved template 224379).
 *   authVerifyOtp      verify in one transaction, resolve or create the Auth user by
 *                      phone number (existing users keep their UID), ensure Users/{uid},
 *                      return a Firebase custom token.
 *   authDeleteAccount  verify a delete-purpose OTP, then remove the account server-side.
 *   authOtpWatchdog    every 15 min: Fast2SMS wallet, counters, breaker, alert email.
 *
 * Billing safety — four independent bounds, none of them client-controlled:
 *   1. Global hour/day counters incremented in the SAME transaction that creates the
 *      session. Nothing is sent without a successful reservation, and failed sends are
 *      never refunded (a provider outage can never be farmed for free quota).
 *   2. Circuit breaker + kill switch (auth_config/otp.sends_enabled).
 *   3. Per-phone / per-install / per-IP quotas plus a zero-I/O in-memory bucket.
 *   4. The Fast2SMS wallet is prepaid with auto-recharge off.
 *
 * The OTP is never stored, logged (outside the emulator) or returned. It is DERIVED from
 * OTP_HMAC_SECRET plus a per-session random nonce, so a resend can re-send the identical
 * code without keeping any recoverable copy of it.
 *
 * App Check is not enabled yet. Every hook is in place: set auth_config/otp.appcheck_mode
 * to "soft" or "enforce" and flip enforceAppCheck/consumeAppCheckToken in CALLABLE_OPTS
 * once the client SDKs ship a provider. See APP_CHECK_NOTES at the bottom of this file.
 */
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {Timestamp, FieldValue} = require("firebase-admin/firestore");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const {
  SMTP_USER,
  SMTP_PASS,
  FAST2SMS_API_KEY,
  OTP_HMAC_SECRET,
  OTP_HASH_PEPPER,
} = require("./secrets");

const {
  PHONE_RE,
  TEN_DIGITS,
  OTP_RE,
  INSTALL_RE,
  PLATFORMS,
  SESSION_MAX_ATTEMPTS,
  SESSION_TTL_SEC,
  RESEND_REUSE_MIN_LEFT_SEC,
  MSG,
  mergeLimits,
  hmacHex,
  secretVersion,
  deriveOtp,
  timingSafeDigitsEqual,
  clientIpKey,
  toMs,
  trimWindow,
  retryIn,
  istKeys,
  evaluateActorLimits,
  evaluateNewPhonePerInstall,
} = require("./otpcore");

if (!admin.apps.length) admin.initializeApp();

// ── configuration ─────────────────────────────────────────────────────────────

// Same region as every other function in this codebase.
const AUTH_REGION = "us-central1";

const CALLABLE_OPTS = {
  region: AUTH_REGION,
  secrets: [FAST2SMS_API_KEY, OTP_HMAC_SECRET, OTP_HASH_PEPPER],
  memory: "256MiB",
  concurrency: 20,
  // 2 instances x 20 concurrent = at most 40 requests in flight. Bounds compute spend
  // and Firestore lock contention on the single global counter documents.
  maxInstances: 2,
  minInstances: 0,
  timeoutSeconds: 20,
  // Flip both to true when App Check ships on the clients (see APP_CHECK_NOTES).
  enforceAppCheck: false,
  consumeAppCheckToken: false,
};

// Fast2SMS DLT constants. Server-side only — never accepted from the client, so no bug
// can fall back to the non-DLT "quick" route which costs ~20x more per message.
const F2S_URL = "https://www.fast2sms.com/dev/bulkV2";
const F2S_WALLET_URL = "https://www.fast2sms.com/dev/wallet";
const F2S_ROUTE = "dlt";
const F2S_SENDER_ID = "CTQPRV";
const F2S_MESSAGE_ID = "224379";

// Fast2SMS status codes that mean the ACCOUNT is broken (bad/disabled key, blacklisted
// sender or template, empty wallet, KYC). Retrying wastes money and time, so the first
// one opens the breaker until a human clears it.
const F2S_ACCOUNT_LEVEL = new Set([406, 409, 412, 413, 414, 415, 416, 424, 425, 500, 996, 998, 999]);

// Not configurable — protocol constants.
const PROVIDER_FAILS_1H_TRIP = 10;
const PROVIDER_FAIL_CIRCUIT_SEC = 1800;
const PROVIDER_ACCOUNT_CIRCUIT_SEC = 6 * 3600;
const AUTO_BLOCKLIST_SEC = 7 * 86400;
const MAX_BREAKER_SEC = 3600; // a quota trip re-evaluates within the hour // provider said the number is invalid; re-test after a week // wallet empty / bad key / blacklisted template
const PROVIDER_TIMEOUT_MS = 8000;
const INSTANCE_BUCKET_PER_MIN = 30;
const AUDIT_TTL_DAYS = 90;
const COUNTER_TTL_DAYS = 30;
const SESSION_TTL_HOURS = 24;
const CONFIG_CACHE_MS = 60000;
const REJECT_AUDIT_SAMPLE = 20; // 1-in-N rejections written to otp_audit

// ── small helpers ─────────────────────────────────────────────────────────────

function fail(code, prefix, message, details) {
  return new HttpsError(code, `${prefix}: ${message}`, Object.assign({code: prefix}, details || {}));
}

const tsFrom = (ms) => Timestamp.fromMillis(ms);

// ── config (cached per instance) ──────────────────────────────────────────────

let configCache = {at: 0, value: null};

async function loadConfig(db) {
  const now = Date.now();
  if (configCache.value && now - configCache.at < CONFIG_CACHE_MS) return configCache.value;
  let raw = {};
  try {
    const snap = await db.doc("auth_config/otp").get();
    if (snap.exists) raw = snap.data() || {};
  } catch (err) {
    logger.error({event: "OTP_CONFIG_READ_FAILED", message: err.message});
    if (configCache.value) return configCache.value; // keep serving on a transient blip
    // No cache yet: this is a cold instance that has never seen the config. Falling back
    // to defaults would quietly ignore a kill switch or a lowered limit an operator set
    // during an incident, so refuse instead — sends stay stopped until Firestore answers.
    throw fail("unavailable", "OTP_SERVICE_BUSY", MSG.serviceBusy, {retryAfterSec: 30});
  }
  const limits = mergeLimits(raw.limits);
  const value = {
    sends_enabled: raw.sends_enabled !== false,
    appcheck_mode: ["off", "soft", "enforce"].includes(raw.appcheck_mode) ? raw.appcheck_mode : "off",
    wallet_min_inr: Number.isFinite(Number(raw.wallet_min_inr)) ? Number(raw.wallet_min_inr) : 500,
    alert_emails: Array.isArray(raw.alert_emails) ? raw.alert_emails.filter((e) => typeof e === "string") : [],
    limits,
  };
  configCache = {at: now, value};
  return value;
}

// ── in-memory burst bucket (zero Firestore I/O) ───────────────────────────────

const memBuckets = new Map();

function memBucketAllow(keys) {
  const now = Date.now();
  if (memBuckets.size > 5000) memBuckets.clear(); // bounded memory; worst case re-fills
  for (const key of keys) {
    if (!key) continue;
    const entry = memBuckets.get(key);
    if (!entry || now - entry.since >= 60000) {
      memBuckets.set(key, {since: now, count: 1});
      continue;
    }
    entry.count += 1;
    if (entry.count > INSTANCE_BUCKET_PER_MIN) return false;
  }
  return true;
}

// ── App Check (wired but disabled until the clients ship a provider) ──────────

const ALLOWED_APP_IDS = new Set([
  "1:1085189600336:android:80e406b86ccbb072b60d55", // customer Android
  "1:1085189600336:ios:0e269635b852207cb60d55", // customer iOS
]);

/**
 * Returns true when the caller presented a valid App Check token.
 * mode "off"     — skipped entirely (current state; App Check not set up yet).
 * mode "soft"    — unverified callers allowed but throttled harder by the caller.
 * mode "enforce" — unverified callers rejected.
 */
function checkAppCheck(request, mode) {
  if (mode === "off") return true;
  const app = request.app;
  if (!app) {
    if (mode === "enforce") throw fail("unauthenticated", "APPCHECK_REQUIRED", MSG.appCheck);
    return false;
  }
  if (app.alreadyConsumed === true) throw fail("permission-denied", "APPCHECK_REPLAY", MSG.appCheck);
  if (ALLOWED_APP_IDS.size && !ALLOWED_APP_IDS.has(app.appId)) {
    throw fail("permission-denied", "APP_NOT_ALLOWED", MSG.appCheck);
  }
  return true;
}

// ── audit ─────────────────────────────────────────────────────────────────────

/**
 * Writes one audit row. Identifiers are hashed; the OTP, the full phone number, the raw
 * IP, the raw installation id, the API key and the custom token are NEVER written here
 * or logged anywhere.
 */
async function audit(db, event) {
  try {
    const now = Date.now();
    await db.collection("otp_audit").add(Object.assign({}, event, {
      ts: tsFrom(now),
      ttl_at: tsFrom(now + AUDIT_TTL_DAYS * 86400000),
    }));
  } catch (err) {
    logger.error({event: "OTP_AUDIT_WRITE_FAILED", message: err.message});
  }
}

function baseAuditFields(ctx) {
  return {
    fn: ctx.fn,
    purpose: ctx.purpose || null,
    phone_h: ctx.phoneH || null,
    phone_tail: ctx.phoneTail || null,
    ip_h: ctx.ipH || null,
    install_h: ctx.installH || null,
    platform: ctx.platform || null,
    app_version: ctx.appVersion || null,
    // null while App Check is off, so an audit row never implies an attestation that
    // was never performed.
    app_verified: ctx.appVerified === true ? true : null,
  };
}

function toHttpsError(limit) {
  return fail(limit.httpsCode, limit.prefix, limit.message,
    limit.retryAfterSec ? {retryAfterSec: limit.retryAfterSec} : undefined);
}

// ── Fast2SMS ──────────────────────────────────────────────────────────────────

/**
 * Sends one OTP. Never retries: Fast2SMS has no idempotency key, so a retry after a
 * timeout could bill twice. Returns {kind: "ok"|"timeout"|"fail", ...}.
 */
async function sendViaFast2Sms(apiKey, phone, otp, udf1) {
  // Defence in depth: a malformed variables_values would either fail DLT validation or
  // deliver a broken message, and the route must never be anything but "dlt".
  if (!OTP_RE.test(otp) || !TEN_DIGITS.test(phone)) {
    return {kind: "fail", statusCode: -2, http: 0, message: "bad send arguments"};
  }
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return {kind: "ok", requestId: "emulator", amountDebited: null};
  }
  try {
    const res = await fetch(F2S_URL, {
      method: "POST",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {"authorization": apiKey, "content-type": "application/json"},
      body: JSON.stringify({
        route: F2S_ROUTE,
        sender_id: F2S_SENDER_ID,
        message: F2S_MESSAGE_ID,
        variables_values: `${otp}|${phone}`,
        numbers: phone,
        sms_details: "1",
        udf1: udf1,
      }),
    });
    let body = {};
    try {
      body = await res.json();
    } catch (err) {
      body = {};
    }
    if (res.ok && (body.return === true || body.return === "true")) {
      const detail = Array.isArray(body.sms_details) ? body.sms_details[0] : (body.sms_details || body);
      const amount = Number(detail && detail.amount_debited);
      return {
        kind: "ok",
        requestId: String(body.request_id || ""),
        amountDebited: Number.isFinite(amount) ? amount : null,
      };
    }
    return {
      kind: "fail",
      http: res.status,
      statusCode: Number(body.status_code) || null,
      message: String(body.message || "").slice(0, 200),
    };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return {kind: "timeout"};
    return {kind: "fail", http: 0, statusCode: null, message: String(err.message || "").slice(0, 200)};
  }
}

async function fetchWallet(apiKey) {
  const res = await fetch(F2S_WALLET_URL, {
    method: "POST",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: {"authorization": apiKey, "content-type": "application/json"},
    body: JSON.stringify({}),
  });
  const body = await res.json();
  const ok = res.ok && (body.return === true || body.return === "true");
  const balanceInr = Number(body.wallet);
  // Fast2SMS answers 200 with {"return":false,...} for a disabled key, incomplete KYC or
  // an unfunded wallet. Throwing here routes those into the failure path instead of
  // writing NaN and silently clearing the failure counter.
  if (!ok || !Number.isFinite(balanceInr)) {
    const err = new Error(`wallet check rejected (status_code ${body.status_code || "?"}: ${String(body.message || "").slice(0, 120)})`);
    err.providerStatusCode = body.status_code || null;
    throw err;
  }
  return {balanceInr, smsCount: Number(body.sms_count), ok};
}

async function bumpProviderFail(db, hourRef, breakerRef, reason, nowMs) {
  try {
    await db.runTransaction(async (tx) => {
      const [hourSnap, breakerSnap] = await tx.getAll(hourRef, breakerRef);
      const fails = (hourSnap.exists ? Number(hourSnap.data().provider_fail) || 0 : 0) + 1;
      tx.set(hourRef, {provider_fail: FieldValue.increment(1)}, {merge: true});
      const open = breakerSnap.exists ? toMs(breakerSnap.data().circuit_open_until) : 0;
      if (fails >= PROVIDER_FAILS_1H_TRIP && open <= nowMs) {
        tx.set(breakerRef, {
          circuit_open_until: tsFrom(nowMs + PROVIDER_FAIL_CIRCUIT_SEC * 1000),
          circuit_reason: `PROVIDER_FAILS_${reason}`,
          circuit_opened_at: tsFrom(nowMs),
        }, {merge: true});
        logger.error({event: "OTP_CIRCUIT_OPEN", reason: `PROVIDER_FAILS_${reason}`, fails});
      }
    });
  } catch (err) {
    logger.error({event: "OTP_PROVIDER_FAIL_BUMP_ERROR", message: err.message});
  }
}

// ── authRequestOtp ────────────────────────────────────────────────────────────

exports.authRequestOtp = onCall(CALLABLE_OPTS, async (request) => {
  const startedAt = Date.now();
  const db = admin.firestore();
  const data = request.data || {};

  // 1. Shape validation — no I/O, so malformed floods cost nothing.
  const purpose = data.purpose === "delete" ? "delete" : "login";
  if (data.purpose !== "login" && data.purpose !== "delete") {
    throw fail("invalid-argument", "OTP_BAD_ARGUMENT", MSG.badArgument);
  }
  const installId = String(data.installId || "");
  if (!INSTALL_RE.test(installId)) throw fail("invalid-argument", "OTP_BAD_ARGUMENT", MSG.badArgument);
  const platform = String(data.platform || "");
  if (!PLATFORMS.has(platform)) throw fail("invalid-argument", "OTP_BAD_ARGUMENT", MSG.badArgument);
  const appVersion = Number(data.appVersion);
  if (!Number.isInteger(appVersion) || appVersion < 1 || appVersion > 1000000) {
    throw fail("invalid-argument", "OTP_BAD_ARGUMENT", MSG.badArgument);
  }
  if (purpose === "delete" && !request.auth) {
    throw fail("unauthenticated", "AUTH_REQUIRED", MSG.authRequired);
  }

  const cfg = await loadConfig(db);
  const appVerified = checkAppCheck(request, cfg.appcheck_mode);
  const softMode = cfg.appcheck_mode === "soft" && !appVerified;

  const pepper = OTP_HASH_PEPPER.value();
  const hmacKey = OTP_HMAC_SECRET.value();
  const ipKey = clientIpKey(request.rawRequest);
  const ipH = ipKey ? hmacHex(pepper, "ip", ipKey).slice(0, 32) : null;
  const installH = hmacHex(pepper, "install", installId).slice(0, 32);

  // 2. Per-instance burst bucket — rejects hot loops before any Firestore read.
  if (!memBucketAllow([`i:${installH}`, ipH ? `p:${ipH}` : null])) {
    throw fail("resource-exhausted", "OTP_RATE_LIMITED", MSG.rateLimited, {retryAfterSec: 60});
  }

  if (!cfg.sends_enabled) throw fail("failed-precondition", "OTP_DISABLED", MSG.serviceBusy);

  // 3. Resolve the phone number. For deletion it comes from the Auth record, never from
  //    the request body, so a signed-in user can only ever delete their own account.
  let phone;
  let callerUid = null;
  if (purpose === "delete") {
    callerUid = request.auth.uid;
    let authUser;
    try {
      authUser = await admin.auth().getUser(callerUid);
    } catch (err) {
      throw fail("unauthenticated", "AUTH_REQUIRED", MSG.authRequired);
    }
    phone = String(authUser.phoneNumber || "").replace(/^\+91/, "");
    if (!TEN_DIGITS.test(phone)) throw fail("failed-precondition", "DELETE_NO_PHONE", MSG.deleteNoPhone);
  } else {
    phone = String(data.phone || "").trim();
    if (!TEN_DIGITS.test(phone)) throw fail("invalid-argument", "OTP_INVALID_PHONE", MSG.invalidPhone);
  }

  const phoneH = hmacHex(pepper, "phone", phone).slice(0, 24);
  const phoneTail = `**${phone.slice(-2)}`;
  const ctx = {fn: "authRequestOtp", purpose, phoneH, phoneTail, ipH, installH, platform, appVersion, appVerified};
  const nowMs = Date.now();

  const phoneRef = db.doc(`otp_phones/${phone}`);
  const installRef = db.doc(`otp_installs/${installH}`);
  const ipRef = ipH ? db.doc(`otp_ips/${ipH}`) : null;
  const sessionRef = db.doc(`otp_sessions/${phone}`);
  const blockRef = db.doc(`otp_blocklist/${phone}`);
  const testRef = db.doc(`otp_test_numbers/${phone}`);

  // 4. One batched read for everything the cheap checks need.
  const preRefs = [blockRef, testRef, phoneRef, installRef].concat(ipRef ? [ipRef] : []);
  const preSnaps = await db.getAll(...preRefs);
  const blockSnap = preSnaps[0];
  const testSnap = preSnaps[1];
  const prePhone = preSnaps[2].data() || {};
  const preInstall = preSnaps[3].data() || {};
  const preIp = ipRef ? (preSnaps[4].data() || {}) : null;

  const testData = testSnap.exists ? testSnap.data() : null;
  const isTest = !!(testData && testData.enabled === true && OTP_RE.test(String(testData.otp || "")) &&
    toMs(testData.expires_at) > nowMs);

  // Blocked numbers get the ordinary "limit" wording so the list cannot be probed.
  const blockData = blockSnap.exists ? (blockSnap.data() || {}) : null;
  const blockActive = !!blockData &&
    (!blockData.expires_at || toMs(blockData.expires_at) > nowMs);
  if (blockActive) {
    await auditReject(db, ctx, "OTP_PHONE_BLOCKED", false);
    throw fail("permission-denied", "OTP_PHONE_LIMIT", MSG.phoneLimit);
  }
  if (!isTest && !PHONE_RE.test(phone)) {
    throw fail("invalid-argument", "OTP_INVALID_PHONE", MSG.invalidPhone);
  }

  const preLimit = evaluateActorLimits({
    phoneDoc: prePhone, installDoc: preInstall, ipDoc: preIp,
    limits: cfg.limits, nowMs, isTest, phoneH, softMode,
  });
  if (preLimit) {
    await auditReject(db, ctx, preLimit.prefix, false);
    throw toHttpsError(preLimit);
  }

  // 5. Refuse accounts that must not sign in BEFORE spending an SMS. Staff and admin
  //    accounts are deliberately unreachable through the phone factor.
  const e164 = `+91${phone}`;
  let authUser = null;
  try {
    authUser = await admin.auth().getUserByPhoneNumber(e164);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }
  if (authUser) {
    if (authUser.disabled) throw fail("permission-denied", "ACCOUNT_DISABLED", MSG.accountDisabled);
    const userSnap = await db.doc(`Users/${authUser.uid}`).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      if (u.isEnabled === false) throw fail("permission-denied", "ACCOUNT_DISABLED", MSG.accountDisabled);
      if (u.Role && u.Role !== "USER") {
        await auditReject(db, ctx, "ACCOUNT_NOT_CUSTOMER", true);
        throw fail("permission-denied", "ACCOUNT_NOT_CUSTOMER", MSG.accountDisabled);
      }
    }
  }
  if (purpose === "delete" && (!authUser || authUser.uid !== callerUid)) {
    throw fail("permission-denied", "PHONE_MISMATCH", MSG.accountDisabled);
  }
  const isNewPhone = !authUser && !isTest;

  // 6. The reservation. Every counter is read and written inside one transaction, so
  //    concurrent requests cannot both slip past the same limit.
  const {hourKey, dayKey, endOfHour, endOfDay} = istKeys(nowMs);
  const breakerRef = db.doc("otp_global/breaker");
  const hourRef = db.doc(`otp_global/${hourKey}`);
  const dayRef = db.doc(`otp_global/${dayKey}`);
  const sendAttemptId = crypto.randomBytes(8).toString("hex");
  const version = secretVersion(hmacKey);

  let outcome = null;
  try {
    await db.runTransaction(async (tx) => {
      const refs = [breakerRef, phoneRef, installRef, sessionRef, hourRef, dayRef].concat(ipRef ? [ipRef] : []);
      const snaps = await tx.getAll(...refs);
      const breaker = snaps[0].data() || {};
      const phoneDoc = snaps[1].data() || {};
      const installDoc = snaps[2].data() || {};
      const session = snaps[3].exists ? snaps[3].data() : null;
      const hourDoc = snaps[4].data() || {};
      const dayDoc = snaps[5].data() || {};
      const ipDoc = ipRef ? (snaps[6].data() || {}) : null;

      const openUntil = toMs(breaker.circuit_open_until);
      if (openUntil > nowMs && !isTest) {
        outcome = {reject: {
          httpsCode: "unavailable", prefix: "OTP_SERVICE_BUSY", message: MSG.serviceBusy,
          retryAfterSec: retryIn(openUntil, nowMs),
        }};
        return;
      }

      const limit = evaluateActorLimits({
        phoneDoc, installDoc, ipDoc, limits: cfg.limits, nowMs, isTest, phoneH, softMode,
      });
      if (limit) {
        outcome = {reject: limit};
        return;
      }

      if (isNewPhone) {
        const perInstall = evaluateNewPhonePerInstall(installDoc, cfg.limits, nowMs, phoneH);
        if (perInstall) {
          outcome = {reject: perInstall};
          return;
        }
        const newBlock = toMs(breaker.new_phones_block_until);
        if (newBlock > nowMs) {
          outcome = {reject: {
            httpsCode: "unavailable", prefix: "OTP_SERVICE_BUSY", message: MSG.serviceBusy,
            retryAfterSec: retryIn(newBlock, nowMs),
          }};
          return;
        }
      }

      // Global caps — the bill bound. Tripping writes the breaker inside this same
      // transaction so a burst cannot slip several sends past the cap.
      if (!isTest) {
        // The counter itself is the bill bound; the breaker only exists to stop us
        // re-reading it under load. Capping how long it stays shut means an operator who
        // raises the limit sees sign-in recover within the hour instead of at IST midnight.
        const trip = (reason, rawUntilMs, field) => {
          const untilMs = Math.min(rawUntilMs, nowMs + MAX_BREAKER_SEC * 1000);
          tx.set(breakerRef, Object.assign({
            circuit_reason: reason,
            circuit_opened_at: tsFrom(nowMs),
          }, field === "new_phones" ?
            {new_phones_block_until: tsFrom(untilMs)} :
            {circuit_open_until: tsFrom(untilMs)}), {merge: true});
          outcome = {
            reject: {
              httpsCode: "unavailable", prefix: "OTP_SERVICE_BUSY", message: MSG.serviceBusy,
              retryAfterSec: retryIn(untilMs, nowMs),
            },
            tripped: reason,
          };
        };
        if (softMode && (Number(hourDoc.unverified) || 0) >= cfg.limits.unverified_1h) {
          outcome = {reject: {
            httpsCode: "unavailable", prefix: "OTP_SERVICE_BUSY", message: MSG.serviceBusy,
            retryAfterSec: retryIn(endOfHour, nowMs),
          }};
          return;
        }
        if ((Number(hourDoc.sends) || 0) >= cfg.limits.global_1h) return trip("GLOBAL_1H", endOfHour, "all");
        if ((Number(dayDoc.sends) || 0) >= cfg.limits.global_24h) return trip("GLOBAL_24H", endOfDay, "all");
        if (isNewPhone && (Number(hourDoc.new_phones) || 0) >= cfg.limits.new_phones_1h) {
          return trip("NEW_PHONES_1H", endOfHour, "new_phones");
        }
        if (isNewPhone && (Number(dayDoc.new_phones) || 0) >= cfg.limits.new_phones_24h) {
          return trip("NEW_PHONES_24H", endOfDay, "new_phones");
        }
      }

      // Reuse a still-valid code on resend: the user is never left wondering which of two
      // codes is the live one, and the attempt budget is not reset by resending.
      const reusable = !!session &&
        session.status !== "send_failed" &&
        session.consumed !== true &&
        session.purpose === purpose &&
        (session.uid_for_delete || null) === callerUid &&
        session.secret_version === version &&
        !!session.is_test === isTest &&
        Number(session.attempts || 0) < SESSION_MAX_ATTEMPTS &&
        toMs(session.expires_at) - nowMs >= RESEND_REUSE_MIN_LEFT_SEC * 1000;

      const nonce = reusable ? session.nonce : crypto.randomBytes(16).toString("hex");
      const expiresAtMs = reusable ? toMs(session.expires_at) : nowMs + SESSION_TTL_SEC * 1000;
      const attempts = reusable ? Number(session.attempts || 0) : 0;
      const sends = reusable ? Number(session.sends || 1) + 1 : 1;
      const otp = isTest ? String(testData.otp) : deriveOtp(hmacKey, phone, purpose, nonce);

      tx.set(sessionRef, {
        phone,
        purpose,
        uid_for_delete: callerUid,
        is_test: isTest,
        status: "pending",
        consumed: false,
        nonce,
        secret_version: version,
        attempts,
        sends,
        send_attempt_id: sendAttemptId,
        created_at: reusable && session.created_at ? session.created_at : tsFrom(nowMs),
        last_sent_at: tsFrom(nowMs),
        expires_at: tsFrom(expiresAtMs),
        install_h: installH,
        ip_h: ipH,
        platform,
        app_version: appVersion,
        provider_request_id: reusable ? (session.provider_request_id || null) : null,
        ttl_at: tsFrom(nowMs + SESSION_TTL_HOURS * 3600000),
      });

      const counterTtl = tsFrom(nowMs + COUNTER_TTL_DAYS * 86400000);
      const sends24 = trimWindow(phoneDoc.send_times, nowMs, 86400);
      // Track consecutive sessions that were never verified. A resend of the same code is
      // not a new session, so it does not count; a verified session resets the run to 0.
      const priorStreak = Number(phoneDoc.unverified_streak) || 0;
      // Only a code that actually went out counts. A session left in "send_failed"
      // means the provider failed, which must never lock the user out of their own
      // number for the anti-bombing cooldown.
      const previouslyDelivered = !!session && session.status !== "send_failed";
      const unverifiedStreak = reusable || !previouslyDelivered ? priorStreak :
        (session.status === "verified" ? 0 : priorStreak + 1);
      tx.set(phoneRef, {
        unverified_streak: unverifiedStreak,
        send_times: sends24.concat([nowMs]),
        last_send_at: tsFrom(nowMs),
        first_seen_at: phoneDoc.first_seen_at || tsFrom(nowMs),
        total_sends: FieldValue.increment(1),
        verify_times: trimWindow(phoneDoc.verify_times, nowMs, 3600),
        is_test: isTest,
        ttl_at: counterTtl,
      }, {merge: true});

      const distinct = (Array.isArray(installDoc.phones_24h) ? installDoc.phones_24h : [])
        .filter((e) => e && toMs(e.t) > nowMs - 86400000 && e.p !== phoneH);
      const installPatch = {
        send_times: trimWindow(installDoc.send_times, nowMs, 86400).concat([nowMs]),
        phones_24h: distinct.concat([{p: phoneH, t: tsFrom(nowMs)}]),
        ttl_at: counterTtl,
      };
      if (isNewPhone) {
        const newList = (Array.isArray(installDoc.new_phones_24h) ? installDoc.new_phones_24h : [])
          .filter((e) => e && toMs(e.t) > nowMs - 86400000 && e.p !== phoneH);
        installPatch.new_phones_24h = newList.concat([{p: phoneH, t: tsFrom(nowMs)}]);
      }
      tx.set(installRef, installPatch, {merge: true});

      if (ipRef) {
        tx.set(ipRef, {
          send_times: trimWindow(ipDoc.send_times, nowMs, 86400).concat([nowMs]),
          ttl_at: counterTtl,
        }, {merge: true});
      }

      if (!isTest) {
        const inc = FieldValue.increment(1);
        const zero = FieldValue.increment(0);
        tx.set(hourRef, {
          sends: inc,
          new_phones: isNewPhone ? inc : zero,
          unverified: softMode ? inc : zero,
          window_end: tsFrom(endOfHour),
          ttl_at: counterTtl,
        }, {merge: true});
        tx.set(dayRef, {
          sends: inc,
          new_phones: isNewPhone ? inc : zero,
          window_end: tsFrom(endOfDay),
          ttl_at: counterTtl,
        }, {merge: true});
      }

      const ladder = cfg.limits.cooldown_ladder_sec;
      const recent10 = sends24.filter((t) => t > nowMs - 600000);
      outcome = {
        ok: true,
        otp,
        reused: reusable,
        resendAfterSec: ladder[Math.min(recent10.length, ladder.length - 1)],
        expiresInSec: Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000)),
      };
    });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (/contention|ABORTED|deadline/i.test(String(err.message))) {
      throw fail("resource-exhausted", "OTP_COOLDOWN", MSG.cooldown, {retryAfterSec: 5});
    }
    logger.error({event: "OTP_REQUEST_TX_FAILED", message: String(err && err.message), phone_h: phoneH});
    throw fail("internal", "INTERNAL", MSG.internal);
  }

  if (!outcome) throw fail("internal", "INTERNAL", MSG.internal);
  if (outcome.reject) {
    if (outcome.tripped) {
      logger.error({event: "OTP_CIRCUIT_OPEN", reason: outcome.tripped, phone_h: phoneH});
    }
    await auditReject(db, ctx, outcome.reject.prefix, !!outcome.tripped, outcome.tripped);
    throw toHttpsError(outcome.reject);
  }

  const reply = {
    resendAfterSec: outcome.resendAfterSec,
    expiresInSec: outcome.expiresInSec,
    attemptsAllowed: SESSION_MAX_ATTEMPTS,
    deliveredVia: isTest ? "test" : "sms",
    maskedPhone: `+91 ${phone.slice(0, 2)}XXXXXX${phone.slice(-2)}`,
    sentAtMs: Date.now(),
  };

  if (isTest) {
    await finishSession(sessionRef, sendAttemptId, {status: "sent"});
    await audit(db, Object.assign(baseAuditFields(ctx), {event: "send", is_test: true, reused: outcome.reused}));
    return reply;
  }

  if (process.env.FUNCTIONS_EMULATOR === "true") {
    logger.info({event: "OTP_DRY_RUN", phone_tail: phoneTail, otp: outcome.otp});
  }

  // 7. Provider call happens OUTSIDE the transaction (no network inside a transaction).
  const result = await sendViaFast2Sms(FAST2SMS_API_KEY.value(), phone, outcome.otp, sendAttemptId);
  const latencyMs = Date.now() - startedAt;

  if (result.kind === "ok") {
    await finishSession(sessionRef, sendAttemptId, {
      status: "sent",
      provider_request_id: result.requestId || null,
      amount_debited: result.amountDebited,
    });
    await audit(db, Object.assign(baseAuditFields(ctx), {
      event: "send",
      reused: outcome.reused,
      is_new_user: isNewPhone,
      provider_request_id: result.requestId || null,
      amount_debited: result.amountDebited,
      latency_ms: latencyMs,
    }));
    return reply;
  }

  if (result.kind === "timeout") {
    // Delivery is unknown. Keep the session live so a code that did arrive still works,
    // and let the user resend after the cooldown.
    await finishSession(sessionRef, sendAttemptId, {status: "sent_unconfirmed"});
    await bumpProviderFail(db, hourRef, breakerRef, "timeout", nowMs);
    await audit(db, Object.assign(baseAuditFields(ctx), {event: "send_unconfirmed", latency_ms: latencyMs}));
    return reply;
  }

  // A failed RESEND of an identical code must not destroy the code already sitting in the
  // user's inbox. That earlier message was delivered and the session is still verifiable;
  // marking it send_failed would make verifySessionTx reject the very code the 995 branch
  // below tells the user to keep using.
  if (outcome.reused) {
    await finishSession(sessionRef, sendAttemptId, {provider_status_code: result.statusCode || null});
  } else {
    await finishSession(sessionRef, sendAttemptId,
      {status: "send_failed", provider_status_code: result.statusCode || null});
  }
  await audit(db, Object.assign(baseAuditFields(ctx), {
    event: "send_fail",
    reused: outcome.reused,
    provider_status_code: result.statusCode || null,
    http: result.http || null,
    latency_ms: latencyMs,
  }));

  if (F2S_ACCOUNT_LEVEL.has(result.statusCode)) {
    // Wrong key, empty wallet, blacklisted template… stop everything until a human looks.
    // Bounded, not permanent: recharging the wallet or fixing the key must restore
    // sign-in on its own. The watchdog closes it sooner once the account looks healthy,
    // and alerts every hour until then.
    await breakerRef.set({
      circuit_open_until: tsFrom(nowMs + PROVIDER_ACCOUNT_CIRCUIT_SEC * 1000),
      circuit_reason: `PROVIDER_${result.statusCode}`,
      circuit_opened_at: tsFrom(nowMs),
    }, {merge: true});
    logger.error({event: "OTP_CIRCUIT_OPEN", reason: `PROVIDER_${result.statusCode}`, message: result.message});
    // The provider account is broken, but a resend of a code the user already received is
    // still usable — tell them so rather than sending them to a dead end.
    if (outcome.reused) return Object.assign({}, reply, {deliveredVia: "previous"});
    throw fail("unavailable", "OTP_SERVICE_BUSY", MSG.serviceBusy);
  }
  if (result.statusCode === 411) {
    await markInvalidNumber(db, phoneRef, phone, nowMs);
    throw fail("invalid-argument", "OTP_INVALID_PHONE", MSG.invalidPhone);
  }
  if (result.statusCode === 995) {
    // Provider anti-spam. If we were re-sending an identical code, the earlier message is
    // still valid and the user should be told that instead of seeing an error.
    if (outcome.reused) {
      return Object.assign({}, reply, {deliveredVia: "previous"});
    }
    throw fail("resource-exhausted", "OTP_PHONE_LIMIT", MSG.phoneLimit, {retryAfterSec: 600});
  }
  await bumpProviderFail(db, hourRef, breakerRef, String(result.statusCode || result.http || "unknown"), nowMs);
  if (outcome.reused) return Object.assign({}, reply, {deliveredVia: "previous"});
  throw fail("internal", "OTP_PROVIDER_ERROR", MSG.providerError);
});

/**
 * Records the outcome of a send on its session.
 *
 * Runs after the SMS has already been sent and billed, so it must never throw: a Firestore
 * hiccup here would tell the user "something went wrong" about a code that is sitting in
 * their inbox and would verify perfectly well. It is also conditional on the attempt that
 * produced it, so a slow send can never stamp its result over a newer session.
 */
async function finishSession(sessionRef, sendAttemptId, patch) {
  try {
    await sessionRef.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(sessionRef);
      if (!snap.exists || snap.data().send_attempt_id !== sendAttemptId) return;
      // The user can verify faster than the provider replies. Never walk a verified or
      // exhausted session back to "sent"/"send_failed" — that would corrupt the record of
      // which code was actually consumed.
      if (snap.data().consumed === true) return;
      tx.update(sessionRef, patch);
    });
  } catch (err) {
    logger.error({event: "OTP_SESSION_FINALISE_FAILED", message: String(err && err.message)});
  }
}

async function auditReject(db, ctx, code, always, tripped) {
  if (!always && Math.random() * REJECT_AUDIT_SAMPLE >= 1) {
    logger.info({event: "otp_reject", code, phone_h: ctx.phoneH, install_h: ctx.installH, ip_h: ctx.ipH});
    return;
  }
  await audit(db, Object.assign(baseAuditFields(ctx), {event: "limit", code, tripped: tripped || null}));
}

async function markInvalidNumber(db, phoneRef, phone, nowMs) {
  try {
    const count = await db.runTransaction(async (tx) => {
      const snap = await tx.get(phoneRef);
      const next = (Number(snap.exists ? snap.data().invalid_count : 0) || 0) + 1;
      tx.set(phoneRef, {invalid_count: next, ttl_at: tsFrom(nowMs + COUNTER_TTL_DAYS * 86400000)}, {merge: true});
      return next;
    });
    if (count >= 3) {
      // Expires on its own: a number can be rejected by the provider for reasons that
      // later stop applying (ported number, carrier issue), and a permanent block would
      // also lock the owner out of deleting their own account.
      await db.doc(`otp_blocklist/${phone}`).set({
        reason: "PROVIDER_411_INVALID_NUMBER",
        created_at: tsFrom(nowMs),
        created_by: "authRequestOtp",
        expires_at: tsFrom(nowMs + AUTO_BLOCKLIST_SEC * 1000),
      }, {merge: true});
    }
  } catch (err) {
    logger.error({event: "OTP_INVALID_MARK_FAILED", message: err.message});
  }
}

// ── shared verification ───────────────────────────────────────────────────────

/**
 * Verifies an OTP and consumes the session, atomically.
 *
 * The compare and the attempt increment happen in the same transaction, so a crash can
 * neither lose nor grant an attempt, and the error is thrown only after the commit.
 *
 * The session is bound to the installation that requested it. Somebody else guessing at
 * a victim's session gets OTP_SESSION_NOT_FOUND without touching the victim's attempt
 * budget, and wrong-guess lockouts land on the guesser's own device rather than on the
 * victim's phone number.
 */
async function verifySessionTx(db, opts) {
  const {phone, otp, purpose, installH, callerUid, hmacKey, nowMs, limits} = opts;
  const sessionRef = db.doc(`otp_sessions/${phone}`);
  const phoneRef = db.doc(`otp_phones/${phone}`);
  const installRef = db.doc(`otp_installs/${installH}`);
  const testRef = db.doc(`otp_test_numbers/${phone}`);
  const {hourKey} = istKeys(nowMs);
  const hourRef = db.doc(`otp_global/${hourKey}`);
  const counterTtl = tsFrom(nowMs + COUNTER_TTL_DAYS * 86400000);

  let outcome = null;
  await db.runTransaction(async (tx) => {
    // Firestore requires every read to happen before any write, so the test-number
    // document is fetched up front even though only test sessions need it.
    const [sessionSnap, phoneSnap, installSnap, testSnap] =
      await tx.getAll(sessionRef, phoneRef, installRef, testRef);
    const session = sessionSnap.exists ? sessionSnap.data() : null;
    const phoneDoc = phoneSnap.data() || {};
    const installDoc = installSnap.data() || {};

    const lockedUntil = toMs(installDoc.locked_until);
    if (lockedUntil > nowMs) {
      outcome = {reject: {
        httpsCode: "permission-denied", prefix: "OTP_INSTALL_LOCKED", message: MSG.installLocked,
        retryAfterSec: retryIn(lockedUntil, nowMs),
      }};
      return;
    }

    const verifyCalls = trimWindow(phoneDoc.verify_times, nowMs, 3600);
    if (verifyCalls.length >= limits.phone_verify_calls_1h) {
      outcome = {reject: {
        httpsCode: "resource-exhausted", prefix: "OTP_TOO_MANY_VERIFY", message: MSG.tooManyVerify,
        retryAfterSec: retryIn(Math.min(...verifyCalls) + 3600000, nowMs),
      }};
      return;
    }

    const notFound = () => {
      outcome = {reject: {httpsCode: "not-found", prefix: "OTP_SESSION_NOT_FOUND", message: MSG.notFound}};
    };

    // No write at all for a missing or foreign session: probing random numbers must not
    // be able to make us write documents, and guessing against somebody else's session
    // must not consume their attempts.
    if (!session || session.purpose !== purpose || session.consumed === true ||
        session.status === "send_failed" || session.install_h !== installH) {
      return notFound();
    }
    if (purpose === "delete" && session.uid_for_delete !== callerUid) return notFound();

    // Every real attempt against a real session is counted. Collected into one patch so
    // the document is written exactly once per transaction.
    const phonePatch = {verify_times: verifyCalls.concat([nowMs]), ttl_at: counterTtl};

    if (toMs(session.expires_at) <= nowMs || session.secret_version !== secretVersion(hmacKey)) {
      tx.set(phoneRef, phonePatch, {merge: true});
      outcome = {reject: {httpsCode: "failed-precondition", prefix: "OTP_EXPIRED", message: MSG.expired}};
      return;
    }
    if (Number(session.attempts || 0) >= SESSION_MAX_ATTEMPTS) {
      tx.set(phoneRef, phonePatch, {merge: true});
      outcome = {reject: {
        httpsCode: "permission-denied", prefix: "OTP_TOO_MANY_ATTEMPTS", message: MSG.tooManyAttempts,
      }};
      return;
    }

    let expected = null;
    if (session.is_test) {
      const testData = testSnap.exists ? testSnap.data() : null;
      if (testData && testData.enabled === true && toMs(testData.expires_at) > nowMs &&
          OTP_RE.test(String(testData.otp || ""))) {
        expected = String(testData.otp);
      }
    } else {
      expected = deriveOtp(hmacKey, phone, purpose, session.nonce);
    }
    const attempts = Number(session.attempts || 0) + 1;

    if (expected && timingSafeDigitsEqual(expected, otp)) {
      tx.update(sessionRef, {
        consumed: true,
        status: "verified",
        verified_at: tsFrom(nowMs),
        attempts,
      });
      phonePatch.unverified_streak = 0;
      tx.set(phoneRef, phonePatch, {merge: true});
      tx.set(hourRef, {verify_ok: FieldValue.increment(1), ttl_at: counterTtl}, {merge: true});
      outcome = {
        ok: true,
        isTest: !!session.is_test,
        platform: session.platform || null,
        appVersion: session.app_version || null,
      };
      return;
    }

    const fails = trimWindow(installDoc.verify_fail_times, nowMs, 3600).concat([nowMs]);
    const lock = fails.length >= limits.install_verify_fails_1h;
    const exhausted = attempts >= SESSION_MAX_ATTEMPTS;
    tx.update(sessionRef, Object.assign({attempts},
      exhausted || lock ? {consumed: true, status: "exhausted"} : {}));
    tx.set(phoneRef, phonePatch, {merge: true});
    // Wrong guesses are counted against the guessing device, never the victim's number,
    // so nobody can lock someone else out of their own account.
    tx.set(installRef, Object.assign({verify_fail_times: fails, ttl_at: counterTtl},
      lock ? {locked_until: tsFrom(nowMs + limits.install_lock_sec * 1000)} : {}), {merge: true});
    tx.set(hourRef, {verify_fail: FieldValue.increment(1), ttl_at: counterTtl}, {merge: true});

    const left = SESSION_MAX_ATTEMPTS - attempts;
    if (lock) {
      outcome = {reject: {
        httpsCode: "permission-denied", prefix: "OTP_INSTALL_LOCKED", message: MSG.installLocked,
        retryAfterSec: limits.install_lock_sec,
      }};
    } else if (left <= 0) {
      outcome = {reject: {
        httpsCode: "permission-denied", prefix: "OTP_TOO_MANY_ATTEMPTS", message: MSG.tooManyAttempts,
      }};
    } else {
      outcome = {reject: {
        httpsCode: "invalid-argument", prefix: "OTP_INCORRECT",
        message: `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.`,
        attemptsLeft: left,
      }};
    }
  });

  if (!outcome) throw fail("internal", "INTERNAL", MSG.internal);
  if (outcome.reject) {
    const details = {};
    if (outcome.reject.retryAfterSec) details.retryAfterSec = outcome.reject.retryAfterSec;
    if (outcome.reject.attemptsLeft) details.attemptsLeft = outcome.reject.attemptsLeft;
    throw fail(outcome.reject.httpsCode, outcome.reject.prefix, outcome.reject.message, details);
  }
  return outcome;
}

// ── authVerifyOtp ─────────────────────────────────────────────────────────────

exports.authVerifyOtp = onCall(CALLABLE_OPTS, async (request) => {
  const db = admin.firestore();
  const data = request.data || {};
  const phone = String(data.phone || "").trim();
  const otp = String(data.otp || "").trim();
  const installId = String(data.installId || "");

  if (!TEN_DIGITS.test(phone)) throw fail("invalid-argument", "OTP_INVALID_PHONE", MSG.invalidPhone);
  if (!OTP_RE.test(otp)) throw fail("invalid-argument", "OTP_INCORRECT", "Enter the 6-digit code.");
  if (!INSTALL_RE.test(installId)) throw fail("invalid-argument", "OTP_BAD_ARGUMENT", MSG.badArgument);

  const cfg = await loadConfig(db);
  const appVerified = checkAppCheck(request, cfg.appcheck_mode);

  const pepper = OTP_HASH_PEPPER.value();
  const hmacKey = OTP_HMAC_SECRET.value();
  const installH = hmacHex(pepper, "install", installId).slice(0, 32);
  const ipKey = clientIpKey(request.rawRequest);
  const ipH = ipKey ? hmacHex(pepper, "ip", ipKey).slice(0, 32) : null;
  const phoneH = hmacHex(pepper, "phone", phone).slice(0, 24);
  const ctx = {fn: "authVerifyOtp", purpose: "login", phoneH, phoneTail: `**${phone.slice(-2)}`,
    ipH, installH, appVerified};

  if (!memBucketAllow([`i:${installH}`, ipH ? `p:${ipH}` : null])) {
    throw fail("resource-exhausted", "OTP_RATE_LIMITED", MSG.rateLimited, {retryAfterSec: 60});
  }

  const nowMs = Date.now();
  let verified;
  try {
    verified = await verifySessionTx(db, {
      phone, otp, purpose: "login", installH, callerUid: null, hmacKey, nowMs, limits: cfg.limits,
    });
  } catch (err) {
    if (err instanceof HttpsError) {
      const code = err.details && err.details.code ? err.details.code : "UNKNOWN";
      await auditReject(db, ctx, code, code === "OTP_INSTALL_LOCKED");
      throw err;
    }
    logger.error({event: "OTP_VERIFY_TX_FAILED", message: err.message, phone_h: phoneH});
    throw fail("internal", "INTERNAL", MSG.internal);
  }

  // The session is consumed before any account is touched, so a wrong guess can never
  // create a user.
  const e164 = `+91${phone}`;
  let user = null;
  let created = false;
  try {
    user = await admin.auth().getUserByPhoneNumber(e164);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    try {
      // Always created WITH the phone number so FirebaseUser.phoneNumber is populated
      // after signInWithCustomToken.
      user = await admin.auth().createUser({phoneNumber: e164});
      created = true;
    } catch (err2) {
      if (err2.code !== "auth/phone-number-already-exists") throw err2;
      user = await admin.auth().getUserByPhoneNumber(e164); // concurrent first sign-in
    }
  }
  if (user.disabled) throw fail("permission-denied", "ACCOUNT_DISABLED", MSG.accountDisabled);

  const userRef = db.doc(`Users/${user.uid}`);
  let profile;
  try {
    profile = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const stamp = {
        last_login_at: FieldValue.serverTimestamp(),
        last_platform: verified.platform,
        last_app_version: verified.appVersion,
        auth_provider: "cutq_otp",
      };
      if (!snap.exists) {
        tx.set(userRef, Object.assign({
          phone,
          name: "",
          email: "",
          profile_photo: "",
          Role: "USER",
          isEnabled: true,
          created_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
          created_by: "server",
        }, stamp));
        return {isNewUser: true, profileComplete: false};
      }
      const d = snap.data();
      if (d.isEnabled === false) throw fail("permission-denied", "ACCOUNT_DISABLED", MSG.accountDisabled);
      if (d.Role && d.Role !== "USER") throw fail("permission-denied", "ACCOUNT_NOT_CUSTOMER", MSG.accountDisabled);
      const patch = Object.assign({}, stamp);
      if (!d.phone) patch.phone = phone;
      tx.update(userRef, patch);
      return {isNewUser: false, profileComplete: !!(d.name && d.gender)};
    });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error({event: "OTP_USERS_DOC_FAILED", message: err.message, uid: user.uid});
    throw fail("internal", "INTERNAL", MSG.internal);
  }

  let customToken;
  try {
    // No developer claims: role/salon claims are managed by onSalonWrittenSyncClaims and
    // must not be settable from this path.
    customToken = await admin.auth().createCustomToken(user.uid);
  } catch (err) {
    if (err.code === "auth/insufficient-permission" || /iam|signBlob|token/i.test(String(err.message))) {
      logger.error({event: "CUSTOM_TOKEN_IAM_MISSING", message: err.message});
    } else {
      logger.error({event: "CUSTOM_TOKEN_FAILED", message: err.message});
    }
    throw fail("internal", "INTERNAL", MSG.internal);
  }

  await audit(db, Object.assign(baseAuditFields(ctx), {
    event: "verify_ok",
    uid: user.uid,
    is_new_user: profile.isNewUser,
    auth_user_created: created,
    is_test: verified.isTest,
  }));

  return {
    customToken,
    uid: user.uid,
    isNewUser: profile.isNewUser,
    profileComplete: profile.profileComplete,
    phone: e164,
  };
});

// ── authDeleteAccount ─────────────────────────────────────────────────────────

exports.authDeleteAccount = onCall(Object.assign({}, CALLABLE_OPTS, {timeoutSeconds: 30}), async (request) => {
  const db = admin.firestore();
  const data = request.data || {};
  if (!request.auth) throw fail("unauthenticated", "AUTH_REQUIRED", MSG.authRequired);
  const otp = String(data.otp || "").trim();
  const installId = String(data.installId || "");
  if (!OTP_RE.test(otp)) throw fail("invalid-argument", "OTP_INCORRECT", "Enter the 6-digit code.");
  if (!INSTALL_RE.test(installId)) throw fail("invalid-argument", "OTP_BAD_ARGUMENT", MSG.badArgument);

  const cfg = await loadConfig(db);
  checkAppCheck(request, cfg.appcheck_mode);

  const uid = request.auth.uid;
  const pepper = OTP_HASH_PEPPER.value();
  const hmacKey = OTP_HMAC_SECRET.value();
  const installH = hmacHex(pepper, "install", installId).slice(0, 32);

  let authUser;
  try {
    authUser = await admin.auth().getUser(uid);
  } catch (err) {
    throw fail("unauthenticated", "AUTH_REQUIRED", MSG.authRequired);
  }
  const phone = String(authUser.phoneNumber || "").replace(/^\+91/, "");
  if (!TEN_DIGITS.test(phone)) throw fail("failed-precondition", "DELETE_NO_PHONE", MSG.deleteNoPhone);

  await verifySessionTx(db, {
    phone, otp, purpose: "delete", installH, callerUid: uid, hmacKey,
    nowMs: Date.now(), limits: cfg.limits,
  });

  // Revoke first so other devices lose their refresh token immediately, then remove the
  // Firestore document (so a failure at the last step leaves a recoverable state), then
  // the Auth user itself.
  await admin.auth().revokeRefreshTokens(uid);
  try {
    await db.doc(`Users/${uid}`).delete();
  } catch (err) {
    logger.error({event: "DELETE_USERS_DOC_FAILED", uid, message: err.message});
  }
  await admin.auth().deleteUser(uid);
  try {
    await db.doc(`otp_sessions/${phone}`).delete();
  } catch (err) {
    logger.warn({event: "DELETE_SESSION_CLEANUP_FAILED", message: err.message});
  }

  await audit(db, {
    fn: "authDeleteAccount",
    event: "delete",
    purpose: "delete",
    uid,
    phone_h: hmacHex(pepper, "phone", phone).slice(0, 24),
    phone_tail: `**${phone.slice(-2)}`,
    install_h: installH,
  });

  return {deleted: true};
});

// ── authOtpWatchdog ───────────────────────────────────────────────────────────

exports.authOtpWatchdog = onSchedule({
  schedule: "every 15 minutes",
  timeZone: "Asia/Kolkata",
  region: AUTH_REGION,
  secrets: [FAST2SMS_API_KEY, SMTP_USER, SMTP_PASS],
  memory: "256MiB",
  timeoutSeconds: 60,
  maxInstances: 1,
}, async () => {
  const db = admin.firestore();
  const nowMs = Date.now();
  const cfg = await loadConfig(db);
  const {hourKey, dayKey} = istKeys(nowMs);
  const alerts = [];

  // 1. Wallet balance — the absolute loss bound. Alert before it runs dry.
  const walletRef = db.doc("otp_global/wallet");
  try {
    const wallet = await fetchWallet(FAST2SMS_API_KEY.value());
    await walletRef.set({
      balance_inr: wallet.balanceInr,
      sms_count: wallet.smsCount,
      checked_at: tsFrom(nowMs),
      consecutive_failures: 0,
    }, {merge: true});
    // If the breaker was opened by a provider fault (empty wallet, bad key) and the
    // account now answers healthily, close it immediately rather than making the operator
    // wait out the timer or clear the document by hand.
    // Gate recovery on the account being usable at all, not on the alert threshold:
    // topping up to less than wallet_min_inr must still bring sign-in back.
    if (wallet.balanceInr > 0) {
      const breakerSnap = await db.doc("otp_global/breaker").get();
      const b = breakerSnap.data() || {};
      if (toMs(b.circuit_open_until) > nowMs && String(b.circuit_reason || "").startsWith("PROVIDER_")) {
        await db.doc("otp_global/breaker").set({
          circuit_open_until: null,
          closed_by: "authOtpWatchdog",
          closed_at: tsFrom(nowMs),
        }, {merge: true});
        alerts.push({
          type: "CIRCUIT_CLOSED",
          text: `Fast2SMS is healthy again (Rs ${wallet.balanceInr}); the OTP circuit breaker ` +
            `opened by ${b.circuit_reason} has been closed automatically. Sign-in is working.`,
        });
      }
    }
    if (Number.isFinite(wallet.balanceInr) && wallet.balanceInr < cfg.wallet_min_inr) {
      alerts.push({
        type: "WALLET_LOW",
        text: `Fast2SMS wallet is down to Rs ${wallet.balanceInr} (${wallet.smsCount} SMS). ` +
          `Recharge before sign-ins start failing.`,
      });
    }
  } catch (err) {
    const snap = await walletRef.get();
    const failures = (Number(snap.exists ? snap.data().consecutive_failures : 0) || 0) + 1;
    await walletRef.set({consecutive_failures: failures, checked_at: tsFrom(nowMs)}, {merge: true});
    if (failures >= 3) {
      alerts.push({
        type: "WALLET_API_FAIL",
        text: `Fast2SMS wallet check has failed ${failures} times: ${err.message}. ` +
          `A rejected check usually means the API key, the KYC status or the balance is the problem — ` +
          `sign-in is probably failing for everyone.`,
      });
    }
  }

  // 2. Counters and breaker.
  const [hourSnap, daySnap, breakerSnap] = await db.getAll(
    db.doc(`otp_global/${hourKey}`), db.doc(`otp_global/${dayKey}`), db.doc("otp_global/breaker"));
  const hour = hourSnap.data() || {};
  const day = daySnap.data() || {};
  const breaker = breakerSnap.data() || {};

  if ((Number(hour.sends) || 0) >= cfg.limits.global_1h * 0.6) {
    alerts.push({type: "GLOBAL_HOUR_60", text: `${hour.sends} OTPs sent this hour (limit ${cfg.limits.global_1h}).`});
  }
  if ((Number(day.sends) || 0) >= cfg.limits.global_24h * 0.6) {
    alerts.push({type: "GLOBAL_DAY_60", text: `${day.sends} OTPs sent today (limit ${cfg.limits.global_24h}).`});
  }
  const sends = Number(hour.sends) || 0;
  const ok = Number(hour.verify_ok) || 0;
  if (sends >= 20 && ok / sends < 0.5) {
    alerts.push({type: "VERIFY_FAIL_SPIKE", text: `Only ${ok} of ${sends} OTPs this hour were verified.`});
  }
  if ((Number(hour.provider_fail) || 0) >= 5) {
    alerts.push({type: "PROVIDER_FAILS", text: `${hour.provider_fail} Fast2SMS failures this hour.`});
  }
  if (toMs(breaker.circuit_open_until) > nowMs) {
    alerts.push({
      type: "CIRCUIT_OPEN",
      text: `OTP circuit breaker is OPEN (${breaker.circuit_reason}) until ` +
        `${new Date(toMs(breaker.circuit_open_until)).toISOString()}. New sign-ins are refused.`,
    });
  }

  // 3. Daily digest at 09:00 IST.
  const istHour = new Date(nowMs + 5.5 * 3600000).getUTCHours();
  const istMinute = new Date(nowMs + 5.5 * 3600000).getUTCMinutes();
  if (istHour === 9 && istMinute < 15) {
    alerts.push({
      type: "DAILY_DIGEST",
      text: `Yesterday/today so far: ${day.sends || 0} sent, ${day.new_phones || 0} new numbers, ` +
        `${hour.verify_ok || 0} verified this hour, ${day.provider_fail || 0} provider failures. ` +
        `Wallet: Rs ${(await walletRef.get()).data()?.balance_inr ?? "?"}.`,
    });
  }

  for (const alert of alerts) {
    logger.error({event: "OTP_ALERT", type: alert.type, message: alert.text});
    await maybeSendAlert(db, cfg, alert);
  }
});

async function maybeSendAlert(db, cfg, alert) {
  const recipients = cfg.alert_emails.filter(Boolean);
  if (!recipients.length) return;
  const smtpUser = SMTP_USER.value();
  const smtpPass = SMTP_PASS.value();
  if (!smtpUser || !smtpPass) return;

  const ref = db.doc("auth_config/alerts");
  const dedupeMs = alert.type === "CIRCUIT_OPEN" ? 3600000 : 6 * 3600000;
  const nowMs = Date.now();
  const send = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const state = snap.exists ? snap.data() : {};
    const last = toMs(state[alert.type] && state[alert.type].last_sent_at);
    if (!alert.force && nowMs - last < dedupeMs) return false;
    tx.set(ref, {[alert.type]: {last_sent_at: tsFrom(nowMs)}}, {merge: true});
    return true;
  });
  if (!send) return;

  try {
    await nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true, auth: {user: smtpUser, pass: smtpPass},
    }).sendMail({
      from: `"CutQ Alerts" <${smtpUser}>`,
      to: recipients.join(","),
      subject: `[CutQ OTP] ${alert.type}`,
      text: `${alert.text}\n\nProject: cutq-e133a\nTime: ${new Date(nowMs).toISOString()}\n\n` +
        `Kill switch: auth_config/otp.sends_enabled = false (takes up to 60 s to reach every instance)\n` +
        `Clear the breaker: otp_global/breaker.circuit_open_until = null`,
    });
  } catch (err) {
    logger.error({event: "OTP_ALERT_EMAIL_FAILED", type: alert.type, message: err.message});
  }
}

/*
 * APP_CHECK_NOTES — turning App Check on later
 *
 * 1. Register the apps: Firebase console -> App Check.
 *      Android: Play Integrity (add the Play App Signing SHA-256, link the Cloud project,
 *               request a Play Integrity quota increase).
 *      iOS:     App Attest + DeviceCheck (Team ID, DeviceCheck .p8 key).
 *    Register debug tokens for development devices and treat them as secrets.
 * 2. Grant the runtime service account the token verifier role (needed by
 *    consumeAppCheckToken):
 *      gcloud projects add-iam-policy-binding cutq-e133a \
 *        --member=serviceAccount:1085189600336-compute@developer.gserviceaccount.com \
 *        --role=roles/firebaseappcheck.tokenVerifier
 * 3. Ship the client SDKs (Play Integrity / App Attest provider installed BEFORE any
 *    other Firebase call) and send limited-use tokens on these callables.
 * 4. Set auth_config/otp.appcheck_mode to "soft" first (unverified callers still work but
 *    at half the quotas and against a separate unverified_1h cap), watch the metrics,
 *    then set "enforce".
 * 5. Finally flip enforceAppCheck/consumeAppCheckToken to true in CALLABLE_OPTS and
 *    redeploy, so unverified callers are rejected by the platform before the handler runs.
 *
 * Until then the bill is bounded by the global caps, the breaker, the per-actor quotas,
 * the in-memory bucket and the prepaid wallet.
 */
