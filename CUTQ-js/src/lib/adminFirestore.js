import {
  collection, doc, updateDoc, deleteDoc, setDoc,
  getDocs, query, orderBy, serverTimestamp,
  runTransaction, onSnapshot, GeoPoint,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { db, storage, functions } from "../firebase";

function requireDb() {
  if (!db) throw new Error("Firebase is not configured (missing VITE_FIREBASE_* env vars).");
  return db;
}

function requireStorage() {
  if (!storage) throw new Error("Firebase Storage is not configured (missing VITE_FIREBASE_* env vars).");
  return storage;
}

function makeId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function toGeoPoint(location) {
  if (!location) return null;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return new GeoPoint(lat, lng);
}

function parseMaxBookingsPerSlot(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

const TARGETED_GENDER_VALUES = ["male", "female", "unisex"];

function parseTargetedGender(value) {
  const v = String(value ?? "").toLowerCase().trim();
  return TARGETED_GENDER_VALUES.includes(v) ? v : "unisex";
}

// ─── Storage helpers ─────────────────────────────────────────────────
// Long-lived cache. Safe because getDownloadURL() returns a token'd URL that
// changes whenever the file is overwritten, so consumers never serve a stale
// image from cache after an update.
const IMAGE_CACHE_CONTROL = "public, max-age=31536000";

export async function uploadFile(path, file) {
  const storageRef = ref(requireStorage(), path);
  try {
    await uploadBytes(storageRef, file, {
      contentType: file?.type || "image/jpeg",
      cacheControl: IMAGE_CACHE_CONTROL,
    });
    return await getDownloadURL(storageRef);
  } catch (err) {
    if (err?.code === "storage/unauthorized") {
      throw new Error("Image upload was blocked by Storage permissions. Check Firebase Storage rules.");
    }
    if (err?.code === "storage/retry-limit-exceeded" || err?.code === "storage/canceled") {
      throw new Error("Image upload failed (network/timeout). Please check your connection and try again.");
    }
    throw new Error(`Image upload failed: ${err?.message || err?.code || "unknown error"}`);
  }
}

export async function deleteFile(path) {
  try {
    await deleteObject(ref(storage, path));
  } catch {
    // ignore missing objects / permission differences
  }
}

// Download a searched royalty-free image server-side and re-host it to `path`.
// Iconify SVGs are rasterized to PNG by the Cloud Function (the app can't render
// SVG). Returns the Storage download URL.
async function attachStockImage(path, selection) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  const call = httpsCallable(functions, "attachRemoteImage");
  const res = await call({
    source: selection.source,
    storagePath: path,
    iconId: selection.iconId,
    color: selection.color,
    photoUrl: selection.photoUrl,
  });
  return res.data.url;
}

// Resolve an image input to a Storage download URL. The input is either a File
// (manual upload) or a stock-image selection ({ __stock: true, ... }) from the
// StockImagePicker. Returns null when there's no input.
async function resolveImage(path, input) {
  if (!input) return null;
  if (input.__stock) return attachStockImage(path, input);
  return uploadFile(path, input);
}

// ─── App Config (global booking fee) ────────────────────────────────
function configRef() {
  return doc(requireDb(), "app_config", "settings");
}

export function listenAppConfig(callback) {
  if (!db) {
    callback({ booking_fee: 0, booking_min_lead_minutes: 30 });
    return () => {};
  }
  return onSnapshot(configRef(), snap => {
    callback(snap.exists() ? snap.data() : { booking_fee: 0, booking_min_lead_minutes: 30 });
  });
}

/**
 * Minimum minutes ahead a customer may book. The apps only OFFER slots this far out; the
 * Cloud Functions accept a slot five minutes sooner, so a customer who takes a few minutes
 * to check out is not rejected at the last step. Change this one number and both follow.
 */
export async function updateBookingLeadMinutes(minutes) {
  const _db = requireDb();
  await runTransaction(_db, async tx => {
    const ref_ = configRef();
    const snap = await tx.get(ref_);
    const patch = { booking_min_lead_minutes: Number(minutes), updated_at: serverTimestamp() };
    if (snap.exists()) tx.update(ref_, patch);
    else tx.set(ref_, patch);
  });
}

export async function updateBookingFee(fee) {
  const _db = requireDb();
  await runTransaction(_db, async tx => {
    const ref_ = configRef();
    const snap = await tx.get(ref_);
    if (snap.exists()) {
      tx.update(ref_, { booking_fee: Number(fee), updated_at: serverTimestamp() });
    } else {
      tx.set(ref_, { booking_fee: Number(fee), updated_at: serverTimestamp() });
    }
  });
}

// ─── Service Categories ──────────────────────────────────────────────
export async function fetchCategories() {
  const _db = requireDb();
  const q = query(collection(_db, "service_categories"), orderBy("display_order"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function listenCategories(callback) {
  const _db = requireDb();
  const q = query(collection(_db, "service_categories"), orderBy("display_order"));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function addCategory(data, iconFile) {
  const _db = requireDb();
  const docRef = doc(collection(_db, "service_categories"));
  await runTransaction(_db, async tx => {
    tx.set(docRef, {
      name: data.name,
      icon_url: "",
      display_order: data.display_order,
      is_active: data.is_active ?? true,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
  });
  const iconUrl = await resolveImage(`service_categories/${docRef.id}/icon.jpg`, iconFile);
  if (iconUrl) await updateDoc(docRef, { icon_url: iconUrl });
  return docRef.id;
}

export async function updateCategory(id, data, iconFile) {
  const _db = requireDb();
  const ref_ = doc(_db, "service_categories", id);
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    if (!snap.exists()) throw new Error("Category not found");
    const updates = {
      name: data.name,
      display_order: data.display_order,
      is_active: data.is_active ?? true,
      updated_at: serverTimestamp(),
    };
    tx.update(ref_, updates);
  });
  const iconUrl = await resolveImage(`service_categories/${id}/icon.jpg`, iconFile);
  if (iconUrl) await updateDoc(ref_, { icon_url: iconUrl });
}

export async function toggleCategory(id, is_active) {
  const _db = requireDb();
  const ref_ = doc(_db, "service_categories", id);
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    if (!snap.exists()) throw new Error("Not found");
    tx.update(ref_, { is_active, updated_at: serverTimestamp() });
  });
}

export async function deleteCategory(id) {
  await deleteFile(`service_categories/${id}/icon.jpg`);
  const _db = requireDb();
  await runTransaction(_db, async tx => {
    tx.delete(doc(_db, "service_categories", id));
  });
}

// ─── Service Subcategories ───────────────────────────────────────────
export async function fetchSubcategories(categoryId) {
  const _db = requireDb();
  const q = query(collection(_db, "service_subcategories"), orderBy("display_order"));
  const snap = await getDocs(q);
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return categoryId ? all.filter(s => s.category_id === categoryId) : all;
}

export function listenSubcategories(callback) {
  const _db = requireDb();
  const q = query(collection(_db, "service_subcategories"), orderBy("display_order"));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function addSubcategory(data, iconFile, bannerFile) {
  const _db = requireDb();
  const docRef = doc(collection(_db, "service_subcategories"));
  await runTransaction(_db, async tx => {
    tx.set(docRef, {
      category_id: data.category_id,
      name: data.name,
      icon_url: "",
      banner_url: "",
      display_order: data.display_order,
      is_active: data.is_active ?? true,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
  });
  const updates = {};
  const iconUrl = await resolveImage(`service_subcategories/${docRef.id}/icon.jpg`, iconFile);
  if (iconUrl) updates.icon_url = iconUrl;
  const bannerUrl = await resolveImage(`service_subcategories/${docRef.id}/banner.jpg`, bannerFile);
  if (bannerUrl) updates.banner_url = bannerUrl;
  if (Object.keys(updates).length) await updateDoc(docRef, updates);
  return docRef.id;
}

export async function updateSubcategory(id, data, iconFile, bannerFile) {
  const _db = requireDb();
  const ref_ = doc(_db, "service_subcategories", id);
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    if (!snap.exists()) throw new Error("Not found");
    tx.update(ref_, {
      name: data.name,
      display_order: data.display_order,
      category_id: data.category_id,
      is_active: data.is_active ?? true,
      updated_at: serverTimestamp(),
    });
  });
  const updates = {};
  const iconUrl = await resolveImage(`service_subcategories/${id}/icon.jpg`, iconFile);
  if (iconUrl) updates.icon_url = iconUrl;
  const bannerUrl = await resolveImage(`service_subcategories/${id}/banner.jpg`, bannerFile);
  if (bannerUrl) updates.banner_url = bannerUrl;
  if (Object.keys(updates).length) await updateDoc(ref_, updates);
}

export async function toggleSubcategory(id, is_active) {
  const _db = requireDb();
  const ref_ = doc(_db, "service_subcategories", id);
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    if (!snap.exists()) throw new Error("Not found");
    tx.update(ref_, { is_active, updated_at: serverTimestamp() });
  });
}

export async function deleteSubcategory(id) {
  await deleteFile(`service_subcategories/${id}/icon.jpg`);
  await deleteFile(`service_subcategories/${id}/banner.jpg`);
  const _db = requireDb();
  await runTransaction(_db, async tx => {
    tx.delete(doc(_db, "service_subcategories", id));
  });
}

// ─── Salons ──────────────────────────────────────────────────────────
export function listenSalons(callback) {
  const _db = requireDb();
  return onSnapshot(collection(_db, "salons"), snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function addSalon(data, logoFile, coverFile) {
  const _db = requireDb();
  const docRef = doc(collection(_db, "salons"));
  await runTransaction(_db, async tx => {
    tx.set(docRef, {
      name: data.name,
      targeted_gender: parseTargetedGender(data.targeted_gender),
      owner_uid: data.owner_uid,
      address: data.address,
      location: toGeoPoint(data.location),
      city: data.city,
      state: data.state,
      pincode: data.pincode,
      phone: data.phone,
      email: data.email,
      logo_url: "",
      cover_photo: "",
      gallery: [],
      working_hours: data.working_hours,
      slot_interval_minutes: 5,
      max_bookings_per_slot: parseMaxBookingsPerSlot(data.max_bookings_per_slot),
      avg_rating: 0,
      review_count: 0,
      is_active: true,
      is_verified: true,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
  });
  // upload logo + cover in parallel
  const [logoUrl, coverUrl] = await Promise.all([
    logoFile ? uploadFile(`salons/${docRef.id}/logo.jpg`, logoFile) : Promise.resolve(null),
    coverFile ? uploadFile(`salons/${docRef.id}/cover.jpg`, coverFile) : Promise.resolve(null),
  ]);
  const updates = {};
  if (logoUrl) updates.logo_url = logoUrl;
  if (coverUrl) updates.cover_photo = coverUrl;
  if (Object.keys(updates).length) await updateDoc(docRef, updates);
  return docRef.id;
}

// Faster variant for AddSalon: creates doc then uploads logo + cover + gallery
// all in parallel, finishing with a single updateDoc instead of two.
export async function addSalonFull(data, logoFile, coverFile, galleryFiles = []) {
  const _db = requireDb();
  const docRef = doc(collection(_db, "salons"));
  await runTransaction(_db, async tx => {
    tx.set(docRef, {
      name: data.name,
      targeted_gender: parseTargetedGender(data.targeted_gender),
      owner_uid: data.owner_uid,
      address: data.address,
      location: toGeoPoint(data.location),
      city: data.city,
      state: data.state,
      pincode: data.pincode,
      phone: data.phone,
      email: data.email,
      logo_url: "",
      cover_photo: "",
      gallery: [],
      working_hours: data.working_hours,
      slot_interval_minutes: 5,
      max_bookings_per_slot: parseMaxBookingsPerSlot(data.max_bookings_per_slot),
      avg_rating: 0,
      review_count: 0,
      is_active: true,
      is_verified: true,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
  });
  const id = docRef.id;
  // upload everything in parallel
  const [logoUrl, coverUrl, ...galleryItems] = await Promise.all([
    logoFile ? uploadFile(`salons/${id}/logo.jpg`, logoFile) : Promise.resolve(null),
    coverFile ? uploadFile(`salons/${id}/cover.jpg`, coverFile) : Promise.resolve(null),
    ...galleryFiles.map((file, idx) => uploadSalonGalleryItem(id, file, idx)),
  ]);
  const updates = { updated_at: serverTimestamp() };
  if (logoUrl) updates.logo_url = logoUrl;
  if (coverUrl) updates.cover_photo = coverUrl;
  if (galleryItems.length) updates.gallery = galleryItems;
  await updateDoc(docRef, updates);
  return id;
}

export async function updateSalon(id, data, logoFile, coverFile, gallery) {
  const _db = requireDb();
  const ref_ = doc(_db, "salons", id);
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    if (!snap.exists()) throw new Error("Salon not found");
    tx.update(ref_, {
      name: data.name,
      targeted_gender: parseTargetedGender(data.targeted_gender),
      owner_uid: data.owner_uid,
      address: data.address,
      location: toGeoPoint(data.location),
      city: data.city,
      state: data.state,
      pincode: data.pincode,
      phone: data.phone,
      email: data.email,
      gallery: Array.isArray(gallery) ? gallery : (data.gallery ?? []),
      working_hours: data.working_hours,
      max_bookings_per_slot: parseMaxBookingsPerSlot(data.max_bookings_per_slot),
      is_active: data.is_active ?? true,
      is_verified: data.is_verified ?? true,
      updated_at: serverTimestamp(),
    });
  });
  const updates = {};
  if (logoFile)
    updates.logo_url = await uploadFile(`salons/${id}/logo.jpg`, logoFile);
  if (coverFile)
    updates.cover_photo = await uploadFile(`salons/${id}/cover.jpg`, coverFile);
  if (Object.keys(updates).length) await updateDoc(ref_, updates);
}

export async function toggleSalon(id, field, value) {
  const _db = requireDb();
  const ref_ = doc(_db, "salons", id);
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    if (!snap.exists()) throw new Error("Salon not found");
    tx.update(ref_, { [field]: value, updated_at: serverTimestamp() });
  });
}

export async function uploadSalonGalleryItem(salonId, file, display_order) {
  const id = makeId();
  const url = await uploadFile(`salons/${salonId}/gallery/${id}.jpg`, file);
  return { id, url, display_order: Number(display_order) };
}

// ─── Header Images (app_config/header) ──────────────────────────────
function headerDocRef() {
  return doc(requireDb(), "app_config", "header");
}

export function listenHeaderImages(callback) {
  if (!db) {
    callback({ images: [] });
    return () => {};
  }
  return onSnapshot(headerDocRef(), snap => {
    callback(snap.exists() ? snap.data() : { images: [] });
  });
}

export async function addHeaderImage(file) {
  const id = makeId();
  const url = await uploadFile(`app_config/header/${id}.jpg`, file);
  const _db = requireDb();
  const ref_ = headerDocRef();
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    const existing = snap.exists() ? (snap.data().images || []) : [];
    const newItem = { id, url };
    if (snap.exists()) {
      tx.update(ref_, { images: [...existing, newItem] });
    } else {
      tx.set(ref_, { images: [newItem] });
    }
  });
  return { id, url };
}

export async function removeHeaderImage(item) {
  const _db = requireDb();
  const ref_ = headerDocRef();
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    if (!snap.exists()) return;
    const existing = snap.data().images || [];
    tx.update(ref_, { images: existing.filter(img => img.id !== item.id) });
  });
  await deleteFile(`app_config/header/${item.id}.jpg`);
}

// ─── Explore Section ─────────────────────────────────────────────────
export function listenExploreSections(callback) {
  const _db = requireDb();
  const q = query(collection(_db, "explore_section"), orderBy("order"));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function addExploreSection(data, imageFile) {
  if (!imageFile) throw new Error("Image is required");
  const _db = requireDb();
  const docRef = doc(collection(_db, "explore_section"));
  await runTransaction(_db, async tx => {
    tx.set(docRef, {
      title: data.title,
      image_url: "",
      category_id: data.category_id,
      order: data.order,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
  });
  const url = await uploadFile(`explore_section/${docRef.id}/image.jpg`, imageFile);
  await updateDoc(docRef, { image_url: url });
  return docRef.id;
}

export async function updateExploreSection(id, data, imageFile) {
  const _db = requireDb();
  const ref_ = doc(_db, "explore_section", id);
  await runTransaction(_db, async tx => {
    const snap = await tx.get(ref_);
    if (!snap.exists()) throw new Error("Explore section item not found");
    tx.update(ref_, {
      title: data.title,
      category_id: data.category_id,
      updated_at: serverTimestamp(),
    });
  });
  if (imageFile) {
    const url = await uploadFile(`explore_section/${id}/image.jpg`, imageFile);
    await updateDoc(ref_, { image_url: url });
  }
}

export async function deleteExploreSection(id) {
  await deleteFile(`explore_section/${id}/image.jpg`);
  await deleteDoc(doc(requireDb(), "explore_section", id));
}
// ─── Support Collection ──────────────────────────────────────────────
// All support data lives in collection `support` with fixed document IDs:
//   support/contact            → email, phone, support_hours
//   support/faqs               → items: [{id, question, answer, order}]
//   support/privacy_policy_user   → html: string
//   support/privacy_policy_salon  → html: string

function supportDocRef(docId) {
  return doc(requireDb(), "support", docId);
}

// ── Contact ──────────────────────────────────────────────────────────
export function listenSupportContact(callback) {
  if (!db) { callback({ email: "", phone: "", support_hours: "" }); return () => {}; }
  return onSnapshot(supportDocRef("contact"), snap => {
    callback(snap.exists() ? snap.data() : { email: "", phone: "", support_hours: "" });
  });
}

export async function saveSupportContact({ email, phone, support_hours }) {
  await setDoc(supportDocRef("contact"), { email, phone, support_hours, updated_at: serverTimestamp() }, { merge: true });
}

// ── FAQs ─────────────────────────────────────────────────────────────
export function listenSupportFaqs(callback) {
  if (!db) { callback({ items: [] }); return () => {}; }
  return onSnapshot(supportDocRef("faqs"), snap => {
    callback(snap.exists() ? snap.data() : { items: [] });
  });
}

export async function saveSupportFaqs(items) {
  // items: [{ id, question, answer, order }]
  await setDoc(supportDocRef("faqs"), { items, updated_at: serverTimestamp() }, { merge: true });
}

// ── Privacy Policy ────────────────────────────────────────────────────
export function listenPrivacyPolicy(type, callback) {
  // type: "user" | "salon"
  const id = type === "salon" ? "privacy_policy_salon" : "privacy_policy_user";
  if (!db) { callback({ html: "" }); return () => {}; }
  return onSnapshot(supportDocRef(id), snap => {
    callback(snap.exists() ? snap.data() : { html: "" });
  });
}

export async function savePrivacyPolicy(type, html) {
  const id = type === "salon" ? "privacy_policy_salon" : "privacy_policy_user";
  await setDoc(supportDocRef(id), { html, updated_at: serverTimestamp() }, { merge: true });
}

// ── Terms & Conditions ────────────────────────────────────────────────
// Same shape and same `support/{docId}` rule as the privacy policy: public read, admin write.
//   support/terms_user   → html: string
export function listenTerms(type, callback) {
  const id = type === "salon" ? "terms_salon" : "terms_user";
  if (!db) { callback({ html: "" }); return () => {}; }
  return onSnapshot(supportDocRef(id), snap => {
    callback(snap.exists() ? snap.data() : { html: "" });
  });
}

export async function saveTerms(type, html) {
  const id = type === "salon" ? "terms_salon" : "terms_user";
  await setDoc(supportDocRef(id), { html, updated_at: serverTimestamp() }, { merge: true });
}

// ─── Customer Support Representative (callables) ──────────────────────
export async function supportListBookings(max = 500) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  const call = httpsCallable(functions, "supportListBookings");
  const res = await call({ limit: max });
  return res.data?.bookings ?? [];
}

// target: "salon" | "customer"; returns { support_called_salon, support_called_customer }
export async function markSupportCall(bookingId, target, done) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  const call = httpsCallable(functions, "markSupportCall");
  const res = await call({ bookingId, target, done });
  return res.data;
}

// ─── Panel booking actions (ADMIN + SUPPORT) ──────────────────────────────
//
// The panel has no direct write access to bookings (firestore.rules admits only
// the booking's own user or the salon's staff), so every action below goes
// through a callable running on the Admin SDK. Each returns the same projected
// booking shape supportListBookings emits, so the caller merges rather than
// reloads.

// action: "confirm" | "cancel_by_salon" | "cancel_by_user"; returns { booking }
export async function supportUpdateBookingStatus(bookingId, action, {reason = "", override = false} = {}) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  const call = httpsCallable(functions, "supportUpdateBookingStatus");
  const res = await call({ bookingId, action, reason, override });
  return res.data?.booking ?? null;
}

// returns { wasConfirmed, booking }
export async function supportRescheduleBooking(bookingId, newSlotStartMs, {override = false} = {}) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  const call = httpsCallable(functions, "supportRescheduleBooking");
  const res = await call({ bookingId, newSlotStartMs, override });
  return res.data;
}

// returns { timezone, duration_minutes, slots: [{ start_ms, label, free, code }] }
export async function supportGetSalonDayAvailability(salonId, dayStartMs, durationMinutes, excludeBookingId) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  const call = httpsCallable(functions, "supportGetSalonDayAvailability");
  const res = await call({ salonId, dayStartMs, durationMinutes, excludeBookingId });
  return res.data;
}

// returns { uid, email, password, isExisting }
export async function createSupportRep(email, name, phone) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  const call = httpsCallable(functions, "createSupportRep");
  const res = await call({ email, name, phone });
  return res.data;
}

// ─── Issue reports ────────────────────────────────────────────────────
export function listenReportCategories(callback) {
  const _db = requireDb();
  const q = query(collection(_db, "report_categories"), orderBy("order"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function addReportCategory(name, order = 0, requiresService = false) {
  const _db = requireDb();
  const ref = doc(collection(_db, "report_categories"));
  await setDoc(ref, {
    name: name.trim(),
    is_active: true,
    order,
    // Written explicitly so the field is visible in Firestore and the admin toggle never
    // renders from `undefined`. The apps default it to false when absent.
    requires_service: requiresService,
    created_at: serverTimestamp(),
  });
}

export async function updateReportCategory(id, data) {
  await updateDoc(doc(requireDb(), "report_categories", id), { ...data, updated_at: serverTimestamp() });
}

export async function deleteReportCategory(id) {
  await deleteDoc(doc(requireDb(), "report_categories", id));
}

export function listenReportConfig(callback) {
  const _db = requireDb();
  return onSnapshot(doc(_db, "report_config", "settings"), snap =>
    callback(snap.exists() ? snap.data() : { notify_emails: [] }));
}

export async function saveReportNotifyEmails(emails) {
  await setDoc(doc(requireDb(), "report_config", "settings"),
    { notify_emails: emails, updated_at: serverTimestamp() }, { merge: true });
}

export function listenReports(callback) {
  const _db = requireDb();
  const q = query(collection(_db, "reports"), orderBy("created_at", "desc"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function updateReportStatus(id, status) {
  await updateDoc(doc(requireDb(), "reports", id), { status, updated_at: serverTimestamp() });
}

// ─── Partner requests (leads from the CutQ landing page) ───────────────
export function listenPartnerRequests(callback) {
  const _db = requireDb();
  const q = query(collection(_db, "partner_requests"), orderBy("created_at", "desc"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function updatePartnerRequestStatus(id, status) {
  await updateDoc(doc(requireDb(), "partner_requests", id), { status, updated_at: serverTimestamp() });
}

export async function deletePartnerRequest(id) {
  await deleteDoc(doc(requireDb(), "partner_requests", id));
}

// ─── Salon onboarding submissions (public /onboard form) ───────────────
// Writes a full salon-details submission (with images) for the admin to review.
// `fields` mirrors the Add Salon inputs; images go under salon_submissions/{id}/.
export async function submitSalonOnboarding(fields, { logoFile, coverFile, galleryFiles = [] }) {
  const _db = requireDb();
  const id = makeId();
  const base = `salon_submissions/${id}`;

  const logoPath = logoFile ? `${base}/logo.jpg` : "";
  const coverPath = coverFile ? `${base}/cover.jpg` : "";
  const logo_url = logoFile ? await uploadFile(logoPath, logoFile) : "";
  const cover_photo = coverFile ? await uploadFile(coverPath, coverFile) : "";

  const gallery = [];
  for (let i = 0; i < galleryFiles.length; i++) {
    const path = `${base}/gallery/${makeId()}.jpg`;
    const url = await uploadFile(path, galleryFiles[i]);
    gallery.push({ url, path, display_order: i });
  }

  await setDoc(doc(_db, "salon_submissions", id), {
    name: fields.name || "",
    targeted_gender: parseTargetedGender(fields.targeted_gender),
    phone: fields.phone || "",
    email: fields.email || "",
    address: fields.address || "",
    city: fields.city || "",
    state: fields.state || "",
    pincode: fields.pincode || "",
    max_bookings_per_slot: parseMaxBookingsPerSlot(fields.max_bookings_per_slot),
    owner_email: fields.owner_email || "",
    owner_name: fields.owner_name || "",
    owner_phone: fields.owner_phone || "",
    location: fields.location
      ? { lat: Number(fields.location.lat), lng: Number(fields.location.lng) }
      : null,
    working_hours: fields.working_hours || {},
    logo_url, logo_path: logoPath,
    cover_photo, cover_path: coverPath,
    gallery,
    status: "new",
    created_at: serverTimestamp(),
  });
  return id;
}

export function listenSalonSubmissions(callback) {
  const _db = requireDb();
  const q = query(collection(_db, "salon_submissions"), orderBy("created_at", "desc"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function deleteSalonSubmission(sub) {
  const _db = requireDb();
  const paths = [sub.logo_path, sub.cover_path, ...(sub.gallery || []).map(g => g.path)].filter(Boolean);
  await Promise.all(paths.map(p => deleteFile(p)));
  await deleteDoc(doc(_db, "salon_submissions", sub.id));
}

// ─── Callables (Cloud Functions) ───────────────────────────────────────
export async function deleteSalonCascade(salonId) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  await httpsCallable(functions, "deleteSalonCascade")({ salonId });
}

export async function importSubmissionImages(payload) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  const res = await httpsCallable(functions, "importSubmissionImages")(payload);
  return res.data;
}
