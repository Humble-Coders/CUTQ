import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ClipboardList, Loader2, Trash2, ArrowRight, Store, User, MapPin, Phone, Mail } from "lucide-react";
import { listenSalonSubmissions, deleteSalonSubmission } from "../../../lib/adminFirestore";

const fmt = (ts) => {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  return d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
};

export default function SalonSubmissions({ onUseInAddSalon }) {
  const [subs, setSubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    const unsub = listenSalonSubmissions((s) => { setSubs(s); setLoading(false); });
    return unsub;
  }, []);

  async function remove(sub) {
    if (!confirm(`Delete the submission from "${sub.name || sub.owner_email}"? This also removes its uploaded images.`)) return;
    setBusy(sub.id);
    try {
      await deleteSalonSubmission(sub);
      toast.success("Submission deleted");
    } catch (e) { console.error(e); toast.error("Failed to delete submission"); }
    finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <ClipboardList size={18} className="text-[#18B79B]" /> Salon Onboarding
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          Details submitted by salons via the public form. Review one, then send it to Add Salon
          (prefilled and editable) to create the salon. Nothing is created automatically.
        </p>
        <p className="text-[11px] text-gray-600 mt-1">
          Public form link: <span className="text-[#18B79B]">admin.cutqsalons.in/onboard</span>
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12 text-gray-500"><Loader2 className="animate-spin" size={18} /></div>
      ) : subs.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center">No submissions yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {subs.map((s) => {
            const thumbs = [s.logo_url, s.cover_photo, ...(s.gallery || []).map((g) => g.url)].filter(Boolean);
            return (
              <div key={s.id} className="rounded-lg border border-white/10 bg-white/5 p-4 flex flex-col gap-3">
                <div className="flex items-start gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-amber-500/15 text-amber-300 border-amber-500/30 capitalize">
                    {s.status || "new"}
                  </span>
                  <span className="ml-auto text-[11px] text-gray-500">{fmt(s.created_at)}</span>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="flex items-start gap-2 min-w-0">
                    <Store size={15} className="text-[#18B79B] mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{s.name || "—"}</p>
                      <p className="text-xs text-gray-400 flex items-center gap-1">
                        <MapPin size={11} /> {s.city || "No city"}{s.location ? " · has location" : ""}
                      </p>
                      {s.phone && <p className="text-xs text-gray-400 flex items-center gap-1"><Phone size={11} /> {s.phone}</p>}
                    </div>
                  </div>
                  <div className="flex items-start gap-2 min-w-0">
                    <User size={15} className="text-[#18B79B] mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{s.owner_name || "—"}</p>
                      {s.owner_email && <a href={`mailto:${s.owner_email}`} className="text-xs text-[#18B79B] hover:underline flex items-center gap-1"><Mail size={11} /> {s.owner_email}</a>}
                      {s.owner_phone && <p className="text-xs text-gray-400 flex items-center gap-1"><Phone size={11} /> {s.owner_phone}</p>}
                    </div>
                  </div>
                </div>

                {thumbs.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {thumbs.slice(0, 6).map((u, i) => (
                      <img key={i} alt="" src={u} className="w-14 h-14 object-cover rounded border border-white/10" />
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2 border-t border-white/10 pt-2.5">
                  <button
                    onClick={() => onUseInAddSalon?.(s)}
                    className="flex items-center gap-1.5 text-xs font-semibold bg-[#18B79B] hover:bg-[#15a389] text-white px-3 py-1.5 rounded">
                    Fill in Add Salon <ArrowRight size={13} />
                  </button>
                  <button
                    onClick={() => remove(s)}
                    disabled={busy === s.id}
                    className="ml-auto p-1.5 text-gray-500 hover:text-red-400 disabled:opacity-50" title="Delete submission">
                    {busy === s.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
