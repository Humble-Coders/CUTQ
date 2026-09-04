/*
 * CutQ Invoice API integration - generates a branded PDF bill for a completed
 * booking and returns a public URL.
 *
 * Contract (see http://68.183.86.89/cutq-docs/):
 *   POST { appId: "cutq", tenantId, data: {...} } -> { message, url }
 *   Optional fields are OMITTED (never sent as 0) so their rows are hidden.
 *
 * The engine writes into ONE S3 bucket shared by every Humble Solutions app. The
 * object key used to be (appId, invoiceNo) alone, which meant any two renders
 * agreeing on that pair silently overwrote each other — across customers of the
 * same app, and with no error, because PutObject on an existing key succeeds.
 * That is what happened to Aromex in Aug 2026: one client's invoice PDF was
 * replaced in place by another client's, and the stale URL kept resolving.
 *
 * Passing `tenantId` moves the object to `invoices/cutq/<tenantId>/<no>-<nonce>`.
 * We send the salon id: structurally unique per salon, not a display name and not
 * something a new salon could be provisioned with unchanged. The per-render nonce
 * also means re-issuing a bill never overwrites a PDF a customer already holds a
 * link to — it writes a new object and we store the new URL.
 */

const BILLING_URL = "https://ty7dvtg7bygzryorzmszp6ykjy0qlhsv.lambda-url.us-east-1.on.aws/";

function fmtBillDate(ms) {
  return new Date(ms || Date.now()).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  });
}

// Build the invoice `data` payload from a booking + salon + resolved customer.
// Amounts are kept identical to the accounting sale: line items are the
// services plus the CutQ booking fee; total = final_amount.
function buildInvoiceData({booking, invoiceNo, salon, customerName}) {
  const services = Array.isArray(booking.services) ? booking.services : [];
  const lineItems = services.map((s) => ({
    name: s.service_name || "Service",
    qty: 1,
    rate: Number(s.service_price) || 0,
  }));
  const fee = Number(booking.booking_fee) || 0;
  if (fee > 0) lineItems.push({name: "Booking Fee", qty: 1, rate: fee});

  const subtotal = lineItems.reduce((a, l) => a + l.qty * l.rate, 0);
  const discount = Number(booking.discount_amount) || 0;
  const total = Number(booking.final_amount) || Math.max(0, subtotal - discount);
  const when = booking.completion?.completed_at?.toMillis?.() ||
    booking.slot_start?.toMillis?.() || Date.now();
  // Compose the address from parts, skipping any part already present in what
  // we've built (salons often put the city inside the free-text address field).
  const addrParts = [];
  for (const raw of [salon.address, salon.city, salon.state, salon.pincode]) {
    const p = (raw || "").toString().trim();
    if (!p) continue;
    if (addrParts.join(", ").toLowerCase().includes(p.toLowerCase())) continue;
    addrParts.push(p);
  }
  const address = addrParts.join(", ");

  const data = {
    invoiceNo,
    date: fmtBillDate(when),
    salonName: salon.name || "Salon",
    salonAddress: address || (salon.city || "-"),
    customerName: customerName || "Customer",
    lineItems: lineItems.length ? lineItems : undefined,
    subtotal,
    total,
    amountPaid: total, // paid in full at completion
    currency: "INR",
  };
  // Optional rows - only include when meaningful (0/empty ⇒ omit so the row hides).
  if (discount > 0) data.discount = discount;
  if (salon.tagline) data.salonTagline = salon.tagline;
  // Customer phone / GSTIN are intentionally omitted for privacy.
  return data;
}

async function generateInvoicePdf(data, tenantId) {
  if (!tenantId) throw new Error("generateInvoicePdf: tenantId (salon id) is required.");
  const res = await fetch(BILLING_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({appId: "cutq", tenantId: String(tenantId), data}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {raw: text};
  }
  if (!res.ok || !json.url) {
    throw new Error(json.error || json.details || `Billing API ${res.status}`);
  }
  return json.url;
}

module.exports = {BILLING_URL, fmtBillDate, buildInvoiceData, generateInvoicePdf};
