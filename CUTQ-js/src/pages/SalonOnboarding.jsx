import { useEffect, useState } from "react";
import { toast } from "sonner";
import { signInAnonymously } from "firebase/auth";
import { auth } from "../firebase";
import { submitSalonOnboarding } from "../lib/adminFirestore";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const defaultHours = Object.fromEntries(
  DAYS.map((d) => [d, { open: "09:00", close: "20:00", is_closed: d === "sunday" }]),
);

const GREEN = "#18B79B";

export default function SalonOnboarding() {
  const [form, setForm] = useState({
    name: "", targeted_gender: "unisex", phone: "", email: "",
    address: "", city: "", state: "", pincode: "", max_bookings_per_slot: "1",
    owner_email: "", owner_name: "", owner_phone: "",
  });
  const [location, setLocation] = useState({ lat: "", lng: "" });
  const [locating, setLocating] = useState(false);
  const [hours, setHours] = useState(defaultHours);
  const [logoFile, setLogoFile] = useState(null);
  const [coverFile, setCoverFile] = useState(null);
  const [galleryFiles, setGalleryFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Sign in anonymously so image uploads pass Storage rules (no account needed).
  useEffect(() => {
    if (auth && !auth.currentUser) {
      signInAnonymously(auth).catch((e) => console.error("anon sign-in failed", e));
    }
  }, []);

  const setField = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const setHour = (day, k, v) => setHours((p) => ({ ...p, [day]: { ...p[day], [k]: v } }));

  function useCurrentLocation() {
    if (!("geolocation" in navigator)) {
      toast.error("Location is not supported on this device.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: String(pos.coords.latitude), lng: String(pos.coords.longitude) });
        setLocating(false);
        toast.success("Location captured");
      },
      (err) => {
        console.error(err);
        setLocating(false);
        toast.error(err?.message || "Could not get your location. You can leave it blank.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const required = { name: "Salon name", phone: "Salon phone", city: "City", owner_email: "Your email" };
    for (const [k, label] of Object.entries(required)) {
      if (!form[k].trim()) return toast.error(`${label} is required`);
    }
    setSubmitting(true);
    try {
      // Guarantee an auth session (anonymous is fine) BEFORE any Storage upload or
      // Firestore write, otherwise the write is rejected with a permissions error.
      if (auth && !auth.currentUser) {
        try {
          await signInAnonymously(auth);
        } catch (authErr) {
          console.error(authErr);
          throw new Error("Could not start a secure session. Please check your connection and try again.");
        }
      }
      const hasLoc = location.lat !== "" && location.lng !== "" &&
        Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng));
      await submitSalonOnboarding(
        { ...form, working_hours: hours, location: hasLoc ? location : null },
        { logoFile, coverFile, galleryFiles },
      );
      setDone(true);
    } catch (err) {
      console.error(err);
      toast.error(`Could not submit: ${err?.message || "please try again"}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-[#f4f9f6] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white rounded-2xl border border-[#dcece5] shadow-sm p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-[#e8f7f2] mx-auto flex items-center justify-center text-2xl">✓</div>
          <h1 className="mt-4 text-xl font-bold text-[#0d1f1a]">Thank you!</h1>
          <p className="mt-2 text-sm text-[#5c7a6b]">
            Your salon details have been submitted to the CutQ team. We will review them and get your
            salon set up. If we need anything else, we will reach out to you.
          </p>
        </div>
      </div>
    );
  }

  const inputCls = "border border-[#dcece5] bg-white rounded-lg px-3 py-2 text-sm text-[#0d1f1a] placeholder-[#9ab8a8] outline-none focus:border-[#18B79B]";
  const labelCls = "text-xs font-medium text-[#5c7a6b]";

  return (
    <div className="min-h-screen bg-[#f4f9f6] py-10 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: GREEN }}>
            <span className="text-white text-sm font-bold">✂</span>
          </div>
          <span className="text-lg font-bold text-[#0d1f1a]">CutQ</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-[#e8f7f2] text-[#18B79B] font-medium">Salon Onboarding</span>
        </div>
        <h1 className="text-2xl font-bold text-[#0d1f1a] mt-3">List your salon on CutQ</h1>
        <p className="text-sm text-[#5c7a6b] mt-1 mb-6">
          Fill in your salon details below and our team will set you up. No account needed.
          Fields marked * are required.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6 bg-white rounded-2xl border border-[#dcece5] p-6 shadow-sm">
          {/* Salon info */}
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-[#0d1f1a] border-b border-[#eef4f1] pb-2">Salon details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Salon name *"><input className={inputCls} value={form.name} onChange={(e) => setField("name", e.target.value)} placeholder="Your salon name" /></Field>
              <Field label="Who do you serve?">
                <select className={inputCls} value={form.targeted_gender} onChange={(e) => setField("targeted_gender", e.target.value)}>
                  <option value="unisex">Everyone (Unisex)</option>
                  <option value="male">Men only</option>
                  <option value="female">Women only</option>
                </select>
              </Field>
              <Field label="Salon phone *"><input className={inputCls} value={form.phone} onChange={(e) => setField("phone", e.target.value)} placeholder="Salon contact number" /></Field>
              <Field label="Salon email"><input type="email" className={inputCls} value={form.email} onChange={(e) => setField("email", e.target.value)} placeholder="salon@email.com" /></Field>
              <Field label="City *"><input className={inputCls} value={form.city} onChange={(e) => setField("city", e.target.value)} placeholder="City" /></Field>
              <Field label="State"><input className={inputCls} value={form.state} onChange={(e) => setField("state", e.target.value)} placeholder="State" /></Field>
              <Field label="Pincode"><input className={inputCls} value={form.pincode} onChange={(e) => setField("pincode", e.target.value)} placeholder="Pincode" /></Field>
              <Field label="Max bookings per slot"><input type="number" min="1" step="1" className={inputCls} value={form.max_bookings_per_slot} onChange={(e) => setField("max_bookings_per_slot", e.target.value)} /></Field>
            </div>
            <Field label="Full address">
              <textarea rows={2} className={`${inputCls} resize-none`} value={form.address} onChange={(e) => setField("address", e.target.value)} placeholder="Shop no., street, area, landmark" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Latitude"><input className={inputCls} value={location.lat} onChange={(e) => setLocation((p) => ({ ...p, lat: e.target.value }))} placeholder="e.g. 28.6139" /></Field>
              <Field label="Longitude"><input className={inputCls} value={location.lng} onChange={(e) => setLocation((p) => ({ ...p, lng: e.target.value }))} placeholder="e.g. 77.2090" /></Field>
            </div>
            <button type="button" onClick={useCurrentLocation} disabled={locating}
              className="self-start text-xs font-medium px-3 py-1.5 rounded-lg border border-[#18B79B] text-[#18B79B] hover:bg-[#e8f7f2] disabled:opacity-50">
              {locating ? "Getting location…" : "📍 Use my current location (stand at your salon)"}
            </button>
          </section>

          {/* Owner / contact */}
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-[#0d1f1a] border-b border-[#eef4f1] pb-2">Your details (salon owner)</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Your email *"><input type="email" className={inputCls} value={form.owner_email} onChange={(e) => setField("owner_email", e.target.value)} placeholder="owner@email.com" /></Field>
              <Field label="Your name"><input className={inputCls} value={form.owner_name} onChange={(e) => setField("owner_name", e.target.value)} placeholder="Full name" /></Field>
              <Field label="Your phone"><input className={inputCls} value={form.owner_phone} onChange={(e) => setField("owner_phone", e.target.value)} placeholder="+91 98765 43210" /></Field>
            </div>
          </section>

          {/* Images */}
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-[#0d1f1a] border-b border-[#eef4f1] pb-2">Photos</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[["Logo", logoFile, setLogoFile], ["Cover photo", coverFile, setCoverFile]].map(([label, file, setFile]) => (
                <div key={label} className="flex flex-col gap-2">
                  <span className={labelCls}>{label}</span>
                  {file && <img alt="" src={URL.createObjectURL(file)} className="w-full h-32 object-cover rounded-lg border border-[#dcece5]" />}
                  <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files[0] || null)}
                    className="text-xs text-[#5c7a6b] file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-[#18B79B] file:text-white file:cursor-pointer" />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <span className={labelCls}>Gallery (you can add several)</span>
              <input type="file" accept="image/*" multiple onChange={(e) => setGalleryFiles(Array.from(e.target.files || []))}
                className="text-xs text-[#5c7a6b] file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-[#18B79B] file:text-white file:cursor-pointer" />
              {galleryFiles.length > 0 && (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {galleryFiles.map((f, i) => (
                    <img key={`${f.name}_${i}`} alt="" src={URL.createObjectURL(f)} className="w-full h-20 object-cover rounded-lg border border-[#dcece5]" />
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Working hours */}
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-[#0d1f1a] border-b border-[#eef4f1] pb-2">Working hours</h2>
            {DAYS.map((day) => (
              <div key={day} className="flex items-center gap-3 flex-wrap">
                <span className="w-24 text-sm text-[#3a5060] capitalize">{day}</span>
                <label className="flex items-center gap-1.5 text-xs text-[#5c7a6b] cursor-pointer">
                  <input type="checkbox" checked={hours[day].is_closed} onChange={(e) => setHour(day, "is_closed", e.target.checked)} style={{ accentColor: GREEN }} />
                  Closed
                </label>
                {!hours[day].is_closed && (
                  <>
                    <input type="time" value={hours[day].open} onChange={(e) => setHour(day, "open", e.target.value)} className={inputCls} />
                    <span className="text-[#9ab8a8] text-xs">to</span>
                    <input type="time" value={hours[day].close} onChange={(e) => setHour(day, "close", e.target.value)} className={inputCls} />
                  </>
                )}
              </div>
            ))}
          </section>

          <button type="submit" disabled={submitting}
            className="self-stretch py-3 rounded-lg text-white font-semibold disabled:opacity-50" style={{ background: GREEN }}>
            {submitting ? "Submitting…" : "Submit salon details"}
          </button>
        </form>
        <p className="text-center text-xs text-[#9ab8a8] mt-4">Trusted by salons across India · CutQ</p>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[#5c7a6b]">{label}</span>
      {children}
    </label>
  );
}
