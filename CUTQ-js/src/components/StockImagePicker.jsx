import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import { toast } from "sonner";
import { X, Search, Loader2, Check } from "lucide-react";

/*
 * Search-and-pick modal for attaching a royalty-free PHOTO to a category or
 * subcategory (icon or banner) instead of uploading a file.
 *
 * Category/subcategory tiles render as large (140dp) images in the app, so real
 * photos look far better than flat icons. Search runs through the
 * searchStockPhotos Cloud Function (Pexels; API key stays server-side).
 *
 * onSelect returns: { __stock, source:"pexels", photoUrl, previewUrl, photographer }
 * The actual download + square/wide crop + re-host happens later in
 * attachRemoteImage (server-side), based on the target Storage path.
 */
export default function StockImagePicker({ kind = "icon", defaultQuery = "", onClose, onSelect }) {
  const [q, setQ] = useState(defaultQuery);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 60); }, []);

  // Auto-search using the name already typed into the form.
  useEffect(() => {
    if (defaultQuery.trim()) runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSearch(e) {
    e?.preventDefault();
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setSelected(null);
    setSearched(true);
    try {
      if (!functions) throw new Error("Functions not configured");
      const call = httpsCallable(functions, "searchStockPhotos");
      const { data } = await call({ query, perPage: 30 });
      setResults(data.photos || []);
    } catch (err) {
      console.error(err);
      toast.error("Photo search failed. Is the Pexels key set on the backend?");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function confirm() {
    if (!selected) return;
    onSelect({
      __stock: true,
      source: "pexels",
      photoUrl: selected.full,
      previewUrl: selected.preview,
      photographer: selected.photographer,
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative bg-[#15171c] border border-white/10 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10">
          <p className="text-sm font-semibold text-white">
            Search {kind === "banner" ? "banner" : "image"}
            <span className="text-gray-500 font-normal ml-2 text-xs">Royalty-free photos (Pexels)</span>
          </p>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white">
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
              placeholder="e.g. hair salon, facial, manicure, spa"
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

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
              <Loader2 className="animate-spin" size={18} /> Searching…
            </div>
          ) : !searched ? (
            <p className="text-center text-sm text-gray-600 py-16">Type a keyword and hit Search.</p>
          ) : results.length === 0 ? (
            <p className="text-center text-sm text-gray-600 py-16">No results. Try another keyword.</p>
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
            {selected ? `Photo by ${selected.photographer} on Pexels` : "Select an image to attach"}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm rounded border border-white/10 text-gray-300 hover:bg-white/5">
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!selected}
              className="px-4 py-1.5 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-40 flex items-center gap-1.5"
            >
              <Check size={15} /> Use this
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
