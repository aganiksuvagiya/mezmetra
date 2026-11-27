# MezMitra API contract

Base URL: `/api` (the dev servers of both web apps proxy `/api` to `http://localhost:4000`; in production the apps use
`import.meta.env.VITE_API_URL` as a prefix, default empty string).

## Conventions

- JSON in/out. Success: `{ "data": ... }` (lists add `"meta"`). Errors: `{ "error": { "code", "message", "details?" } }`
  with an HTTP status. `message` is safe to show to people. `details` (validation) is `[{ field, message }]`.
- Auth for `/api/admin/*`: header `Authorization: Bearer <token>` (token from login). A `401` means sign in again.
- **Money is a plain number of rupees** with up to 2 decimals (e.g. `499.5`). Never do float maths on it for
  totals - the server computes every total; just display what it returns. Format with
  `new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`.
- **Timestamps are ISO-8601 UTC strings.** Display them in the vendor's `timezone` (an IANA name such as `Asia/Kolkata`, returned
  by `/api/auth/me`) with `Intl.DateTimeFormat`. Dashboard `weekly_revenue[].day` is already a `YYYY-MM-DD` date in the vendor's timezone.
- Ids are positive integers, except customer-facing tokens (`table token`, `order token`) which are opaque strings.
- `photo_url` is a path like `/api/public/items/7/photo?v=2` (prefix with the API base). `null` when the item has no photo.
- Pagination: `?page=1&per_page=20` -> `meta: { page, per_page, total }`.
- Status codes: 400 validation, 401 auth, 404 not found, 409 business-rule conflict (always has a readable `message`),
  415 bad upload, 429 rate limited, 502 payment provider problem.

## Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/auth/login` | `{ email, password, otp? }` | `{ token, vendor }` |
| POST | `/api/auth/logout` | - | `{ ok }` (ends this session: its token answers 401 from now on) |
| GET | `/api/auth/me` | - | `vendor` |
| GET | `/api/auth/2fa` | - | `{ enabled, recovery_codes_left }` |
| POST | `/api/auth/2fa/setup` | `{ password }` | `{ secret, otpauth_url, qr }` (nothing changes yet) |
| POST | `/api/auth/2fa/enable` | `{ code }` | `{ enabled, recovery_codes }` (shown this once) |
| POST | `/api/auth/2fa/disable` | `{ password, code }` | `{ enabled: false }` |

- **Sign-in limits.** 20 failed sign-ins per address per 15 minutes (429 `RATE_LIMITED`); 10 failed tries for one account from one address per 15 minutes (429 `ACCOUNT_LOCKED`, also for the right password). After 50 failed tries for one account from all addresses together, an address gets 3 tries only (so guessing from many addresses is stopped and the owner can still sign in from another one). A password set by reset, by the platform owner or (kitchen) by the restaurant ends the lock.
- A session that types the account's own password wrong 10 times in 15 minutes (change password, two-step set-up, payment keys) gets 429 `ACCOUNT_LOCKED`; other sessions are not affected.
- Wrong two-step codes after a right password: 10 per account in 15 minutes, from all addresses together (429 `ACCOUNT_LOCKED`); a password reset ends it.
- **Two-step sign-in** (not for the kitchen login): with it on, `login` answers 400 `OTP_REQUIRED` for a right password without `otp`, and 400 `OTP_WRONG` for a wrong one. `otp` is the app's 6-digit code (each works once) or a recovery code. A password set by the platform owner switches it off.
- **New passwords** (8 to 72 characters) are refused when well known, only digits, a run such as `abcdefgh`, a common word with a few digits, or containing the email: 400 `VALIDATION_ERROR` on the password field. On the live server the demo passwords written in `seed.js` do not sign anyone in (403).

`vendor` = `{ id, name, email, currency: "INR", timezone, tax_percent, theme: { primary, accent, style } }` - `theme` holds the restaurant's customer-menu colours as `#rrggbb` (defaults `#2f6f62` / `#e8872a`) and its design `style`: one of `classic` (default), `bistro`, `gallery`, `minimal`, `night` (see `shared/styles.js`; the customer app lays the menu out and colours it accordingly).

## Admin (all need the bearer token)

### Vendor settings
- `GET /api/admin/vendor` -> vendor
- `PATCH /api/admin/vendor` `{ name?, tax_percent? (0-100), timezone?, theme_primary? (#rrggbb), theme_accent? (#rrggbb), theme_style? (classic|bistro|gallery|minimal|night) }` -> vendor. Colours are stored lower-case; anything that is not exactly `#rrggbb`, or a design that is not one of the five, is a 400.
- `PUT /api/admin/vendor/logo` raw image bytes (`Content-Type: image/jpeg|png|webp`, max 512 KB; the admin shrinks it to 512 px first) -> vendor with `logo_url`. `DELETE /api/admin/vendor/logo` removes it. `logo_url` is a path like `/api/public/vendors/3/logo?v=2` (prefix with the API base), `null` without a logo; it is also on the public menu's and the public order's `vendor`. `GET /api/public/vendors/:id/logo` serves the image (cached for a year; the `?v=` changes with every upload).

### Dashboard
`GET /api/admin/dashboard/overview` ->
```json
{
  "timezone": "Asia/Kolkata",
  "today_revenue": 1419,
  "live_orders": 1,
  "latest_orders": [{ "id": 4, "table_number": "T-01", "status": "pending", "payment_status": "unpaid", "total": 399, "created_at": "..." }],
  "weekly_revenue": [{ "day": "2026-10-23", "revenue": 0 }, "... 7 entries, oldest first ..."],
  "payment_methods": [{ "method": "cash", "amount": 1419, "percent": 74 }, { "method": "razorpay", "amount": 499.5, "percent": 26 }],
  "top_selling": [{ "name": "Margherita", "quantity": 3, "revenue": 1918.5 }],
  "ranges": { "weekly_days": 7, "payment_days": 30, "top_days": 30 }
}
```
Revenue only counts **paid** orders. `payment_methods[].method`: `cash` (counter), `razorpay` or `phonepe` (online); `upi`, `cashfree` or `paytm` appear only for orders paid before those were removed.

### Categories
`category` = `{ id, name, description, is_active, sort_order, item_count, created_at, updated_at }`
- `GET /api/admin/categories?status=active|inactive&q=&page=&per_page=`
- `POST /api/admin/categories` `{ name, description?, is_active?, sort_order? }` -> 201 category
- `GET /api/admin/categories/:id`
- `PATCH /api/admin/categories/:id` any subset of the create fields. Only the fields you send are changed.
- `DELETE /api/admin/categories/:id` -> 204, or 409 `CATEGORY_NOT_EMPTY` when it still has items.

### Items (menu dishes)
`item` = `{ id, category_id, category_name, name, description, price, is_active, is_featured, photo_url, option_groups, created_at, updated_at }`
`option_groups` = `[{ id, name, multi_select, required, options: [{ id, name, price }] }]` (`price` = extra rupees, may be 0).
- `GET /api/admin/items?category_id=&status=active|inactive&q=&page=&per_page=` (default per_page 50)
- `POST /api/admin/items` `{ category_id, name, description?, price, is_active?, is_featured?, option_groups?: [{ name, multi_select?, required?, options: [{ name, price? }] }] }` -> 201 item
- `GET /api/admin/items/:id`
- `PATCH /api/admin/items/:id` any subset. If `option_groups` is present it **replaces** all groups; omit it to keep them.
- `DELETE /api/admin/items/:id` -> 204 (past orders keep their snapshot)
- `PUT /api/admin/items/:id/photo` - body is the **raw image bytes**, header `Content-Type: image/jpeg|image/png|image/webp`, max 512 KB
  (the UI must downscale first; see admin notes). Returns the item. 415 on a bad file, 413 when too big.
- `DELETE /api/admin/items/:id/photo` -> item

### Tables
`table` = `{ id, number, capacity, area, is_active, availability: "available"|"occupied"|"maintenance", qr_url, created_at, updated_at }`
(`qr_url` is the link encoded in that table's QR code, e.g. `http://localhost:5174/t/<32 hex chars>`.)
- `GET /api/admin/tables?area=&availability=&q=` -> `data: table[]`, `meta: { total, total_capacity, active_tables, occupied_tables, occupancy_percent }`
- `GET /api/admin/tables/areas` -> `string[]` (existing area names, for a datalist/select)
- `POST /api/admin/tables` `{ number, capacity, area?, is_active? }` -> 201 table
- `PATCH /api/admin/tables/:id` any subset (only sent fields change) -> table
- `DELETE /api/admin/tables/:id` -> 204
- `GET /api/admin/tables/:id/qr.png?size=1024` -> image/png (needs the auth header, so fetch it, make a blob URL for `<img>`/download)

### Orders
`order` = `{ id, number, table_number, status, payment_status, payment_method, pay_pref, subtotal, tax, total, note, items, total_quantity, created_at, accepted_at, completed_at, paid_at, receipt_url }`

**Order numbers.** `number` is the restaurant's own order number (#1, #2, #3 ... counted per restaurant, never reused after a delete); show this one to people (admin lists, receipts, reports, the diner's order page). `id` is the internal key of the shared orders table: it is what the admin URLs (`/api/admin/orders/:id`, `/api/admin/tables/:id/bill`) take, and it is not meant to be shown.
- `status`: `pending` -> `accepted` -> `completed`; `cancelled` from pending/accepted.
- `payment_status`: `unpaid` | `paid` | `refunded`. `payment_method`: `cash` | `razorpay` | `phonepe` | `null` (orders paid before UPI, Cashfree and Paytm were removed still say `upi`, `cashfree` or `paytm`). `pay_pref`: what the diner chose (`counter` | `online`).
- `items[]` = `{ id, name, quantity, unit_price, instructions, options: [{ group, name, price }], line_total }`
- `receipt_url` is `null` until paid, then `/api/admin/orders/:id/receipt.pdf` (needs the auth header -> fetch as blob and open).
- `GET /api/admin/orders?status=pending|accepted|completed|cancelled|active&payment=paid|unpaid&q=&page=&per_page=` (`active` = pending + accepted; `q` matches a table number or an exact order number)
- `GET /api/admin/orders/:id`
- `PATCH /api/admin/orders/:id/status` `{ status: "accepted"|"completed"|"cancelled" }` -> order.
  409 codes: `INVALID_TRANSITION`, `PAYMENT_REQUIRED` (complete needs payment first), `ALREADY_PAID` (cannot cancel a paid order).
- `POST /api/admin/orders/:id/cash-payment` (no body) -> order marked paid by cash. 409 `ALREADY_PAID` / `ALREADY_REFUNDED` / `ORDER_CANCELLED` / `METHOD_NOT_AVAILABLE` (cash is not in `PAYMENT_METHODS`).
- `DELETE /api/admin/orders/:id` -> 204. Only an order that never involved money: 409 `ORDER_HAS_PAYMENTS` when it is paid or refunded, or has a payment page open.
- `GET /api/admin/orders/:id/receipt.pdf` -> application/pdf (409 `NOT_PAID` before payment)
- **Money that needs a person.** Money that arrives for an order which has already been paid (even if refunded since) is recorded, never dropped, and the order does not change. Admin orders carry `extra_payments: [{ id, method, amount, status: "paid"|"refunded", refund_state, paid_at, refunded_at }]` and `refund_state` (`null|"requested"|"pending"|"processed"|"failed"`, of the payment that paid the order). `GET /api/admin/orders/attention` -> `[{ kind: "paid_twice"|"cancelled_paid"|"refund_failed"|"refund_unconfirmed", order_id, order_number, table_number, method, amount }]` (newest first, at most 20; `refund_unconfirmed`: still `requested` after 15 minutes). `POST /api/admin/orders/:id/extra-payments/:paymentId/refund` gives a second payment back: 404 unknown, 409 `ALREADY_REFUNDED`, gateway errors as for a refund.
- **Before cash is recorded** (here and on a table bill) the server asks the gateways about the order's open online payments: if one arrived, 409 `ALREADY_PAID` (table bill: `PAID_ONLINE`) and nothing is recorded. Cash records who took it; the order's open Razorpay QR codes are closed.

### Payment settings
`settings` = `{ methods_available, cash_enabled, razorpay_enabled, razorpay_key_id, razorpay_secret_set, razorpay_mode: "test"|"live"|null, razorpay_configured, razorpay_live_only, phonepe_enabled, phonepe_client_id, phonepe_client_version, phonepe_secret_set, phonepe_configured, webhook_url_razorpay, webhook_url_phonepe, razorpay_webhook_set, phonepe_webhook_set }`
- `GET /api/admin/payment-settings` -> the settings. `methods_available` is what the product offers (from `PAYMENT_METHODS`, default `["cash","razorpay","phonepe"]`). Switching on a method that is not available is a 400. `GET /api/auth/me` returns the same list as `payment_methods`.
- Changing a key, secret or webhook setting needs `current_password` in the same request (400 `PASSWORD_REQUIRED` / `WRONG_PASSWORD` on that field; switching a method on or off does not). The change is recorded and the restaurant is emailed.
- `PUT /api/admin/payment-settings` `{ current_password?, cash_enabled?, razorpay_enabled?, razorpay_key_id?, razorpay_key_secret?, razorpay_webhook_secret?, phonepe_enabled?, phonepe_client_id?, phonepe_client_version?, phonepe_client_secret?, phonepe_webhook_username?, phonepe_webhook_password? }` - secrets are **write-only** (never returned); omit one to keep the stored one. PhonePe keys are always the live ones. On the live server (`razorpay_live_only: true`, i.e. `NODE_ENV=production`) a `rzp_test_...` key is a 400, a saved test key counts as not configured (diners are not offered Razorpay and nothing it reports marks an order paid), and `/test` answers 409 `RAZORPAY_TEST_KEY`. At least one method must stay on, and only one online gateway can be on at a time: switching both on is a 400 (switch one off in the same request).
- `POST /api/admin/payment-settings/test` (body `{ provider: "phonepe" }`, empty for Razorpay) -> `{ ok: true, mode }`, or 502 `RAZORPAY_BAD_KEYS` / `RAZORPAY_ERROR` / `PHONEPE_BAD_KEYS` / `PHONEPE_ERROR` with a readable message.

## Public (customer app; no auth)

A table's QR code opens `<customer-app>/t/<token>`. `<token>` is the 32-hex string at the end of `qr_url`.

### `GET /api/public/t/:token` - the menu for that table
```json
{
  "vendor": { "name": "Demo Kitchen", "currency": "INR", "tax_percent": 5, "theme": { "primary": "#2f6f62", "accent": "#e8872a", "style": "classic" }, "logo_url": null },
  "table": { "number": "T-01" },
  "payment_options": { "cash": true, "razorpay": false, "phonepe": false },
  "categories": [{ "id": 1, "name": "Pizza", "description": "..." }],
  "items": [{ "id": 3, "category_id": 1, "category_name": "Pizza", "name": "...", "description": "...", "price": 499, "is_featured": true, "photo_url": null, "option_groups": [] }]
}
```
Only active items inside active categories are returned (featured first). 404 unknown token, 409 `TABLE_UNAVAILABLE` (table switched off).
`payment_options` = `{ cash, razorpay, phonepe }`: a method is true only when the product offers it (`PAYMENT_METHODS`) **and** the restaurant switched it on (`razorpay` and `phonepe` also need keys). Either of those two true means the diner can choose `pay_pref: "online"`. When all are false the restaurant cannot take orders yet (see 409 `PAYMENTS_NOT_SET_UP` below).

### `POST /api/public/t/:token/orders` - place an order
Header `Idempotency-Key: <8-80 chars [A-Za-z0-9_-]>` - **send one per checkout attempt** (generate when the customer taps
"Place order", reuse it on retries). The same key returns the same order (HTTP 200 instead of 201) so double taps and retries never create duplicates.

Body:
```json
{ "items": [{ "item_id": 3, "quantity": 2, "instructions": "less spicy", "option_ids": [11, 14] }],
  "note": "optional note for the table", "pay_pref": "counter" }   // pay_pref: counter | online
```
Do **not** send prices; the server prices everything. Returns 201 `public order` (below). Errors: 400 `OPTION_REQUIRED`,
`OPTION_TOO_MANY`, `INVALID_OPTION`; 409 `ITEM_UNAVAILABLE` (a dish was switched off - ask the diner to review the cart), `TABLE_UNAVAILABLE`, `PAYMENT_METHOD_UNAVAILABLE` (the chosen `pay_pref` is not offered; omit `pay_pref` to get the first offered one), `PAYMENTS_NOT_SET_UP` (the restaurant offers no way to pay yet), `TOO_MANY_OPEN_ORDERS` (12 orders of this table are still pending and unpaid); 429 `TABLE_CODE_LOCKED` (10 wrong codes from one address in 15 minutes; after 40 wrong ones at a table from all addresses, 3 per address; a new code or link starts afresh). The table code is checked after the cart, so a bad cart answers the same whatever the code.

### `GET /api/public/orders/:orderToken` - follow an order (poll every few seconds)
`public order` = `{ token, number, can_cancel, table_number, status, payment_status, payment_method, subtotal, tax, total, note, items[], total_quantity, created_at, accepted_at, completed_at, paid_at, vendor: { name, currency, theme }, payment_options: { cash, razorpay, phonepe }, second_payment, refund_pending }` (`second_payment`: money arrived on an already paid order and has not been given back; `refund_pending`: a refund is started but the gateway has not finished it)
(`items[]` as in admin orders.) There is no numeric id; `number` is the restaurant's own order number, the one to show and say aloud.

### Cancel an order (by the diner)
`POST /api/public/orders/:orderToken/cancel` (no body) -> `public order`. Allowed only while `can_cancel` is true on the order (the kitchen has not accepted it, nothing is paid and no online payment started); otherwise 409 `CANNOT_CANCEL` with a sentence for the diner. Asking again for an already cancelled order answers with it. The restaurant sees it under Cancelled in the admin.

### Online payment by scanning a QR (Razorpay UPI QR)
1. `POST /api/public/orders/:orderToken/razorpay-qr` (no body) -> `{ qr_id, image_url, amount, vendor_name }`: a single-use, fixed-amount UPI QR for this order (the same one is returned on a reload; a closed one is replaced). 409 `RAZORPAY_NOT_CONFIGURED`, `ALREADY_PAID`, `ORDER_CANCELLED`, `RAZORPAY_QR_UNAVAILABLE` (Razorpay refused, for example "UPI QR" is not switched on for the account).
2. Show `image_url`, then call `POST /api/public/orders/:orderToken/razorpay-qr/verify` (no body) every few seconds -> `public order`. It becomes `payment_status: "paid"` (and `accepted`) only when Razorpay reports a `captured` payment of the exact amount on that QR.

### Online payment (PhonePe)
1. `POST /api/public/orders/:orderToken/pay/phonepe` (no body) -> `{ provider, client: { type: "redirect", url }, amount, vendor_name }`: send the browser to `client.url` (PhonePe's own page), which brings the diner back to the order page.
   409 `GATEWAY_NOT_CONFIGURED` (message already says "pay another way"), `ALREADY_PAID`, `ALREADY_REFUNDED`, `TABLE_UNAVAILABLE` (suspended restaurant), `ORDER_CANCELLED`, `TOO_MANY_PAYMENT_TRIES` (10 payment pages open for this order within 3 hours); 502 `PHONEPE_*`. Every open page is asked about first, so a payment made on an older one is found; a page is closed only when PhonePe says it failed.
2. Whenever the diner comes back to the order page, call `POST /api/public/orders/:orderToken/pay/phonepe/verify` (no body) -> `public order`. The server asks PhonePe and marks the order paid (`payment_method: "phonepe"`) only when PhonePe reports the payment completed for the exact amount.

### Online payment (Razorpay Checkout)
1. `POST /api/public/orders/:orderToken/razorpay` (no body) -> `{ key_id, razorpay_order_id, amount_paise, amount, currency, vendor_name }`.
   409 `RAZORPAY_NOT_CONFIGURED` (message already says "pay at the counter"), `ALREADY_PAID`, `ORDER_CANCELLED`; 502 `RAZORPAY_*`.
2. Load `https://checkout.razorpay.com/v1/checkout.js` and open Checkout with `{ key: key_id, order_id: razorpay_order_id, amount: amount_paise, currency, name: vendor_name }`.
3. In the checkout `handler(response)` call `POST /api/public/orders/:orderToken/razorpay/verify` with
   `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` (the three fields of `response`) -> `public order` with `payment_status: "paid"`. A `pending` order also becomes `accepted` at that moment (`accepted_at` set); the same goes for PhonePe.
   Opening a checkout or a QR first asks Razorpay about earlier ones: 409 `ALREADY_PAID` if money had arrived. A Razorpay payment may be larger than the total (the fee paid by the diner), never smaller.
   After the signature the server asks Razorpay about the payment: it must belong to this Razorpay order, cover the total and be `captured` (an `authorized` one is captured by the server). 400 `PAYMENT_SIGNATURE_INVALID` / `PAYMENT_NOT_FOUND`; 503 `PAYMENT_NOT_CAPTURED` (try the same call again; do not pay again); 409 `PAYMENT_NOT_TAKEN` (the order is cancelled or already paid, so a held amount is left to be released); 502 `RAZORPAY_*`. Sending the reply of a payment that was already counted or refunded changes nothing.

If the diner pays at the counter, staff record it in the admin panel; the order page just keeps polling until `payment_status` becomes `paid`.

### `GET /api/public/items/:id/photo` - raw image (cacheable)

## Platform owner API (`/api/platform/*`)

Only for accounts listed in `SUPER_ADMIN_EMAILS` (`GET /api/auth/me` has `is_super_admin: true`); everyone else gets 403 `FORBIDDEN`.

- `GET /api/platform/overview` -> `{ restaurants: { total, active, suspended, new_30d }, orders_30d, revenue_30d }` (revenue = paid orders only, rupees).
- `GET /api/platform/restaurants?q=&status=active|suspended&page=&per_page=` -> `{ data: restaurant[], meta: { page, per_page, total } }`, newest first.
  `restaurant` = `{ id, name, email, created_at, status: "active"|"suspended", suspended_at, suspended_reason, is_platform_owner, tables, items, orders_total, orders_30d, revenue_total, last_order_at }`.
- `POST /api/platform/restaurants` `{ name (2-100), email, password (8-200) }` -> 201 the new `restaurant`. The only way a restaurant account comes to exist (there is no public sign-up: `POST /api/auth/signup` is gone). 400 `VALIDATION_ERROR`, 409 `EMAIL_TAKEN`.
- `POST /api/platform/restaurants/:id/profile` `{ name (2-100), email }` -> the updated `restaurant`. Fixes a restaurant's name or login email (same password). Saving without a change adds nothing to the record. 409 `EMAIL_TAKEN`, 409 `RESERVED_EMAIL` (an email listed in `SUPER_ADMIN_EMAILS`), 409 `CANNOT_EDIT_OWNER` for a platform owner's account, 404 unknown id.
- `GET /api/platform/activity?action=&q=&page=&per_page=` -> `{ data: entry[], meta }`, newest first, across all restaurants. `entry` = `{ id, action: create|update|suspend|reactivate|set_password|delete (and `login_as` on old entries: that feature was removed), by, restaurant: { id|null, name, email }, detail, at }`; `restaurant.id` is null once the restaurant has been deleted. `q` matches the restaurant's name or email or the owner's email.
- `PATCH /api/platform/restaurants/:id` `{ suspended: boolean, reason?: string(<=200) }` -> the updated `restaurant`. 409 `CANNOT_SUSPEND` for a platform owner (or yourself); 404 unknown id.
- `GET /api/platform/restaurants/:id` -> one restaurant in full: the `restaurant` fields plus `timezone`, `currency`, `tax_percent`, `categories`, `revenue_30d`, `payment` (per way of paying `{ key, enabled, configured, offered }`, never a secret), `recent_orders` (latest 10: `number`, `table_number`, `status`, `payment_status`, `payment_method`, `total`, `created_at`) and `activity` (the owner's latest 10 actions on it: `{ action, by, detail, at }`).
- `POST /api/platform/restaurants/:id/password` `{ password (8-200) }` -> `{ ok }`. Sets a new password and signs the restaurant out everywhere. 409 `CANNOT_RESET_OWNER` for a platform owner (their password is changed in Settings).
- `POST /api/platform/restaurants/:id/delete` `{ confirm_name }` -> `{ deleted: true }`. Deletes the restaurant and all its data. Only a suspended one (409 `SUSPEND_FIRST`), only with its exact name (400 `NAME_MISMATCH`), never a platform owner (409 `CANNOT_DELETE_OWNER`).
- Every add, change of details, suspend / reactivate (when something changed), new password, log-in-as and delete is recorded in `platform_audit` (migrations 019, 021, 022); the latest ones for a restaurant are in its `activity`.

A suspended restaurant: `POST /api/auth/login` and every `/api/admin/*` call return 403 `ACCOUNT_SUSPENDED` (message includes the reason), and its public menu / order endpoints return 409 `TABLE_UNAVAILABLE`.

## Kitchen login (`/api/admin/kitchen-login`)

A restaurant can give its kitchen a sign-in of its own, so the kitchen tablet never holds the restaurant's own login. It is an email and a password (migration 023, table `vendor_staff`, one per restaurant) and signs in through the same `POST /api/auth/login`: the answer's `vendor.role` is `"kitchen"` (`"owner"` for the restaurant's own login), its `email` is the kitchen's and `is_super_admin` is false. The token says `role: kitchen`.

- `GET /api/admin/kitchen-login` -> `{ configured, email, created_at }`.
- `PUT /api/admin/kitchen-login` `{ email, password? (8-200) }` -> the same. Creates it (the password is then required: 409 `PASSWORD_REQUIRED`) or changes it; leaving the password out keeps the password and its open sessions, a new password signs the kitchen out everywhere. 409 `EMAIL_UNAVAILABLE` (the address is already a login, or reserved: one answer for both).
- `DELETE /api/admin/kitchen-login` -> removes it; the kitchen is signed out at once. 404 when there is none.

What a kitchen token may call in `/api/admin`: `GET /orders`, `GET /orders/:id`, `PATCH /orders/:id/status` with `accepted` or `cancelled` (not `completed`), and `POST /orders/:id/ready`. Everything else, including these three endpoints above, `/api/auth/change-password` and `/api/platform/*` (even for the platform owner's own restaurant), answers 403. A suspended restaurant's kitchen cannot sign in, and a removed login's token answers 401. The orders it reads still carry their totals; the kitchen screen simply does not show them.

## Payment webhooks (`/api/webhooks/*`, called by the gateways, no login)

The gateway tells the server the moment a payment succeeds, so an order turns paid even when the diner has closed the page. Each restaurant has its
own gateway account, so each has its own unguessable address (`webhook_url_razorpay` / `webhook_url_phonepe` in `GET /api/admin/payment-settings`)
and its own secrets (write-only: `razorpay_webhook_secret`, `phonepe_webhook_username` + `phonepe_webhook_password`; stored encrypted, only
`razorpay_webhook_set` / `phonepe_webhook_set` come back).

- `POST /api/webhooks/razorpay/:key` - `order.paid`, `payment.captured` (checkout) and `qr_code.credited` (scan-to-pay). Signed: `X-Razorpay-Signature` =
  HMAC-SHA256(raw body, webhook secret). The amount must equal the payment attempt's. 400 `WEBHOOK_SIGNATURE_INVALID`, 400 `WEBHOOK_NOT_SET_UP`.
- `POST /api/webhooks/phonepe/:key` - `checkout.order.*`. `Authorization` = SHA256(`username:password`). The call is only a nudge: the server then asks
  PhonePe about the order itself and marks it paid only if PhonePe says so for the right amount. 401 `WEBHOOK_UNAUTHORIZED`, 400 `WEBHOOK_NOT_SET_UP`.
- Answers `200` to events it does not need or orders it does not know (so the gateway stops retrying), `200` with `mismatch: true` for a wrong amount
  (not marked paid), `200` with `already: true` for a repeat or a refunded payment, `200` with `extra: true` for a second payment on a paid order,
  `404` for an unknown address, and `500` when it could not finish (the gateway retries).
- Safety net: every 5 minutes the server asks the gateways about open online payments (2 minutes to 24 hours old; up to 50 a pass, 35 places kept for
  unpaid orders and the rest for paid or cancelled ones, least recently asked first) and records the ones that arrived (`src/lib/reconcile.js`), so a
  missed webhook costs minutes, not an unpaid order. It also follows up unfinished refunds.

## Password reset

- `POST /api/auth/forgot-password` `{ email }` -> always `200 { data: { ok: true } }` (an unknown email is not revealed). Emails a link `<ADMIN_APP_URL>/reset-password#token=...` (after `#`, so it reaches no server log); at most one email a minute per account; none for suspended accounts.
- `POST /api/auth/reset-password` `{ token, password (8-200 chars) }` -> `200 { data: { ok: true } }`. 400 `INVALID_RESET_TOKEN` when the link is wrong, used or expired (60 minutes; only the newest link works). Signs out every session started before the change (401 "Your password was changed").
- `POST /api/auth/change-password` (signed in) `{ current_password, new_password (8-200 chars) }` -> `200 { data: { token, vendor } }`. The change signs out every older session, so use the new `token`. 400 `WRONG_PASSWORD` (deliberately not a 401, so the admin does not log itself out) and 400 `SAME_PASSWORD`; rate-limited like login.

## Sold-out dishes

- `item.is_sold_out` (admin and public). `PATCH /api/admin/items/:id` `{ is_sold_out: boolean }`. The public menu still lists a sold-out dish (with `is_sold_out: true`); ordering it returns 409 `ITEM_UNAVAILABLE`.
- `item.diet` (admin and public): `"veg"` | `"egg"` | `"nonveg"` | `"jain"` | `null` (not marked). Send it on `POST`/`PATCH /api/admin/items`; `null` clears it, leaving it out keeps it. Diners see the green / amber / red mark and can filter the menu by it.
- `order.ready_at` (admin and public): set when staff press **Mark ready** (`POST /api/admin/orders/:id/ready`, only for an `accepted` order; pressing it again keeps the first time; 409 `INVALID_TRANSITION` otherwise). The order stays `accepted` until `completed`; the diner's order page shows "Your order is ready!" with a vibration and chime.
- **Call the waiter / ask for the bill.** Diner: `GET /api/public/t/:token/requests` -> `{ waiter, bill, waiter_since, bill_since }` (which are open, and when each was made; a phone compares `*_since` with the request it asked for, so it says "Waiter called" only about its own and a newcomer at the same table can still ask); `POST /api/public/t/:token/requests { kind: "waiter" | "bill" }` -> 201 (new) or 200 `already_asked: true` (one open request of each kind per table). Staff: `GET /api/admin/requests` -> open `[{ id, table_number, kind, created_at }]`; `POST /api/admin/requests/:id/done` (twice is fine). The admin chimes and reads it out ("Table 3 is calling the waiter.") and shows a banner until Done.
- **Table bill.** `GET /api/admin/tables/:id/bill` -> `{ table_number, count, total, orders: [{ id, status, total, created_at, items: [{ name, quantity }] }] }`: every unpaid, non-cancelled order of the table. `POST /api/admin/tables/:id/settle { method: "cash", order_ids? }` marks all of them paid together -> `{ settled, total, method }`. Send the bill's order ids: if the unpaid orders are no longer exactly those, 409 `BILL_CHANGED` and nothing is recorded (409 `NOTHING_TO_PAY`, `PAID_ONLINE`, `METHOD_NOT_AVAILABLE`).
- **Refund.** `POST /api/admin/orders/:id/refund` (no body) gives an online (Razorpay or PhonePe) payment back in full: `payment_status` becomes `"refunded"` (no longer revenue) and a pending/accepted order is cancelled too. The request is recorded before the gateway is asked. If the gateway says the refund failed or refuses it: 502 `REFUND_FAILED` (or the gateway's error) and nothing changes. If no clear answer arrives: 502 `REFUND_UNCONFIRMED`, the order stays paid with `refund_state: "requested"`, and the server finds out (every few minutes, or when staff press Refund again after 5 minutes; before that 409 `REFUND_IN_PROGRESS`); it never asks for the money twice, and after 10 minutes with no refund at the gateway marks it `"failed"`. An answer that does not name the refund counts as no clear answer. If the refund is only pending, `refund_state` is `"pending"`; should it fail later, the order counts as paid again (`refund_state: "failed"`). A refund already made in the Razorpay dashboard is recorded when staff press Refund. 409 `NOT_PAID`, `ALREADY_REFUNDED`, `REFUND_MANUAL` (cash, or an order paid a way that was removed: give the money back the way it was paid), `RAZORPAY_NOT_CONFIGURED`; 502 `RAZORPAY_*` / `PHONEPE_*` if the gateway refuses. The diner's order page shows "Refunded".
- **Table code (fake-order guard).** Every table has a random 4-digit `code` (admin `table.code`; `POST /api/admin/tables/:id/code` makes a new one, so an old printed card stops working; `POST /api/admin/tables/:id/link` replaces the table's link and code, so photos of the old QR stop working). `PATCH /api/admin/vendor { table_code_mode: "off" | "optional" | "required" }` chooses how strictly diners are asked for it (default `off`; the vendor object carries `table_code_mode`). The public menu has `table.code_mode` (never the code itself). `POST /api/public/t/:token/orders` takes `table_code`: **required** — missing is 403 `TABLE_CODE_REQUIRED`, wrong is 403 `TABLE_CODE_WRONG`; **optional** — it may be left out, but a code that is sent must be right (403 `TABLE_CODE_WRONG`); **off** — it is ignored. Orders placed with the right code have `table_code_verified: true`. The printed QR card shows the code unless the mode is `off`.
- `GET /api/admin/items?status=sold_out` filters; list `meta.sold_out` is the number of sold-out dishes in the whole menu.
- `POST /api/admin/items/restock` -> `{ restocked: n }` puts every sold-out dish back in stock.

## Reports

All take `from` and `to` (`YYYY-MM-DD`, the restaurant's own days; both default to today, one given means that single day; at most 92 days; 400 otherwise).

- `GET /api/admin/reports/summary` -> `{ from, to, timezone, sales: { orders, subtotal, tax, total, by_method: [{ method, orders, amount }] }, placed: { total, completed, cancelled, open, unpaid, unpaid_value }, top_items: [{ name, quantity, revenue }] }`. `sales` counts paid orders by the day they were paid (same as the dashboard); `placed` counts orders by the day they were placed.
- `GET /api/admin/reports/orders.csv` -> UTF-8 CSV (with BOM), one row per order placed or paid in the period; text cells that start with `= + - @` are prefixed with `'`.
- `GET /api/admin/reports/report.pdf` -> A4 PDF with the summary, best sellers and the order list.

## Payment states

- Payment attempt: `created` -> `paid` | `failed`; `failed` -> `paid` (it arrived late after all); `paid` -> `refunded`; `refunded` -> `paid` only when the gateway reports that the refund itself failed.
- Refund (`refund_state`): `requested` (asked for, no clear answer yet; the attempt stays `paid`) -> `pending` -> `processed` | `failed`.
- Order: `unpaid` -> `paid` -> `refunded`. Online money only ever turns an **unpaid** order paid; on any other order it is recorded as a second payment. A refunded order turns paid again only when the gateway reports that the refund failed.
- Every change is written to `audit_events` with who reported it.

## Rate limits

Per visitor address. Shared by all instances (kept in the database): failed sign-ins 20 / 15 min; password reset and change 20 / 15 min; orders, waiter calls and cancelling 60 / min; opening payments 60 / min; asking whether a payment arrived 300 / min. In memory per instance: public reads 900 / min, webhooks 1200 / min. Behind Cloudflare or Render set `CLIENT_IP_HEADER=cf-connecting-ip` so that the visitor's own address is counted. `/api/health` asks the database at most once in 5 seconds.

