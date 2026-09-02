/**
 * Pure helpers for the customer phone-OTP flow.
 *
 * Nothing in here touches Firestore, the network, or firebase-admin, so every rule can be
 * unit tested without an emulator. auth.js owns all the I/O.
 */
const crypto = require("crypto");
const net = require("net");

// ── validation ────────────────────────────────────────────────────────────────

const PHONE_RE = /^[6-9]\d{9}$/; // real Indian mobile numbers
const TEN_DIGITS = /^\d{10}$/;
const OTP_RE = /^\d{6}$/;
const INSTALL_RE = /^[A-Za-z0-9_:.-]{8,80}$/; // Firebase Installations ID
const PLATFORMS = new Set(["android", "ios"]);

// ── quotas ────────────────────────────────────────────────────────────────────

/**
 * Hard ceilings compiled into the deployment. auth_config/otp.limits may only LOWER
 * these, so a mistaken console edit can never raise the SMS bill beyond this point.
 */
const CEIL = {
  cooldown_ladder_sec: [30, 60, 120],
  phone_10m: 3,
  phone_1h: 5,
  phone_24h: 8,
  phone_verify_calls_1h: 20,
  install_1h: 6,
  install_24h: 12,
  install_distinct_24h: 3,
  install_new_phones_24h: 2,
  install_verify_fails_1h: 15,
  install_lock_sec: 3600,
  ip_10m: 40,
  ip_1h: 120,
  ip_24h: 400,
  unverified_streak_limit: 3,
  unverified_streak_gap_sec: 1800,
  global_1h: 300,
  global_24h: 1500,
  new_phones_1h: 120,
  new_phones_24h: 800,
  unverified_1h: 60,
};

/** Values seeded into auth_config/otp and editable live without a deploy. */
const DEFAULT_LIMITS = {
  cooldown_ladder_sec: [30, 60, 120],
  phone_10m: 3,
  phone_1h: 5,
  phone_24h: 8,
  phone_verify_calls_1h: 20,
  install_1h: 6,
  install_24h: 12,
  install_distinct_24h: 3,
  install_new_phones_24h: 2,
  install_verify_fails_1h: 15,
  install_lock_sec: 3600,
  ip_10m: 20,
  ip_1h: 60,
  ip_24h: 200,
  unverified_streak_limit: 3,
  unverified_streak_gap_sec: 1800,
  global_1h: 150,
  global_24h: 800,
  new_phones_1h: 60,
  new_phones_24h: 400,
  unverified_1h: 30,
};

// Protocol constants — not configurable.
const SESSION_MAX_ATTEMPTS = 5;
const SESSION_TTL_SEC = 600; // matches "Valid for 10 minutes" in the approved DLT template
const RESEND_REUSE_MIN_LEFT_SEC = 120;

const MSG = {
  invalidPhone: "Enter a valid 10-digit Indian mobile number.",
  badArgument: "Invalid request.",
  cooldown: "Please wait before requesting another code.",
  rateLimited: "Too many requests. Please wait a moment and try again.",
  phoneLimit: "Too many codes sent to this number. Please try again later.",
  deviceLimit: "Too many requests from this device. Please try again later.",
  ipLimit: "Too many requests from your network. Please try again later.",
  serviceBusy: "OTP service is temporarily unavailable. Please try again later.",
  tooManyVerify: "Too many attempts. Please wait and try again.",
  tooManyAttempts: "Too many incorrect attempts. Please request a new code.",
  installLocked: "Too many incorrect attempts from this device. Please try again later.",
  expired: "This code has expired. Please request a new one.",
  notFound: "Please request a new code.",
  accountDisabled: "This account cannot sign in. Please contact support.",
  authRequired: "Please sign in first.",
  deleteNoPhone: "No phone number is linked to this account.",
  providerError: "Could not send the code right now. Please try again.",
  internal: "Something went wrong. Please try again.",
  appCheck: "We couldn't verify this app installation. Please reinstall CutQ from the store and try again.",
};

/** Merges the live config over the defaults, clamped by the compiled ceilings. */
function mergeLimits(configured) {
  const src = configured && typeof configured === "object" ? configured : {};
  const out = {};
  Object.keys(DEFAULT_LIMITS).forEach((key) => {
    const ceiling = CEIL[key];
    const wanted = src[key];
    if (Array.isArray(ceiling)) {
      const arr = Array.isArray(wanted) && wanted.length ? wanted : DEFAULT_LIMITS[key];
      // Ladder entries may only get LONGER than the ceiling (a longer wait is safer).
      out[key] = arr.map((v, i) => Math.max(Number(v) || 0, ceiling[Math.min(i, ceiling.length - 1)]));
    } else {
      const n = typeof wanted === "number" && Number.isFinite(wanted) ? wanted : DEFAULT_LIMITS[key];
      // Floor of 1: a limit of 0 makes over() refuse every request forever and report an
      // infinite retry. Stopping the service is what sends_enabled is for.
      out[key] = Math.max(1, Math.min(n, ceiling));
    }
  });
  return out;
}

// ── crypto ────────────────────────────────────────────────────────────────────

function hmacHex(key, domain, value) {
  return crypto.createHmac("sha256", key).update(`${domain} ${value}`).digest("hex");
}

function secretVersion(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex").slice(0, 8);
}

/**
 * Derives the 6-digit OTP from the server secret plus the session's random nonce.
 * Nothing recoverable is persisted: the session stores only the nonce, so read access to
 * Firestore is not enough to compute a live code, and a resend can reproduce the exact
 * same code without ever storing it.
 */
function deriveOtp(secret, phone, purpose, nonce) {
  const digest = crypto.createHmac("sha256", secret)
    .update(`otp ${phone}|${purpose}|${nonce}`)
    .digest();
  // 64 bits of the digest reduced mod 1e6, kept inside Number's exact-integer range:
  // (hi % 1e6) * 2^32 + lo  <  1e6 * 2^32 + 2^32  ~=  4.3e15  <  2^53.
  const hi = digest.readUInt32BE(0);
  const lo = digest.readUInt32BE(4);
  const n = ((hi % 1000000) * 4294967296 + lo) % 1000000;
  return String(n).padStart(6, "0");
}

function timingSafeDigitsEqual(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// ── network identity ──────────────────────────────────────────────────────────

function expandIpv6(ip) {
  const parts = ip.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const middle = parts.length > 1 ?
    new Array(Math.max(0, 8 - head.length - tail.length)).fill("0") : [];
  return head.concat(middle, tail).map((h) => (h || "0").padStart(4, "0")).join(":");
}

/**
 * Caller IP. Google Front End APPENDS the real client address as the RIGHTMOST
 * X-Forwarded-For entry, so anything a client injects sits to the left and is ignored.
 * IPv6 is bucketed to a /64 because one subscriber usually owns a whole /64.
 * Returns null when the address cannot be parsed; IP limiting is then skipped and the
 * phone / install / global limits still apply.
 */
function clientIpKey(rawRequest) {
  if (!rawRequest) return null;
  const header = rawRequest.headers ? rawRequest.headers["x-forwarded-for"] : "";
  const parts = String(header || "").split(",").map((s) => s.trim()).filter(Boolean);
  let ip = parts.length ? parts[parts.length - 1] : "";
  if (!ip && rawRequest.socket) ip = rawRequest.socket.remoteAddress || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip.includes("%")) ip = ip.split("%")[0];
  const kind = net.isIP(ip);
  if (kind === 4) return `v4:${ip}`;
  if (kind === 6) return `v6:${expandIpv6(ip).split(":").slice(0, 4).join(":")}/64`;
  return null;
}

// ── time windows ──────────────────────────────────────────────────────────────

const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : Number(v) || 0);

const trimWindow = (arr, nowMs, sec) =>
  (Array.isArray(arr) ? arr : []).map(toMs).filter((t) => t > nowMs - sec * 1000);

const retryIn = (untilMs, nowMs) => Math.max(1, Math.ceil((untilMs - nowMs) / 1000));

/** Fixed hour/day window keys and their end instants, in IST. */
function istKeys(nowMs) {
  const d = new Date(nowMs + 5.5 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  const day = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const msIntoHour = d.getUTCMinutes() * 60000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
  const msIntoDay = d.getUTCHours() * 3600000 + msIntoHour;
  return {
    hourKey: `h_${day}${p(d.getUTCHours())}`,
    dayKey: `d_${day}`,
    endOfHour: nowMs + (3600000 - msIntoHour),
    endOfDay: nowMs + (86400000 - msIntoDay),
  };
}

// ── limit evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluates every per-actor limit against already-loaded documents.
 * Returns null when allowed, otherwise {httpsCode, prefix, message, retryAfterSec}.
 *
 * Pure and shared, so the cheap pre-check and the authoritative in-transaction check can
 * never drift apart.
 */
function evaluateActorLimits(input) {
  const {phoneDoc, installDoc, ipDoc, limits, nowMs, isTest, phoneH, softMode} = input;
  const ph = phoneDoc || {};
  const ins = installDoc || {};
  const ipd = ipDoc || {};
  const scaled = (v) => (softMode ? Math.max(1, Math.floor(v / 2)) : v);

  if (ins.locked_until && toMs(ins.locked_until) > nowMs) {
    return {
      httpsCode: "permission-denied",
      prefix: "OTP_INSTALL_LOCKED",
      message: MSG.installLocked,
      retryAfterSec: retryIn(toMs(ins.locked_until), nowMs),
    };
  }

  const sends24 = trimWindow(ph.send_times, nowMs, 86400);
  const recent10 = sends24.filter((t) => t > nowMs - 600000);

  // Escalating resend cooldown: 30 s, then 60 s, then 120 s inside the same 10 minutes.
  if (recent10.length) {
    const ladder = limits.cooldown_ladder_sec;
    const wait = ladder[Math.min(recent10.length - 1, ladder.length - 1)] * 1000;
    const last = Math.max.apply(null, recent10);
    if (nowMs - last < wait) {
      return {
        httpsCode: "resource-exhausted",
        prefix: "OTP_COOLDOWN",
        message: MSG.cooldown,
        retryAfterSec: retryIn(last + wait, nowMs),
      };
    }
  }

  // A number that keeps receiving codes nobody ever verifies is being bombed, not used.
  const streak = Number(ph.unverified_streak) || 0;
  if (streak >= limits.unverified_streak_limit && sends24.length) {
    const gap = limits.unverified_streak_gap_sec * 1000;
    const last = Math.max.apply(null, sends24);
    if (nowMs - last < gap) {
      return {
        httpsCode: "resource-exhausted",
        prefix: "OTP_PHONE_LIMIT",
        message: MSG.phoneLimit,
        retryAfterSec: retryIn(last + gap, nowMs),
      };
    }
  }

  const over = (times, sec, max) => {
    const win = trimWindow(times, nowMs, sec);
    return win.length >= max ? retryIn(Math.min.apply(null, win) + sec * 1000, nowMs) : 0;
  };

  let retry = over(sends24, 600, scaled(limits.phone_10m)) ||
    over(sends24, 3600, scaled(limits.phone_1h)) ||
    over(sends24, 86400, scaled(limits.phone_24h));
  if (retry) {
    return {
      httpsCode: "resource-exhausted", prefix: "OTP_PHONE_LIMIT",
      message: MSG.phoneLimit, retryAfterSec: retry,
    };
  }

  const insSends = trimWindow(ins.send_times, nowMs, 86400);
  retry = over(insSends, 3600, scaled(limits.install_1h)) ||
    over(insSends, 86400, scaled(limits.install_24h));
  if (retry) {
    return {
      httpsCode: "resource-exhausted", prefix: "OTP_DEVICE_LIMIT",
      message: MSG.deviceLimit, retryAfterSec: retry,
    };
  }

  const distinct = (Array.isArray(ins.phones_24h) ? ins.phones_24h : [])
    .filter((e) => e && toMs(e.t) > nowMs - 86400000);
  if (!distinct.some((e) => e.p === phoneH) && distinct.length >= scaled(limits.install_distinct_24h)) {
    return {
      httpsCode: "resource-exhausted",
      prefix: "OTP_DEVICE_LIMIT",
      message: MSG.deviceLimit,
      retryAfterSec: retryIn(Math.min.apply(null, distinct.map((e) => toMs(e.t))) + 86400000, nowMs),
    };
  }

  // Test numbers still obey cooldown / phone / device limits (so a leaked review number
  // cannot be looped); they skip only the global counters and the provider call.
  if (!isTest && ipDoc !== undefined && ipDoc !== null) {
    const ipSends = trimWindow(ipd.send_times, nowMs, 86400);
    retry = over(ipSends, 600, scaled(limits.ip_10m)) ||
      over(ipSends, 3600, scaled(limits.ip_1h)) ||
      over(ipSends, 86400, scaled(limits.ip_24h));
    if (retry) {
      return {
        httpsCode: "resource-exhausted", prefix: "OTP_IP_LIMIT",
        message: MSG.ipLimit, retryAfterSec: retry,
      };
    }
  }

  return null;
}

/** Per-device cap on how many never-seen numbers one install may introduce per day. */
function evaluateNewPhonePerInstall(installDoc, limits, nowMs, phoneH) {
  const list = (Array.isArray(installDoc && installDoc.new_phones_24h) ? installDoc.new_phones_24h : [])
    .filter((e) => e && toMs(e.t) > nowMs - 86400000);
  if (list.some((e) => e.p === phoneH)) return null;
  if (list.length < limits.install_new_phones_24h) return null;
  return {
    httpsCode: "resource-exhausted",
    prefix: "OTP_DEVICE_LIMIT",
    message: MSG.deviceLimit,
    retryAfterSec: retryIn(Math.min.apply(null, list.map((e) => toMs(e.t))) + 86400000, nowMs),
  };
}

module.exports = {
  PHONE_RE,
  TEN_DIGITS,
  OTP_RE,
  INSTALL_RE,
  PLATFORMS,
  CEIL,
  DEFAULT_LIMITS,
  SESSION_MAX_ATTEMPTS,
  SESSION_TTL_SEC,
  RESEND_REUSE_MIN_LEFT_SEC,
  MSG,
  mergeLimits,
  hmacHex,
  secretVersion,
  deriveOtp,
  timingSafeDigitsEqual,
  expandIpv6,
  clientIpKey,
  toMs,
  trimWindow,
  retryIn,
  istKeys,
  evaluateActorLimits,
  evaluateNewPhonePerInstall,
};
