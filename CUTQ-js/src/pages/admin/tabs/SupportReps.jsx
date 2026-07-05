import { useEffect, useState } from "react";
import { toast } from "sonner";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../../../firebase";
import { createSupportRep } from "../../../lib/adminFirestore";
import { UserPlus, Loader2, Copy, Check, Headphones } from "lucide-react";

/*
 * Admin-only: create a Customer Support Representative (Role: SUPPORT). The
 * account is created server-side (createSupportRep) with a generated password,
 * which is shown once here so the admin can share it. SUPPORT users can sign
 * into the admin panel and see only the Bookings section.
 */
export default function SupportReps() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null); // { email, password, isExisting }
  const [copied, setCopied] = useState(false);

  const [reps, setReps] = useState([]);
  const [loadingReps, setLoadingReps] = useState(true);

  async function loadReps() {
    setLoadingReps(true);
    try {
      const snap = await getDocs(query(collection(db, "Users"), where("Role", "==", "SUPPORT")));
      setReps(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error(err);
      setReps([]); // best-effort - rules may restrict Users reads
    } finally {
      setLoadingReps(false);
    }
  }

  useEffect(() => { loadReps(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!email.trim()) return toast.error("Email is required");
    setCreating(true);
    setCreated(null);
    try {
      const res = await createSupportRep(email.trim(), name.trim(), phone.trim());
      setCreated(res);
      if (res.isExisting) {
        toast.success("Existing account promoted to Support Rep");
      } else {
        toast.success("Support Rep created");
      }
      setEmail(""); setName(""); setPhone("");
      loadReps();
    } catch (err) {
      console.error(err);
      toast.error(err?.message || "Failed to create support rep");
    } finally {
      setCreating(false);
    }
  }

  function copyCreds() {
    if (!created?.password) return;
    navigator.clipboard.writeText(`Email: ${created.email}\nPassword: ${created.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Headphones size={18} className="text-[#18B79B]" /> Customer Support Reps
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          Support reps can sign into this panel and see only the Bookings section.
        </p>
      </div>

      {/* Create form */}
      <form onSubmit={handleCreate} className="flex flex-col gap-3 bg-white/5 rounded-lg p-4 border border-white/10">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Email *</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
            placeholder="support.rep@company.com"
            className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
          </div>
        </div>
        <button type="submit" disabled={creating}
          className="mt-1 self-start flex items-center gap-2 px-4 py-2 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-50 transition-colors">
          {creating ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
          Create Support Rep
        </button>
      </form>

      {/* Created credentials */}
      {created && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
          {created.isExisting ? (
            <p className="text-sm text-emerald-200">
              <b>{created.email}</b> already had an account - it's now a Support Rep. They keep their existing password.
            </p>
          ) : (
            <>
              <p className="text-sm text-emerald-200 mb-2">Account created. Share these credentials (shown once):</p>
              <div className="flex items-center gap-3 bg-black/30 rounded px-3 py-2">
                <div className="text-xs text-gray-200 font-mono">
                  <div>Email: {created.email}</div>
                  <div>Password: {created.password}</div>
                </div>
                <button onClick={copyCreds} className="ml-auto flex items-center gap-1 text-xs text-emerald-300 hover:text-emerald-200">
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Existing reps */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-gray-300">Existing reps</h3>
        {loadingReps ? (
          <p className="text-xs text-gray-500">Loading…</p>
        ) : reps.length === 0 ? (
          <p className="text-xs text-gray-500">No support reps yet.</p>
        ) : (
          reps.map((r) => (
            <div key={r.id} className="flex items-center gap-3 bg-white/5 border border-white/10 rounded px-3 py-2">
              <Headphones size={14} className="text-[#18B79B] flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm text-white truncate">{r.name || "-"}</p>
                <p className="text-xs text-gray-500 truncate">{r.email}</p>
              </div>
              <span className={`ml-auto text-[10px] px-2 py-0.5 rounded-full border ${r.isEnabled ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-gray-500/15 text-gray-400 border-gray-500/30"}`}>
                {r.isEnabled ? "Enabled" : "Disabled"}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
