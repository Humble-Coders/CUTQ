# Salon Booking App — Firestore Schema

---

## `app_config`

**Document ID:** `settings` (fixed path: `app_config/settings`)

| Field | Type | Notes |
|-------|------|-------|
| `booking_fee` | number | Global booking fee in ₹, applies to all salons |
| `updated_at` | timestamp | Set on create and every update |

---

## `app_config/header`

**Document ID:** `header` (fixed path: `app_config/header`)

| Field | Type | Notes |
|-------|------|-------|
| `images` | array | Array of **Header image item** objects |

### Header image item shape

Each item in `images[]`:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Stable ID (also used for Storage filename) |
| `url` | string | Image download URL |

---

## `service_categories`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Category display name |
| `icon_url` | string | Firebase Storage URL; `""` until uploaded |
| `display_order` | number | Ascending sort order in UI |
| `is_active` | boolean | |
| `created_at` | timestamp | Set on create |
| `updated_at` | timestamp | Set on create, update, and toggle |

**Storage:** `service_categories/{id}/icon.jpg`

**Indexes:** `orderBy("display_order")`

---

## `explore_section`

**Document ID:** auto-generated

**Max documents:** Admin panel should keep a maximum of `5` documents.

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Required |
| `image_url` | string | Required |
| `category_id` | string | Required; ref → `service_categories/{categoryId}` document ID |
| `order` | number | Required; values `1..5`, auto-assigned |
| `created_at` | timestamp | Set on create |
| `updated_at` | timestamp | Set on create and every update |

---

## `service_subcategories`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `category_id` | string | Parent `service_categories` document ID |
| `name` | string | Subcategory display name |
| `icon_url` | string | Firebase Storage URL; `""` until uploaded |
| `banner_url` | string | Firebase Storage URL; `""` until uploaded |
| `display_order` | number | Ascending sort order in UI |
| `is_active` | boolean | |
| `created_at` | timestamp | Set on create |
| `updated_at` | timestamp | Set on create, update, and toggle |

**Storage:**
- `service_subcategories/{id}/icon.jpg`
- `service_subcategories/{id}/banner.jpg`

**Indexes:** `orderBy("display_order")`

---

## `Users`

**Document ID:** Firebase Auth UID

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | |
| `phone` | string | |
| `email` | string | |
| `profile_photo` | string | Often `""` |
| `Role` | string | `"ADMIN"` \| `"SALONOWNER"` \| `"USER"` |
| `isEnabled` | boolean | Must be `true` for admin panel login |
| `created_at` | timestamp | Set on create |

**Written by:** Cloud Function `createSalonOwner` sets `Role: "SALONOWNER"`, `isEnabled: true`

**Read by:** Admin auth gate, `createSalonOwner` Cloud Function

---

## `salons`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Salon display name |
| `targeted_gender` | string | `"male"` \| `"female"` \| `"unisex"` — who the salon primarily serves |
| `owner_uid` | string | Firebase Auth UID — links to `Users/{owner_uid}` |
| `address` | string | |
| `location` | GeoPoint \| null | Derived from lat/lng; `null` if invalid or missing |
| `city` | string | |
| `state` | string | |
| `pincode` | string | |
| `phone` | string | Salon business contact phone |
| `email` | string | Salon business contact email |
| `logo_url` | string | Firebase Storage URL |
| `cover_photo` | string | Firebase Storage URL |
| `gallery` | array | See **Gallery item** shape below |
| `working_hours` | map | Keys: `monday` … `sunday`; see **Working hours day** shape below |
| `slot_interval_minutes` | number | Fixed at `5` on create |
| `max_bookings_per_slot` | number | Maximum concurrent bookings allowed per time slot; integer ≥ `1`; set from admin **Add Salon** / **Edit Salon** |
| `avg_rating` | number | `0` on create; updated by booking/review logic, not admin |
| `review_count` | number | `0` on create; updated by booking/review logic, not admin |
| `is_active` | boolean | |
| `is_verified` | boolean | |
| `created_at` | timestamp | Set on create |
| `updated_at` | timestamp | Set on create and every update |

### Working hours day shape

Each day key (`monday` … `sunday`) maps to:

| Field | Type | Notes |
|-------|------|-------|
| `open` | string | e.g. `"09:00"` |
| `close` | string | e.g. `"20:00"` |
| `is_closed` | boolean | |

### Gallery item shape

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Stable ID used in Storage path |
| `url` | string | Firebase Storage download URL |
| `display_order` | number | Order in gallery |

**Storage:**
- `salons/{id}/logo.jpg`
- `salons/{id}/cover.jpg`
- `salons/{id}/gallery/{galleryItemId}.jpg`

---

## `salons/{salonId}/services/{serviceId}`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `category_id` | string | Parent `service_categories` document ID — denormalized from subcategory for efficient cross-category filtering |
| `subcategory_id` | string | Parent `service_subcategories` document ID |
| `name` | string | Salon's custom service name |
| `description` | string | |
| `price` | number | In ₹ |
| `duration_minutes` | number | e.g. `30`, `45`, `60` |
| `photos` | array | See **Service photo item** shape below |
| `avg_rating` | number | `0` on create; updated by review logic |
| `review_count` | number | `0` on create; updated by review logic |
| `is_active` | boolean | |
| `created_at` | timestamp | Set on create |
| `updated_at` | timestamp | Set on create and every update |

### Service photo item shape

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Stable ID used in Storage path |
| `url` | string | Firebase Storage download URL |
| `display_order` | number | First item is used as thumbnail |

**Storage:** `salons/{salonId}/services/{serviceId}/{photoId}.jpg`

---

## `salons/{salonId}/stylists/{stylistId}`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | |
| `photo_url` | string | Firebase Storage URL |
| `bio` | string | |
| `service_ids` | string[] | IDs of services this stylist performs |
| `is_active` | boolean | |
| `created_at` | timestamp | Set on create |

**Storage:** `salons/{salonId}/stylists/{stylistId}/photo.jpg`

---

## `salons/{salonId}/blocked_slots/{blockId}`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `stylist_id` | string \| null | `null` = entire salon blocked; string = specific stylist blocked |
| `start` | timestamp | Block start |
| `end` | timestamp | Block end |
| `reason` | string | `"break"` \| `"holiday"` \| `"walkin"` \| `"other"` |
| `created_at` | timestamp | Set on create |

---

## `bookings`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `user_id` | string | Ref → `Users` |
| `salon_id` | string | Ref → `salons` |
| `service_id` | string | Ref → `salons/{salonId}/services` |
| `stylist_id` | string \| null | Ref → `salons/{salonId}/stylists`; `null` if no preference |
| `slot_start` | timestamp | Exact slot start time |
| `slot_end` | timestamp | `slot_start` + `duration_minutes` |
| `status` | string | `"pending"` \| `"confirmed"` \| `"completed"` \| `"cancelled"` |
| `cancellation_reason` | string \| null | |
| `cancelled_by` | string \| null | `"user"` \| `"salon"` |
| `service_price` | number | Snapshot of price at booking time |
| `booking_fee` | number | Snapshot of global booking fee at booking time |
| `coupon_id` | string \| null | Ref → `coupons` |
| `coupon_code` | string \| null | Snapshot of coupon code for display |
| `discount_amount` | number | `0` if no coupon |
| `final_amount` | number | `service_price + booking_fee - discount_amount` |
| `notes` | string | User instructions to salon |
| `is_reviewed` | boolean | Gates review submission; set to `true` after review created |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

**Indexes:**
- `(salon_id, slot_start ASC)` — salon dashboard calendar
- `(salon_id, status, created_at DESC)` — salon filter by status
- `(user_id, created_at DESC)` — user booking history

---

## `coupons`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `code` | string | Unique, uppercase |
| `type` | string | `"percent"` \| `"flat"` |
| `value` | number | Percentage or flat ₹ amount |
| `min_order_amount` | number | Minimum order value to apply coupon |
| `max_discount` | number \| null | Cap for percent coupons; `null` = no cap |
| `usage_limit` | number \| null | Total uses allowed; `null` = unlimited |
| `used_count` | number | Incremented on each valid redemption |
| `expires_at` | timestamp | |
| `is_active` | boolean | |
| `created_at` | timestamp | |

---

## `salon_reviews`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `salon_id` | string | Ref → `salons` |
| `user_id` | string | Ref → `Users` |
| `booking_id` | string | Ref → `bookings`; enforces one review per booking |
| `rating` | number | 1–5 |
| `comment` | string | |
| `created_at` | timestamp | |

**Indexes:** `(salon_id, created_at DESC)`

---

## `service_reviews`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `salon_id` | string | Ref → `salons` |
| `service_id` | string | Ref → `salons/{salonId}/services` |
| `user_id` | string | Ref → `Users` |
| `booking_id` | string | Ref → `bookings`; enforces one review per booking |
| `rating` | number | 1–5 |
| `comment` | string | |
| `created_at` | timestamp | |

**Indexes:** `(service_id, created_at DESC)`

---

## `salon_category_index`

**Document ID:** `{salonId}_{categoryId}` (deterministic — safe to upsert)

| Field | Type | Notes |
|-------|------|-------|
| `salon_id` | string | Ref → `salons` |
| `category_id` | string | Ref → `service_categories` |
| `city` | string | Denormalized for city-scoped search |
| `created_at` | timestamp | |

**Written by:** service add/delete (batch write alongside salon service doc)

**Indexes:** `(category_id, city, salon_id)`

---

## `salon_subcategory_index`

**Document ID:** `{salonId}_{subcategoryId}` (deterministic — safe to upsert)

| Field | Type | Notes |
|-------|------|-------|
| `salon_id` | string | Ref → `salons` |
| `subcategory_id` | string | Ref → `service_subcategories` |
| `city` | string | Denormalized for city-scoped search |
| `created_at` | timestamp | |

**Written by:** service add/delete (batch write alongside salon service doc)

**Indexes:** `(subcategory_id, city, salon_id)`

---

## Firebase Storage — full path reference

| Path | Used for |
|------|----------|
| `service_categories/{id}/icon.jpg` | Category icon |
| `service_subcategories/{id}/icon.jpg` | Subcategory icon |
| `service_subcategories/{id}/banner.jpg` | Subcategory banner |
| `salons/{id}/logo.jpg` | Salon logo |
| `salons/{id}/cover.jpg` | Salon cover photo |
| `salons/{id}/gallery/{galleryItemId}.jpg` | Salon gallery images |
| `salons/{id}/services/{serviceId}/{photoId}.jpg` | Service photos |
| `salons/{id}/stylists/{stylistId}/photo.jpg` | Stylist photo |