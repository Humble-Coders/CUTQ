import { useState, useEffect } from "react";
import { toast } from "sonner";
import AddSalon from "./tabs/AddSalon";
import Categories from "./tabs/Categories";
import Salons from "./tabs/Salons";
import HeaderImages from "./tabs/HeaderImages";
import ExploreSection from "./tabs/ExploreSection";
import Support from "./tabs/Support";
import BookingsSupport from "./tabs/BookingsSupport";
import SupportReps from "./tabs/SupportReps";
import Reports from "./tabs/Reports";
import { listenAppConfig, updateBookingFee } from "../../lib/adminFirestore";

const ADMIN_TABS = [
  { id: "salons_list",     label: "Salons" },
  { id: "add_salon",       label: "Add Salon" },
  { id: "categories",      label: "Categories" },
  { id: "bookings",        label: "Bookings" },
  { id: "support_reps",    label: "Support Reps" },
  { id: "reports",         label: "Reports" },
  { id: "header_images",   label: "Header Images" },
  { id: "explore_section", label: "Explore Section" },
  { id: "support",         label: "Support" },
];

// Customer Support Representatives see ONLY the Bookings section.
const SUPPORT_TABS = [
  { id: "bookings", label: "Bookings" },
];

export default function AdminPanel({ role }) {
  const isSupport = role === "SUPPORT";
  const tabs = isSupport ? SUPPORT_TABS : ADMIN_TABS;

  const [tab, setTab] = useState(isSupport ? "bookings" : "salons_list");
  const [bookingFee, setBookingFee] = useState(0);
  const [feeInput, setFeeInput] = useState("0");
  const [savingFee, setSavingFee] = useState(false);

  useEffect(() => {
    if (isSupport) return; // support reps don't manage global config
    const unsub = listenAppConfig(config => {
      setBookingFee(config.booking_fee ?? 0);
      setFeeInput(String(config.booking_fee ?? 0));
    });
    return unsub;
  }, [isSupport]);

  async function handleSaveFee() {
    setSavingFee(true);
    try {
      await updateBookingFee(feeInput);
      toast.success("Booking fee updated");
    } catch {
      toast.error("Failed to update booking fee");
    } finally {
      setSavingFee(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#18B79B]" />
          <h1 className="text-base font-semibold tracking-wide">
            {isSupport ? "Support - Bookings" : "Salon Admin"}
          </h1>
        </div>
        {/* Global booking fee - admin only */}
        {!isSupport && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Global Booking Fee ₹</span>
            <input type="number" value={feeInput} onChange={e => setFeeInput(e.target.value)}
              className="w-20 bg-white/10 border border-white/10 rounded px-2 py-1 text-sm text-white outline-none focus:border-[#18B79B] text-center" />
            <button onClick={handleSaveFee} disabled={savingFee || feeInput === String(bookingFee)}
              className="px-3 py-1 text-xs rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-40 transition-colors">
              {savingFee ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </header>

      <div className="flex min-h-[calc(100vh-57px)]">
        {/* Sidebar */}
        <nav className="w-52 border-r border-white/10 p-4 flex flex-col gap-1 shrink-0">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`text-left px-3 py-2 rounded text-sm transition-colors ${
                tab === t.id
                  ? "bg-[#18B79B]/15 text-[#18B79B] font-medium"
                  : "text-gray-400 hover:text-white hover:bg-white/5"
              }`}>
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="flex-1 p-6 overflow-y-auto">
          {tab === "salons_list"     && !isSupport && <Salons />}
          {tab === "add_salon"       && !isSupport && <AddSalon />}
          {tab === "categories"      && !isSupport && <Categories />}
          {tab === "bookings"        && <BookingsSupport />}
          {tab === "support_reps"    && !isSupport && <SupportReps />}
          {tab === "reports"         && !isSupport && <Reports />}
          {tab === "header_images"   && !isSupport && <HeaderImages />}
          {tab === "explore_section" && !isSupport && <ExploreSection />}
          {tab === "support"         && !isSupport && <Support />}
        </main>
      </div>
    </div>
  );
}
