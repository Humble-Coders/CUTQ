/*
 * Humble Ledger integration for CutQ salons — API v2 (hl.humblesolutions.in).
 *
 * The salon dashboard cannot call the accounting API directly (its CORS is
 * locked to the API's own origin), so all traffic goes through Cloud Functions.
 *
 * Model: ONE Humble Ledger "company" per salon. Credentials + resolved account
 * ids live in Firestore `ledger_accounts/{salonId}` — a server-only collection
 * (no client access; functions use the admin SDK).
 *
 * A completed booking is posted as: SALE (amount = services + booking_fee −
 * discount → revenue account) then PAYMENT (same amount, Cash/Bank). The
 * booking fee is the salon's revenue here; the salon later remits collected
 * fees to CutQ as a separate vendor payment. The API dedupes on (appId,
 * sourceId), so every posting uses a distinct sourceId (`<bookingId>:sale`,
 * `<bookingId>:payment`) and we additionally guard with booking.ledger.posted.
 *
 * ── v1 → v2 migration ───────────────────────────────────────────────────────
 * v2 runs on a new host with a fresh database: the companies registered against
 * the retired v1 instance do not exist there. A `ledger_accounts` record written
 * by v1 (no `apiVersion`) is therefore archived to `ledger_accounts_v1/{salonId}`
 * and the salon is re-provisioned on v2 on next use. Bookings already posted
 * under v1 keep `ledger.posted: true` and are never re-posted, so nothing is
 * double-counted; their books simply stay behind on the old instance.
 *
 * What changed in the API itself (v1 → v2):
 *   - Host/base URL, and auth now issues a short-lived accessToken (15 min) plus
 *     a rotating refreshToken (30 days) exchanged at POST /auth/refresh.
 *   - The registered user carries a nested `company` object instead of companyId.
 *   - The seeded chart of accounts calls revenue "Sales Revenue" (was "Service
 *     Revenue"), so accounts are resolved by candidate name and created if absent.
 *   - POST /customers and POST /vendors are idempotent on externalId.
 *   - POST /sales requires a description; POST /transactions/:id/reverse requires
 *     a reason.
 *   - Errors are {success:false, error:"message", code:"CODE"}.
 */

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");
const billing = require("./billing");

// Overridable so a future host move needs no code change.
const LEDGER_BASE = process.env.LEDGER_BASE_URL || "https://hl.humblesolutions.in/api/v1";
// Retired v1 instance — recorded on archived credentials for provenance only.
const LEGACY_LEDGER_BASE = "https://ledger.humblesolutions.in/api/v1";
// Stamped on every `ledger_accounts` record. A record without it predates v2.
const LEDGER_API_VERSION = "v2";
const APP_ID = "cutq";

// In-memory token cache per ledger email (survives warm invocations).
// { token, exp, refreshToken }
const tokenCache = new Map();

function randomToken(len = 16) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function ledgerFetch(path, {method = "GET", token, body, query} = {}) {
  let url = LEDGER_BASE + path;
  if (query) {
    const pairs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "");
    const qs = new URLSearchParams(pairs).toString();
    if (qs) url += "?" + qs;
  }
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {raw: text};
  }
  if (!res.ok || json.success === false) {
    // v2 errors are {success:false, error:"message", code:"CODE"}; validation
    // failures add details:[{path,message}]. v1 sometimes nested the message
    // under error.message. Accept every shape, and fold the field-level detail
    // into the message — it is what the salon sees in the dashboard toast.
    let m = json?.error?.message || json?.message ||
      (typeof json?.error === "string" ? json.error : null) ||
      `Ledger API ${res.status}`;
    if (typeof m !== "string") m = JSON.stringify(m);
    if (Array.isArray(json?.details) && json.details.length) {
      const fields = json.details
        .map((d) => [d.path, d.message].filter(Boolean).join(": "))
        .filter(Boolean)
        .join("; ");
      if (fields) m += ` (${fields})`;
    }
    const err = new Error(m);
    err.status = res.status;
    err.code = json?.code || null;
    err.body = json;
    throw err;
  }
  return json;
}

function acctRef(salonId) {
  return admin.firestore().collection("ledger_accounts").doc(salonId);
}

function tokenFrom(authData) {
  return authData?.accessToken || authData?.token;
}

// The company id is informational (the JWT itself scopes every request to one
// company). /auth/register and /auth/login return only {id,name,email,role} for
// the user, so read it off the token and fall back to /auth/me.
function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64").toString());
  } catch {
    return null;
  }
}

async function resolveCompanyId(authData, cred) {
  const direct = authData?.user?.company?.id || authData?.user?.companyId;
  if (direct) return direct;
  const p = jwtPayload(tokenFrom(authData));
  if (p?.companyId) return p.companyId;
  try {
    const me = await authed(cred, "/auth/me");
    return me?.data?.company?.id || me?.data?.companyId || null;
  } catch (err) {
    logger.warn("Could not resolve ledger companyId", {msg: err.message});
    return null;
  }
}

function jwtExp(token) {
  const payload = jwtPayload(token);
  return payload?.exp ? payload.exp * 1000 : null;
}

// Cache the access token (and the rotating refresh token) for an email, and
// return the access token. v2 access tokens are short (15 min) — the recorded
// expiry is only a hint; a 401 still triggers a re-auth in authed().
function cacheTokens(email, authData) {
  const token = tokenFrom(authData);
  if (!token) throw new Error("Ledger auth returned no access token.");
  const exp = jwtExp(token) || Date.now() + 14 * 60 * 1000;
  const prev = tokenCache.get(email);
  tokenCache.set(email, {
    token,
    exp,
    refreshToken: authData?.refreshToken || prev?.refreshToken || null,
  });
  return token;
}

async function getToken(cred, force = false) {
  const cached = tokenCache.get(cred.email);
  if (!force && cached?.token && cached.exp > Date.now() + 60000) return cached.token;

  // Prefer the refresh grant — it avoids a password round-trip. The token is
  // rotated on use (the old one is revoked immediately), so a failure here just
  // means this instance's copy is stale: fall through to a password login.
  if (cached?.refreshToken) {
    try {
      const r = await ledgerFetch("/auth/refresh", {
        method: "POST", body: {refreshToken: cached.refreshToken},
      });
      return cacheTokens(cred.email, r.data);
    } catch {
      tokenCache.delete(cred.email);
    }
  }

  const auth = await ledgerFetch("/auth/login", {
    method: "POST", body: {email: cred.email, password: cred.password},
  });
  return cacheTokens(cred.email, auth.data);
}

// Authenticated request that transparently re-authenticates on a 401 (access
// token expired or rotated) and retries once. All authed ledger calls go here.
async function authed(cred, path, opts = {}) {
  try {
    return await ledgerFetch(path, {...opts, token: await getToken(cred)});
  } catch (err) {
    if (err.status === 401) {
      tokenCache.delete(cred.email);
      return ledgerFetch(path, {...opts, token: await getToken(cred, true)});
    }
    throw err;
  }
}

// ── Chart of accounts ────────────────────────────────────────────────────────
//
// v2 seeds a full chart: Cash, Bank, Accounts Receivable, Accounts Payable,
// Advance Liability, GST Input/Payable, Owner's Equity, Other Income, Sales
// Revenue, Service Revenue, Operating/Rent/Salary Expense. Bookings stay on
// "Service Revenue" (what v1 posted to, and the right line on a salon's P&L);
// "Sales Revenue" is only the fallback if a future seed drops it. Each slot is
// resolved against accepted names and created when missing, so neither a rename
// nor a leaner seed can leave a salon with a null account id.
const ACCOUNT_SPECS = {
  serviceRevenue: {names: ["Service Revenue", "Sales Revenue"], type: "INCOME", create: true},
  cash: {names: ["Cash"], type: "ASSET", create: true},
  bank: {names: ["Bank"], type: "ASSET", create: true},
  accountsReceivable: {names: ["Accounts Receivable"], type: "ASSET", create: false},
  // Where remittances to CutQ are booked.
  cutqBookingFees: {names: ["CutQ Booking Fees"], type: "EXPENSE", create: true},
  // Default bucket for dashboard-entered expenses that pick no category.
  operatingExpense: {names: ["Operating Expense"], type: "EXPENSE", create: true},
};

async function listAllAccounts(cred) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await authed(cred, "/accounts", {query: {page, limit: 200}});
    out.push(...(res.data || []));
    if (!res.meta?.hasMore) break;
  }
  return out;
}

async function resolveAccounts(cred) {
  let accts = await listAllAccounts(cred);
  const find = (names) => {
    for (const n of names) {
      const hit = accts.find((a) => String(a.name || "").toLowerCase() === n.toLowerCase());
      if (hit) return hit.id;
    }
    return null;
  };

  const accounts = {};
  for (const [key, spec] of Object.entries(ACCOUNT_SPECS)) {
    let id = find(spec.names);
    if (!id && spec.create) {
      try {
        const made = await authed(cred, "/accounts", {
          method: "POST", body: {name: spec.names[0], type: spec.type},
        });
        id = made.data.id;
      } catch (err) {
        if (err.status !== 409) throw err;
        // Created concurrently (or archived under that name) — re-read and resolve.
        accts = await listAllAccounts(cred);
        id = find(spec.names);
      }
    }
    accounts[key] = id || null;
  }
  return accounts;
}

// Register the company. The slug/email are derived from the salon id, so a
// retry after a register that succeeded but whose credentials were lost would
// collide (409). Step to the next generation instead of dead-ending.
async function registerCompany(salonId, salonName) {
  let lastErr = null;
  for (let gen = 1; gen <= 3; gen++) {
    const suffix = gen === 1 ? "" : `-${gen}`;
    const slug = `cutq-${salonId}${suffix}`.toLowerCase().slice(0, 48);
    const email = `salon-${salonId}${suffix}@ledger.cutq.internal`.toLowerCase();
    const password = randomToken(20);
    try {
      const reg = await ledgerFetch("/auth/register", {
        method: "POST",
        body: {
          companyName: salonName || `CutQ Salon ${salonId}`,
          companySlug: slug,
          currency: "INR",
          name: salonName || "Salon Owner",
          email,
          password,
        },
      });
      return {authData: reg.data, slug, email, password, gen};
    } catch (err) {
      lastErr = err;
      if (err.status !== 409) throw err;
      logger.warn("Ledger slug/email already taken, trying next generation", {salonId, slug});
    }
  }
  throw lastErr || new Error("Could not register a ledger company for this salon.");
}

// Copy a pre-v2 credential record aside so the retired company stays
// identifiable. The live record is NOT touched here — the claim transaction
// already replaced it, atomically, with the provisioning lock.
async function archiveLegacyLedger(salonId, data) {
  const archive = admin.firestore().collection("ledger_accounts_v1").doc(salonId);
  const existing = await archive.get();
  if (!existing.exists) {
    await archive.set({
      ...data,
      archived_from: LEGACY_LEDGER_BASE,
      archived_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  if (data.email) tokenCache.delete(data.email);
  logger.info("Archived pre-v2 ledger company; salon will be re-provisioned", {salonId});
}

function isCurrent(d) {
  return Boolean(d && d.email && d.accounts && d.apiVersion === LEDGER_API_VERSION);
}

// Provision (register) a Humble Ledger company for a salon and store its
// credentials + resolved account ids. Idempotent: returns existing if present
// and already on the current API version.
async function provisionSalon(salonId) {
  const ref = acctRef(salonId);
  const fast = await ref.get();
  if (isCurrent(fast.data())) return fast.data();

  // Claim a provisioning lock so two concurrent first-sales don't both register
  // a company (which would orphan a duplicate we can't recover the password for).
  // The same transaction retires a pre-v2 record: the write is a full replace
  // (no merge), so the stale v1 email/password/accounts are gone the instant the
  // lock is taken. Doing this outside the transaction would let a slow instance
  // wipe a v2 record another instance had just finished writing.
  const claim = await admin.firestore().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const dd = s.exists ? s.data() : null;
    if (isCurrent(dd)) return {done: dd};
    const lockedAt = dd?.provisioning_at?.toMillis?.() || 0;
    if (dd?.provisioning && Date.now() - lockedAt < 120000) return {busy: true};
    const legacy = dd?.email && dd?.accounts ? dd : null;
    tx.set(ref, {provisioning: true, provisioning_at: admin.firestore.FieldValue.serverTimestamp()});
    return {claimed: true, legacy};
  });
  if (claim.done) return claim.done;
  if (claim.busy) {
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await ref.get();
      if (isCurrent(s.data())) return s.data();
    }
    throw new Error("Ledger provisioning already in progress; please retry shortly.");
  }

  // Lock is held — safe to file the retired record away.
  if (claim.legacy) await archiveLegacyLedger(salonId, claim.legacy);

  const salonSnap = await admin.firestore().collection("salons").doc(salonId).get();
  if (!salonSnap.exists) throw new Error("Salon not found");
  const salon = salonSnap.data();

  let reg;
  try {
    reg = await registerCompany(salonId, salon.name);
  } catch (err) {
    // Clear the lock so it can be retried.
    await ref.set({provisioning: false}, {merge: true}).catch(() => {});
    logger.error("provisionSalon register failed", {salonId, msg: err.message});
    throw err;
  }

  const {authData, slug, email, password} = reg;
  try {
    // Registration logs us in — seed the cache so account setup needs no login.
    cacheTokens(email, authData);
    const cred = {email, password};

    const accounts = await resolveAccounts(cred);

    // CutQ as a vendor (the salon pays it monthly). Idempotent on externalId.
    const vendor = await authed(cred, "/vendors", {
      method: "POST", body: {name: "CutQ Platform", externalId: "cutq_platform"},
    });

    const record = {
      companyId: await resolveCompanyId(authData, cred),
      slug,
      email,
      password,
      accounts,
      cutqVendorId: vendor.data?.id || null,
      apiVersion: LEDGER_API_VERSION,
      apiBase: LEDGER_BASE,
      provisioning: false,
      provisioned_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    await ref.set(record, {merge: true});
    logger.info("Provisioned ledger company for salon", {salonId, slug, apiVersion: LEDGER_API_VERSION});
    return record;
  } catch (err) {
    await ref.set({provisioning: false}, {merge: true}).catch(() => {});
    logger.error("provisionSalon setup failed", {salonId, msg: err.message});
    throw err;
  }
}

// Ensure a salon has a provisioned ledger company on the current API version;
// return {cred}. The token is fetched lazily (and 401-retried) by authed().
async function ensureSalonLedger(salonId) {
  const snap = await acctRef(salonId).get();
  if (isCurrent(snap.data())) return {cred: snap.data()};
  const record = await provisionSalon(salonId);
  return {cred: record};
}

// Allocate a globally-unique, human-readable invoice number (CUTQ-<year>-<seq>)
// once per booking, from a global Firestore counter. Reused on retries. This
// same number is stored on the accounting invoice AND printed on the bill, and
// is unique across all salons (required by the flat bill filename namespace).
async function ensureInvoiceNumber(bookingId) {
  const db = admin.firestore();
  const bref = db.collection("bookings").doc(bookingId);
  const counterRef = db.collection("app_config").doc("invoice_counter");
  return db.runTransaction(async (tx) => {
    const b = await tx.get(bref);
    const existing = b.data()?.ledger?.invoiceNumber;
    if (existing) return existing;
    const c = await tx.get(counterRef);
    const n = (c.data()?.seq || 0) + 1;
    tx.set(counterRef, {seq: n, updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    const num = `CUTQ-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`;
    tx.set(bref, {ledger: {invoiceNumber: num}}, {merge: true});
    return num;
  });
}

function computeTotals(booking) {
  const services = Array.isArray(booking.services) ? booking.services : [];
  const serviceTotal = services.length ?
    services.reduce((s, x) => s + (Number(x.service_price) || 0), 0) :
    (Number(booking.total_service_price) || 0);
  const fee = Number(booking.booking_fee) || 0; // per-booking snapshot of admin global fee
  const discount = Number(booking.discount_amount) || 0;
  const grand = Math.max(0, serviceTotal + fee - discount);
  return {serviceTotal, fee, discount, grand};
}

// The salons and their books run on IST. toISOString() reports UTC, which pushes
// any completion between midnight and 05:30 IST back into the previous day —
// landing the sale in the wrong accounting period and disagreeing with the date
// printed on the bill (billing.js already formats in Asia/Kolkata).
const IST_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});
function istDate(d = new Date()) {
  return IST_DATE_FORMAT.format(d);
}

function todayISO(booking) {
  const c = booking?.completion?.completed_at?.toDate?.() || booking?.slot_start?.toDate?.() || new Date();
  return istDate(c);
}

// Generate the customer-facing PDF bill (idempotent per invoiceNo). A failure
// here is non-fatal — the sale/payment are already posted; the bill can be
// regenerated by retrying. The error is surfaced on the booking.
async function makeBill({booking, bookingId, invoiceNo, customerName}) {
  try {
    const salonSnap = await admin.firestore().collection("salons").doc(booking.salon_id).get();
    const salon = salonSnap.exists ? salonSnap.data() : {};
    const invoiceData = billing.buildInvoiceData({booking, invoiceNo, salon, customerName});
    return {billUrl: await billing.generateInvoicePdf(invoiceData), billError: null};
  } catch (err) {
    const billError = String(err.message || err);
    logger.error("bill generation failed", {bookingId, msg: billError});
    return {billUrl: null, billError};
  }
}

// Post a completed booking to the ledger (sale + payment). Returns ledger refs.
// Server-authoritative on amount; idempotent at the API via distinct sourceIds.
async function recordSaleForBooking(bookingId, {actorUid} = {}) {
  const bref = admin.firestore().collection("bookings").doc(bookingId);
  const bsnap = await bref.get();
  if (!bsnap.exists) throw new Error("Booking not found");
  const booking = bsnap.data();
  if (booking.status !== "completed") throw new Error("Booking is not completed");

  const {cred} = await ensureSalonLedger(booking.salon_id);
  const totals = computeTotals(booking);
  const date = todayISO(booking);

  // Canonical invoice number, shared by the accounting invoice and the bill.
  const invoiceNumber = await ensureInvoiceNumber(bookingId);

  // A fully-comped booking (discount cancels the whole total) has nothing to
  // post — the API rejects amounts below 0.01, so a sale here would fail on
  // every retry and leave the booking stuck behind a "not posted" banner. Issue
  // the ₹0 bill and report it settled instead.
  if (!(totals.grand > 0)) {
    const zero = await makeBill({
      booking, bookingId, invoiceNo: invoiceNumber,
      customerName: booking.customer_name || "Customer",
    });
    logger.info("Booking total is zero — nothing posted to the ledger", {bookingId});
    return {
      companyId: cred.companyId || null,
      customerId: null,
      invoiceId: null,
      invoiceNumber,
      saleTxnId: null,
      paymentTxnId: null,
      amount: 0,
      method: booking?.completion?.payment_method === "BANK" ? "BANK" : "CASH",
      skipped: "zero_amount",
      billUrl: zero.billUrl,
      billError: zero.billError,
      posted_at: new Date().toISOString(),
    };
  }

  // Resolve customer name/phone. Walk-in bookings carry them directly; app
  // bookings look them up from the Users doc.
  let customerName = booking.customer_name || "Walk-in customer";
  let customerPhone = booking.customer_phone || undefined;
  if (booking.user_id && !booking.customer_name) {
    const u = await admin.firestore().collection("Users").doc(booking.user_id).get();
    if (u.exists) {
      customerName = u.data().name || customerName;
      customerPhone = u.data().phone || undefined;
    }
  }
  // externalId is the idempotency key: a returning customer maps to the same
  // ledger account and their balance carries over.
  const externalId = booking.user_id || `booking_${bookingId}`;
  const cust = await authed(cred, "/customers", {
    method: "POST",
    body: {name: customerName, phone: customerPhone, externalId},
  });
  const customerId = cust.data?.id;
  if (!customerId) throw new Error("Ledger did not return a customer id.");

  // Traceability only — metadata/actorRef have no effect on the posting itself.
  const metadata = {bookingId, salonId: booking.salon_id, isWalkIn: Boolean(booking.is_walk_in)};
  const actorRef = actorUid ? String(actorUid).slice(0, 128) : undefined;

  const desc = `Booking ${bookingId} — ${customerName}`;
  const sale = await authed(cred, "/sales", {
    method: "POST",
    body: {
      customerId,
      amount: totals.grand,
      description: desc,
      appId: APP_ID,
      sourceId: `${bookingId}:sale`,
      invoiceNumber,
      date,
      revenueAccountId: cred.accounts?.serviceRevenue || undefined,
      actorRef,
      metadata,
    },
  });
  const invoiceId = sale.data?.invoice?.id;
  if (!invoiceId) throw new Error("Ledger did not return an invoice for this sale.");
  const saleTxnId = sale.data.invoice.saleTxnId || sale.data.transaction?.id || null;
  // Authoritative invoice number the ledger actually stored (equals ours on
  // first creation; on an idempotent replay it's whatever already existed).
  const ledgerInvoiceNo = sale.data.invoice.invoiceNumber || invoiceNumber;

  const method = booking?.completion?.payment_method === "BANK" ? "BANK" : "CASH";
  const pay = await authed(cred, "/payments", {
    method: "POST",
    body: {
      customerId,
      amount: totals.grand,
      method,
      invoiceId,
      paymentAccountId: (method === "BANK" ? cred.accounts?.bank : cred.accounts?.cash) || undefined,
      description: `Payment for ${ledgerInvoiceNo}`,
      appId: APP_ID,
      sourceId: `${bookingId}:payment`,
      date,
      actorRef,
      metadata,
    },
  });
  const paymentTxnId = pay.data?.transaction?.id || null;

  const {billUrl, billError} = await makeBill({booking, bookingId, invoiceNo: ledgerInvoiceNo, customerName});

  return {
    companyId: cred.companyId || null,
    customerId,
    invoiceId,
    invoiceNumber: ledgerInvoiceNo,
    saleTxnId,
    paymentTxnId,
    amount: totals.grand,
    method,
    billUrl,
    billError,
    posted_at: new Date().toISOString(),
  };
}

// Reverse a booking's ledger postings (correction / un-complete). v2 requires a
// non-empty reason on every reversal.
async function reverseSaleForBooking(bookingId, ledgerRefs, reason) {
  const bsnap = await admin.firestore().collection("bookings").doc(bookingId).get();
  const salonId = bsnap.data()?.salon_id;
  if (!salonId) throw new Error("Booking/salon not found");
  const {cred} = await ensureSalonLedger(salonId);
  const why = (reason && String(reason).trim()) || `Reversal of booking ${bookingId} from the CutQ salon dashboard`;
  const results = {};
  for (const [key, txnId] of [["payment", ledgerRefs?.paymentTxnId], ["sale", ledgerRefs?.saleTxnId]]) {
    if (!txnId) continue;
    try {
      await authed(cred, `/transactions/${txnId}/reverse`, {method: "POST", body: {reason: why}});
      results[key] = "reversed";
    } catch (err) {
      results[key] = `error: ${err.message}`;
    }
  }
  return results;
}

module.exports = {
  LEDGER_BASE,
  LEGACY_LEDGER_BASE,
  LEDGER_API_VERSION,
  APP_ID,
  ledgerFetch,
  authed,
  provisionSalon,
  ensureSalonLedger,
  getToken,
  computeTotals,
  istDate,
  recordSaleForBooking,
  reverseSaleForBooking,
  acctRef,
};
