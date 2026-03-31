import { useState, useEffect } from "react";
import { toast } from "sonner";
import { PlusIcon, Pencil, Trash2, ChevronDown, ChevronRight, ToggleLeft, ToggleRight } from "lucide-react";
import {
  fetchCategories, addCategory, updateCategory, toggleCategory, deleteCategory,
  fetchSubcategories, addSubcategory, updateSubcategory, toggleSubcategory, deleteSubcategory,
} from "../../../lib/adminFirestore";

const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

function ImagePicker({ label, onChange, preview }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400">{label}</label>
      <div className="flex items-center gap-3">
        {preview && <img src={preview} className="w-10 h-10 rounded object-cover border border-white/10" />}
        <input type="file" accept="image/*" onChange={e => onChange(e.target.files[0])}
          className="text-xs text-gray-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-[#18B79B] file:text-white file:cursor-pointer" />
      </div>
    </div>
  );
}

function CategoryForm({ initial, onSave, onCancel, loading }) {
  const [name, setName] = useState(initial?.name || "");
  const [order, setOrder] = useState(initial?.display_order ?? 0);
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [icon, setIcon] = useState(null);

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) return toast.error("Name is required");
    onSave({ name: name.trim(), display_order: Number(order), is_active: isActive }, icon);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 bg-white/5 rounded-lg p-4 border border-white/10">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Category name"
        className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
      <input type="number" value={order} onChange={e => setOrder(e.target.value)} placeholder="Display order"
        className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="accent-[#18B79B]" />
        Active
      </label>
      <ImagePicker label="Icon" onChange={setIcon} preview={initial?.icon_url} />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-1.5 text-sm rounded border border-white/10 text-gray-300 hover:bg-white/5">Cancel</button>
        <button type="submit" disabled={loading} className="px-4 py-1.5 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-50">
          {loading ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function SubcategoryForm({ categories, initial, onSave, onCancel, loading }) {
  const [name, setName] = useState(initial?.name || "");
  const [catId, setCatId] = useState(initial?.category_id || categories[0]?.id || "");
  const [order, setOrder] = useState(initial?.display_order ?? 0);
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [icon, setIcon] = useState(null);
  const [banner, setBanner] = useState(null);

  function submit(e) {
    e.preventDefault();
    if (!name.trim() || !catId) return toast.error("Name and category are required");
    onSave({ name: name.trim(), category_id: catId, display_order: Number(order), is_active: isActive }, icon, banner);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 bg-white/5 rounded-lg p-4 border border-white/10">
      <select value={catId} onChange={e => setCatId(e.target.value)}
        className="bg-[#0f1115] border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-[#18B79B]">
        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Subcategory name"
        className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
      <input type="number" value={order} onChange={e => setOrder(e.target.value)} placeholder="Display order"
        className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="accent-[#18B79B]" />
        Active
      </label>
      <ImagePicker label="Icon" onChange={setIcon} preview={initial?.icon_url} />
      <ImagePicker label="Banner" onChange={setBanner} preview={initial?.banner_url} />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-1.5 text-sm rounded border border-white/10 text-gray-300 hover:bg-white/5">Cancel</button>
        <button type="submit" disabled={loading} className="px-4 py-1.5 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-50">
          {loading ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export default function Categories() {
  const [categories, setCategories] = useState([]);
  const [subcategories, setSubcategories] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [showCatForm, setShowCatForm] = useState(false);
  const [editCat, setEditCat] = useState(null);
  const [showSubForm, setShowSubForm] = useState(false);
  const [editSub, setEditSub] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    const [cats, subs] = await Promise.all([fetchCategories(), fetchSubcategories(null)]);
    setCategories(cats);
    setSubcategories(subs);
  }

  useEffect(() => { load(); }, []);

  async function handleAddCategory(data, icon) {
    setLoading(true);
    try { await addCategory(data, icon); toast.success("Category added"); setShowCatForm(false); await load(); }
    catch { toast.error("Failed to add category"); }
    finally { setLoading(false); }
  }

  async function handleEditCategory(data, icon) {
    setLoading(true);
    try { await updateCategory(editCat.id, data, icon); toast.success("Category updated"); setEditCat(null); await load(); }
    catch { toast.error("Failed to update"); }
    finally { setLoading(false); }
  }

  async function handleToggleCategory(cat) {
    await toggleCategory(cat.id, !cat.is_active);
    await load();
  }

  async function handleDeleteCategory(cat) {
    if (!confirm(`Delete "${cat.name}"? This will not delete its subcategories.`)) return;
    await deleteCategory(cat.id);
    toast.success("Deleted");
    await load();
  }

  async function handleAddSub(data, icon, banner) {
    setLoading(true);
    try { await addSubcategory(data, icon, banner); toast.success("Subcategory added"); setShowSubForm(false); await load(); }
    catch { toast.error("Failed to add subcategory"); }
    finally { setLoading(false); }
  }

  async function handleEditSub(data, icon, banner) {
    setLoading(true);
    try { await updateSubcategory(editSub.id, data, icon, banner); toast.success("Updated"); setEditSub(null); await load(); }
    catch { toast.error("Failed to update"); }
    finally { setLoading(false); }
  }

  async function handleToggleSub(sub) {
    await toggleSubcategory(sub.id, !sub.is_active);
    await load();
  }

  async function handleDeleteSub(sub) {
    if (!confirm(`Delete "${sub.name}"?`)) return;
    await deleteSubcategory(sub.id);
    toast.success("Deleted");
    await load();
  }

  const subsFor = (catId) => subcategories.filter(s => s.category_id === catId);

  return (
    <div className="flex flex-col gap-6">
      {/* Categories */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Service Categories</h2>
          <button onClick={() => { setShowCatForm(true); setEditCat(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#18B79B] text-white rounded hover:bg-[#15a389]">
            <PlusIcon size={14} /> Add Category
          </button>
        </div>

        {showCatForm && !editCat && (
          <CategoryForm onSave={handleAddCategory} onCancel={() => setShowCatForm(false)} loading={loading} />
        )}

        {categories.map(cat => (
          <div key={cat.id} className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3">
              <button onClick={() => setExpanded(p => ({ ...p, [cat.id]: !p[cat.id] }))} className="text-gray-400 hover:text-white">
                {expanded[cat.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {cat.icon_url && <img src={cat.icon_url} className="w-8 h-8 rounded object-cover" />}
              <span className={`flex-1 text-sm font-medium ${cat.is_active ? "text-white" : "text-gray-500 line-through"}`}>{cat.name}</span>
              <span className="text-xs text-gray-500">order: {cat.display_order}</span>
              <button onClick={() => handleToggleCategory(cat)} className="text-gray-400 hover:text-[#18B79B]">
                {cat.is_active ? <ToggleRight size={18} className="text-[#18B79B]" /> : <ToggleLeft size={18} />}
              </button>
              <button onClick={() => { setEditCat(cat); setShowCatForm(false); }} className="text-gray-400 hover:text-white"><Pencil size={14} /></button>
              <button onClick={() => handleDeleteCategory(cat)} className="text-gray-400 hover:text-red-400"><Trash2 size={14} /></button>
            </div>

            {editCat?.id === cat.id && (
              <div className="px-4 pb-4">
                <CategoryForm initial={cat} onSave={handleEditCategory} onCancel={() => setEditCat(null)} loading={loading} />
              </div>
            )}

            {expanded[cat.id] && (
              <div className="border-t border-white/10 px-4 py-3 flex flex-col gap-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">Subcategories</span>
                </div>
                {subsFor(cat.id).map(sub => (
                  <div key={sub.id} className="flex items-center gap-3 bg-white/5 rounded px-3 py-2">
                    {sub.icon_url && <img src={sub.icon_url} className="w-6 h-6 rounded object-cover" />}
                    <span className={`flex-1 text-sm ${sub.is_active ? "text-gray-200" : "text-gray-500 line-through"}`}>{sub.name}</span>
                    <span className="text-xs text-gray-500">order: {sub.display_order}</span>
                    <button onClick={() => handleToggleSub(sub)} className="text-gray-400 hover:text-[#18B79B]">
                      {sub.is_active ? <ToggleRight size={16} className="text-[#18B79B]" /> : <ToggleLeft size={16} />}
                    </button>
                    <button onClick={() => { setEditSub(sub); setShowSubForm(false); }} className="text-gray-400 hover:text-white"><Pencil size={13} /></button>
                    <button onClick={() => handleDeleteSub(sub)} className="text-gray-400 hover:text-red-400"><Trash2 size={13} /></button>
                  </div>
                ))}
                {editSub && editSub.category_id === cat.id && (
                  <SubcategoryForm categories={categories} initial={editSub} onSave={handleEditSub} onCancel={() => setEditSub(null)} loading={loading} />
                )}
                {subsFor(cat.id).length === 0 && <p className="text-xs text-gray-600">No subcategories yet.</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Subcategories add form */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Add Subcategory</h2>
          <button onClick={() => { setShowSubForm(p => !p); setEditSub(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#18B79B] text-white rounded hover:bg-[#15a389]">
            <PlusIcon size={14} /> Add Subcategory
          </button>
        </div>
        {showSubForm && (
          <SubcategoryForm categories={categories} onSave={handleAddSub} onCancel={() => setShowSubForm(false)} loading={loading} />
        )}
      </div>
    </div>
  );
}