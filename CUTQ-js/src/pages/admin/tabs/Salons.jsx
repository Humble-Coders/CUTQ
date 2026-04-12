import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Pencil, X, ToggleLeft, ToggleRight, ChevronDown, ChevronUp, BadgeCheck, BadgeX } from "lucide-react";
import { listenSalons, updateSalon, toggleSalon, uploadSalonGalleryItem } from "../../../lib/adminFirestore";

const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

function Field({ label, value, onChange, type = "text", textarea = false, min, step }) {
  const cls = "bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B] w-full";
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400">{label}</label>
      {textarea
        ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={2} className={`${cls} resize-none`} />
        : <input type={type} value={value} onChange={e => onChange(e.target.value)} className={cls} min={min} step={step} />
      }
    </div>
  );
}

function EditSalonDrawer({ salon, onClose }) {
  const [form, setForm] = useState({
    name: salon.name || "",
    owner_uid: salon.owner_uid || "",
    phone: salon.phone || "",
    email: salon.email || "",
    address: salon.address || "",
    city: salon.city || "",
    state: salon.state || "",
    pincode: salon.pincode || "",
    targeted_gender: salon.targeted_gender || "unisex",
    max_bookings_per_slot: String(salon.max_bookings_per_slot ?? 1),
    is_active: salon.is_active ?? true,
    is_verified: salon.is_verified ?? true,
  });
  const [location, setLocation] = useState({
    lat: salon.location?.latitude ?? "",
    lng: salon.location?.longitude ?? "",
  });
  const [locating, setLocating] = useState(false);
  const [hours, setHours] = useState(
    salon.working_hours || Object.fromEntries(
      DAYS.map(d => [d, { open: "09:00", close: "20:00", is_closed: d === "sunday" }])
    )
  );
  const [gallery, setGallery] = useState(
    Array.isArray(salon.gallery)
      ? salon.gallery
          .slice()
          .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
      : []
  );
  const [newGalleryFiles, setNewGalleryFiles] = useState([]);
  const [logoFile, setLogoFile] = useState(null);
  const [coverFile, setCoverFile] = useState(null);
  const [loading, setLoading] = useState(false);

  function setField(k, v) { setForm(p => ({ ...p, [k]: v })); }
  function setHour(day, k, v) { setHours(p => ({ ...p, [day]: { ...p[day], [k]: v } })); }

  function normalizeGallery(list) {
    return list.map((it, idx) => ({ ...it, display_order: idx }));
  }

  function autofillFromCurrentLocation() {
    if (!("geolocation" in navigator)) {
      toast.error("Geolocation is not supported in this browser");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          lat: String(pos.coords.latitude),
          lng: String(pos.coords.longitude),
        });
        setLocating(false);
        toast.success("Location filled");
      },
      (err) => {
        console.error(err);
        setLocating(false);
        toast.error(err?.message || "Unable to fetch location");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  async function handleSave() {
    const required = ["name","address","city","state","pincode","phone","email"];
    for (const k of required) {
      if (!form[k].trim()) return toast.error(`${k} is required`);
    }
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return toast.error("location (lat/lng) is required");
    }
    const maxBookings = Number(form.max_bookings_per_slot);
    if (!Number.isFinite(maxBookings) || maxBookings < 1) {
      return toast.error("Max bookings per slot must be a number ≥ 1");
    }
    setLoading(true);
    try {
      let nextGallery = normalizeGallery(gallery);
      if (newGalleryFiles.length) {
        const uploaded = await Promise.all(
          newGalleryFiles.map((file, idx) =>
            uploadSalonGalleryItem(salon.id, file, nextGallery.length + idx)
          )
        );
        nextGallery = normalizeGallery([...nextGallery, ...uploaded]);
      }
      await updateSalon(
        salon.id,
        {
          ...form,
          max_bookings_per_slot: form.max_bookings_per_slot,
          location: { lat, lng },
          working_hours: hours,
          gallery: nextGallery,
        },
        logoFile,
        coverFile,
        nextGallery
      );
      toast.success("Salon updated");
      onClose();
    } catch {
      toast.error("Failed to update salon");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <div className="w-full max-w-xl bg-[#0f0f0f] border-l border-white/10 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <h2 className="text-sm font-semibold text-white">Edit — {salon.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-6">
          {/* Toggles */}
          <div className="flex gap-4">
            {[
              { label: "Active", field: "is_active" },
              { label: "Verified", field: "is_verified" },
            ].map(({ label, field }) => (
              <button key={field} onClick={() => setField(field, !form[field])}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs border transition-colors ${
                  form[field]
                    ? "border-[#18B79B]/40 bg-[#18B79B]/10 text-[#18B79B]"
                    : "border-white/10 bg-white/5 text-gray-400"
                }`}>
                {form[field] ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                {label}: {form[field] ? "On" : "Off"}
              </button>
            ))}
          </div>

          {/* Basic Info */}
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Basic Info</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Salon Name" value={form.name} onChange={v => setField("name", v)} />
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">targeted_gender</label>
                <select
                  value={form.targeted_gender}
                  onChange={e => setField("targeted_gender", e.target.value)}
                  className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-[#18B79B] w-full"
                >
                  <option value="male" className="bg-[#0f0f0f]">Male</option>
                  <option value="female" className="bg-[#0f0f0f]">Female</option>
                  <option value="unisex" className="bg-[#0f0f0f]">Unisex</option>
                </select>
              </div>
              <Field label="Owner UID" value={form.owner_uid} onChange={v => setField("owner_uid", v)} />
              <Field label="Phone" value={form.phone} onChange={v => setField("phone", v)} />
              <Field label="Email" value={form.email} onChange={v => setField("email", v)} type="email" />
              <Field label="City" value={form.city} onChange={v => setField("city", v)} />
              <Field label="State" value={form.state} onChange={v => setField("state", v)} />
              <Field label="Pincode" value={form.pincode} onChange={v => setField("pincode", v)} />
              <Field
                label="Max bookings per slot"
                value={form.max_bookings_per_slot}
                onChange={v => setField("max_bookings_per_slot", v)}
                type="number"
                min="1"
                step="1"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Latitude" value={String(location.lat)} onChange={v => setLocation(p => ({ ...p, lat: v }))} />
              <Field label="Longitude" value={String(location.lng)} onChange={v => setLocation(p => ({ ...p, lng: v }))} />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={autofillFromCurrentLocation}
                disabled={locating}
                className="px-3 py-1.5 text-xs rounded border border-white/10 text-gray-300 hover:bg-white/5 disabled:opacity-50"
              >
                {locating ? "Getting location…" : "Use current location"}
              </button>
            </div>
            <Field label="Address" value={form.address} onChange={v => setField("address", v)} textarea />
          </section>

          {/* Images */}
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Images</h3>
            {[
              { label: "Logo", current: salon.logo_url, file: logoFile, setFile: setLogoFile },
              { label: "Cover Photo", current: salon.cover_photo, file: coverFile, setFile: setCoverFile },
            ].map(({ label, current, file, setFile }) => (
              <div key={label} className="flex flex-col gap-1.5">
                <label className="text-xs text-gray-400">{label}</label>
                <div className="flex items-center gap-3">
                  {(file ? URL.createObjectURL(file) : current)
                    ? <img src={file ? URL.createObjectURL(file) : current} className="w-14 h-14 rounded object-cover border border-white/10" />
                    : <div className="w-14 h-14 rounded bg-white/5 border border-white/10 flex items-center justify-center text-xs text-gray-600">None</div>
                  }
                  <input type="file" accept="image/*" onChange={e => setFile(e.target.files[0])}
                    className="text-xs text-gray-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-[#18B79B] file:text-white file:cursor-pointer" />
                </div>
              </div>
            ))}
          </section>

          {/* Working Hours */}
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Working Hours</h3>
            {DAYS.map(day => (
              <div key={day} className="flex items-center gap-3">
                <span className="w-24 text-sm text-gray-300 capitalize shrink-0">{day}</span>
                <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer shrink-0">
                  <input type="checkbox" checked={hours[day]?.is_closed ?? false}
                    onChange={e => setHour(day, "is_closed", e.target.checked)}
                    className="accent-[#18B79B]" />
                  Closed
                </label>
                {!hours[day]?.is_closed && (
                  <>
                    <input type="time" value={hours[day]?.open ?? "09:00"}
                      onChange={e => setHour(day, "open", e.target.value)}
                      className="bg-white/10 border border-white/10 rounded px-2 py-1 text-sm text-white outline-none focus:border-[#18B79B]" />
                    <span className="text-gray-500 text-xs">to</span>
                    <input type="time" value={hours[day]?.close ?? "20:00"}
                      onChange={e => setHour(day, "close", e.target.value)}
                      className="bg-white/10 border border-white/10 rounded px-2 py-1 text-sm text-white outline-none focus:border-[#18B79B]" />
                  </>
                )}
              </div>
            ))}
          </section>

          {/* Gallery */}
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Gallery</h3>
            {gallery.length > 0 ? (
              <div className="grid grid-cols-3 gap-2">
                {gallery.map((g, idx) => (
                  <div key={g.id || `${g.url}_${idx}`} className="relative">
                    <img src={g.url} className="w-full h-20 object-cover rounded border border-white/10" />
                    <div className="absolute top-1 left-1 text-[10px] bg-black/60 border border-white/10 rounded px-1.5 py-0.5 text-gray-200">
                      order {idx}
                    </div>
                    <div className="absolute bottom-1 right-1 flex gap-1">
                      <button
                        type="button"
                        onClick={() => setGallery(p => normalizeGallery(p.filter((_, i) => i !== idx)))}
                        className="text-[10px] px-2 py-1 rounded bg-black/60 border border-white/10 text-gray-200 hover:bg-black/80"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="absolute bottom-1 left-1 flex gap-1">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => setGallery(p => {
                          const next = p.slice();
                          const tmp = next[idx - 1];
                          next[idx - 1] = next[idx];
                          next[idx] = tmp;
                          return normalizeGallery(next);
                        })}
                        className="text-[10px] px-2 py-1 rounded bg-black/60 border border-white/10 text-gray-200 disabled:opacity-40 hover:bg-black/80"
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        disabled={idx === gallery.length - 1}
                        onClick={() => setGallery(p => {
                          const next = p.slice();
                          const tmp = next[idx + 1];
                          next[idx + 1] = next[idx];
                          next[idx] = tmp;
                          return normalizeGallery(next);
                        })}
                        className="text-[10px] px-2 py-1 rounded bg-black/60 border border-white/10 text-gray-200 disabled:opacity-40 hover:bg-black/80"
                      >
                        Down
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600">No gallery images.</p>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-gray-400">Add gallery images</label>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={e => setNewGalleryFiles(Array.from(e.target.files || []))}
                className="text-xs text-gray-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-[#18B79B] file:text-white file:cursor-pointer"
              />
              {newGalleryFiles.length > 0 && (
                <p className="text-xs text-gray-500">{newGalleryFiles.length} new image(s) selected</p>
              )}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/10 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded border border-white/10 text-gray-300 hover:bg-white/5">Cancel</button>
          <button onClick={handleSave} disabled={loading}
            className="px-5 py-1.5 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-50 transition-colors">
            {loading ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SalonRow({ salon }) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function handleToggle(field) {
    setToggling(true);
    try {
      await toggleSalon(salon.id, field, !salon[field]);
    } catch {
      toast.error("Failed to update");
    } finally {
      setToggling(false);
    }
  }

  return (
    <>
      {editing && <EditSalonDrawer salon={salon} onClose={() => setEditing(false)} />}

      <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
        {/* Main row */}
        <div className="flex items-center gap-3 px-4 py-3">
          {salon.logo_url
            ? <img src={salon.logo_url} className="w-10 h-10 rounded object-cover shrink-0 border border-white/10" />
            : <div className="w-10 h-10 rounded bg-white/10 shrink-0 flex items-center justify-center text-xs text-gray-500">{salon.name?.[0]}</div>
          }
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{salon.name}</p>
            <p className="text-xs text-gray-400 truncate">{salon.city}, {salon.state}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Active toggle */}
            <button disabled={toggling} onClick={() => handleToggle("is_active")}
              title={salon.is_active ? "Active" : "Inactive"}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                salon.is_active
                  ? "border-[#18B79B]/40 text-[#18B79B] bg-[#18B79B]/10"
                  : "border-white/10 text-gray-500 bg-white/5"
              }`}>
              {salon.is_active ? "Active" : "Inactive"}
            </button>
            {/* Verified toggle */}
            <button disabled={toggling} onClick={() => handleToggle("is_verified")}
              title={salon.is_verified ? "Verified" : "Unverified"}
              className="text-gray-400 hover:text-white transition-colors">
              {salon.is_verified
                ? <BadgeCheck size={16} className="text-[#18B79B]" />
                : <BadgeX size={16} />
              }
            </button>
            <button onClick={() => setEditing(true)} className="text-gray-400 hover:text-white"><Pencil size={14} /></button>
            <button onClick={() => setExpanded(p => !p)} className="text-gray-400 hover:text-white">
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="border-t border-white/10 px-4 py-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            {[
              { label: "Phone", value: salon.phone },
              { label: "Email", value: salon.email },
              { label: "Address", value: salon.address },
              { label: "Pincode", value: salon.pincode },
              { label: "Owner UID", value: salon.owner_uid },
              { label: "Avg Rating", value: `${salon.avg_rating ?? 0} (${salon.review_count ?? 0} reviews)` },
              { label: "Slot Interval", value: `${salon.slot_interval_minutes} min` },
            ].map(({ label, value }) => (
              <div key={label}>
                <p className="text-xs text-gray-500">{label}</p>
                <p className="text-white break-all">{value || "—"}</p>
              </div>
            ))}
            {/* Working hours */}
            <div className="col-span-2">
              <p className="text-xs text-gray-500 mb-1">Working Hours</p>
              <div className="grid grid-cols-2 gap-1">
                {DAYS.map(day => {
                  const h = salon.working_hours?.[day];
                  return (
                    <div key={day} className="flex gap-2 text-xs">
                      <span className="text-gray-400 capitalize w-20">{day}</span>
                      <span className="text-white">
                        {h?.is_closed ? "Closed" : `${h?.open ?? "?"} – ${h?.close ?? "?"}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Cover photo */}
            {salon.cover_photo && (
              <div className="col-span-2">
                <p className="text-xs text-gray-500 mb-1">Cover Photo</p>
                <img src={salon.cover_photo} className="w-full max-w-sm h-32 object-cover rounded border border-white/10" />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export default function Salons() {
  const [salons, setSalons] = useState([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const unsub = listenSalons(setSalons);
    return unsub;
  }, []);

  const filtered = salons.filter(s =>
    s.name?.toLowerCase().includes(search.toLowerCase()) ||
    s.city?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Salons <span className="text-sm text-gray-500 font-normal ml-1">({salons.length})</span></h2>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or city…"
          className="bg-white/10 border border-white/10 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B] w-56" />
      </div>

      {filtered.length === 0
        ? <p className="text-sm text-gray-600 py-8 text-center">No salons found.</p>
        : filtered.map(s => <SalonRow key={s.id} salon={s} />)
      }
    </div>
  );
}