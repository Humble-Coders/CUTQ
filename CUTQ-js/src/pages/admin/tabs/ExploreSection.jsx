import { useState, useEffect } from "react";
import { toast } from "sonner";
import { PlusIcon, Pencil, Trash2, LayoutGrid } from "lucide-react";
import {
  listenExploreSections,
  addExploreSection,
  updateExploreSection,
  deleteExploreSection,
  fetchCategories,
} from "../../../lib/adminFirestore";

const MAX_ITEMS = 5;

function ImagePicker({ label, onChange, preview, required }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      <div className="flex items-center gap-3">
        {preview && (
          <img
            src={preview}
            className="w-12 h-8 rounded object-cover border border-white/10"
            alt="preview"
          />
        )}
        <input
          type="file"
          accept="image/*"
          onChange={e => onChange(e.target.files?.[0] ?? null)}
          className="text-xs text-gray-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-[#18B79B] file:text-white file:cursor-pointer"
        />
      </div>
    </div>
  );
}

function ExploreSectionForm({ categories, initial, nextOrder, onSave, onCancel, loading }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [catId, setCatId] = useState(initial?.category_id || categories[0]?.id || "");
  const [imageFile, setImageFile] = useState(null);

  function submit(e) {
    e.preventDefault();
    if (!title.trim()) return toast.error("Title is required");
    if (!catId) return toast.error("Please select a category");
    if (!initial && !imageFile) return toast.error("Image is required");
    onSave(
      { title: title.trim(), category_id: catId, order: initial?.order ?? nextOrder },
      imageFile
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 bg-white/5 rounded-lg p-4 border border-white/10"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-gray-400">
          {initial ? `Editing slot #${initial.order}` : `New item — will be assigned order #${nextOrder}`}
        </span>
      </div>

      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Title *"
        className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]"
      />

      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">
          Category <span className="text-red-400">*</span>
        </label>
        <select
          value={catId}
          onChange={e => setCatId(e.target.value)}
          className="bg-[#0f1115] border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-[#18B79B]"
        >
          <option value="" disabled>Select a category…</option>
          {categories.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <ImagePicker
        label={initial ? "Image (leave empty to keep current)" : "Image"}
        onChange={setImageFile}
        preview={initial?.image_url}
        required={!initial}
      />

      <div className="flex gap-2 justify-end mt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 text-sm rounded border border-white/10 text-gray-300 hover:bg-white/5"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-1.5 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-50"
        >
          {loading ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export default function ExploreSection() {
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const unsub = listenExploreSections(setItems);
    fetchCategories().then(setCategories).catch(() => {});
    return unsub;
  }, []);

  function computeNextOrder() {
    const usedOrders = new Set(items.map(i => i.order));
    for (let o = 1; o <= MAX_ITEMS; o++) {
      if (!usedOrders.has(o)) return o;
    }
    return MAX_ITEMS;
  }

  function categoryName(catId) {
    return categories.find(c => c.id === catId)?.name ?? catId;
  }

  async function handleAdd(data, imageFile) {
    setLoading(true);
    try {
      await addExploreSection(data, imageFile);
      toast.success("Explore item added");
      setShowAddForm(false);
    } catch (err) {
      toast.error(err?.message || "Failed to add item");
    } finally {
      setLoading(false);
    }
  }

  async function handleEdit(data, imageFile) {
    setLoading(true);
    try {
      await updateExploreSection(editItem.id, data, imageFile);
      toast.success("Explore item updated");
      setEditItem(null);
    } catch {
      toast.error("Failed to update item");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(item) {
    if (!confirm(`Delete "${item.title}"?`)) return;
    try {
      await deleteExploreSection(item.id);
      toast.success("Deleted");
    } catch {
      toast.error("Failed to delete");
    }
  }

  const atMax = items.length >= MAX_ITEMS;

  return (
    <div className="flex flex-col gap-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Explore Section</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Up to {MAX_ITEMS} featured items — stored in{" "}
            <code className="text-gray-400">explore_section</code>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-medium ${atMax ? "text-red-400" : "text-gray-400"}`}>
            {items.length}/{MAX_ITEMS} slots used
          </span>
          <button
            onClick={() => { setShowAddForm(true); setEditItem(null); }}
            disabled={atMax}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#18B79B] text-white rounded hover:bg-[#15a389] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={atMax ? "Maximum 5 items allowed" : "Add new item"}
          >
            <PlusIcon size={14} />
            Add Item
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAddForm && !editItem && (
        <ExploreSectionForm
          categories={categories}
          nextOrder={computeNextOrder()}
          onSave={handleAdd}
          onCancel={() => setShowAddForm(false)}
          loading={loading}
        />
      )}

      {/* Items list */}
      {items.length === 0 && !showAddForm ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 rounded-xl border border-dashed border-white/10 text-gray-600">
          <LayoutGrid size={32} />
          <p className="text-sm">No explore items yet. Add up to {MAX_ITEMS}.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map(item => (
            <div key={item.id} className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
              <div className="flex items-center gap-4 px-4 py-3">
                {/* Order badge */}
                <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#18B79B]/20 text-[#18B79B] text-xs font-bold flex items-center justify-center">
                  {item.order}
                </div>

                {/* Image thumbnail */}
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt={item.title}
                    className="w-16 h-10 rounded object-cover border border-white/10 flex-shrink-0"
                  />
                ) : (
                  <div className="w-16 h-10 rounded bg-white/10 flex items-center justify-center flex-shrink-0">
                    <LayoutGrid size={14} className="text-gray-600" />
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{item.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Category: <span className="text-gray-400">{categoryName(item.category_id)}</span>
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => { setEditItem(item); setShowAddForm(false); }}
                    className="text-gray-400 hover:text-white transition-colors"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(item)}
                    className="text-gray-400 hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Inline edit form */}
              {editItem?.id === item.id && (
                <div className="px-4 pb-4 border-t border-white/10 pt-3">
                  <ExploreSectionForm
                    categories={categories}
                    initial={editItem}
                    nextOrder={editItem.order}
                    onSave={handleEdit}
                    onCancel={() => setEditItem(null)}
                    loading={loading}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {atMax && (
        <p className="text-xs text-red-400/70">
          Maximum of {MAX_ITEMS} explore items reached. Delete an existing item to add a new one.
        </p>
      )}
    </div>
  );
}
