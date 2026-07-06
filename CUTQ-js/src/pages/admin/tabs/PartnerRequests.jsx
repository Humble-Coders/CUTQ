import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Handshake, Loader2, Search, Phone, Mail, MapPin, Trash2, Store, User,
} from "lucide-react";
import {
  listenPartnerRequests, updatePartnerRequestStatus, deletePartnerRequest,
} from "../../../lib/adminFirestore";

const fmt = (ts) => {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  return d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
};

// status -> pill style
const STATUS = {
  new:       { label: "New",       cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  contacted: { label: "Contacted", cls: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  onboarded: { label: "Onboarded", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  rejected:  { label: "Rejected",  cls: "bg-gray-500/15 text-gray-400 border-gray-500/30" },
};
const STATUS_ORDER = ["new", "contacted", "onboarded", "rejected"];

export default function PartnerRequests() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const unsub = listenPartnerRequests((r) => { setRequests(r); setLoading(false); });
    return unsub;
  }, []);

  const counts = useMemo(() => {
    const c = { total: requests.length };
    STATUS_ORDER.forEach((s) => { c[s] = requests.filter((r) => (r.status || "new") === s).length; });
    return c;
  }, [requests]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests.filter((r) => {
      if (status && (r.status || "new") !== status) return false;
      if (q) {
        const hay = `${r.salon_name} ${r.owner_name} ${r.phone} ${r.email} ${r.city} ${r.message}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [requests, status, search]);

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Handshake size={18} className="text-[#18B79B]" /> Partner Requests
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          &ldquo;Become a Partner&rdquo; leads submitted from the CutQ landing page. Follow up and update each status.
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[180px] bg-white/5 border border-white/10 rounded px-2.5 py-1.5">
          <Search size={14} className="text-gray-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, city, phone…"
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-[#18B79B]">
          <option value="">All ({counts.total})</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>{STATUS[s].label} ({counts[s]})</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-12 text-gray-500"><Loader2 className="animate-spin" size={18} /></div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center">No partner requests.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((r) => <RequestCard key={r.id} r={r} />)}
        </div>
      )}
    </div>
  );
}

function RequestCard({ r }) {
  const [busy, setBusy] = useState(false);
  const cur = r.status || "new";
  const st = STATUS[cur] || STATUS.new;

  async function changeStatus(next) {
    if (next === cur) return;
    setBusy(true);
    try {
      await updatePartnerRequestStatus(r.id, next);
      toast.success(`Marked ${STATUS[next]?.label || next}`);
    } catch (e) { console.error(e); toast.error("Failed to update status"); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm(`Delete partner request from "${r.salon_name || r.owner_name}"?`)) return;
    setBusy(true);
    try {
      await deletePartnerRequest(r.id);
      toast.success("Deleted");
    } catch (e) { console.error(e); toast.error("Failed to delete"); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 flex flex-col gap-3">
      {/* top row */}
      <div className="flex items-start gap-2 flex-wrap">
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
        <span className="ml-auto text-[11px] text-gray-500">{fmt(r.created_at)}</span>
      </div>

      {/* salon + owner */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Store size={15} className="text-[#18B79B] mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm text-white truncate">{r.salon_name || "—"}</p>
            {r.city ? (
              <p className="text-xs text-gray-400 flex items-center gap-1"><MapPin size={11} /> {r.city}</p>
            ) : <p className="text-xs text-gray-600">No city</p>}
          </div>
        </div>
        <div className="flex items-start gap-2 min-w-0">
          <User size={15} className="text-[#18B79B] mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm text-white truncate">{r.owner_name || "—"}</p>
            <div className="flex flex-col">
              {r.phone ? (
                <a href={`tel:${r.phone}`} className="text-xs text-[#18B79B] hover:underline flex items-center gap-1">
                  <Phone size={11} /> {r.phone}
                </a>
              ) : <p className="text-xs text-gray-600">No phone</p>}
              {r.email && (
                <a href={`mailto:${r.email}`} className="text-xs text-[#18B79B] hover:underline flex items-center gap-1">
                  <Mail size={11} /> {r.email}
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* message */}
      {r.message && (
        <p className="text-sm text-gray-300 whitespace-pre-wrap border-t border-white/10 pt-2">{r.message}</p>
      )}

      {/* actions */}
      <div className="flex items-center gap-2 flex-wrap border-t border-white/10 pt-2.5">
        <span className="text-[11px] text-gray-500">Set status:</span>
        {STATUS_ORDER.map((s) => (
          <button key={s} onClick={() => changeStatus(s)} disabled={busy}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors disabled:opacity-50 ${
              s === cur ? STATUS[s].cls : "bg-white/5 text-gray-400 border-white/10 hover:border-[#18B79B]/50"
            }`}>
            {STATUS[s].label}
          </button>
        ))}
        <button onClick={remove} disabled={busy} className="ml-auto p-1.5 text-gray-500 hover:text-red-400 disabled:opacity-50" title="Delete">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}
