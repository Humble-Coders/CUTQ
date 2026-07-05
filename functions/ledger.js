/*
 * Humble Ledger integration for CutQ salons.
 *
 * The salon dashboard cannot call the accounting API directly (its CORS is
 * locked to the API's own origin), so all traffic goes through Cloud Functions.
 *
 * Model: ONE Humble Ledger "company" per salon. Credentials + resolved account
 * ids live in Firestore `ledger_accounts/{salonId}` — a server-only collection
 * (no client access; functions use the admin SDK).
 *
 * A completed booking is posted as: SALE (amount = services + booking_fee −
 * discount → Service Revenue) then PAYMENT (same amount, Cash/Bank). The
 * booking fee is the salon's revenue here; the salon later remits collected
 * fees to CutQ as a separate vendor payment. The API dedupes on (appId,
 * sourceId), so every posting uses a distinct sourceId (`<bookingId>:sale`,
 * `<bookingId>:payment`) and we additionally guard with booking.ledger.posted.
 */

const admin = require("firebase-admin");
const {logger} = require("firebase-functions");
const billing = require("./billing");

const LEDGER_BASE = "https://ledger.humblesolutions.in/api/v1";
const APP_ID = "cutq";

// In-memory access-token cache per ledger email (survives warm invocations).
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
    const m = json?.error?.message || json?.message || json?.error || `Ledger API ${res.status}`;
    const err = new Error(typeof m === "string" ? m : JSON.stringify(m));
    err.status = res.status;
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

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    if (payload.exp) return payload.exp * 1000;
    if (payload.companyId) return null;
  } catch {
    // ignore
  }
  return null;
}

// Provision (register) a Humble Ledger company for a salon and store its
// credentials + resolved account ids. Idempotent: returns existing if present.
async function provisionSalon(salonId) {
  const ref = acctRef(salonId);
  const existing = await ref.get();
  if (existing.exists && existing.data().email && existing.data().accounts) {
    return existing.data();
  }

  // Claim a provisioning lock so two concurrent first-sales don't both register
  // a company (which would orphan a duplicate we can't recover the password for).
  const claim = await admin.firestore().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const dd = s.data() || {};
    if (dd.email && dd.accounts) return {done: dd};
    const lockedAt = dd.provisioning_at?.toMillis?.() || 0;
    if (dd.provisioning && Date.now() - lockedAt < 120000) return {busy: true};
    tx.set(ref, {provisioning: true, provisioning_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    return {claimed: true};
  });
  if (claim.done) return claim.done;
  if (claim.busy) {
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await ref.get();
      if (s.exists && s.data().email && s.data().accounts) return s.data();
    }
    throw new Error("Ledger provisioning already in progress; please retry shortly.");
  }

  const salonSnap = await admin.firestore().collection("salons").doc(salonId).get();
  if (!salonSnap.exists) throw new Error("Salon not found");
  const salon = salonSnap.data();

  const slug = `cutq-${salonId}`.toLowerCase().slice(0, 48);
  const email = `salon-${salonId}@ledger.cutq.internal`;
  const password = randomToken(20);

  let authData;
  try {
    const reg = await ledgerFetch("/auth/register", {
      method: "POST",
      body: {
        companyName: salon.name || `CutQ Salon ${salonId}`,
        companySlug: slug,
        currency: "INR",
        name: salon.name || "Salon Owner",
        email,
        password,
      },
    });
    authData = reg.data;
  } catch (err) {
    // Clear the lock so it can be retried. A prior partial provision may have
    // registered already — but we won't know that password.
    await ref.set({provisioning: false}, {merge: true}).catch(() => {});
    logger.error("provisionSalon register failed", {salonId, msg: err.message});
    throw err;
  }

  try {
    const token = tokenFrom(authData);

    const accts = (await ledgerFetch("/accounts", {token, query: {limit: 100}})).data || [];
    const byName = (n) => (accts.find((a) => a.name === n) || {}).id || null;
    const accounts = {
      serviceRevenue: byName("Service Revenue"),
      cash: byName("Cash"),
      bank: byName("Bank"),
      accountsReceivable: byName("Accounts Receivable"),
    };

    // Dedicated expense account for CutQ booking-fee remittances.
    const feeAcct = await ledgerFetch("/accounts", {
      method: "POST", token, body: {name: "CutQ Booking Fees", type: "EXPENSE"},
    });
    accounts.cutqBookingFees = feeAcct.data.id;

    // CutQ as a vendor (the salon pays it monthly).
    const vendor = await ledgerFetch("/vendors", {
      method: "POST", token, body: {name: "CutQ Platform", externalId: "cutq_platform"},
    });

    const record = {
      companyId: authData?.user?.companyId || null,
      slug,
      email,
      password,
      accounts,
      cutqVendorId: vendor.data.id,
      provisioning: false,
      provisioned_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    await ref.set(record, {merge: true});
    logger.info("Provisioned ledger company for salon", {salonId, slug});
    return record;
  } catch (err) {
    await ref.set({provisioning: false}, {merge: true}).catch(() => {});
    logger.error("provisionSalon setup failed", {salonId, msg: err.message});
    throw err;
  }
}

async function getToken(cred, force = false) {
  if (!force) {
    const cached = tokenCache.get(cred.email);
    if (cached && cached.exp > Date.now() + 60000) return cached.token;
  }
  const auth = await ledgerFetch("/auth/login", {
    method: "POST", body: {email: cred.email, password: cred.password},
  });
  const token = tokenFrom(auth.data);
  const exp = jwtExp(token) || Date.now() + 10 * 60 * 1000;
  tokenCache.set(cred.email, {token, exp});
  return token;
}

// Authenticated request that transparently re-logs in on a 401 (access token
// expired or rotated) and retries once. All authed ledger calls go through this.
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

// Ensure a salon has a provisioned ledger company; return {cred, token}.
async function ensureSalonLedger(salonId) {
  let snap = await acctRef(salonId).get();
  if (!snap.exists || !snap.data().email || !snap.data().accounts) {
    await provisionSalon(salonId);
    snap = await acctRef(salonId).get();
  }
  // The token is fetched lazily (and 401-retried) by authed(); no eager login.
  return {cred: snap.data()};
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

function todayISO(booking) {
  const c = booking?.completion?.completed_at?.toDate?.() || booking?.slot_start?.toDate?.() || new Date();
  return c.toISOString().slice(0, 10);
}

// Post a completed booking to the ledger (sale + payment). Returns ledger refs.
// Server-authoritative on amount; idempotent at the API via distinct sourceIds.
async function recordSaleForBooking(bookingId) {
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
  const externalId = booking.user_id || `booking_${bookingId}`;
  const cust = await authed(cred, "/customers", {
    method: "POST",
    body: {name: customerName, phone: customerPhone, externalId},
  });
  const customerId = cust.data.id;

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
      revenueAccountId: cred.accounts.serviceRevenue || undefined,
    },
  });
  const invoiceId = sale.data.invoice.id;
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
      paymentAccountId: method === "BANK" ? cred.accounts.bank : cred.accounts.cash,
      appId: APP_ID,
      sourceId: `${bookingId}:payment`,
      date,
    },
  });
  const paymentTxnId = pay.data.transaction?.id || null;

  // Generate the customer-facing PDF bill (idempotent per invoiceNo). A failure
  // here is non-fatal — the sale/payment are already posted; the bill can be
  // regenerated by retrying. We surface the error on the booking.
  let billUrl = null;
  let billError = null;
  try {
    const salonSnap = await admin.firestore().collection("salons").doc(booking.salon_id).get();
    const salon = salonSnap.exists ? salonSnap.data() : {};
    const invoiceData = billing.buildInvoiceData({booking, invoiceNo: ledgerInvoiceNo, salon, customerName});
    billUrl = await billing.generateInvoicePdf(invoiceData);
  } catch (err) {
    billError = String(err.message || err);
    logger.error("bill generation failed", {bookingId, msg: billError});
  }

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

// Reverse a booking's ledger postings (correction / un-complete).
async function reverseSaleForBooking(bookingId, ledgerRefs) {
  const bsnap = await admin.firestore().collection("bookings").doc(bookingId).get();
  const salonId = bsnap.data()?.salon_id;
  if (!salonId) throw new Error("Booking/salon not found");
  const {cred} = await ensureSalonLedger(salonId);
  const results = {};
  for (const [key, txnId] of [["payment", ledgerRefs?.paymentTxnId], ["sale", ledgerRefs?.saleTxnId]]) {
    if (!txnId) continue;
    try {
      await authed(cred, `/transactions/${txnId}/reverse`, {method: "POST", body: {}});
      results[key] = "reversed";
    } catch (err) {
      results[key] = `error: ${err.message}`;
    }
  }
  return results;
}

module.exports = {
  LEDGER_BASE,
  APP_ID,
  ledgerFetch,
  authed,
  provisionSalon,
  ensureSalonLedger,
  getToken,
  computeTotals,
  recordSaleForBooking,
  reverseSaleForBooking,
  acctRef,
};
