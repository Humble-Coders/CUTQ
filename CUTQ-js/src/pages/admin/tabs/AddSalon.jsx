import { useState } from "react";
import { toast } from "sonner";
import { httpsCallable } from "firebase/functions";
import { addSalon, uploadSalonGalleryItem, updateSalon } from "../../../lib/adminFirestore";
import { functions } from "../../../firebase";

const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

const defaultHours = Object.fromEntries(
  DAYS.map(d => [d, { open: "09:00", close: "20:00", is_closed: d === "sunday" }])
);

export default function AddSalon() {
  const [form, setForm] = useState({
    name: "", owner_uid: "", address: "", city: "", state: "",
    pincode: "", phone: "", email: "",
  });
  const [ownerEmail, setOwnerEmail] = useState("");
  const [creatingOwner, setCreatingOwner] = useState(false);
  const [location, setLocation] = useState({ lat: "", lng: "" });
  const [locating, setLocating] = useState(false);
  const [hours, setHours] = useState(defaultHours);
  const [logoFile, setLogoFile] = useState(null);
  const [coverFile, setCoverFile] = useState(null);
  const [galleryFiles, setGalleryFiles] = useState([]);
  const [loading, setLoading] = useState(false);

  function setField(key, val) {
    setForm(p => ({ ...p, [key]: val }));
  }

  function setHour(day, key, val) {
    setHours(p => ({ ...p, [day]: { ...p[day], [key]: val } }));
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

  async function handleSubmit(e) {
    e.preventDefault();
    const required = ["name","address","city","state","pincode","phone","email"];
    for (const k of required) {
      if (!form[k].trim()) return toast.error(`${k} is required`);
    }
    if (!ownerEmail.trim()) return toast.error("Owner email is required");
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return toast.error("location (lat/lng) is required");
    }
    setLoading(true);
    try {
      setCreatingOwner(true);
      const createOwner = httpsCallable(functions, "createSalonOwner");
      const res = await createOwner({
        email: ownerEmail.trim(),
        name: "",
        phone: "",
      });
      const ownerUid = res?.data?.uid;
      if (!ownerUid) throw new Error("createSalonOwner did not return uid");

      const id = await addSalon(
        { ...form, owner_uid: ownerUid, location: { lat, lng }, working_hours: hours },
        logoFile,
        coverFile,
      );

      let gallery = [];
      if (galleryFiles.length) {
        gallery = await Promise.all(
          galleryFiles.map((file, idx) => uploadSalonGalleryItem(id, file, idx)),
        );
      }
      if (gallery.length) {
        await updateSalon(id, { ...form, location: { lat, lng }, working_hours: hours }, null, null, gallery);
      }

      toast.success(`Salon added! ID: ${id}`);
      setForm({ name:"", owner_uid:"", address:"", city:"", state:"", pincode:"", phone:"", email:"" });
      setOwnerEmail("");
      setLocation({ lat: "", lng: "" });
      setHours(defaultHours);
      setLogoFile(null);
      setCoverFile(null);
      setGalleryFiles([]);
    } catch (err) {
      console.error(err);
      toast.error("Failed to add salon");
    } finally {
      setCreatingOwner(false);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6 max-w-2xl">
      {/* Basic Info */}
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-white border-b border-white/10 pb-2">Basic Information</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { key: "name", label: "Salon Name" },
            { key: "phone", label: "Phone" },
            { key: "email", label: "Email", type: "email" },
            { key: "city", label: "City" },
            { key: "state", label: "State" },
            { key: "pincode", label: "Pincode" }
          ].map(({ key, label, type = "text" }) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">{label}</label>
              <input type={type} value={form[key]} onChange={e => setField(key, e.target.value)}
                placeholder={label}
                className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Owner Email (will be created automatically)</label>
            <input
              value={ownerEmail}
              onChange={e => setOwnerEmail(e.target.value)}
              type="email"
              placeholder="owner@salon.com"
              className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Latitude</label>
            <input value={location.lat} onChange={e => setLocation(p => ({ ...p, lat: e.target.value }))}
              placeholder="e.g. 28.6139"
              className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Longitude</label>
            <input value={location.lng} onChange={e => setLocation(p => ({ ...p, lng: e.target.value }))}
              placeholder="e.g. 77.2090"
              className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]" />
          </div>
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
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Address</label>
          <textarea value={form.address} onChange={e => setField("address", e.target.value)}
            rows={2} placeholder="Full address"
            className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B] resize-none" />
        </div>
      </section>

      {/* Images */}
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-white border-b border-white/10 pb-2">Images</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            { label: "Logo", file: logoFile, setFile: setLogoFile },
            { label: "Cover Photo", file: coverFile, setFile: setCoverFile },
          ].map(({ label, file, setFile }) => (
            <div key={label} className="flex flex-col gap-2">
              <label className="text-xs text-gray-400">{label}</label>
              {file && <img src={URL.createObjectURL(file)} className="w-full h-32 object-cover rounded border border-white/10" />}
              <input type="file" accept="image/*" onChange={e => setFile(e.target.files[0])}
                className="text-xs text-gray-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-[#18B79B] file:text-white file:cursor-pointer" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs text-gray-400">Gallery (multiple images)</label>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={e => setGalleryFiles(Array.from(e.target.files || []))}
            className="text-xs text-gray-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-[#18B79B] file:text-white file:cursor-pointer"
          />
          {galleryFiles.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {galleryFiles.map((f, idx) => (
                <div key={`${f.name}_${idx}`} className="relative">
                  <img src={URL.createObjectURL(f)} className="w-full h-20 object-cover rounded border border-white/10" />
                  <div className="absolute top-1 left-1 text-[10px] bg-black/60 border border-white/10 rounded px-1.5 py-0.5 text-gray-200">
                    order {idx}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Working Hours */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-white border-b border-white/10 pb-2">Working Hours</h2>
        {DAYS.map(day => (
          <div key={day} className="flex items-center gap-3">
            <span className="w-24 text-sm text-gray-300 capitalize">{day}</span>
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" checked={hours[day].is_closed}
                onChange={e => setHour(day, "is_closed", e.target.checked)}
                className="accent-[#18B79B]" />
              Closed
            </label>
            {!hours[day].is_closed && (
              <>
                <input type="time" value={hours[day].open} onChange={e => setHour(day, "open", e.target.value)}
                  className="bg-white/10 border border-white/10 rounded px-2 py-1 text-sm text-white outline-none focus:border-[#18B79B]" />
                <span className="text-gray-500 text-xs">to</span>
                <input type="time" value={hours[day].close} onChange={e => setHour(day, "close", e.target.value)}
                  className="bg-white/10 border border-white/10 rounded px-2 py-1 text-sm text-white outline-none focus:border-[#18B79B]" />
              </>
            )}
          </div>
        ))}
      </section>

      <button type="submit" disabled={loading}
        className="self-start px-6 py-2 bg-[#18B79B] text-white rounded font-medium hover:bg-[#15a389] disabled:opacity-50 transition-colors">
        {loading ? (creatingOwner ? "Creating owner…" : "Creating salon…") : "Create Salon"}
      </button>
    </form>
  );
}