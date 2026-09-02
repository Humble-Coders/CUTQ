/*
 * End-to-end verification of the Humble Ledger v2 integration.
 *
 * Registers a THROWAWAY company on the ledger API and drives exactly the calls
 * ledger.js makes for a salon, asserting every response shape the Cloud
 * Functions and the dashboard Accounts page depend on. Several of those shapes
 * (ledger rows, P&L, trial balance, balance sheet) are not described in the
 * OpenAPI spec, so this script is the only way to confirm them.
 *
 * It writes only to the throwaway company it creates — no CutQ salon is touched.
 *
 *   node scripts/verifyLedgerV2.js
 *   LEDGER_BASE_URL=http://localhost:3001/api/v1 node scripts/verifyLedgerV2.js
 *
 * Re-runs should reuse the company the first run printed, so repeated
 * verification does not litter the ledger with new tenants:
 *   LEDGER_VERIFY_EMAIL=... LEDGER_VERIFY_PASSWORD=... node scripts/verifyLedgerV2.js
 */

const BASE = process.env.LEDGER_BASE_URL || "https://hl.humblesolutions.in/api/v1";
const APP_ID = "cutq";

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail === undefined ? "" : ` — got ${JSON.stringify(detail)}`}`);
  }
}

function section(t) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
}

async function api(path, {method = "GET", token, body, query} = {}) {
  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ""),
    ).toString();
    if (qs) url += "?" + qs;
  }
  const res = await fetch(url, {
    method,
    headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Bearer ${token}`} : {})},
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
    const err = new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const keys = (o) => (o && typeof o === "object" ? Object.keys(o) : []);
const num = (v) => Number(v || 0);

(async () => {
  const stamp = Date.now();
  const reuseCompany = Boolean(process.env.LEDGER_VERIFY_EMAIL && process.env.LEDGER_VERIFY_PASSWORD);
  const email = process.env.LEDGER_VERIFY_EMAIL || `verify-${stamp}@ledger.cutq.internal`;
  const password = process.env.LEDGER_VERIFY_PASSWORD || `Verify-${stamp}-pw`;

  console.log(`Humble Ledger v2 verification\nbase: ${BASE}\n${reuseCompany ? `reusing: ${email}` : `company: cutq-verify-${stamp}`}`);

  // ── 1. Register (or log in to the company a previous run created) ──────────
  section(reuseCompany ? "auth/login" : "auth/register");
  const reg = reuseCompany ?
    await api("/auth/login", {method: "POST", body: {email, password}}) :
    await api("/auth/register", {
      method: "POST",
      body: {
        companyName: `CutQ Verify ${stamp}`,
        companySlug: `cutq-verify-${stamp}`,
        currency: "INR",
        name: "Verify Owner",
        email,
        password,
      },
    });
  const auth = reg.data;
  check("returns accessToken", typeof auth.accessToken === "string");
  check("returns refreshToken", typeof auth.refreshToken === "string");
  check("keeps `token` alias", typeof auth.token === "string");
  let token = auth.accessToken || auth.token;
  const jwt = (() => {
    try {
      return JSON.parse(Buffer.from(String(token).split(".")[1], "base64").toString());
    } catch {
      return null;
    }
  })();
  let companyId = auth?.user?.company?.id || auth?.user?.companyId || jwt?.companyId || null;
  if (!companyId) {
    const me = await api("/auth/me", {token});
    companyId = me?.data?.company?.id || me?.data?.companyId || null;
    check("companyId resolved via /auth/me fallback", Boolean(companyId), keys(me?.data));
  } else {
    check("companyId resolved from the auth response or JWT", true);
  }

  // ── 2. Seeded chart of accounts ────────────────────────────────────────────
  section("accounts (seeded chart)");
  const acctRes = await api("/accounts", {token, query: {page: 1, limit: 200}});
  const accts = acctRes.data || [];
  console.log("  seeded:", accts.map((a) => `${a.name} [${a.type}]`).join(", ") || "(none)");
  check("pagination meta present", keys(acctRes.meta).includes("hasMore"), keys(acctRes.meta));
  const byName = (n) => accts.find((a) => String(a.name).toLowerCase() === n.toLowerCase());
  // ledger.js prefers Service Revenue and falls back to Sales Revenue.
  const revenue = byName("Service Revenue") || byName("Sales Revenue");
  check("a revenue account exists (Service/Sales Revenue)", Boolean(revenue));
  check("Cash exists", Boolean(byName("Cash")));
  check("Bank exists", Boolean(byName("Bank")));
  check("Accounts Receivable exists", Boolean(byName("Accounts Receivable")));

  // ── 3. Accounts we create at provisioning ──────────────────────────────────
  section("accounts (provisioned by CutQ)");
  // Exactly what resolveAccounts() does: use the seeded account if present,
  // create it only when absent.
  const ensure = async (name, type) => {
    const hit = byName(name);
    if (hit) {
      check(`${name} resolved from the seeded chart`, true);
      return hit;
    }
    const made = await api("/accounts", {method: "POST", token, body: {name, type}});
    check(`create ${name} -> data.id`, Boolean(made.data?.id));
    return made.data;
  };
  const feeAcct = await ensure("CutQ Booking Fees", "EXPENSE");
  const opAcct = await ensure("Operating Expense", "EXPENSE");
  check("CutQ Booking Fees id resolved", Boolean(feeAcct?.id));
  check("Operating Expense id resolved", Boolean(opAcct?.id));
  let dupStatus = null;
  try {
    await api("/accounts", {method: "POST", token, body: {name: "CutQ Booking Fees", type: "EXPENSE"}});
  } catch (e) {
    dupStatus = e.status;
  }
  check("duplicate account name -> 409 (resolveAccounts re-reads and resolves)", dupStatus === 409, dupStatus);

  // ── 4. Vendor + customer idempotency ───────────────────────────────────────
  section("vendors / customers (idempotent on externalId)");
  const v1 = await api("/vendors", {method: "POST", token, body: {name: "CutQ Platform", externalId: "cutq_platform"}});
  const v2 = await api("/vendors", {method: "POST", token, body: {name: "CutQ Platform", externalId: "cutq_platform"}});
  check("vendor create -> data.id", Boolean(v1.data?.id));
  check("vendor replay returns same id", v1.data?.id === v2.data?.id, {a: v1.data?.id, b: v2.data?.id});
  const c1 = await api("/customers", {method: "POST", token, body: {name: "Asha K", phone: "9876500000", externalId: "user_verify_1"}});
  const c2 = await api("/customers", {method: "POST", token, body: {name: "Asha K", phone: "9876500000", externalId: "user_verify_1"}});
  check("customer create -> data.id", Boolean(c1.data?.id));
  check("customer replay returns same id", c1.data?.id === c2.data?.id, {a: c1.data?.id, b: c2.data?.id});
  const customerId = c1.data.id;

  // ── 5. Sale (the booking posting) ──────────────────────────────────────────
  section("sales");
  const invoiceNumber = `CUTQ-VERIFY-${stamp}`;
  const date = new Date().toISOString().slice(0, 10);
  const amount = 1250;
  const saleBody = {
    customerId,
    amount,
    description: `Booking verify_${stamp} — Asha K`,
    appId: APP_ID,
    sourceId: `verify_${stamp}:sale`,
    invoiceNumber,
    date,
    revenueAccountId: revenue?.id || undefined,
    actorRef: "verify_uid",
    metadata: {bookingId: `verify_${stamp}`, salonId: "verify_salon", isWalkIn: false},
  };
  const sale = await api("/sales", {method: "POST", token, body: saleBody});
  check("sale -> data.invoice.id", Boolean(sale.data?.invoice?.id), keys(sale.data));
  check("sale -> invoice.saleTxnId or transaction.id", Boolean(sale.data?.invoice?.saleTxnId || sale.data?.transaction?.id));
  check("sale honours our invoiceNumber", sale.data?.invoice?.invoiceNumber === invoiceNumber, sale.data?.invoice?.invoiceNumber);
  check("sale total equals amount posted", num(sale.data?.invoice?.total) === amount, sale.data?.invoice?.total);
  check("accepts actorRef + metadata", true);
  const invoiceId = sale.data.invoice.id;
  const saleTxnId = sale.data.invoice.saleTxnId || sale.data.transaction?.id;

  const replay = await api("/sales", {method: "POST", token, body: saleBody});
  check("(appId,sourceId) replay returns the same invoice", replay.data?.invoice?.id === invoiceId, replay.data?.invoice?.id);

  // A fully-comped booking totals 0. recordSaleForBooking short-circuits rather
  // than posting it — this proves the API would otherwise reject it forever.
  let zeroStatus = null;
  try {
    await api("/sales", {
      method: "POST", token,
      body: {...saleBody, amount: 0, sourceId: `verify_${stamp}:zero`, invoiceNumber: `${invoiceNumber}-Z`},
    });
  } catch (e) {
    zeroStatus = e.status;
  }
  check("amount 0 is rejected (comped bookings must be short-circuited)", zeroStatus !== null, zeroStatus);

  // ── 6. Payment ─────────────────────────────────────────────────────────────
  section("payments");
  const payRes = await api("/payments", {
    method: "POST", token,
    body: {
      customerId, amount, method: "CASH", invoiceId,
      paymentAccountId: byName("Cash")?.id,
      description: `Payment for ${invoiceNumber}`,
      appId: APP_ID, sourceId: `verify_${stamp}:payment`, date,
      actorRef: "verify_uid", metadata: saleBody.metadata,
    },
  });
  check("payment -> data.transaction.id", Boolean(payRes.data?.transaction?.id), keys(payRes.data));
  const payTxnId = payRes.data.transaction.id;

  // A retry after a crash between the payment call and the Firestore write must
  // NOT settle the invoice twice.
  const payReplay = await api("/payments", {
    method: "POST", token,
    body: {
      customerId, amount, method: "CASH", invoiceId,
      paymentAccountId: byName("Cash")?.id,
      description: `Payment for ${invoiceNumber}`,
      appId: APP_ID, sourceId: `verify_${stamp}:payment`, date,
    },
  });
  check("payment replay returns the original transaction", payReplay.data?.transaction?.id === payTxnId, payReplay.data?.transaction?.id);
  const inv = await api(`/invoices/${invoiceId}`, {token});
  check("invoice amountPaid did not double on replay", num(inv.data?.amountPaid) === amount, inv.data?.amountPaid);
  check("invoice is PAID", inv.data?.status === "PAID", inv.data?.status);

  // paymentAccountId is omitted when the account slot is unresolved — the ledger
  // must fall back to its own Cash/Bank account rather than reject the call.
  const payNoAcct = await api("/payments", {
    method: "POST", token,
    body: {customerId, amount: 1, method: "CASH", appId: APP_ID, sourceId: `verify_${stamp}:payadv`, date},
  });
  check("payment without paymentAccountId is accepted", Boolean(payNoAcct.data?.transaction?.id));

  // ── 7. Expense + vendor payment ────────────────────────────────────────────
  section("expenses / vendor-payments");
  const exp = await api("/expenses", {
    method: "POST", token,
    body: {
      amount: 300, expenseAccountId: opAcct.id, paymentMethod: "CASH",
      description: "Shop rent — verify", appId: APP_ID, sourceId: `verify_${stamp}:exp`, date,
    },
  });
  check("expense -> data.transaction.id", Boolean(exp.data?.transaction?.id), keys(exp.data));
  const vp = await api("/vendor-payments", {
    method: "POST", token,
    body: {
      vendorId: v1.data.id, amount: 100, method: "BANK",
      description: "CutQ booking-fee remittance", appId: APP_ID, sourceId: `verify_${stamp}:remit`, date,
    },
  });
  check("vendor-payment -> data.transaction.id", Boolean(vp.data?.transaction?.id), keys(vp.data));
  const expReplay = await api("/expenses", {
    method: "POST", token,
    body: {
      amount: 300, expenseAccountId: opAcct.id, paymentMethod: "CASH",
      description: "Shop rent — verify", appId: APP_ID, sourceId: `verify_${stamp}:exp`, date,
    },
  });
  check("expense replay returns the original transaction", expReplay.data?.transaction?.id === exp.data.transaction.id, expReplay.data?.transaction?.id);
  const vpReplay = await api("/vendor-payments", {
    method: "POST", token,
    body: {
      vendorId: v1.data.id, amount: 100, method: "BANK",
      description: "CutQ booking-fee remittance", appId: APP_ID, sourceId: `verify_${stamp}:remit`, date,
    },
  });
  check("vendor-payment replay returns the original transaction", vpReplay.data?.transaction?.id === vp.data.transaction.id, vpReplay.data?.transaction?.id);

  // ── 8. Transactions list (Accounts > Transactions tab) ─────────────────────
  section("transactions (dashboard: Transactions tab)");
  const txns = await api("/transactions", {token, query: {from: date, to: date, limit: 100}});
  const rows = txns.data || [];
  const one = rows[0];
  check("data is an array", Array.isArray(rows));
  check("row has postingType", Boolean(one?.postingType), keys(one));
  check("row has description (rendered in the UI)", one?.description !== undefined, keys(one));
  check("row has sourceId", one?.sourceId !== undefined);
  check("row has entries[] with type/amount", Array.isArray(one?.entries) && Boolean(one.entries[0]?.type) && one.entries[0]?.amount !== undefined, one?.entries?.[0]);
  const debitSum = (one?.entries || []).filter((e) => e.type === "DEBIT").reduce((s, e) => s + num(e.amount), 0);
  check("DEBIT entries sum to a positive amount (txnAmount())", debitSum > 0, debitSum);
  check("postingType filter accepted", Array.isArray((await api("/transactions", {token, query: {postingType: "SALE", limit: 5}})).data));

  // ── 9. Ledger (dashboard: Ledger tab) — shape NOT in the OpenAPI spec ──────
  section("ledger (dashboard: Ledger tab)");
  const led = await api("/ledger", {token, query: {accountId: revenue.id, from: date, to: date, limit: 200}});
  console.log("  top-level keys:", keys(led).join(", "));
  console.log("  data keys:", keys(led.data).join(", "));
  const lrow = (led.data?.rows || [])[0];
  console.log("  row keys:", keys(lrow).join(", "));
  check("data.account.name", Boolean(led.data?.account?.name), keys(led.data?.account));
  check("data.rows[] present", Array.isArray(led.data?.rows));
  check("data.closingBalance present", led.data?.closingBalance !== undefined);
  check("row has date/description/postingType", Boolean(lrow?.date && lrow?.postingType), keys(lrow));
  check("row has debit/credit/balance", lrow?.debit !== undefined && lrow?.credit !== undefined && lrow?.balance !== undefined, keys(lrow));

  // ── 10. Reports (dashboard: Overview + Reports tabs) — shapes NOT in spec ──
  section("reports/pnl (dashboard: Overview + Reports)");
  const pnl = (await api("/reports/pnl", {token, query: {from: date, to: date}})).data;
  console.log("  keys:", keys(pnl).join(", "));
  console.log("  income[0]:", JSON.stringify((pnl?.income || [])[0]));
  check("income[] present", Array.isArray(pnl?.income));
  check("expenses[] present", Array.isArray(pnl?.expenses));
  check("income row has accountId/name/balance", keys((pnl?.income || [])[0]).includes("name") && keys((pnl?.income || [])[0]).includes("balance"), keys((pnl?.income || [])[0]));
  check("totalIncome present", pnl?.totalIncome !== undefined);
  check("totalExpenses present", pnl?.totalExpenses !== undefined);
  check("netProfit present", pnl?.netProfit !== undefined);

  section("reports/trial-balance");
  const tb = (await api("/reports/trial-balance", {token, query: {date}})).data;
  console.log("  keys:", keys(tb).join(", "));
  console.log("  rows[0]:", JSON.stringify((tb?.rows || [])[0]));
  check("rows[] present", Array.isArray(tb?.rows));
  check("row has accountName", keys((tb?.rows || [])[0]).includes("accountName"), keys((tb?.rows || [])[0]));
  check("row has totalDebit/totalCredit", keys((tb?.rows || [])[0]).includes("totalDebit") && keys((tb?.rows || [])[0]).includes("totalCredit"));
  check("isBalanced present", tb?.isBalanced !== undefined);
  check("totalDebit/totalCredit present", tb?.totalDebit !== undefined && tb?.totalCredit !== undefined);
  check("books balance", tb?.isBalanced === true, {d: tb?.totalDebit, c: tb?.totalCredit});

  section("reports/balance-sheet");
  const bs = (await api("/reports/balance-sheet", {token, query: {date}})).data;
  console.log("  keys:", keys(bs).join(", "));
  check("assets[] present", Array.isArray(bs?.assets));
  check("liabilities[] present", Array.isArray(bs?.liabilities));
  check("equity[] present", Array.isArray(bs?.equity));
  check("totalAssets present", bs?.totalAssets !== undefined);
  check("totalLiabilitiesAndEquity present", bs?.totalLiabilitiesAndEquity !== undefined);
  check("retainedEarnings present", bs?.retainedEarnings !== undefined);

  // ── 11. Receivables (dashboard: Overview 'Outstanding' card) ───────────────
  section("receivables (dashboard: Outstanding card)");
  const rec = await api("/receivables", {token, query: {limit: 200}});
  console.log("  top-level keys:", keys(rec).join(", "));
  console.log("  summary:", JSON.stringify(rec.summary));
  check("data[] present", Array.isArray(rec.data));
  check("summary.totalOutstanding present", rec?.summary?.totalOutstanding !== undefined, keys(rec.summary));

  // ── 11b. ledgerQuery's remaining resources ────────────────────────────────
  section("invoices / vendors (ledgerQuery resources)");
  const invList = await api("/invoices", {token, query: {limit: 50}});
  check("invoices data[] present", Array.isArray(invList.data));
  check("invoice row has invoiceNumber/total/status", Boolean(invList.data?.[0]?.invoiceNumber) && invList.data?.[0]?.total !== undefined, keys(invList.data?.[0]));
  const venList = await api("/vendors", {token, query: {limit: 50}});
  check("vendors data[] present", Array.isArray(venList.data));
  check("vendor row has name/payable", Boolean(venList.data?.[0]?.name) && venList.data?.[0]?.payable !== undefined, keys(venList.data?.[0]));
  const acctTypeFilter = await api("/accounts", {token, query: {type: "EXPENSE", limit: 200}});
  check("accounts type=EXPENSE filter works (Expenses tab)", Array.isArray(acctTypeFilter.data) && acctTypeFilter.data.every((a) => a.type === "EXPENSE"), acctTypeFilter.data?.map((a) => a.type));

  // Books must still balance after every posting this script made.
  const tb2 = (await api("/reports/trial-balance", {token, query: {date}})).data;
  check("books still balance after all postings", tb2?.isBalanced === true, {d: tb2?.totalDebit, c: tb2?.totalCredit});

  // ── 12. Reversal (ledgerReverseSale) ──────────────────────────────────────
  section("transactions/:id/reverse");
  let noReason = null;
  try {
    await api(`/transactions/${saleTxnId}/reverse`, {method: "POST", token, body: {}});
  } catch (e) {
    noReason = e.status;
  }
  check("reverse without reason is rejected (v2 requires it)", noReason !== null, noReason);
  const rev = await api(`/transactions/${saleTxnId}/reverse`, {
    method: "POST", token, body: {reason: `Reversal of booking verify_${stamp} from the CutQ salon dashboard`},
  });
  check("reverse with reason succeeds", rev.success !== false);

  // ── 13. Refresh-token rotation (getToken) ─────────────────────────────────
  section("auth/refresh (rotation)");
  const r1 = await api("/auth/refresh", {method: "POST", body: {refreshToken: auth.refreshToken}});
  check("refresh returns a new accessToken", typeof (r1.data?.accessToken || r1.data?.token) === "string");
  check("refresh rotates the refreshToken", Boolean(r1.data?.refreshToken) && r1.data.refreshToken !== auth.refreshToken);
  token = r1.data.accessToken || r1.data.token;
  check("rotated accessToken works", Array.isArray((await api("/accounts", {token, query: {limit: 5}})).data));
  let reuse = null;
  try {
    await api("/auth/refresh", {method: "POST", body: {refreshToken: auth.refreshToken}});
  } catch (e) {
    reuse = e.status;
  }
  check("old refreshToken is revoked after rotation (login fallback needed)", reuse !== null, reuse);

  // ── Result ────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(64)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) console.log("FAILED:\n  - " + failures.join("\n  - "));
  console.log(reuseCompany ?
    `reused company: ${email}` :
    `throwaway company: cutq-verify-${stamp}\nre-run without creating another tenant:\n  LEDGER_VERIFY_EMAIL=${email} LEDGER_VERIFY_PASSWORD='${password}' node scripts/verifyLedgerV2.js`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
