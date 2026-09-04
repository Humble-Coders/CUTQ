/*
 * Deploy Cloud Functions in small batches.
 *
 * A full `firebase deploy --only functions` fails on this project with
 *   "Container Healthcheck failed. Quota exceeded for total allowable CPU
 *    per project per region."
 * Each function reserves 1 vCPU and a rollout runs the old and new revisions
 * side by side, so deploying ~33 at once exceeds the us-central1 Cloud Run CPU
 * quota. Small batches stay under it. The real fix is a quota increase (Cloud
 * Console -> IAM & Admin -> Quotas -> Cloud Run Admin API, "Total CPU
 * allocation", us-central1); until then, use this.
 *
 *   node scripts/deployBatched.js                 # every exported function
 *   node scripts/deployBatched.js ledger          # only names containing "ledger"
 *   node scripts/deployBatched.js --size 2 auth   # smaller batches
 *
 * Failures are retried once, individually, because a batch failure is usually
 * contention rather than a bad function.
 */
const {execFileSync} = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const sizeAt = args.indexOf("--size");
const SIZE = sizeAt === -1 ? 3 : Number(args[sizeAt + 1]) || 3;
const filter = args.filter((a, i) => !a.startsWith("--") && i !== sizeAt + 1).join(" ").trim();
const PROJECT = process.env.FIREBASE_PROJECT || "cutq-e133a";
const ROOT = path.resolve(__dirname, "..", "..");

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || PROJECT;
const mod = require("../index.js");
let names = Object.keys(mod).filter((n) => typeof mod[n] === "function" || typeof mod[n] === "object");
if (filter) names = names.filter((n) => n.toLowerCase().includes(filter.toLowerCase()));

if (!names.length) {
  console.error(`No functions matched "${filter}".`);
  process.exit(1);
}

function deploy(batch) {
  const only = batch.map((n) => `functions:${n}`).join(",");
  try {
    execFileSync("npx", ["firebase", "deploy", "--project", PROJECT, "--non-interactive", "--only", only],
      {cwd: ROOT, stdio: "pipe", encoding: "utf8"});
    return {ok: true};
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    return {ok: false, quota: /Quota exceeded/i.test(out), out};
  }
}

const batches = [];
for (let i = 0; i < names.length; i += SIZE) batches.push(names.slice(i, i + SIZE));

console.log(`${names.length} function(s), ${batches.length} batch(es) of ${SIZE}, project ${PROJECT}\n`);
const failed = [];
batches.forEach((b, i) => {
  process.stdout.write(`  [${i + 1}/${batches.length}] ${b.join(", ")} … `);
  const r = deploy(b);
  console.log(r.ok ? "ok" : r.quota ? "QUOTA" : "FAILED");
  if (!r.ok) failed.push(...b);
});

if (failed.length) {
  console.log(`\n  retrying ${failed.length} individually…`);
  for (const n of [...failed]) {
    process.stdout.write(`    ${n} … `);
    const r = deploy([n]);
    console.log(r.ok ? "ok" : r.quota ? "QUOTA" : "FAILED");
    if (r.ok) failed.splice(failed.indexOf(n), 1);
  }
}

console.log(failed.length ? `\n${failed.length} still failing: ${failed.join(", ")}` : "\nAll deployed.");
process.exit(failed.length ? 1 : 0);
