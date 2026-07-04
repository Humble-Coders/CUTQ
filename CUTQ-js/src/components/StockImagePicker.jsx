import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import { toast } from "sonner";
import { X, Search, Loader2, Check } from "lucide-react";

/*
 * Search-and-pick modal for attaching a royalty-free image without uploading.
 *
 *   kind="icon"   -> Iconify open-source icon search (keyless, done in-browser).
 *                    Returns { __stock, source:"iconify", iconId, color, previewUrl }.
 *   kind="banner" -> Pexels photo search via the searchStockPhotos Cloud Function
 *                    (keeps the API key server-side).
 *                    Returns { __stock, source:"pexels", photoUrl, previewUrl, photographer }.
 *
 * The picker only chooses — the actual download + re-host to Firebase Storage is
 * done later by the attachRemoteImage Cloud Function (see adminFirestore.js), so
 * that it lands on the correct salon/category Storage path.
 */

const ICON_COLORS = [
  { label: "Charcoal", hex: "#111827" },
  { label: "Teal", hex: "#18B79B" },
  { label: "Slate", hex: "#475569" },
];

function iconSvgUrl(iconId, hex, size = 40) {
  const [prefix, name] = iconId.split(":");
  return `https://api.iconify.design/${prefix}/${name}.svg?height=${size}&color=${encodeURIComponent(hex)}`;
}

export default function StockImagePicker({ kind, onClose, onSelect }) {
  const isIcon = kind === "icon";
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]); // icon: ["mdi:x"]; banner: [{id, preview, full, photographer, alt}]
  const [selected, setSelected] = useState(null);
  const [color, setColor] = useState(ICON_COLORS[0].hex);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 60); }, []);

  async function runSearch(e) {
    e?.preventDefault();
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setSelected(null);
    setSearched(true);
    try {
      if (isIcon) {
        const res = await fetch(
          `https://api.iconify.design/search?query=${encodeURIComponent(query)}&limit=64`
        );
        if (!res.ok) throw new Error(`Iconify HTTP ${res.status}`);
        const data = await res.json();
        setResults(Array.isArray(data.icons) ? data.icons : []);
      } else {
        if (!functions) throw new Error("Functions not configured");
        const call = httpsCallable(functions, "searchStockPhotos");
        const { data } = await call({ query, perPage: 30 });
        setResults(data.photos || []);
      }
    } catch (err) {
      console.error(err);
      toast.error(isIcon ? "Icon search failed." : "Photo search failed. Is the Pexels key set?");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function confirm() {
    if (!selected) return;
    if (isIcon) {
      onSelect({
        __stock: true,
        source: "iconify",
        iconId: selected,
        color,
        previewUrl: iconSvgUrl(selected, color, 96),
      });
    } else {
      onSelect({
        __stock: true,
        source: "pexels",
        photoUrl: selected.full,
        previewUrl: selected.preview,
        photographer: selected.photographer,
      });
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative bg-[#15171c] border border-white/10 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10">
          <p className="text-sm font-semibold text-white">
            {isIcon ? "Search icons" : "Search photos"}
            <span className="text-gray-500 font-normal ml-2 text-xs">
              {isIcon ? "Open-source icons (Iconify)" : "Royalty-free photos (Pexels)"}
            </span>
          </p>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white">
            <X size={16} />
          </button>
        </div>

        {/* Search bar */}
        <form onSubmit={runSearch} className="px-5 py-3 border-b border-white/10 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={15} />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={isIcon ? "e.g. haircut, spa, razor" : "e.g. hair salon, spa, makeup"}
              className="w-full pl-9 pr-3 py-2 rounded bg-white/10 border border-white/10 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !q.trim()}
            className="px-4 py-2 rounded bg-[#18B79B] text-white text-sm font-medium hover:bg-[#15a389] disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            Search
          </button>
        </form>

        {/* Icon color swatches */}
        {isIcon && (
          <div className="px-5 py-2.5 border-b border-white/10 flex items-center gap-3">
            <span className="text-xs text-gray-400">Icon color:</span>
            {ICON_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                onClick={() => setColor(c.hex)}
                title={c.label}
                className={`w-5 h-5 rounded-full border-2 ${color === c.hex ? "border-[#18B79B]" : "border-white/20"}`}
                style={{ backgroundColor: c.hex }}
              />
            ))}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
              <Loader2 className="animate-spin" size={18} /> Searching…
            </div>
          ) : !searched ? (
            <p className="text-center text-sm text-gray-600 py-16">
              Type a keyword and hit Search.
            </p>
          ) : results.length === 0 ? (
            <p className="text-center text-sm text-gray-600 py-16">No results. Try another keyword.</p>
          ) : isIcon ? (
            <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
              {results.map((iconId) => {
                const isSel = selected === iconId;
                return (
                  <button
                    key={iconId}
                    type="button"
                    onClick={() => setSelected(iconId)}
                    title={iconId}
                    className={`aspect-square rounded-lg bg-white flex items-center justify-center border-2 transition-colors ${
                      isSel ? "border-[#18B79B]" : "border-transparent hover:border-white/30"
                    }`}
                  >
                    <img src={iconSvgUrl(iconId, color, 32)} alt={iconId} className="w-7 h-7" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {results.map((p) => {
                const isSel = selected?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelected(p)}
                    className={`relative rounded-lg overflow-hidden border-2 transition-colors group ${
                      isSel ? "border-[#18B79B]" : "border-transparent hover:border-white/30"
                    }`}
                  >
                    <img src={p.preview} alt={p.alt} className="w-full h-28 object-cover" loading="lazy" />
                    {isSel && (
                      <span className="absolute top-1.5 right-1.5 bg-[#18B79B] text-white rounded-full p-0.5">
                        <Check size={13} />
                      </span>
                    )}
                    <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[10px] text-gray-300 px-1.5 py-0.5 truncate opacity-0 group-hover:opacity-100">
                      {p.photographer}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-white/10">
          <p className="text-xs text-gray-500 truncate">
            {selected
              ? isIcon ? selected : `Photo by ${selected.photographer} on Pexels`
              : "Select an image to attach"}
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-1.5 text-sm rounded border border-white/10 text-gray-300 hover:bg-white/5">
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={!selected}
              className="px-4 py-1.5 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-40 flex items-center gap-1.5"
            >
              <Check size={15} /> Use this
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
