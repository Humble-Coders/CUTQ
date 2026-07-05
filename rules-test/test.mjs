import { readFileSync } from "fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, getDocs } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "cutq-rules-test",
  firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
});

const db = (uid) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());

await env.clearFirestore();
await env.withSecurityRulesDisabled(async (c) => {
  const d = c.firestore();
  await setDoc(doc(d, "Users/owner1"), { Role: "SALONOWNER", isEnabled: true, name: "Owner" });
  await setDoc(doc(d, "Users/team1"), { Role: "SALONTEAM", isEnabled: true, name: "Team" });
  await setDoc(doc(d, "Users/cust1"), { Role: "USER", isEnabled: true, name: "Cust1" });
  await setDoc(doc(d, "Users/cust2"), { Role: "USER", isEnabled: true, name: "Cust2" });
  await setDoc(doc(d, "Users/admin1"), { Role: "ADMIN", isEnabled: true });
  await setDoc(doc(d, "salons/salonA"), { owner_uid: "owner1", team_uids: ["team1"], name: "A", avg_rating: 4, review_count: 2, is_verified: true });
  await setDoc(doc(d, "salons/salonB"), { owner_uid: "ownerB", team_uids: [], name: "B" });
  await setDoc(doc(d, "salons/salonA/services/s1"), { name: "Cut", price: 100, is_active: true });
  await setDoc(doc(d, "salons/salonA/team/team1"), { uid: "team1", modules: ["dashboard"] });
  await setDoc(doc(d, "salons/salonA/cutq_remittances/r1"), { amount: 5 });
  await setDoc(doc(d, "bookings/bk1"), { user_id: "cust1", salon_id: "salonA", status: "pending" });
  await setDoc(doc(d, "bookings/bk2"), { user_id: "cust2", salon_id: "salonA", status: "completed" });
  await setDoc(doc(d, "ledger_accounts/salonA"), { email: "x", password: "secret" });
  await setDoc(doc(d, "app_config/invoice_counter"), { seq: 5 });
  await setDoc(doc(d, "app_config/settings"), { booking_fee: 5 });
  await setDoc(doc(d, "service_categories/c1"), { name: "Hair" });
});

let pass = 0; let fail = 0;
async function ok(name, p) { try { await assertSucceeds(p); console.log("  PASS(allow)", name); pass++; } catch (e) { console.log("  FAIL(should allow)", name, "|", e.message.slice(0, 80)); fail++; } }
async function no(name, p) { try { await assertFails(p); console.log("  PASS(deny) ", name); pass++; } catch (e) { console.log("  FAIL(should deny)", name); fail++; } }

console.log("USERS");
await ok("cust reads own", getDoc(doc(db("cust1"), "Users/cust1")));
await ok("staff reads customer (enrichment)", getDoc(doc(db("owner1"), "Users/cust1")));
await ok("admin reads any user", getDoc(doc(db("admin1"), "Users/cust1")));
await no("customer reads another customer PII", getDoc(doc(db("cust1"), "Users/cust2")));
await no("anon reads user", getDoc(doc(db(null), "Users/cust1")));
await ok("signup as USER", setDoc(doc(db("newu"), "Users/newu"), { Role: "USER", isEnabled: true, name: "N" }));
await no("signup as ADMIN", setDoc(doc(db("evil"), "Users/evil"), { Role: "ADMIN", isEnabled: true }));
await no("self-grant salon_access", setDoc(doc(db("evil2"), "Users/evil2"), { Role: "USER", salon_access: { salonA: {} } }));
await ok("edit own name", updateDoc(doc(db("cust1"), "Users/cust1"), { name: "New" }));
await no("escalate own Role", updateDoc(doc(db("cust1"), "Users/cust1"), { Role: "ADMIN" }));
await no("write other user", updateDoc(doc(db("cust1"), "Users/cust2"), { name: "hax" }));

console.log("SALONS");
await ok("public reads salon", getDoc(doc(db(null), "salons/salonA")));
await ok("owner edits salon name", updateDoc(doc(db("owner1"), "salons/salonA"), { name: "A2" }));
await ok("team edits salon name", updateDoc(doc(db("team1"), "salons/salonA"), { name: "A3" }));
await no("owner tampers avg_rating", updateDoc(doc(db("owner1"), "salons/salonA"), { avg_rating: 5 }));
await no("outsider edits salon", updateDoc(doc(db("cust1"), "salons/salonA"), { name: "hax" }));
await ok("admin verifies salon", updateDoc(doc(db("admin1"), "salons/salonA"), { is_verified: true }));
await ok("owner writes service", setDoc(doc(db("owner1"), "salons/salonA/services/s2"), { name: "New", price: 50 }));
await no("outsider writes service", setDoc(doc(db("cust1"), "salons/salonA/services/s3"), { name: "x" }));
await no("read team roster as outsider", getDoc(doc(db("cust1"), "salons/salonA/team/team1")));
await ok("staff reads team roster", getDoc(doc(db("owner1"), "salons/salonA/team/team1")));
await no("client writes team roster", setDoc(doc(db("owner1"), "salons/salonA/team/x"), { uid: "x" }));
await ok("staff writes stylist_stats", setDoc(doc(db("owner1"), "salons/salonA/stylist_stats/st1"), { services_count: 1 }));

console.log("BOOKINGS");
await ok("user reads own booking", getDoc(doc(db("cust1"), "bookings/bk1")));
await ok("signed-in reads other booking (availability)", getDoc(doc(db("cust1"), "bookings/bk2")));
await no("anon reads booking", getDoc(doc(db(null), "bookings/bk2")));
await ok("availability query (salon's bookings)", getDocs(collection(db("cust1"), "bookings")));
await ok("staff reads salon booking", getDoc(doc(db("owner1"), "bookings/bk2")));
await ok("user creates own pending booking", setDoc(doc(db("cust1"), "bookings/bknew"), { user_id: "cust1", salon_id: "salonA", status: "pending" }));
await no("user creates booking as other", setDoc(doc(db("cust1"), "bookings/bkx"), { user_id: "cust2", salon_id: "salonA", status: "pending" }));
await no("user creates non-pending", setDoc(doc(db("cust1"), "bookings/bky"), { user_id: "cust1", salon_id: "salonA", status: "completed" }));
await ok("staff creates walk-in", setDoc(doc(db("owner1"), "bookings/bkwalk"), { user_id: null, salon_id: "salonA", status: "completed", is_walk_in: true }));
await ok("user cancels own booking", updateDoc(doc(db("cust1"), "bookings/bk1"), { status: "cancelled" }));
await ok("staff completes salon booking", updateDoc(doc(db("owner1"), "bookings/bk2"), { status: "completed" }));
await no("outsider updates booking", updateDoc(doc(db("cust2"), "bookings/bk1"), { status: "cancelled" }));

console.log("REVIEWS / CATALOG / CONFIG / SECRETS");
await ok("user creates own review", addDoc(collection(db("cust1"), "salon_reviews"), { user_id: "cust1", salon_id: "salonA", rating: 5 }));
await no("review as other user", addDoc(collection(db("cust1"), "salon_reviews"), { user_id: "cust2", salon_id: "salonA", rating: 5 }));
await no("review bad rating", addDoc(collection(db("cust1"), "salon_reviews"), { user_id: "cust1", rating: 9 }));
await ok("public reads reviews", getDocs(collection(db(null), "salon_reviews")));
await ok("public reads categories", getDoc(doc(db(null), "service_categories/c1")));
await no("non-admin writes category", setDoc(doc(db("owner1"), "service_categories/c2"), { name: "x" }));
await ok("admin writes category", setDoc(doc(db("admin1"), "service_categories/c2"), { name: "Nails" }));
await ok("public reads booking fee", getDoc(doc(db(null), "app_config/settings")));
await no("read invoice_counter", getDoc(doc(db("owner1"), "app_config/invoice_counter")));
await no("write invoice_counter", updateDoc(doc(db("owner1"), "app_config/invoice_counter"), { seq: 999 }));
await no("read ledger_accounts (secrets)", getDoc(doc(db("owner1"), "ledger_accounts/salonA")));
await no("admin reads ledger_accounts", getDoc(doc(db("admin1"), "ledger_accounts/salonA")));
await ok("salon staff writes category index", setDoc(doc(db("owner1"), "salon_category_index/salonA_c1"), { salon_id: "salonA", category_id: "c1" }));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
