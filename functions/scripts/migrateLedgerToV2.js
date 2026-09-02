/*
 * One-shot: move every salon still holding a pre-v2 ledger record onto Humble
 * Ledger v2, now, instead of waiting for the lazy migration to fire on the
 * salon's next posting or Accounts view.
 *
 * It calls the same provisionSalon() the callables use — no separate code path —
 * so the v1 record is archived to ledger_accounts_v1 and a fresh company is
 * registered on the v2 host. Salons already on v2 are skipped.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<serviceAccount.json> \
 *     node scripts/migrateLedgerToV2.js          # report only
 *   GOOGLE_APPLICATION_CREDENTIALS=<serviceAccount.json> \
 *     node scripts/migrateLedgerToV2.js --apply  # actually migrate
 */
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const PROJECT = process.env.GCLOUD_PROJECT || "cutq-e133a";

admin.initializeApp({credential: admin.credential.applicationDefault(), projectId: PROJECT});
const ledger = require("../ledger");
const db = admin.firestore();

const isCurrent = (d) => Boolean(d && d.email && d.accounts && d.apiVersion === ledger.LEDGER_API_VERSION);

(async () => {
  console.log(`project ${PROJECT} · ledger ${ledger.LEDGER_BASE}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: report only (pass --apply to migrate)\n");

  const salons = await db.collection("salons").get();
  const pending = [];
  for (const s of salons.docs) {
    const rec = (await db.collection("ledger_accounts").doc(s.id).get()).data();
    const state = isCurrent(rec) ? "v2" : rec && rec.email && rec.accounts ? "v1" : "none";
    console.log(`  ${state.padEnd(4)} ${s.id}  ${s.data().name || ""}`);
    if (state !== "v2") pending.push(s.id);
  }
  if (!pending.length) {
    console.log("\nEvery salon is already on v2.");
    process.exit(0);
  }
  console.log(`\n${pending.length} salon(s) to migrate.`);
  if (!APPLY) process.exit(0);

  let ok = 0;
  for (const salonId of pending) {
    process.stdout.write(`  migrating ${salonId} … `);
    try {
      const rec = await ledger.provisionSalon(salonId);
      const archived = (await db.collection("ledger_accounts_v1").doc(salonId).get()).exists;
      console.log(`done (company ${rec.companyId || "?"}, v1 archived: ${archived})`);
      ok++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }
  console.log(`\n${ok}/${pending.length} migrated.`);
  process.exit(ok === pending.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
