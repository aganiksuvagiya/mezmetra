# MezMitra API contract

Base URL: `/api` (the dev servers of both web apps proxy `/api` to `http://localhost:4000`; in production the apps use
`import.meta.env.VITE_API_URL` as a prefix, default empty string).

## Conventions

- JSON in/out. Success: `{ "data": ... }` (lists add `"meta"`). Errors: `{ "error": { "code", "message", "details?" } }`
  with an HTTP status. `message` is safe to show to people. `details` (validation) is `[{ field, message }]`.
- Auth for `/api/admin/*`: header `Authorization: Bearer <token>` (token from login/signup). A `401` means sign in again.
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
| POST | `/api/auth/signup` | `{ name, email, password (min 8) }` | 201 `{ token, vendor }` |
| POST | `/api/auth/login` | `{ email, password }` | `{ token, vendor }` |
| GET | `/api/auth/me` | - | `vendor` |

`vendor` = `{ id, name, email, currency: "INR", timezone, tax_percent, theme: { primary, accent } }` - `theme` holds the restaurant's customer-menu colours as `#rrggbb` (defaults `#2f6f62` / `#e8872a`).

## Admin (all need the bearer token)

### Vendor settings
- `GET /api/admin/vendor` -> vendor
- `PATCH /api/admin/vendor` `{ name?, tax_percent? (0-100), timezone?, theme_primary? (#rrggbb), theme_accent? (#rrggbb) }` -> vendor. Colours are stored lower-case; anything that is not exactly `#rrggbb` is a 400.

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
Revenue only counts **paid** orders. `payment_methods[].method`: `cash` (counter) or `razorpay` (online).

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
`order` = `{ id, table_number, status, payment_status, payment_method, pay_pref, subtotal, tax, total, note, items, total_quantity, created_at, accepted_at, completed_at, paid_at, receipt_url }`
- `status`: `pending` -> `accepted` -> `completed`; `cancelled` from pending/accepted.
- `payment_status`: `unpaid` | `paid`. `payment_method`: `cash` | `upi` | `razorpay` | `null`. `pay_pref`: what the diner chose (`counter` | `upi` | `online`).
- `payment_claim`: `null`, or `{ method: "upi", reference, claimed_at }` when the diner says they paid through a UPI app. It is only a claim: the order stays `unpaid` until staff confirm.
- `items[]` = `{ id, name, quantity, unit_price, instructions, options: [{ group, name, price }], line_total }`
- `receipt_url` is `null` until paid, then `/api/admin/orders/:id/receipt.pdf` (needs the auth header -> fetch as blob and open).
- `GET /api/admin/orders?status=pending|accepted|completed|cancelled|active&payment=paid|unpaid&q=&page=&per_page=` (`active` = pending + accepted; `q` matches a table number or an exact order id)
- `GET /api/admin/orders/:id`
- `PATCH /api/admin/orders/:id/status` `{ status: "accepted"|"completed"|"cancelled" }` -> order.
  409 codes: `INVALID_TRANSITION`, `PAYMENT_REQUIRED` (complete needs payment first), `ALREADY_PAID` (cannot cancel a paid order).
- `POST /api/admin/orders/:id/cash-payment` (no body) -> order marked paid by cash. 409 `ALREADY_PAID` / `ORDER_CANCELLED` / `METHOD_NOT_AVAILABLE` (cash is not in `PAYMENT_METHODS`; the default is UPI only).
- `POST /api/admin/orders/:id/upi-payment` `{ reference? }` -> staff confirm the money arrived by UPI; marks the order paid (`payment_method: "upi"`). Defaults the reference to the diner's claimed one. 409 `ALREADY_PAID` / `ORDER_CANCELLED` / `DUPLICATE_REFERENCE`.
- `DELETE /api/admin/orders/:id` -> 204
- `GET /api/admin/orders/:id/receipt.pdf` -> application/pdf (409 `NOT_PAID` before payment)

### Payment settings
`settings` = `{ cash_enabled, upi_enabled, upi_id, razorpay_enabled, razorpay_key_id, razorpay_secret_set, razorpay_mode: "test"|"live"|null, razorpay_configured }`
- `GET /api/admin/payment-settings` -> includes `methods_available` (the ways of paying the product offers, from `PAYMENT_METHODS`, default `["upi"]`). Switching on a method that is not available is a 400. `GET /api/auth/me` returns the same list as `payment_methods`.
- `PUT /api/admin/payment-settings` `{ cash_enabled?, upi_enabled?, upi_id? (name@bank, "" clears it), razorpay_enabled?, razorpay_key_id?, razorpay_key_secret? }` - the secret is **write-only**
  (never returned); omit it to keep the stored one. At least one method must stay on.
- `POST /api/admin/payment-settings/test` -> `{ ok: true, mode }`, or 502 `RAZORPAY_BAD_KEYS` / `RAZORPAY_ERROR` with a readable message.

## Public (customer app; no auth)

A table's QR code opens `<customer-app>/t/<token>`. `<token>` is the 32-hex string at the end of `qr_url`.

### `GET /api/public/t/:token` - the menu for that table
```json
{
  "vendor": { "name": "Demo Kitchen", "currency": "INR", "tax_percent": 5, "theme": { "primary": "#2f6f62", "accent": "#e8872a" } },
  "table": { "number": "T-01" },
  "payment_options": { "cash": false, "upi": true, "razorpay": false },
  "categories": [{ "id": 1, "name": "Pizza", "description": "..." }],
  "items": [{ "id": 3, "category_id": 1, "category_name": "Pizza", "name": "...", "description": "...", "price": 499, "is_featured": true, "photo_url": null, "option_groups": [] }]
}
```
Only active items inside active categories are returned (featured first). 404 unknown token, 409 `TABLE_UNAVAILABLE` (table switched off).
`payment_options` = `{ cash, upi, razorpay }`: a method is true only when the product offers it (`PAYMENT_METHODS`, default UPI only) **and** the restaurant switched it on (`upi` also needs a UPI ID, `razorpay` needs keys). When all three are false the restaurant cannot take orders yet (see 409 `PAYMENTS_NOT_SET_UP` below).

### `POST /api/public/t/:token/orders` - place an order
Header `Idempotency-Key: <8-80 chars [A-Za-z0-9_-]>` - **send one per checkout attempt** (generate when the customer taps
"Place order", reuse it on retries). The same key returns the same order (HTTP 200 instead of 201) so double taps and retries never create duplicates.

Body:
```json
{ "items": [{ "item_id": 3, "quantity": 2, "instructions": "less spicy", "option_ids": [11, 14] }],
  "note": "optional note for the table", "pay_pref": "counter" }   // pay_pref: counter | upi | online
```
Do **not** send prices; the server prices everything. Returns 201 `public order` (below). Errors: 400 `OPTION_REQUIRED`,
`OPTION_TOO_MANY`, `INVALID_OPTION`; 409 `ITEM_UNAVAILABLE` (a dish was switched off - ask the diner to review the cart), `TABLE_UNAVAILABLE`, `PAYMENT_METHOD_UNAVAILABLE` (the chosen `pay_pref` is not offered; omit `pay_pref` to get the first offered one), `PAYMENTS_NOT_SET_UP` (the restaurant offers no way to pay yet, for example no UPI ID).

### `GET /api/public/orders/:orderToken` - follow an order (poll every few seconds)
`public order` = `{ token, table_number, status, payment_status, payment_method, payment_claim, subtotal, tax, total, note, items[], total_quantity, created_at, accepted_at, completed_at, paid_at, vendor: { name, currency, theme }, payment_options: { cash, upi, razorpay }, upi }`
(`items[]` as in admin orders.) There is no numeric id.
`upi` is `null` unless the order is unpaid, not cancelled and UPI is enabled; then it is `{ vpa, payee_name, amount, query }` where `query` is the ready-made, server-built query string of the payment link (exact amount included).

### Pay with a UPI app (Google Pay, PhonePe, Paytm ...) - no payment gateway needed
1. When `order.upi` is present, build a link by prefixing `order.upi.query`: `upi://pay?` (phone offers all UPI apps), `tez://upi/pay?` (Google Pay), `phonepe://pay?`, `paytmmp://pay?`. The amount is already inside; never compute it client side. On a computer show the `upi://pay?...` link as a QR code.
2. A plain UPI link cannot report whether the payment succeeded. When the diner returns to the page ask "Did your payment go through?" and call
   `POST /api/public/orders/:orderToken/upi-claim` `{ reference? }` (optional UPI reference, 6-30 letters/digits) -> `public order` with `payment_claim` set. **The order is still unpaid**; staff confirm in the admin panel (`POST /api/admin/orders/:id/upi-payment`), after which polling shows `payment_status: "paid"`, `payment_method: "upi"`.
   409 `UPI_NOT_AVAILABLE`, `ORDER_CANCELLED`.

### Online payment (Razorpay Checkout)
1. `POST /api/public/orders/:orderToken/razorpay` (no body) -> `{ key_id, razorpay_order_id, amount_paise, amount, currency, vendor_name }`.
   409 `RAZORPAY_NOT_CONFIGURED` (message already says "pay at the counter"), `ALREADY_PAID`, `ORDER_CANCELLED`; 502 `RAZORPAY_*`.
2. Load `https://checkout.razorpay.com/v1/checkout.js` and open Checkout with `{ key: key_id, order_id: razorpay_order_id, amount: amount_paise, currency, name: vendor_name }`.
3. In the checkout `handler(response)` call `POST /api/public/orders/:orderToken/razorpay/verify` with
   `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` (the three fields of `response`) -> `public order` with `payment_status: "paid"`.
   400 `PAYMENT_SIGNATURE_INVALID` / `PAYMENT_NOT_FOUND`.

If the diner pays at the counter, staff record it in the admin panel; the order page just keeps polling until `payment_status` becomes `paid`.

### `GET /api/public/items/:id/photo` - raw image (cacheable)

## Platform owner API (`/api/platform/*`)

Only for accounts listed in `SUPER_ADMIN_EMAILS` (`GET /api/auth/me` has `is_super_admin: true`); everyone else gets 403 `FORBIDDEN`.

- `GET /api/platform/overview` -> `{ restaurants: { total, active, suspended, new_30d }, orders_30d, revenue_30d }` (revenue = paid orders only, rupees).
- `GET /api/platform/restaurants?q=&status=active|suspended&page=&per_page=` -> `{ data: restaurant[], meta: { page, per_page, total } }`, newest first.
  `restaurant` = `{ id, name, email, created_at, status: "active"|"suspended", suspended_at, suspended_reason, is_platform_owner, tables, items, orders_total, orders_30d, revenue_total, last_order_at, upi_ready }`.
- `PATCH /api/platform/restaurants/:id` `{ suspended: boolean, reason?: string(<=200) }` -> the updated `restaurant`. 409 `CANNOT_SUSPEND` for a platform owner (or yourself); 404 unknown id.

A suspended restaurant: `POST /api/auth/login` and every `/api/admin/*` call return 403 `ACCOUNT_SUSPENDED` (message includes the reason), and its public menu / order endpoints return 409 `TABLE_UNAVAILABLE`.

## Password reset

- `POST /api/auth/forgot-password` `{ email }` -> always `200 { data: { ok: true } }` (an unknown email is not revealed). Emails a link `<ADMIN_APP_URL>/reset-password?token=...`; at most one email a minute per account; none for suspended accounts.
- `POST /api/auth/reset-password` `{ token, password (8-200 chars) }` -> `200 { data: { ok: true } }`. 400 `INVALID_RESET_TOKEN` when the link is wrong, used or expired (60 minutes; only the newest link works). Signs out every session started before the change (401 "Your password was changed").

## Sold-out dishes

- `item.is_sold_out` (admin and public). `PATCH /api/admin/items/:id` `{ is_sold_out: boolean }`. The public menu still lists a sold-out dish (with `is_sold_out: true`); ordering it returns 409 `ITEM_UNAVAILABLE`.
- `GET /api/admin/items?status=sold_out` filters; list `meta.sold_out` is the number of sold-out dishes in the whole menu.
- `POST /api/admin/items/restock` -> `{ restocked: n }` puts every sold-out dish back in stock.

## Reports

All take `from` and `to` (`YYYY-MM-DD`, the restaurant's own days; both default to today, one given means that single day; at most 92 days; 400 otherwise).

- `GET /api/admin/reports/summary` -> `{ from, to, timezone, sales: { orders, subtotal, tax, total, by_method: [{ method, orders, amount }] }, placed: { total, completed, cancelled, open, unpaid, unpaid_value }, top_items: [{ name, quantity, revenue }] }`. `sales` counts paid orders by the day they were paid (same as the dashboard); `placed` counts orders by the day they were placed.
- `GET /api/admin/reports/orders.csv` -> UTF-8 CSV (with BOM), one row per order placed or paid in the period; text cells that start with `= + - @` are prefixed with `'`.
- `GET /api/admin/reports/report.pdf` -> A4 PDF with the summary, best sellers and the order list.

## UPI mobile number

- `upi_mobile` in `GET`/`PUT /api/admin/payment-settings`: the restaurant's mobile number for "Pay phone number" in any UPI app. Any common format is accepted (`+91 98765-43210`, `09876543210`) and stored as 10 digits; `""` clears it; anything else is 400 `VALIDATION_ERROR`.
- UPI can be switched on with a UPI ID, a mobile number, or both. `payment_options.upi` is true when UPI is on and at least one of them is set.
- The public order's `upi` is `{ vpa, mobile, payee_name, amount, query }`. `vpa`/`query` are `null` when only a mobile number is set: there is no pay link then, and the order page shows the number to pay by hand (the diner still taps "I've paid"; staff confirm).

## UPI app buttons

- `upi_pay_buttons` (boolean, default `false`) in `GET`/`PUT /api/admin/payment-settings`: show the Google Pay / PhonePe / Paytm buttons. Turn it on only for a business (merchant) UPI ID: Google Pay and PhonePe usually refuse these pre-filled links for a personal UPI ID ("bank limit exceeded", "security reasons").
- The public order's `upi` has `pay_buttons` (true only when the switch is on **and** there is a UPI ID). `query` is still sent whenever there is a UPI ID, because the order page uses it for the QR code. With the buttons off the page shows how to pay by typing the UPI ID or mobile number.
