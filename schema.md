# CUTQ — Firestore schema (as used in code)

This file reflects **only** what the CUTQ admin web app (`CUTQ-js`) and **Cloud Functions** (`functions`) read or write. Document IDs are noted where fixed.

---

## `app_config`

### `app_config/settings`

| Field | Type | Notes |
|-------|------|--------|
| `booking_fee` | number | Global booking fee (currency implied as ₹ in UI) |
| `updated_at` | timestamp | Set on create/update |

**Document ID:** `settings`

### `app_config/header`

| Field | Type | Notes |
|-------|------|--------|
| `images` | array of `{id, url}` | Ordered list of header carousel images |

**Document ID:** `header`

Each item in `images`:

| Field | Type | Notes |
|-------|------|--------|
| `id` | string | Stable UUID (used in Storage path) |
| `url` | string | Firebase Storage download URL |

**Storage path:** `app_config/header/{id}.jpg`

Admin panel allows adding (upload) and removing individual images. Changes are persisted as an array update on the single `header` document.

---

## `service_categories`

**Document ID:** auto-generated.

| Field | Type | Notes |
|-------|------|--------|
| `name` | string | |
| `icon_url` | string | URL from Storage; may be `""` until upload |
| `display_order` | number | Used with `orderBy("display_order")` |
| `is_active` | boolean | |
| `created_at` | timestamp | On create |
| `updated_at` | timestamp | On create / update / toggle |

**Indexes:** query uses `orderBy("display_order")` — ensure a composite index if you add filters later.

---

## `service_subcategories`

**Document ID:** auto-generated.

| Field | Type | Notes |
|-------|------|--------|
| `category_id` | string | Parent category document ID |
| `name` | string | |
| `icon_url` | string | May be `""` until upload |
| `banner_url` | string | May be `""` until upload |
| `display_order` | number | Used with `orderBy("display_order")` |
| `is_active` | boolean | |
| `created_at` | timestamp | On create |
| `updated_at` | timestamp | On create / update / toggle |

---

## `salons`

**Document ID:** auto-generated.

Salon **contact** `phone` / `email` are the business listing fields. **Owner identity** is only linked via `owner_uid` (Firebase Auth UID). Owner **name** and **phone** live on `Users/{owner_uid}`, not on the salon doc.

| Field | Type | Notes |
|-------|------|--------|
| `name` | string | Salon name |
| `owner_uid` | string | Firebase Auth UID of salon owner |
| `address` | string | |
| `location` | GeoPoint \| null | From `lat`/`lng` in app; invalid/missing → `null` |
| `city` | string | |
| `state` | string | |
| `pincode` | string | |
| `phone` | string | Salon contact phone (form field) |
| `email` | string | Salon contact email (form field) |
| `logo_url` | string | |
| `cover_photo` | string | |
| `gallery` | array | See **Gallery item** below |
| `working_hours` | map | Keys: `monday` … `sunday` |
| `slot_interval_minutes` | number | Set to **5** on create; not updated by `updateSalon` in current code |
| `avg_rating` | number | **0** on create; not updated by admin `updateSalon` |
| `review_count` | number | **0** on create; not updated by admin `updateSalon` |
| `is_active` | boolean | |
| `is_verified` | boolean | |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### `working_hours` day shape

Each key (`monday` … `sunday`) maps to:

| Field | Type |
|-------|------|
| `open` | string | e.g. `"09:00"` |
| `close` | string | e.g. `"20:00"` |
| `is_closed` | boolean | |

### `gallery[]` item shape

| Field | Type | Notes |
|-------|------|--------|
| `id` | string | Stable id (used in Storage path) |
| `url` | string | Download URL |
| `display_order` | number | Order in gallery |

---

## `Users`

**Document ID:** Firebase Auth **UID** (same as `owner_uid` for salon owners created via Cloud Function).

The admin panel auth code also **reads** a fallback collection name `users` (lowercase) if `Users` is missing — prefer **`Users`** for consistency.

| Field | Type | Notes |
|-------|------|--------|
| `name` | string | |
| `phone` | string | |
| `email` | string | |
| `profile_photo` | string | Often `""` |
| `created_at` | timestamp | |
| `Role` | string | e.g. `"ADMIN"`, `"SALONOWNER"` (exact strings used in code) |
| `isEnabled` | boolean | Must be `true` for admin login to admin panel |

**Written by Cloud Function `createSalonOwner`:** `Role: "SALONOWNER"`, `isEnabled: true`, plus name/phone/email from admin form.

**Read by:** `AdminAuth.jsx` (admin gate), `functions/index.js` (admin gate before creating owner).

---

## `explore_section`

**Document ID:** auto-generated (max 5 documents enforced by admin panel UI).

| Field | Type | Notes |
|-------|------|--------|
| `title` | string | Display title for the explore card |
| `image_url` | string | Firebase Storage download URL |
| `category_id` | string | Document ID of a `service_categories` document |
| `order` | number | Display order 1–5; auto-assigned (next available slot) on creation |
| `created_at` | timestamp | Set on create |
| `updated_at` | timestamp | Set on create / update |

**Indexes:** query uses `orderBy("order")`.

**Storage path:** `explore_section/{id}/image.jpg`

Admin panel caps creation at 5 documents. Editing allows changing title, category, and image; order is locked after creation. Deletion removes both the Firestore document and the Storage image.

---

## Summary table

| Collection | Primary use in repo |
|------------|---------------------|
| `app_config` | Global booking fee (`settings` doc), header carousel images (`header` doc) |
| `service_categories` | Service category CRUD |
| `service_subcategories` | Subcategory CRUD |
| `salons` | Salon CRUD / list |
| `Users` | Auth profiles, roles, salon owner creation |
| `explore_section` | Featured explore cards (max 5) with title, image, category link, order |

---

## Firebase Storage paths (reference)

Not Firestore, but tied to the same entities:

- `app_config/header/{id}.jpg` — header carousel images
- `service_categories/{id}/icon.jpg`
- `service_subcategories/{id}/icon.jpg`, `banner.jpg`
- `salons/{id}/logo.jpg`, `cover.jpg`, `gallery/{galleryItemId}.jpg`
- `explore_section/{id}/image.jpg` — explore section card images

---

*Generated from codebase. If you add fields in the UI or functions, update this file to match.*
