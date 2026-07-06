import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Flag, Plus, Trash2, Loader2, Mail, X, Check, Search, ChevronDown,
} from "lucide-react";
import {
  listenReportCategories, addReportCategory, updateReportCategory, deleteReportCategory,
  listenReportConfig, saveReportNotifyEmails, listenReports, updateReportStatus,
} from "../../../lib/adminFirestore";

const fmt = (ts) => {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  return d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
};

const SECTIONS = [
  { id: "reports", label: "Reports" },
  { id: "categories", label: "Categories" },
  { id: "emails", label: "Notify emails" },
];

export default function Reports() {
  const [section, setSection] = useState("reports");
  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Flag size={18} className="text-[#18B79B]" /> Issue Reports
        </h2>
        <p className="text-xs text-gray-500 mt-1">Reports filed by users, the categories they pick from, and who gets emailed.</p>
      </div>
      <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-lg p-1 w-fit">
        {SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${section === s.id ? "bg-[#18B79B] text-white" : "text-gray-400 hover:text-white"}`}>
            {s.label}
          </button>
        ))}
      </div>
      {section === "reports" && <ReportsList />}
      {section === "categories" && <CategoriesManager />}
      {section === "emails" && <EmailsManager />}
    </div>
  );
}

// ── Reports list ────────────────────────────────────────────────────────────────
function ReportsList() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const unsub = listenReports((r) => { setReports(r); setLoading(false); });
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reports.filter((r) => {
      if (status && (r.status || "open") !== status) return false;
      if (q) {
        const hay = `${r.category_name} ${r.description} ${r.user_name} ${r.booking_brief?.salon_name || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [reports, status, search]);

  const openCount = reports.filter((r) => (r.status || "open") === "open").length;

  async function setResolved(r, resolved) {
    try {
      await updateReportStatus(r.id, resolved ? "resolved" : "open");
      toast.success(resolved ? "Marked resolved — user notified" : "Reopened");
    } catch (e) { console.error(e); toast.error("Failed to update status"); }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[180px] bg-white/5 border border-white/10 rounded px-2.5 py-1.5">
          <Search size={14} className="text-gray-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search reports…"
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-[#18B79B]">
          <option value="">All ({reports.length})</option>
          <option value="open">Open ({openCount})</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-12 text-gray-500"><Loader2 className="animate-spin" size={18} /></div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center">No reports.</p>
      ) : (
        filtered.map((r) => <ReportCard key={r.id} r={r} onResolve={setResolved} />)
      )}
    </div>
  );
}

function ReportCard({ r, onResolve }) {
  const [open, setOpen] = useState(false);
  const resolved = (r.status || "open") === "resolved";
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-[#18B79B]/15 text-[#18B79B] border-[#18B79B]/30">
          {r.category_name || "—"}
        </span>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${resolved ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-amber-500/15 text-amber-300 border-amber-500/30"}`}>
          {resolved ? "Resolved" : "Open"}
        </span>
        <span className="ml-auto text-[11px] text-gray-500">{fmt(r.created_at)}</span>
      </div>
      <p className="text-sm text-gray-200 whitespace-pre-wrap">{r.description}</p>
      <div className="text-xs text-gray-400">
        By <span className="text-gray-200">{r.user_name || "Unknown"}</span>
        {r.user_phone && <a href={`tel:${r.user_phone}`} className="text-[#18B79B] hover:underline ml-1">{r.user_phone}</a>}
      </div>
      {r.about_booking && r.booking_id && (
        <div className="text-xs text-gray-400 border-t border-white/10 pt-2">
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-gray-300 hover:text-white">
            Booking: {r.booking_brief?.salon_name || r.booking_id}
            <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {open && (
            <div className="mt-1.5 pl-2 text-gray-400">
              <div>ID: <span className="font-mono text-gray-300">{r.booking_id}</span></div>
              {r.booking_brief?.services?.length > 0 && (
                <div className="mt-0.5">Services: {r.booking_brief.services.map((s) => s.service_name || s.name).join(", ")}</div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex justify-end pt-1">
        {resolved ? (
          <button onClick={() => onResolve(r, false)} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded border border-white/10">Reopen</button>
        ) : (
          <button onClick={() => onResolve(r, true)} className="flex items-center gap-1.5 text-xs font-semibold bg-[#18B79B] hover:bg-[#15a389] text-white px-3 py-1.5 rounded">
            <Check size={13} /> Mark resolved
          </button>
        )}
      </div>
    </div>
  );
}

// ── Categories ──────────────────────────────────────────────────────────────────
function CategoriesManager() {
  const [cats, setCats] = useState([]);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => listenReportCategories(setCats), []);

  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    try {
      await addReportCategory(name, cats.length);
      setName("");
    } catch (err) { console.error(err); toast.error("Failed to add category"); }
    finally { setAdding(false); }
  }

  return (
    <div className="flex flex-col gap-3 max-w-md">
      <form onSubmit={add} className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category name"
          className="flex-1 bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
        <button type="submit" disabled={adding} className="flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-50">
          {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
        </button>
      </form>
      {cats.length === 0 ? (
        <p className="text-xs text-gray-500">No categories yet.</p>
      ) : cats.map((c) => (
        <div key={c.id} className="flex items-center gap-3 bg-white/5 border border-white/10 rounded px-3 py-2">
          <span className={`text-sm ${c.is_active ? "text-white" : "text-gray-500 line-through"}`}>{c.name}</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => updateReportCategory(c.id, { is_active: !c.is_active })}
              className={`text-[10px] px-2 py-0.5 rounded-full border ${c.is_active ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-gray-500/15 text-gray-400 border-gray-500/30"}`}>
              {c.is_active ? "Active" : "Hidden"}
            </button>
            <button onClick={() => { if (confirm(`Delete "${c.name}"?`)) deleteReportCategory(c.id); }}
              className="p-1 text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Notify emails ─────────────────────────────────────────────────────────────────
function EmailsManager() {
  const [emails, setEmails] = useState([]);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => listenReportConfig((c) => setEmails(c.notify_emails || [])), []);

  async function persist(next) {
    setSaving(true);
    try { await saveReportNotifyEmails(next); }
    catch (e) { console.error(e); toast.error("Failed to save"); }
    finally { setSaving(false); }
  }
  function add(e) {
    e.preventDefault();
    const v = input.trim().toLowerCase();
    if (!v || !v.includes("@")) return toast.error("Enter a valid email");
    if (emails.includes(v)) return toast.error("Already added");
    persist([...emails, v]);
    setInput("");
  }
  function remove(v) { persist(emails.filter((e) => e !== v)); }

  return (
    <div className="flex flex-col gap-3 max-w-md">
      <p className="text-xs text-gray-500">Everyone here gets an email whenever a new report is filed or a new partner request comes in from the landing page.</p>
      <form onSubmit={add} className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} type="email" placeholder="alerts@company.com"
          className="flex-1 bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
        <button type="submit" disabled={saving} className="flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
        </button>
      </form>
      {emails.length === 0 ? (
        <p className="text-xs text-gray-500">No recipients — reports won't trigger emails until you add one.</p>
      ) : emails.map((e) => (
        <div key={e} className="flex items-center gap-2 bg-white/5 border border-white/10 rounded px-3 py-2">
          <Mail size={14} className="text-[#18B79B]" />
          <span className="text-sm text-gray-200">{e}</span>
          <button onClick={() => remove(e)} className="ml-auto p-1 text-gray-500 hover:text-red-400"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
