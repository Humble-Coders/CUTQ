import {
  collection, doc, updateDoc, deleteDoc,
  getDocs, query, orderBy, serverTimestamp,
  runTransaction, onSnapshot, GeoPoint,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from "../firebase";

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
export async function uploadFile(path, file) {
  const storageRef = ref(requireStorage(), path);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}

export async function deleteFile(path) {
  try {
    await deleteObject(ref(storage, path));
  } catch {
    // ignore missing objects / permission differences
  }
}

// ─── App Config (global booking fee) ────────────────────────────────
function configRef() {
  return doc(requireDb(), "app_config", "settings");
}

export function listenAppConfig(callback) {
  if (!db) {
    callback({ booking_fee: 0 });
    return () => {};
  }
  return onSnapshot(configRef(), snap => {
    callback(snap.exists() ? snap.data() : { booking_fee: 0 });
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
  if (iconFile) {
    const url = await uploadFile(`service_categories/${docRef.id}/icon.jpg`, iconFile);
    await updateDoc(docRef, { icon_url: url });
  }
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
  if (iconFile) {
    const url = await uploadFile(`service_categories/${id}/icon.jpg`, iconFile);
    await updateDoc(ref_, { icon_url: url });
  }
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
  if (iconFile)
    updates.icon_url = await uploadFile(`service_subcategories/${docRef.id}/icon.jpg`, iconFile);
  if (bannerFile)
    updates.banner_url = await uploadFile(`service_subcategories/${docRef.id}/banner.jpg`, bannerFile);
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
  if (iconFile)
    updates.icon_url = await uploadFile(`service_subcategories/${id}/icon.jpg`, iconFile);
  if (bannerFile)
    updates.banner_url = await uploadFile(`service_subcategories/${id}/banner.jpg`, bannerFile);
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