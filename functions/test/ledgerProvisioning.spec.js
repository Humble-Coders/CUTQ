/**
 * Unit tests for the Humble Ledger v1 → v2 provisioning state machine
 * (no emulator, no network, no credentials).
 *
 * This is the part of the migration the API verifier cannot reach: it is pure
 * Firestore logic, it only ever runs once per salon, and getting it wrong either
 * loses a salon's ledger credentials or registers a duplicate company. Firestore
 * and fetch are both faked here so every branch can be driven deterministically.
 *
 * Run with: npm test
 */
const assert = require("assert");
const admin = require("firebase-admin");

// ── fake Firestore ───────────────────────────────────────────────────────────
function makeDb() {
  const data = new Map();
  const key = (c, d) => `${c}/${d}`;
  const snapOf = (k) => ({
    exists: data.has(k),
    id: k.split("/").pop(),
    data: () => (data.has(k) ? {...data.get(k)} : undefined),
  });
  const docRef = (c, d) => ({
    _k: key(c, d),
    get: async () => snapOf(key(c, d)),
    set: async (v, opts) => {
      const k = key(c, d);
      data.set(k, opts && opts.merge ? {...(data.get(k) || {}), ...v} : {...v});
    },
    delete: async () => {
      data.delete(key(c, d));
    },
    collection: (sub) => collRef(`${c}/${d}/${sub}`),
  });
  const collRef = (c) => ({doc: (d) => docRef(c, d)});

  return {
    _data: data,
    _get: (c, d) => data.get(key(c, d)),
    _set: (c, d, v) => data.set(key(c, d), v),
    collection: collRef,
    // Buffers writes and applies them only after the body resolves, so a body
    // that throws leaves nothing behind — like a real transaction.
    runTransaction: async (fn) => {
      const writes = [];
      let readsClosed = false;
      const tx = {
        get: async (ref) => {
          if (readsClosed) throw new Error("Firestore: reads must come before writes in a transaction");
          return snapOf(ref._k);
        },
        set: (ref, v, opts) => {
          readsClosed = true;
          writes.push([ref._k, v, opts]);
        },
      };
      const out = await fn(tx);
      for (const [k, v, opts] of writes) {
        data.set(k, opts && opts.merge ? {...(data.get(k) || {}), ...v} : {...v});
      }
      return out;
    },
  };
}

// ── fake ledger API ──────────────────────────────────────────────────────────
function installFetch({registerFails = false, calls = []} = {}) {
  global.fetch = async (url, opts) => {
    const path = String(url).replace(/^.*\/api\/v1/, "");
    const method = (opts && opts.method) || "GET";
    calls.push(`${method} ${path.split("?")[0]}`);
    const ok = (data, extra) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({success: true, data, ...(extra || {})}),
    });
    if (path.startsWith("/auth/register")) {
      if (registerFails) {
        return {ok: false, status: 409, text: async () => JSON.stringify({success: false, error: "Slug taken"})};
      }
      // Header/payload/signature — payload carries companyId and a far exp.
      const payload = Buffer.from(JSON.stringify({companyId: "co_1", exp: 4102444800})).toString("base64");
      return ok({accessToken: `h.${payload}.s`, refreshToken: "r1", user: {id: "u1"}});
    }
    if (path.startsWith("/auth/login")) {
      const payload = Buffer.from(JSON.stringify({companyId: "co_1", exp: 4102444800})).toString("base64");
      return ok({accessToken: `h.${payload}.s`, refreshToken: "r2", user: {id: "u1"}});
    }
    if (path.startsWith("/accounts") && method === "GET") {
      return ok([
        {id: "a_rev", name: "Service Revenue", type: "INCOME"},
        {id: "a_cash", name: "Cash", type: "ASSET"},
        {id: "a_bank", name: "Bank", type: "ASSET"},
        {id: "a_ar", name: "Accounts Receivable", type: "ASSET"},
        {id: "a_op", name: "Operating Expense", type: "EXPENSE"},
      ], {meta: {hasMore: false}});
    }
    if (path.startsWith("/accounts") && method === "POST") return ok({id: "a_fees"});
    if (path.startsWith("/vendors")) return ok({id: "v_cutq"});
    throw new Error(`unexpected call ${method} ${path}`);
  };
}

// ── harness ──────────────────────────────────────────────────────────────────
const realFirestore = admin.firestore;
let db;
let ledger;

// admin.firestore is defined as a getter on the namespace, so plain assignment
// does not stick — replace the property outright.
function setFirestore(fn) {
  Object.defineProperty(admin, "firestore", {value: fn, configurable: true, writable: true});
}

function reset(opts) {
  db = makeDb();
  const stub = () => db;
  stub.FieldValue = {serverTimestamp: () => "__ts__"};
  setFirestore(stub);
  db._set("salons", "s1", {name: "Test Salon", owner_uid: "o1"});
  installFetch(opts);
  delete require.cache[require.resolve("../ledger")];
  ledger = require("../ledger");
}

const V1_RECORD = {
  companyId: "old_co",
  slug: "cutq-s1",
  email: "salon-s1@ledger.cutq.internal",
  password: "old-secret",
  accounts: {serviceRevenue: "old_rev", cash: "old_cash"},
  cutqVendorId: "old_vendor",
};

describe("provisionSalon — v1 → v2 migration", () => {
  after(() => {
    setFirestore(realFirestore);
  });

  it("provisions a salon that has never used accounting", async () => {
    reset();
    const rec = await ledger.provisionSalon("s1");
    assert.strictEqual(rec.apiVersion, "v2");
    assert.strictEqual(rec.accounts.serviceRevenue, "a_rev");
    assert.strictEqual(rec.accounts.operatingExpense, "a_op");
    assert.strictEqual(rec.accounts.cutqBookingFees, "a_fees");
    assert.strictEqual(rec.cutqVendorId, "v_cutq");
    assert.strictEqual(rec.companyId, "co_1");
    assert.strictEqual(db._get("ledger_accounts", "s1").apiVersion, "v2");
    // Nothing to retire, so nothing archived.
    assert.strictEqual(db._get("ledger_accounts_v1", "s1"), undefined);
  });

  it("archives a v1 record and re-provisions on v2", async () => {
    reset();
    db._set("ledger_accounts", "s1", {...V1_RECORD});
    const rec = await ledger.provisionSalon("s1");

    const archived = db._get("ledger_accounts_v1", "s1");
    assert.ok(archived, "v1 credentials must be archived");
    assert.strictEqual(archived.password, "old-secret");
    assert.strictEqual(archived.companyId, "old_co");
    assert.match(archived.archived_from, /ledger\.humblesolutions\.in/);

    // Live record is fully replaced — no stale v1 fields survive.
    const live = db._get("ledger_accounts", "s1");
    assert.strictEqual(live.apiVersion, "v2");
    assert.strictEqual(live.password === "old-secret", false);
    assert.strictEqual(live.companyId, "co_1");
    assert.strictEqual(rec.accounts.serviceRevenue, "a_rev");
  });

  it("keeps the archived credentials when registration fails", async () => {
    // The regression that matters: the lock write destroys the v1 record, so if
    // the archive were a separate write after it, a failure here would lose the
    // credentials permanently.
    reset({registerFails: true});
    db._set("ledger_accounts", "s1", {...V1_RECORD});

    await assert.rejects(() => ledger.provisionSalon("s1"));

    const archived = db._get("ledger_accounts_v1", "s1");
    assert.ok(archived, "archive must survive a failed registration");
    assert.strictEqual(archived.password, "old-secret");
    // Lock released so the salon can retry.
    assert.strictEqual(db._get("ledger_accounts", "s1").provisioning, false);
  });

  it("releases the lock when the salon document is missing", async () => {
    reset();
    db._data.delete("salons/s1");
    await assert.rejects(() => ledger.provisionSalon("s1"), /Salon not found/);
    assert.strictEqual(db._get("ledger_accounts", "s1").provisioning, false);
  });

  it("is a no-op for a salon already on v2 (no API calls)", async () => {
    const calls = [];
    reset({calls});
    const current = {
      ...V1_RECORD, apiVersion: "v2", accounts: {serviceRevenue: "a_rev"},
    };
    db._set("ledger_accounts", "s1", current);
    const rec = await ledger.provisionSalon("s1");
    assert.strictEqual(rec.apiVersion, "v2");
    assert.deepStrictEqual(calls, [], "must not touch the ledger API");
    assert.strictEqual(db._get("ledger_accounts_v1", "s1"), undefined, "must not archive a current record");
  });

  it("never overwrites an archive that already exists", async () => {
    reset();
    db._set("ledger_accounts_v1", "s1", {password: "first-archive", archived_from: "x"});
    db._set("ledger_accounts", "s1", {...V1_RECORD});
    await ledger.provisionSalon("s1");
    assert.strictEqual(db._get("ledger_accounts_v1", "s1").password, "first-archive");
  });

  it("refuses to start while another instance holds a fresh lock", async () => {
    reset();
    db._set("ledger_accounts", "s1", {provisioning: true, provisioning_at: {toMillis: () => Date.now()}});
    await assert.rejects(() => ledger.provisionSalon("s1"), /already in progress/);
  }).timeout(40000);

  it("takes over a lock that has gone stale", async () => {
    reset();
    db._set("ledger_accounts", "s1", {
      provisioning: true,
      provisioning_at: {toMillis: () => Date.now() - 5 * 60 * 1000},
    });
    const rec = await ledger.provisionSalon("s1");
    assert.strictEqual(rec.apiVersion, "v2");
  });
});

describe("ensureSalonLedger", () => {
  after(() => {
    setFirestore(realFirestore);
  });

  it("returns the stored record without re-provisioning when current", async () => {
    const calls = [];
    reset({calls});
    db._set("ledger_accounts", "s1", {...V1_RECORD, apiVersion: "v2"});
    const {cred} = await ledger.ensureSalonLedger("s1");
    assert.strictEqual(cred.email, V1_RECORD.email);
    assert.deepStrictEqual(calls, []);
  });

  it("migrates a v1 salon on first use", async () => {
    reset();
    db._set("ledger_accounts", "s1", {...V1_RECORD});
    const {cred} = await ledger.ensureSalonLedger("s1");
    assert.strictEqual(cred.apiVersion, "v2");
    assert.ok(cred.accounts.serviceRevenue);
    assert.ok(db._get("ledger_accounts_v1", "s1"));
  });
});

describe("ensureInvoiceNumber — per-salon numbering", () => {
  after(() => {
    setFirestore(realFirestore);
  });

  const numberFor = async (salonId, bookingId) => {
    db._set("bookings", bookingId, {salon_id: salonId, status: "completed"});
    return ledger.ensureInvoiceNumber(bookingId, salonId);
  };

  it("gives each salon its own sequence starting at 1", async () => {
    reset();
    assert.strictEqual(await numberFor("ROfUwg5wHGOcDWnCUUKS", "b1"), "CUTQ-ROFUWG-2026-0001");
    assert.strictEqual(await numberFor("ROfUwg5wHGOcDWnCUUKS", "b2"), "CUTQ-ROFUWG-2026-0002");
    assert.strictEqual(await numberFor("oITixzOE0LBEHLj8fgIu", "b3"), "CUTQ-OITIXZ-2026-0001");
    assert.strictEqual(await numberFor("oITixzOE0LBEHLj8fgIu", "b4"), "CUTQ-OITIXZ-2026-0002");
  });

  it("is stable per booking — a retry reuses the allocated number", async () => {
    reset();
    const first = await numberFor("salonA1", "b1");
    const again = await ledger.ensureInvoiceNumber("b1", "salonA1");
    assert.strictEqual(again, first);
    // Sequence must not advance on the replay.
    assert.strictEqual(db._get("salon_billing", "salonA1").seq, 1);
  });

  it("never issues the same code to two salons, even on a shared prefix", async () => {
    // The regression that matters: a 6-char prefix of the salon id is only
    // PROBABLY unique. Two salons sharing one would collide their invoice numbers.
    reset();
    const a = await numberFor("ABCDEFzzzz1111111111", "b1");
    const b = await numberFor("ABCDEFyyyy2222222222", "b2");
    assert.strictEqual(a, "CUTQ-ABCDEF-2026-0001");
    assert.strictEqual(b, "CUTQ-ABCDEF2-2026-0001", "second salon must be disambiguated");
    assert.notStrictEqual(a, b);
    assert.strictEqual(db._get("invoice_codes", "ABCDEF").salonId, "ABCDEFzzzz1111111111");
    assert.strictEqual(db._get("invoice_codes", "ABCDEF2").salonId, "ABCDEFyyyy2222222222");
  });

  it("reuses a salon's claimed code rather than claiming another", async () => {
    reset();
    await numberFor("salonA1", "b1");
    await numberFor("salonA1", "b2");
    const claimed = Object.keys(Object.fromEntries(db._data)).filter((k) => k.startsWith("invoice_codes/"));
    assert.strictEqual(claimed.length, 1, `expected one claimed code, got ${claimed}`);
  });

  it("falls back to a usable code when the salon id has no alphanumerics", async () => {
    reset();
    assert.strictEqual(await numberFor("---", "b1"), "CUTQ-SALON-2026-0001");
  });

  it("derives the year in IST, not UTC", () => {
    reset();
    // 00:30 IST on 1 Jan is still 31 Dec in UTC.
    assert.strictEqual(ledger.istDate(new Date("2027-01-01T00:30:00+05:30")).slice(0, 4), "2027");
  });
});

describe("istDate", () => {
  it("reports the IST calendar date, not the UTC one", () => {
    reset();
    // 02:00 IST on 3 Sep is still 2 Sep in UTC.
    assert.strictEqual(ledger.istDate(new Date("2026-09-03T02:00:00+05:30")), "2026-09-03");
    assert.strictEqual(ledger.istDate(new Date("2026-09-02T23:00:00+05:30")), "2026-09-02");
  });
});
