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
| `name` | string | Display name; collected on first sign-in |
| `phone` | string | |
| `email` | string | |
| `profile_photo` | string | Often `""` |
| `gender` | string | `"Male"` \| `"Female"` \| `""`; collected on first sign-in |
| `dob` | string | `"DD-MM-YYYY"` format; optional, collected on first sign-in |
| `Role` | string | `"ADMIN"` \| `"SALONOWNER"` \| `"SALONTEAM"` \| `"SUPPORT"` \| `"USER"` |
| `isEnabled` | boolean | Must be `true` for admin panel login |
| `created_at` | timestamp | Set on create |

**Written by:** Cloud Function `createSalonOwner` sets `Role: "SALONOWNER"`, `isEnabled: true`; Cloud Function `createSupportRep` sets `Role: "SUPPORT"`, `isEnabled: true`

> **`SUPPORT` role (Customer Support Representative):** can sign into the **admin panel** but sees **only** the Bookings section (all bookings across every salon/user, with salon + customer name & phone). Used to call both parties to confirm a booking, then mark `support_called_salon` / `support_called_customer`. When **both** are `true`, the salon dashboard shows a "Customer Confirmed" badge (the end-user app shows nothing).

**Read by:** Admin auth gate, `createSalonOwner` Cloud Function

---

## `salons`

**Document ID:** auto-generated

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Salon display name |
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
| `targeted_gender` | string | `"male"` \| `"female"` \| `"unisex"`; default `"unisex"` |
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

Each booking represents a single visit and may contain one or more services booked sequentially.

| Field | Type | Notes |
|-------|------|-------|
| `user_id` | string | Ref → `Users` |
| `salon_id` | string | Ref → `salons` |
| `salon_name` | string | Denormalized for display without extra reads |
| `salon_logo_url` | string | Denormalized |
| `stylist_id` | string \| null | Ref → `salons/{salonId}/stylists`; `null` if no preference |
| `slot_start` | timestamp | Total visit start (start of first service) |
| `slot_end` | timestamp | Total visit end (end of last service) |
| `services` | array of maps | One entry per booked service (see below) |
| `total_service_price` | number | Sum of all service prices |
| `booking_fee` | number | Snapshot of global booking fee (charged once per booking) |
| `booked_for_other` | boolean | `true` when the user booked on behalf of someone else. Absent/`false` for normal bookings. `user_id` still refers to the account holder who placed the booking |
| `beneficiary_name` | string | Name of the person being served (only when `booked_for_other`); `""` otherwise |
| `beneficiary_phone` | string | Contact number of the beneficiary (only when `booked_for_other`); `""` otherwise |
| `beneficiary_gender` | string | `"Male"` \| `"Female"` \| `"Other"` — required when `booked_for_other`; `""` otherwise |
| `coupon_id` | string \| null | Ref → `coupons` |
| `coupon_code` | string \| null | Snapshot of coupon code for display |
| `discount_amount` | number | `0` if no coupon |
| `final_amount` | number | `total_service_price + booking_fee - discount_amount` |
| `notes` | string | User instructions to salon |
| `status` | string | `"pending"` \| `"confirmed"` \| `"completed"` \| `"cancelled"` |
| `cancellation_reason` | string \| null | |
| `cancelled_by` | string \| null | `"user"` \| `"salon"` \| `"system"` |
| `is_reviewed` | boolean | Set to `true` after any review is submitted for this booking |
| `support_called_salon` | boolean | Set `true` by a Customer Support Rep (admin panel) after phoning the **salon** to confirm the booking. Absent/`false` until then |
| `support_called_customer` | boolean | Set `true` by a Customer Support Rep after phoning the **customer** to confirm. Absent/`false` until then |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### `services` array entry

| Field | Type | Notes |
|-------|------|-------|
| `service_id` | string | Ref → `salons/{salonId}/services` |
| `service_name` | string | Denormalized snapshot |
| `service_price` | number | Snapshot of price at booking time |
| `duration_minutes` | number | Snapshot of duration at booking time |
| `slot_start` | timestamp | Individual service start time |
| `slot_end` | timestamp | Individual service end time |

> **Backward compatibility:** Old booking documents written before multi-service support have
> `service_id` and `service_price` at top level instead of a `services` array. Both formats
> are supported by the app; new bookings always use the `services` array.

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

## `support`

All documents are **fixed IDs** — never auto-generated.

### `support/contact`

| Field | Type | Notes |
|-------|------|-------|
| `email` | string | Support email address |
| `phone` | string | Support phone number (e.g. `+91 9588561910`) |
| `support_hours` | string | Display string shown in app (e.g. `Mon–Sat, 9 AM – 7 PM IST`) |
| `updated_at` | timestamp | Set on every save |

### `support/faqs`

| Field | Type | Notes |
|-------|------|-------|
| `items` | array | Array of **FAQ item** objects (see below) |
| `updated_at` | timestamp | Set on every save |

#### FAQ item shape

Each entry in `items[]`:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Stable UUID; generated on creation |
| `question` | string | FAQ question text |
| `answer` | string | FAQ answer text |
| `order` | number | Ascending sort order in UI |

### `support/privacy_policy_user`

| Field | Type | Notes |
|-------|------|-------|
| `html` | string | Full HTML string of the user-facing privacy policy; edited via TipTap rich text editor in admin panel; rendered in WebView in the app |
| `updated_at` | timestamp | Set on every save |

### `support/privacy_policy_salon`

| Field | Type | Notes |
|-------|------|-------|
| `html` | string | Full HTML string of the salon-facing privacy policy; shown in salon dashboard (not in user app) |
| `updated_at` | timestamp | Set on every save |

**Managed by:** Admin panel → Support tab (Contact Info / FAQs / Privacy Policy sections)

**Read by:** User app — `support/contact`, `support/faqs`, `support/privacy_policy_user` only

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

---

## Accounting integration (Humble Ledger)

CutQ salons keep double-entry books in an external accounting service, **Humble
Ledger** (`https://ledger.humblesolutions.in`, API `/api/v1`). The salon
dashboard never calls it directly (its CORS blocks the dashboard origin); all
traffic is proxied through Cloud Functions authorized as the salon owner.

**Tenancy:** one Humble Ledger *company* per salon. On first use a company is
registered and its credentials + resolved account ids are cached (see
`ledger_accounts` below). A completed booking is posted as a **SALE**
(amount = services + `booking_fee` − discount → Service Revenue) followed by a
**PAYMENT** (Cash/Bank). Postings are deduped by the ledger on `(appId,
sourceId)`; CutQ uses `appId: "cutq"` and namespaced source ids
`<bookingId>:sale` / `<bookingId>:payment`.

The **booking fee is the salon's revenue** at sale time; the salon later remits
collected fees to CutQ (modelled as a vendor) via `ledgerRecordCutqRemittance`.
"Owed to CutQ" = Σ `booking_fee` over completed bookings − Σ remittances.

### `ledger_accounts/{salonId}` — server-only (no client access)

Written/read only by Cloud Functions (admin SDK). Never exposed to clients.

| Field | Type | Notes |
|-------|------|-------|
| `companyId` | string \| null | Humble Ledger company id |
| `slug` | string | `cutq-<salonId>` |
| `email` | string | Ledger login (system address) |
| `password` | string | Ledger login secret |
| `accounts` | map | `{ serviceRevenue, cash, bank, accountsReceivable, cutqBookingFees }` → ledger account ids |
| `cutqVendorId` | string | Vendor id for CutQ (fee remittances) |
| `provisioned_at` | timestamp | |

### `salons/{salonId}/stylist_stats/{stylistId}`

Per-stylist processed-service aggregate, incremented on booking completion.

| Field | Type | Notes |
|-------|------|-------|
| `stylist_id` | string | |
| `name` | string | Denormalized stylist name |
| `services_count` | number | Total services this stylist has performed |
| `revenue` | number | Total ₹ of services this stylist performed |
| `updated_at` | timestamp | |

### `salons/{salonId}/cutq_remittances/{id}`

Log of booking-fee payments the salon has made to CutQ.

| Field | Type | Notes |
|-------|------|-------|
| `amount` | number | |
| `method` | string | `"CASH"` \| `"BANK"` |
| `description` | string | |
| `txnId` | string \| null | Humble Ledger vendor-payment transaction id |
| `sourceId` | string | `remit_<timestamp>` |
| `created_at` | timestamp | |

### `bookings` — completion additions

Set when a confirmed booking is completed via the dashboard completion dialog:

| Field | Type | Notes |
|-------|------|-------|
| `services[].origin` | string | `"booked"` (from the original booking) \| `"added"` (added at the salon) |
| `services[].performed_by_stylist_id` | string \| null | Stylist who performed this service |
| `services[].performed_by_stylist_name` | string \| null | Denormalized stylist name |
| `completion` | map | `{ payment_method: "CASH"\|"BANK", service_total, booking_fee, discount, grand_total, completed_at }` |
| `ledger` | map | Accounting refs: `{ posted, posting, companyId, customerId, invoiceId, saleTxnId, paymentTxnId, amount, method, posted_at, error, reversed }` — written by `ledgerRecordSale` |

**Written by:** Cloud Functions `ledgerRecordSale`, `ledgerReverseSale`,
`ledgerRecordExpense`, `ledgerRecordCutqRemittance`, `ledgerCutqSummary`,
`ledgerQuery`, `ledgerProvisionSalon`. The salon dashboard **Accounts** page and
completion dialog read/trigger these.


### `bookings` — walk-in entries

Created from the salon dashboard **New walk-in** action for customers who didn't
book through the app. A real booking document is written (with `slot_start` /
`slot_end`) so the app blocks that time slot too.

| Field | Type | Notes |
|-------|------|-------|
| `is_walk_in` | boolean | `true` for dashboard-entered walk-ins |
| `user_id` | null | Walk-ins have no app user |
| `customer_name` | string | Entered by the salon |
| `customer_phone` | string \| null | Optional |
| `services[].origin` | string | `"walk_in"` for walk-in service lines |
| `booking_fee` | number | Defaulted from `app_config/settings.booking_fee` (editable per walk-in) |
| `status` | string | `"confirmed"` (just book the slot) or `"completed"` (paid now → posts the sale) |

A walk-in created as `"completed"` posts to accounting immediately (same as any
completion); a `"confirmed"` walk-in blocks the slot and can be completed later.


---

## Billing (CutQ Invoice API)

When a booking is completed and posted to accounting, a branded PDF bill is
generated via the **CutQ Invoice API** (`https://ty7dvtg7bygzryorzmszp6ykjy0qlhsv.lambda-url.us-east-1.on.aws/`).
It is idempotent per `invoiceNo` (file `invoices/cutq-<invoiceNo>.pdf`), so the
invoice number must be globally unique across all CutQ salons.

**Invoice number:** a single canonical `CUTQ-<year>-<seq>` is allocated from a
global counter and used **both** as the accounting invoice number (Humble Ledger
`invoiceNumber`) **and** the bill `invoiceNo` — they are always identical.

### `app_config/invoice_counter`

| Field | Type | Notes |
|-------|------|-------|
| `seq` | number | Global monotonic invoice sequence; incremented in a transaction |
| `updated_at` | timestamp | |

### `bookings` — billing fields

| Field | Type | Notes |
|-------|------|-------|
| `ledger.invoiceNumber` | string | Canonical invoice number `CUTQ-<year>-<seq>` (same on the ledger invoice) |
| `bill` | map | `{ url, invoiceNo, error, generated_at }` — `url` is the public PDF link shown to the salon (Past bookings / completed cards) and, later, the customer app |

The bill's line items are the booking's services plus a "Booking Fee" line;
`total` equals the booking `final_amount` (and the accounting sale amount).
Customer phone/GSTIN are intentionally omitted from the bill for privacy.


---

## Salon team members (`SALONTEAM`)

A salon owner can add team members who can sign into the **salon dashboard** and
manage the salon, limited to a chosen set of **modules** (UI-gated only — no
per-module Firestore rules). Dashboard is always granted; the **Team** module is
owner-only and never grantable. Team members can belong to multiple salons and
switch between them, just like owners. Managed by Cloud Functions
`addSalonTeamMember` / `updateSalonTeamMember` / `removeSalonTeamMember`
(owner-authorized; credentials emailed to new members).

**`Users` additions (for team members):**

| Field | Type | Notes |
|-------|------|-------|
| `Role` | string | `"SALONTEAM"` for team members (existing owners/admins keep their role even when added to a salon) |
| `salon_access` | map | `{ [salonId]: { modules: string[], is_active: boolean, salon_name, added_at } }` — the salons this user can access and the modules granted per salon. Read by the dashboard to build the salon list + gate the nav |

Module ids: `dashboard`, `bookings`, `schedule`, `services`, `stylists`,
`customers`, `past_bookings`, `accounts`, `settings`.

**`salons` addition:** `team_uids` (array) — uids of team members (for lookup).

### `salons/{salonId}/team/{memberUid}`

Owner-facing team roster for a salon (mirrors the member's `salon_access` entry).

| Field | Type | Notes |
|-------|------|-------|
| `uid` | string | Team member's Auth UID |
| `name` | string | |
| `email` | string | |
| `phone` | string | |
| `modules` | array | Granted module ids (always includes `dashboard`) |
| `is_active` | boolean | Owner can pause access without removing |
| `created_at` / `updated_at` | timestamp | |


---

## Issue reports

Users file issue reports from the app (Profile -> "Report an issue"), track them
under "My tickets", and can call the salon or support from a pending/confirmed
booking's detail screen. Admins manage categories + notification recipients and
resolve reports in the admin **Reports** tab.

### `report_categories/{id}`

Admin-managed categories the user picks from. Read by the app (signed-in), write admin-only.

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Category label |
| `is_active` | boolean | Only active categories show in the app |
| `order` | number | Ascending sort |
| `created_at` / `updated_at` | timestamp | |

### `reports/{id}`

Created by the user (own `user_id`); readable by the reporter and admin; status
changed (resolve) by admin only; never deleted by clients.

| Field | Type | Notes |
|-------|------|-------|
| `user_id` | string | Reporter (Auth UID) |
| `user_name` / `user_phone` | string | Denormalized for admin follow-up (admin-only reads) |
| `category_id` / `category_name` | string | Chosen category |
| `description` | string | Free text |
| `about_booking` | boolean | Whether tied to a booking |
| `booking_id` | string \| null | Selected booking (if `about_booking`) |
| `booking_brief` | map \| null | `{ salon_name, services: [{ service_name }] }` snapshot |
| `status` | string | `"open"` \| `"resolved"` |
| `created_at` / `updated_at` | timestamp | |

### `report_config/settings` — admin only

| Field | Type | Notes |
|-------|------|-------|
| `notify_emails` | array | Emails alerted on every new report |
| `updated_at` | timestamp | |

**Cloud Functions:** `onReportCreated` emails `report_config.notify_emails` on a
new report; `onReportResolved` sends the reporter an FCM push when `status`
becomes `"resolved"`.


---

## `partner_requests`

**Document ID:** auto-generated

Leads captured by the public **CutQ landing page** "Become a Partner" form. A
salon owner submits their details; the CutQ team follows up to onboard them.
Anyone (including anonymous website visitors) can **create** a request with a
validated shape; only **admins** can read or manage them.

| Field | Type | Notes |
|-------|------|-------|
| `salon_name` | string | Required; 2–119 chars |
| `owner_name` | string | Required; 2–119 chars |
| `phone` | string | Required; 6–19 chars |
| `email` | string | Optional; `< 200` chars (`""` if omitted) |
| `city` | string | Optional; `< 120` chars (`""` if omitted) |
| `message` | string | Optional free text; `< 2000` chars (`""` if omitted) |
| `status` | string | Fixed `"new"` on create; admin updates to e.g. `"contacted"` / `"onboarded"` / `"rejected"` |
| `created_at` | timestamp | Must equal `request.time` (server timestamp) |

**Written by:** CutQ landing page (public create). **Read/managed by:** Admin
panel only. Suggested admin surface: a "Partner requests" / leads inbox.

**Security rule:** create is public with a strict field whitelist + validation;
`read`, `update`, `delete` are `isAdmin()` only.
