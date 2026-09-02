/**
 * Unit tests for the pure OTP logic (no emulator, no network, no credentials).
 * Run with: npm test
 */
const assert = require("assert");
const core = require("../otpcore");

const SECRET = "0".repeat(64);
const NOW = 1750000000000; // fixed instant so window maths is deterministic
const LIMITS = core.mergeLimits(null);
const PHONE_H = "phonehash";

const ago = (sec) => NOW - sec * 1000;
const stamp = (ms) => ({toMillis: () => ms});

describe("deriveOtp", () => {
  it("is deterministic and always 6 digits", () => {
    const a = core.deriveOtp(SECRET, "9876543210", "login", "nonce1");
    const b = core.deriveOtp(SECRET, "9876543210", "login", "nonce1");
    assert.strictEqual(a, b);
    assert.match(a, /^\d{6}$/);
  });

  it("changes with nonce, phone, purpose and secret", () => {
    const base = core.deriveOtp(SECRET, "9876543210", "login", "n1");
    assert.notStrictEqual(base, core.deriveOtp(SECRET, "9876543210", "login", "n2"));
    assert.notStrictEqual(base, core.deriveOtp(SECRET, "9876543211", "login", "n1"));
    assert.notStrictEqual(base, core.deriveOtp(SECRET, "9876543210", "delete", "n1"));
    assert.notStrictEqual(base, core.deriveOtp("1".repeat(64), "9876543210", "login", "n1"));
  });

  it("covers the whole 000000-999999 space without bias clustering", () => {
    const seen = new Set();
    let low = 0;
    for (let i = 0; i < 3000; i++) {
      const otp = core.deriveOtp(SECRET, "9876543210", "login", `n${i}`);
      assert.match(otp, /^\d{6}$/);
      seen.add(otp);
      if (Number(otp) < 500000) low++;
    }
    assert.ok(seen.size > 2950, `expected near-unique codes, got ${seen.size}`);
    assert.ok(low > 1300 && low < 1700, `expected a balanced split, got ${low}/3000 below 500000`);
  });
});

describe("timingSafeDigitsEqual", () => {
  it("matches equal codes and rejects everything else", () => {
    assert.strictEqual(core.timingSafeDigitsEqual("123456", "123456"), true);
    assert.strictEqual(core.timingSafeDigitsEqual("123456", "123457"), false);
    assert.strictEqual(core.timingSafeDigitsEqual("123456", "12345"), false);
    assert.strictEqual(core.timingSafeDigitsEqual("123456", ""), false);
  });
});

describe("clientIpKey", () => {
  const req = (xff, remote) => ({headers: xff === null ? {} : {"x-forwarded-for": xff}, socket: {remoteAddress: remote}});

  it("takes the RIGHTMOST forwarded entry (the one Google appends)", () => {
    assert.strictEqual(core.clientIpKey(req("1.2.3.4, 5.6.7.8")), "v4:5.6.7.8");
  });

  it("ignores a spoofed left-hand entry", () => {
    assert.strictEqual(core.clientIpKey(req("9.9.9.9,  203.0.113.7 ")), "v4:203.0.113.7");
  });

  it("buckets IPv6 to a /64", () => {
    assert.strictEqual(core.clientIpKey(req("2001:db8:1234:5678:9abc:def0:1234:5678")),
      "v6:2001:0db8:1234:5678/64");
    assert.strictEqual(core.clientIpKey(req("2001:db8::1")), "v6:2001:0db8:0000:0000/64");
  });

  it("unwraps IPv4-mapped IPv6 and strips zone ids", () => {
    assert.strictEqual(core.clientIpKey(req("::ffff:203.0.113.9")), "v4:203.0.113.9");
    assert.strictEqual(core.clientIpKey(req("fe80::1%en0")), "v6:fe80:0000:0000:0000/64");
  });

  // Measured against the deployed function on 2026-09-02: a request with no header
  // arrives with a single entry (the client), and a client-supplied header arrives as
  // "<spoofed>, <real client>" — Google appends the real address on the right.
  it("ignores a client-injected header the way the deployed front end delivers it", () => {
    assert.strictEqual(core.clientIpKey(req("203.0.113.9")), "v4:203.0.113.9");
    assert.strictEqual(core.clientIpKey(req("1.2.3.4, 203.0.113.9")), "v4:203.0.113.9");
    assert.notStrictEqual(core.clientIpKey(req("1.2.3.4, 203.0.113.9")), "v4:1.2.3.4");
  });

  it("keeps two different clients in two different buckets", () => {
    assert.notStrictEqual(
      core.clientIpKey(req("1.2.3.4, 203.0.113.9")),
      core.clientIpKey(req("1.2.3.4, 203.0.113.10")));
  });

  it("falls back to the socket and returns null for garbage", () => {
    assert.strictEqual(core.clientIpKey(req(null, "198.51.100.4")), "v4:198.51.100.4");
    assert.strictEqual(core.clientIpKey(req("not-an-ip")), null);
    assert.strictEqual(core.clientIpKey(null), null);
  });
});

describe("istKeys", () => {
  it("builds IST hour/day keys and window ends", () => {
    const k = core.istKeys(NOW);
    // Independently derived through the ICU timezone database rather than by hand.
    const ist = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", hour12: false,
    }).formatToParts(new Date(NOW)).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    assert.strictEqual(k.hourKey, `h_${ist.year}${ist.month}${ist.day}${ist.hour}`);
    assert.strictEqual(k.dayKey, `d_${ist.year}${ist.month}${ist.day}`);
    assert.ok(k.endOfHour > NOW && k.endOfHour - NOW <= 3600000);
    assert.ok(k.endOfDay > NOW && k.endOfDay - NOW <= 86400000);
    // The hour boundary must land exactly on an IST hour.
    assert.strictEqual((k.endOfHour + 5.5 * 3600000) % 3600000, 0);
  });
});

describe("mergeLimits", () => {
  it("uses defaults when nothing is configured", () => {
    assert.strictEqual(LIMITS.global_24h, 800);
    assert.strictEqual(LIMITS.phone_10m, 3);
  });

  it("clamps a configured value that exceeds the compiled ceiling", () => {
    const l = core.mergeLimits({global_1h: 99999, global_24h: 99999, phone_24h: 500});
    assert.strictEqual(l.global_1h, core.CEIL.global_1h);
    assert.strictEqual(l.global_24h, core.CEIL.global_24h);
    assert.strictEqual(l.phone_24h, core.CEIL.phone_24h);
  });

  it("accepts a lower value", () => {
    assert.strictEqual(core.mergeLimits({global_24h: 50}).global_24h, 50);
  });

  it("never lets the cooldown ladder get shorter than the ceiling", () => {
    const l = core.mergeLimits({cooldown_ladder_sec: [1, 1, 1]});
    assert.deepStrictEqual(l.cooldown_ladder_sec, [30, 60, 120]);
    const longer = core.mergeLimits({cooldown_ladder_sec: [90, 120, 300]});
    assert.deepStrictEqual(longer.cooldown_ladder_sec, [90, 120, 300]);
  });

  it("never produces a zero limit, which would block every request forever", () => {
    const l = core.mergeLimits({global_1h: 0, phone_10m: 0, ip_1h: -5});
    assert.strictEqual(l.global_1h, 1);
    assert.strictEqual(l.phone_10m, 1);
    assert.strictEqual(l.ip_1h, 1);
  });

  it("ignores junk", () => {
    const l = core.mergeLimits({global_24h: "abc", phone_1h: null});
    assert.strictEqual(l.global_24h, 800);
    assert.strictEqual(l.phone_1h, 5);
  });
});

describe("evaluateActorLimits", () => {
  const evaluate = (over) => core.evaluateActorLimits(Object.assign({
    phoneDoc: {}, installDoc: {}, ipDoc: {}, limits: LIMITS, nowMs: NOW,
    isTest: false, phoneH: PHONE_H, softMode: false,
  }, over));

  it("allows a first request", () => {
    assert.strictEqual(evaluate({}), null);
  });

  it("applies the escalating resend cooldown", () => {
    const first = evaluate({phoneDoc: {send_times: [ago(10)]}});
    assert.strictEqual(first.prefix, "OTP_COOLDOWN");
    assert.strictEqual(first.retryAfterSec, 20);
    assert.strictEqual(evaluate({phoneDoc: {send_times: [ago(31)]}}), null);

    const second = evaluate({phoneDoc: {send_times: [ago(120), ago(40)]}});
    assert.strictEqual(second.prefix, "OTP_COOLDOWN");
    assert.strictEqual(second.retryAfterSec, 20); // 60 s ladder step

    const third = evaluate({phoneDoc: {send_times: [ago(300), ago(200), ago(100)]}});
    assert.strictEqual(third.prefix, "OTP_COOLDOWN");
    assert.strictEqual(third.retryAfterSec, 20); // 120 s ladder step
  });

  it("caps sends per phone over 10 minutes, an hour and a day", () => {
    const tenMin = evaluate({phoneDoc: {send_times: [ago(500), ago(400), ago(300)]}});
    assert.strictEqual(tenMin.prefix, "OTP_PHONE_LIMIT");

    const hour = evaluate({phoneDoc: {send_times: [ago(3000), ago(2500), ago(2000), ago(1500), ago(1000)]}});
    assert.strictEqual(hour.prefix, "OTP_PHONE_LIMIT");

    const day = evaluate({phoneDoc: {send_times: Array.from({length: 8}, (unused, i) => ago(80000 - i * 100))}});
    assert.strictEqual(day.prefix, "OTP_PHONE_LIMIT");
  });

  it("does not throttle a number whose codes never left the provider", () => {
    // A streak only accrues for sessions that were actually delivered (auth.js), so a
    // number with no streak is never punished for a Fast2SMS failure.
    assert.strictEqual(evaluate({phoneDoc: {unverified_streak: 0, send_times: [ago(600)]}}), null);
  });

  it("throttles a number nobody ever verifies", () => {
    const bombed = evaluate({phoneDoc: {unverified_streak: 3, send_times: [ago(600)]}});
    assert.strictEqual(bombed.prefix, "OTP_PHONE_LIMIT");
    assert.ok(bombed.retryAfterSec > 1000);
    // The streak clears once a code is verified.
    assert.strictEqual(evaluate({phoneDoc: {unverified_streak: 0, send_times: [ago(600)]}}), null);
  });

  it("caps one device and the number of distinct phones it may target", () => {
    const perHour = evaluate({installDoc: {send_times: Array.from({length: 6}, (unused, i) => ago(3000 - i * 10))}});
    assert.strictEqual(perHour.prefix, "OTP_DEVICE_LIMIT");

    const distinct = evaluate({installDoc: {phones_24h: [
      {p: "a", t: stamp(ago(100))}, {p: "b", t: stamp(ago(200))}, {p: "c", t: stamp(ago(300))},
    ]}});
    assert.strictEqual(distinct.prefix, "OTP_DEVICE_LIMIT");

    // A phone the device already used does not count again.
    assert.strictEqual(evaluate({installDoc: {phones_24h: [
      {p: PHONE_H, t: stamp(ago(100))}, {p: "b", t: stamp(ago(200))}, {p: "c", t: stamp(ago(300))},
    ]}}), null);
  });

  it("caps an IP but skips IP limits for test numbers", () => {
    const ipDoc = {send_times: Array.from({length: 20}, (unused, i) => ago(500 - i))};
    assert.strictEqual(evaluate({ipDoc}).prefix, "OTP_IP_LIMIT");
    assert.strictEqual(evaluate({ipDoc, isTest: true}), null);
  });

  it("skips IP limits entirely when the address could not be parsed", () => {
    assert.strictEqual(evaluate({ipDoc: null}), null);
  });

  it("rejects a locked device before anything else", () => {
    const locked = evaluate({installDoc: {locked_until: stamp(NOW + 900000)}});
    assert.strictEqual(locked.prefix, "OTP_INSTALL_LOCKED");
    assert.strictEqual(locked.retryAfterSec, 900);
  });

  it("halves the quotas in App Check soft mode", () => {
    const doc = {send_times: [ago(3000), ago(2000)]}; // 2 in the hour, under the normal 5
    assert.strictEqual(evaluate({phoneDoc: doc}), null);
    assert.strictEqual(evaluate({phoneDoc: doc, softMode: true}).prefix, "OTP_PHONE_LIMIT");
  });
});

describe("evaluateNewPhonePerInstall", () => {
  it("caps how many never-seen numbers one device may introduce per day", () => {
    const doc = {new_phones_24h: [{p: "a", t: stamp(ago(100))}, {p: "b", t: stamp(ago(200))}]};
    assert.strictEqual(core.evaluateNewPhonePerInstall(doc, LIMITS, NOW, PHONE_H).prefix, "OTP_DEVICE_LIMIT");
    // Already-seen number, and a device under the cap, both pass.
    assert.strictEqual(core.evaluateNewPhonePerInstall(
      {new_phones_24h: [{p: PHONE_H, t: stamp(ago(100))}, {p: "b", t: stamp(ago(200))}]},
      LIMITS, NOW, PHONE_H), null);
    assert.strictEqual(core.evaluateNewPhonePerInstall({new_phones_24h: []}, LIMITS, NOW, PHONE_H), null);
    assert.strictEqual(core.evaluateNewPhonePerInstall({}, LIMITS, NOW, PHONE_H), null);
  });

  it("forgets entries older than a day", () => {
    const stale = {new_phones_24h: [{p: "a", t: stamp(ago(90000))}, {p: "b", t: stamp(ago(95000))}]};
    assert.strictEqual(core.evaluateNewPhonePerInstall(stale, LIMITS, NOW, PHONE_H), null);
  });
});

describe("validation patterns", () => {
  it("accepts only real Indian mobile numbers", () => {
    ["9876543210", "6000000000", "7000000000", "8000000000"].forEach((p) => assert.ok(core.PHONE_RE.test(p)));
    ["5876543210", "1000000001", "98765432101", "987654321", "+919876543210", "09876543210"]
      .forEach((p) => assert.ok(!core.PHONE_RE.test(p), `${p} should be rejected`));
  });

  it("recognises 10-digit strings separately, so test numbers can bypass the leading-digit rule", () => {
    assert.ok(core.TEN_DIGITS.test("1000000001"));
    assert.ok(!core.TEN_DIGITS.test("100000000"));
  });

  it("validates OTP and installation id shapes", () => {
    assert.ok(core.OTP_RE.test("000000"));
    assert.ok(!core.OTP_RE.test("12345"));
    assert.ok(!core.OTP_RE.test("12345a"));
    assert.ok(core.INSTALL_RE.test("cQ1_a-bZ8y2Tkm0pRs3Ldx"));
    assert.ok(!core.INSTALL_RE.test("short"));
    assert.ok(!core.INSTALL_RE.test("has spaces in it"));
    assert.ok(!core.INSTALL_RE.test("a".repeat(200)));
  });
});

describe("trimWindow", () => {
  it("keeps only timestamps inside the window and accepts Firestore Timestamps", () => {
    const arr = [ago(10), stamp(ago(100)), ago(4000)];
    assert.deepStrictEqual(core.trimWindow(arr, NOW, 3600), [ago(10), ago(100)]);
    assert.deepStrictEqual(core.trimWindow(undefined, NOW, 3600), []);
  });
});
