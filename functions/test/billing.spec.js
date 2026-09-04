/**
 * The printed bill must agree with the books. `total` is the amount the ledger
 * actually posted; everything else on the bill is derived from it so the two can
 * never drift apart.
 *
 * Run with: npm test
 */
const assert = require("assert");
const billing = require("../billing");

const booking = (over = {}) => ({
  services: [{service_name: "Haircut", service_price: 300}, {service_name: "Shave", service_price: 200}],
  booking_fee: 20,
  discount_amount: 0,
  final_amount: 520,
  ...over,
});
const build = (over, total) => billing.buildInvoiceData({
  booking: booking(over), invoiceNo: "CUTQ-ROFUWG-2026-0001",
  salon: {name: "Shadows", city: "Ludhiana"}, customerName: "Asha", total,
});

describe("buildInvoiceData", () => {
  it("prints the amount that was posted, not a recomputation", () => {
    const d = build({}, 520);
    assert.strictEqual(d.total, 520);
    assert.strictEqual(d.amountPaid, 520);
    assert.strictEqual(d.subtotal, 520); // 300 + 200 + 20 fee
    assert.strictEqual(d.discount, undefined); // omitted when zero
  });

  it("derives the discount so the bill always adds up", () => {
    // Services + fee = 520, posted 400 -> the bill must show a 120 discount, no
    // matter what discount_amount claims.
    const d = build({discount_amount: 999, final_amount: 400}, 400);
    assert.strictEqual(d.subtotal, 520);
    assert.strictEqual(d.discount, 120);
    assert.strictEqual(d.subtotal - d.discount, d.total);
  });

  it("handles a fully comped booking", () => {
    // The regression: total came from `Number(final_amount) || <computed>`, and 0
    // is falsy, so a genuinely-zero bill silently fell through to the fallback.
    const d = build({discount_amount: 520, final_amount: 0}, 0);
    assert.strictEqual(d.total, 0);
    assert.strictEqual(d.amountPaid, 0);
    assert.strictEqual(d.discount, 520);
    assert.strictEqual(d.subtotal - d.discount, 0);
  });

  it("never prints a negative discount", () => {
    const d = build({}, 600); // posted more than the lines (should not happen)
    assert.strictEqual(d.discount, undefined);
    assert.strictEqual(d.total, 600);
  });

  it("refuses to build without a posted total", () => {
    assert.throws(() => build({}, undefined), /total is required/);
    assert.throws(() => build({}, NaN), /total is required/);
  });

  it("omits the booking-fee line when there is no fee", () => {
    const d = build({booking_fee: 0}, 500);
    assert.strictEqual(d.lineItems.length, 2);
    assert.strictEqual(d.subtotal, 500);
  });

  it("leaves customer phone and gstin off the bill", () => {
    const d = build({customer_phone: "9876543210"}, 520);
    assert.strictEqual(d.customerPhone, undefined);
    assert.strictEqual(d.gstin, undefined);
  });
});

describe("generateInvoicePdf", () => {
  it("refuses to render without a tenant id", async () => {
    // Without tenantId the engine falls back to a key shared by every salon and
    // every other app on the bucket.
    await assert.rejects(() => billing.generateInvoicePdf({invoiceNo: "X"}), /tenantId .* is required/);
  });
});
