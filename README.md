# MezMitra

QR-code table ordering for restaurants. Diners scan the code on their table, browse the menu on their phone, place an
order and pay at the counter or online (Razorpay or PhonePe). Staff manage the menu, tables and live orders from an admin panel.

```
backend/    Node.js + Express API (PostgreSQL: Aiven in production, PGlite locally)
admin/      Restaurant admin panel (React + Vite + Tailwind)
customer/   Diner-facing mobile menu (React + Vite + Tailwind)
API.md      The API contract both web apps are built against
```

> Showing MezMitra to a tea cafe? See **[DEMO.md](DEMO.md)** for the ready-made *Tea Post* demo and a 5-minute walkthrough.

## Run it locally (no database setup needed)

Requires Node.js 22+.

```bash
npm install
SEED_DEMO=true npm run dev      # API :4000, admin :5180, customer menu :5174 (with DATABASE_URL empty: a local database)
```

- Admin panel: http://localhost:5180 - sign in with the demo vendor from `backend/src/seed.js` (change it before real use), or create a restaurant with `NEW_PASSWORD='a-long-password' npm run create-restaurant -w backend -- "My Cafe" me@example.com` (there is no public sign-up).
- Customer menu: in the admin go to **Tables -> QR codes**; each table has a link like `http://localhost:5174/t/<token>` (this is what the QR code contains). Open it on your phone (same Wi-Fi: use your computer's LAN address and set `CUSTOMER_APP_URL` accordingly) or paste it into the browser.
- The customer app's start page (`http://localhost:5174/`) has a **Scan QR code** button that opens the phone camera. Browsers only allow the camera on `https://` (or `localhost`); on a plain-`http` LAN address it automatically offers "Use a photo of the QR code" instead, and there is always a paste-the-link box.
- Without `DATABASE_URL` the API uses a file-based PGlite (a WebAssembly Postgres) in `backend/.data/pglite`. Only one process can open it at a time, which is why the demo data is seeded by the server itself (`SEED_DEMO=true`) rather than a second command. Delete that folder to start from scratch.

### Try it on your phone (same Wi-Fi)

Both web apps listen on your network address, so a phone on the same Wi-Fi can open them:

1. Find this computer's address (macOS: `ipconfig getifaddr en0`, e.g. `192.168.1.22`).
2. Put it in `backend/.env` so table QR codes point there instead of `localhost`, then restart the API:
   ```
   CUSTOMER_APP_URL=http://192.168.1.22:5174
   ```
3. On the phone open `http://192.168.1.22:5174/` (customer menu) or `http://192.168.1.22:5180/` (admin). Scan a table QR with the phone's own camera app, or print/show the QR from **Tables -> QR codes**.
4. If it does not load: allow incoming connections for `node` in the macOS firewall prompt, make sure the phone is on the same Wi-Fi (not a guest/isolated network), and re-check the address (it can change when you reconnect).

On plain `http://` the *in-page* camera scanner is disabled by the browser (it needs `https`); use the phone's camera app or "Use a photo of the QR code".

```bash
npm test          # backend end-to-end tests (in-memory database, fake Razorpay and PhonePe)
npm run build     # production builds of both web apps (admin/dist, customer/dist)
```

## Use Aiven PostgreSQL

1. Create an Aiven account and a **PostgreSQL** service on the **Free** plan (Aiven console -> *Create service*).
2. On the service's **Overview** page copy the **Service URI** and download the **CA certificate**.
3. Create `backend/.env` (start from `backend/.env.example`):
   ```
   DATABASE_URL=postgres://avnadmin:<password>@<host>:<port>/defaultdb?sslmode=require
   DATABASE_CA_CERT_PATH=./aiven-ca.pem       # save the downloaded certificate as backend/aiven-ca.pem
   APP_SECRET=<64 random hex characters>      # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Keep `.env` out of git (it is in `.gitignore`). Do not paste the URI into chat or issues - it contains the password.
4. Check the connection, create the tables and (optionally) the demo data:
   ```bash
   npm run db:check                        # connects, prints the Postgres version and whether TLS is on
   ALLOW_REMOTE_DB=true npm run db:migrate # applies backend/migrations/*.sql (also runs automatically when the API starts)
   ```
   A run on your own computer refuses a remote database without `ALLOW_REMOTE_DB=true`, so that live data is not changed by
   accident; for everyday work keep `DATABASE_URL` empty. Demo restaurants can be seeded into a real database only with
   `SEED_PASSWORD` and `TEAPOST_PASSWORD` set to passwords of your own.
5. The free plan has small limits (storage, connections, possible inactivity power-off - read Aiven's current free-plan terms).
   The API keeps its pool small (`DATABASE_POOL_MAX=5`). Item photos are stored in the database (max 512 KB each, the admin
   panel shrinks them first), so keep an eye on storage; if you outgrow it, move photos to object storage and keep `photo_url`.

All SQL is plain PostgreSQL 14+, so moving to another provider later (Supabase, Neon, RDS, your own server) is a
`pg_dump` / restore plus a new `DATABASE_URL`.

## Configuration (`backend/.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. Empty = local PGlite. |
| `DATABASE_CA_CERT_PATH` / `DATABASE_CA_CERT` | CA certificate of the database. **Required in production** for a database on another machine: the server refuses to start without it. |
| `DATABASE_ALLOW_UNVERIFIED_TLS` | Emergency only: `true` lets production start without the certificate. |
| `ALLOW_REMOTE_DB` | A run on your own computer (not production) refuses a remote database, so live data is not touched by accident. Set `true` for the one run where you mean it (`reset-password` and `create-restaurant` work without it and print the database they use). |
| `APP_SECRET` | **Required in production**, 32+ chars. Signs login tokens and encrypts stored Razorpay secrets (AES-256-GCM). Changing it logs everyone out, invalidates saved Razorpay secrets, and makes authenticator codes of two-step sign-in unusable (recovery codes still work). |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API (your admin and customer URLs). |
| `CUSTOMER_APP_URL` | Public URL of the customer app. It is the base of every table QR link. |
| `SUPER_ADMIN_EMAILS` | Emails (comma separated) of the platform owner's account(s). They get the **Owner console** (`/owner`, linked from the sidebar): every restaurant with its numbers, and a switch to suspend or reactivate it. Empty = nobody has access. |
| `SMTP_URL`, `MAIL_FROM` | Email for password reset. `SMTP_URL` is any provider's SMTP address, e.g. `smtps://user:app-password@smtp.gmail.com:465` (Gmail needs an *app password*). Empty = no email is sent; in development the email is printed in the API console instead. |
| `ADMIN_APP_URL` | Public URL of the admin site (default `http://localhost:5180`): the base of the link inside the reset email. |
| `PAYMENT_METHODS` | Ways of paying the product offers: any of `cash`, `razorpay`, `phonepe`, comma separated. **Default: all three.** Restaurants can only switch on what is listed here. |
| `API_PUBLIC_URL` | Optional, e.g. `https://your-api.onrender.com`: the base of the payment webhook address shown to restaurants. Empty = read from the request (fine behind Render's proxy). |
| `PHONEPE_API_BASE` | Optional. Leave empty: PhonePe's own live servers are used. Tests point it at a fake. |
| `TRUST_PROXY` | How many reverse proxies sit in front of the API: `1` on Render/Fly/Heroku, `0` when none (default in production is `1`). Used for the request's protocol and, without the next setting, its address. |
| `CLIENT_IP_HEADER` | The header in which the proxy names the visitor; the rate limits count by it. `cf-connecting-ip` on Render (set in `render.yaml`). Set it only where no request can bypass that proxy. |
| `MAX_OPEN_ORDERS_PER_TABLE` | How many pending, unpaid orders one table may have (default 12). |

Web apps: set `VITE_API_URL` (build time) to the API's public URL when they are not served from the same origin. The admin's `Content-Security-Policy`
(`admin/vercel.json`, `admin/public/_headers`) names the API's address: change it there too if the API moves (for example to a domain of your own),
or the admin cannot reach it.

## Password reset, sold-out dishes, reports

- **Forgot password:** *Sign in -> Forgot password?* emails a one-time link (valid 60 minutes, newest link only, at most one email a minute
  per account). The answer is the same whether or not the email has an account. Choosing a new password signs out sessions started
  before it. Needs `SMTP_URL` / `MAIL_FROM` / `ADMIN_APP_URL`; without SMTP the link is printed in the API console (development only).
- **Change password:** *Settings -> Password* (current password, new password twice, with a strength hint). Other devices are signed out; this one continues.
- **Locked out (no email set up):** passwords are stored as one-way bcrypt hashes, so an old one can never be read back. Set a new one
  on the database `backend/.env` points to (Aiven when `DATABASE_URL` is set): `NEW_PASSWORD='a-new-password' npm run reset-password -w backend -- you@example.com`.
  It prints which database it is talking to, refuses weak passwords, signs out the account's old sessions, and never prints the password. Add `DISABLE_2FA=true` when the phone with the authenticator app is lost.
- **Two-step sign-in:** *Settings -> Two-step sign-in*: scan the QR code with any authenticator app and keep the recovery codes. Recommended for the platform owner's account.
- **Sold out:** *Menu -> Items -> Mark sold out* is one tap. The dish stays on the menu, greyed out and labelled "Sold out", and cannot
  be ordered; carts drop it. **All back in stock** clears every sold-out dish at once (end of the day). This is separate from the
  *Available* switch, which hides a dish completely.
- **Reports:** *Reports* shows a day (or up to 92 days) of sales: money received (counted on the day it was paid, like the dashboard),
  split by payment method (cash / online), orders placed, unpaid orders and best sellers, with a **CSV** (one row per order, opens in Excel/Sheets) and
  a **PDF** download.

## Voice for new orders

With **New-order sound** on, the admin panel chimes and reads each new order out ("New order. Table 3. 2 items."). Admin -> Settings ->
**New-order alerts** lets each device choose English or Hindi, a voice and a speed (kept on that device). It uses the browser's own
text-to-speech, so nothing is shipped or called online; the voices come from the device, and a language the device has no voice for shows a warning.
Table names are read as digits only ("T-03" is "Table 3"); dish names are not read.

## Kitchen screen

Admin -> **Kitchen screen** (`/kitchen`) is a full-screen view for a tablet or spare monitor in the kitchen: no sidebar, no prices. It is drawn the way
Apple draws its own apps (system fonts and colours, a grouped grey background, white cards with modest rounded corners, hairline separators, tinted labels,
segmented controls), in a light and a dark look (switch at the top, remembered per device); the look lives in `admin/src/index.css` under `.kitchen`, and
everything is sized in rem so the Small / Medium / Large switch (Medium is the default) scales the whole page. A card of four figures (new, cooking, ready, longest wait) and a
"To cook" row that adds up the open orders ("4 Masala Chaas") sit above three columns: **New**, **Preparing** and **Ready** (stays 30 minutes). Each order is a
card with the table number, how long it has waited (grey, orange after 8 minutes, red with "Late" after 15), the dishes as a list with the diner's notes and
dish instructions highlighted, and a small button in the corner, the way the App Store puts "Get": **Accept** on a new order, **Ready** on one being cooked.
The rarely used "Can't make it" sits in a **...** menu next to Accept and asks before it cancels. Motion is only for what happened and uses the system easing: a
new order opens in (with a chime that reads the table out) and is ringed in blue for a moment, and a card that moves on glides to its new column; animations
are off for devices set to reduced motion. Tap **Start** once (browsers only allow sound and a screen that stays awake after a click). It shows "Offline" when it
cannot reach the server, and on a phone the three columns become a segmented control. It has its own sign-in: in Admin -> Settings -> **Kitchen login** the restaurant sets an email and a password for the kitchen tablet. Signing in with it opens the
kitchen screen and nothing else (no sidebar, menu, payments or settings, and the API refuses everything but orders), a new password signs the tablet out, and removing
the login ends it at once. The restaurant's own login also works on the screen, with an "Admin" link back. It uses the same order feed as the admin; an order still open after 12 hours is not shown (it is counted under the figures).

## Demo data (sample orders and prices)

For a client demo: `npm run demo:prices` makes every Tea Post dish Rs 1 (extras free), so a real payment costs almost nothing, and
`npm run demo:history` adds 4 paid, completed sample orders over the last 2 days so the dashboard, Orders and Reports are not empty.
`npm run demo:history -- --busy` makes a busy cafe (about 30 orders a day for 14 days). Sample orders are marked and never mix with
real ones: run `npm run demo:history -- --remove` to delete only them, and `npm run demo:prices -- --restore` for the seed.js prices.
Add `--email you@x.in` to use another restaurant.
`npm run demo:qr` rebuilds the printable QR cards (PDF + PNGs in `demo/tea-post/`) from the address in `CUSTOMER_APP_URL`; run it again whenever that address (for example the Wi-Fi) changes.

## Platform owner (all restaurants)

Create an account of your own (`NEW_PASSWORD='a-long-password' npm run create-restaurant -w backend -- "My Cafe" me@example.com`), put its email in `SUPER_ADMIN_EMAILS` and restart the API. That account now has
the **Owner console** at `/owner` (a link above "Sign out" in the sidebar; old `/platform` links land there). It is a separate area with
its own dark header and an "Owner" mark, not part of a restaurant's admin, and it has a link back to the account's own restaurant admin.
It lists every restaurant with its orders, paid revenue, tables and dishes, with search and filters, **Add restaurant** (you type its name, email and a first password; the login is shown once so you can hand it over, because restaurants cannot sign themselves up), and **Suspend / Reactivate**. A restaurant's page has **Edit details** (fix its name or login email) and the **Activity** page lists everything done from the console, across all restaurants, with a search and a filter by kind of action. Everyone else who opens `/owner` is sent back to their own admin. A suspended restaurant cannot sign in (it sees your optional reason), its admin
API is refused on the very next request, and its tables stop taking orders; its data is kept and reactivating restores everything.
Platform owner accounts cannot be suspended. Removing an email from `SUPER_ADMIN_EMAILS` removes the access.

## Payments: cash, Razorpay and PhonePe

Diners pay at the counter (cash) or online. `PAYMENT_METHODS` lists what the product offers; each restaurant switches those on in
**Admin -> Payments** and uses **one** online gateway at a time (Razorpay or PhonePe). New restaurants start with cash on. While a
restaurant has no way to be paid, the Dashboard shows a reminder and the menu refuses orders with a clear message.

The plain "UPI ID" way of paying (UPI app links, the restaurant's own UPI QR, staff confirming the payment), Cashfree and Paytm were
removed. Orders paid those ways keep their names in Orders, receipts and Reports, and the old data stays in the database. Migration
`026` switches cash on for any restaurant that was left with no way to be paid.

## Online payments (PhonePe)

The official PhonePe payment gateway (**Standard Checkout v2**): the diner is sent to PhonePe's own page to pay by UPI, card or net
banking, and comes back to the order page. The money goes through PhonePe to the restaurant's own merchant account; MezMitra never
holds it.

Each restaurant brings its own PhonePe **payment gateway** account: **Admin -> Payments** -> turn on *Online payments (PhonePe)* and
enter the **Client ID**, **Client Version** (usually `1`) and **Client Secret** (PhonePe Business dashboard -> Developer Settings,
with Test Mode off). Only **live** keys work: there is no sandbox choice, so every payment is real money. These keys come with PhonePe's
payment gateway onboarding; a UPI ID or QR from the PhonePe Business app is not enough. Secrets are stored encrypted and never shown
again; *Test connection* proves the keys. Migration `027` switches PhonePe off (and cash on, if needed) for any restaurant that had
saved sandbox keys.

How a payment is confirmed: `POST /api/public/orders/:token/pay/phonepe` opens a payment at PhonePe and returns where to send the
diner. Coming back, the order page calls `.../pay/phonepe/verify`, which sends nothing: the **server asks PhonePe** for the order status
and only marks the order paid for exactly the right amount. Every open attempt is asked about before a new one is opened (at most 10
within 3 hours). Refunds work (admin -> order -> *Refund*).

**Paid twice:** if money arrives for an order that is already paid (say cash was recorded while the diner was still paying online),
it is kept as a second payment: Orders shows a red notice, and the order has a button to refund it.

**Refund not confirmed:** if the gateway's answer to a refund gets lost, the order says so, nobody should pay the money back another
way, and the server asks the gateway every few minutes how it ended.

**Not yet tried against a real PhonePe account**: the code follows their published docs and is tested against fakes, so before relying
on it, place a very small real order, pay it, and refund it.

## Payment webhooks (Razorpay, PhonePe)

A payment is confirmed when the gateway says so: when the diner comes back to the order page, when the gateway **calls the server** (webhook), or at the
latest by the server's own re-check every few minutes. Webhooks make it instant even if the diner closed the page. In **Admin -> Payments** each
restaurant sees its own private webhook address with a copy button, a few steps for the gateway's dashboard, and a box for the webhook secret
(Razorpay) or username and password (PhonePe). The API must be reachable from the internet (set `API_PUBLIC_URL` if the address shown is wrong).
See API.md "Payment webhooks".

## Online payments (Razorpay)

Only used when `PAYMENT_METHODS` includes `razorpay`.

Each restaurant brings its own Razorpay account: **Admin -> Payments** -> enter the Key ID and Key Secret from the Razorpay
dashboard, press **Test connection**, then turn online payments on. **The live server (`NODE_ENV=production`) accepts only live keys
(`rzp_live_...`)**: a test key's payments are pretend, so anyone could get an order marked paid. A local run also accepts
`rzp_test_...` keys for trying things out. Migration `028` switches Razorpay off (and cash on, if needed) for any restaurant that had
a test key saved. Secrets are stored encrypted
and are never sent back to the browser. Diners then see **Pay online** on their order page; the API creates the Razorpay order,
the browser opens Razorpay Checkout, and the API verifies Razorpay's HMAC signature, then asks Razorpay that the money is captured
(capturing it itself if the account only authorized it) before marking the order paid. If a
restaurant has no keys the diner is simply told to pay at the counter, and staff can record the payment (**Orders -> Record cash payment**).

Paying online also **accepts the order**: once the gateway has confirmed the money, a pending order becomes accepted by itself (staff do not press Accept; they press Complete when it is served). Cash orders still wait for staff.

**Scan to pay (QR):** under *Pay online* the diner can tap *Or scan a QR code to pay*. The API makes a Razorpay **UPI QR** for that order (single use, fixed amount; `POST /api/public/orders/:token/razorpay-qr`) and the page asks `.../razorpay-qr/verify` every 3 seconds; the server asks Razorpay and marks the order paid (and accepted) when a captured payment of at least the order's amount shows up. Razorpay must have switched **UPI QR** on for the account (an on-demand feature, ask Razorpay support); if not, the diner is told to use *Pay online* instead.

Set up the Razorpay **webhook** too (see *Payment webhooks* above): without it, a diner who closes the page right after paying is
noticed only by the five-minute re-check.

## Deploying (Aiven + Render + Cloudflare Pages)

Three pieces: the database (Aiven, see above), the API (Render, `render.yaml`) and the two static web apps (Cloudflare Pages).
The free plans are fine for demos and first restaurants; for real daily use move the API off the free plan (it sleeps after
15 minutes without traffic) and the database to a plan that is not powered off when idle.

1. **Code on GitHub.** Create a private repository, then from this folder:
   ```bash
   git add -A && git commit -m "MezMitra" && git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git && git push -u origin main
   ```
   `.env`, certificates, `.data/` and `demo/` are git-ignored; check `git status` before the first commit.
2. **API on Render.** New -> *Blueprint* -> pick the repository (it reads `render.yaml`). When asked, fill in:
   - `DATABASE_URL`: the Aiven Service URI.
   - `DATABASE_CA_CERT`: the full contents of `backend/aiven-ca.pem` (paste all lines, including BEGIN/END). The API does not
     start in production without it.
   - `APP_SECRET`: 32+ random characters. Use the value from `backend/.env` if you also run locally against the same Aiven database
     (otherwise saved Razorpay keys cannot be decrypted by the other side).
   - `CORS_ORIGINS` and `CUSTOMER_APP_URL`: put `https://placeholder.invalid` for now, you set them in step 4.
   Check `https://<your-service>.onrender.com/api/health` -> `{"data":{"status":"ok","database":"pg"}}`.
3. **Two sites on Cloudflare Pages** (Workers & Pages -> Create -> Pages -> Connect to Git, same repository, twice). Leave the root directory empty.

   | | Build command | Build output directory |
   |---|---|---|
   | admin | `npm ci && npm run build -w admin` | `admin/dist` |
   | customer | `npm ci && npm run build -w customer` | `customer/dist` |

   Environment variables for both: `VITE_API_URL=https://<your-service>.onrender.com` (no trailing slash) and `NODE_VERSION=22`.
   `public/_redirects` (single-page-app routing) and `public/_headers` (caching, basic security headers) are already in each app.
   **Vercel instead of Cloudflare Pages:** the repo-root `vercel.json` (SPA rewrite + headers) is shared by both sites. In Vercel choose
   **Import single project** (not the multi-service import) twice, leave **Root Directory** as `./`, and set per project
   (Settings → Build & Development): Framework **Vite**, Install `npm ci`, Build `npm run build -w admin` (or `-w customer`),
   Output Directory `admin/dist` (or `customer/dist`). Add `VITE_API_URL`, deploy. Vercel's free Hobby plan is for
   non-commercial use only, so use Cloudflare Pages (or a paid Vercel plan) for real restaurants.
4. **Connect them.** On Render set `CORS_ORIGINS=https://<admin>.pages.dev,https://<customer>.pages.dev` and
   `CUSTOMER_APP_URL=https://<customer>.pages.dev`; it redeploys by itself. Table QR codes use `CUSTOMER_APP_URL`, so
   **create (or re-download) the QR codes only after this step**, and use a domain you own before printing: a QR code
   breaks if the address changes. Changing a variable on Cloudflare needs a new deployment (the value is baked in at build time).
5. **Before real restaurants:** change or delete the demo accounts from `backend/src/seed.js`, there is no public sign-up (restaurants are added by you, from the Owner console), and add your custom domains (Cloudflare Pages -> Custom domains; Render -> Custom domains).

- If you add a Content-Security-Policy header to the customer site, allow Razorpay Checkout: `script-src https://checkout.razorpay.com`, `frame-src https://api.razorpay.com https://checkout.razorpay.com`, `connect-src https://lumberjack.razorpay.com` plus your API origin.
- Any other Node 22 host works for the API (`npm run start -w backend`, `NODE_ENV=production`, the variables above); any static host with a fallback to `index.html` works for the sites.
- Back up regularly: `pg_dump "$DATABASE_URL" > backup.sql` (store it somewhere other than the database provider).

## What changed compared with the previous version (called TableSeva)

Found while reviewing the old deployment and fixed by design here:

- Table QR codes hold an unguessable token, not the vendor's email and a sequential `table_id`; customers follow an order by a random token, not by a numeric id.
- The server computes every price and total from the database; the client cannot change prices.
- Revenue and "top selling" only count **paid** orders and are grouped by the restaurant's own time zone; an order cannot be completed before it is paid; receipts are generated on demand.
- Inactive categories and their dishes never reach customers; editing a table's seats no longer re-activates it; PATCH changes only the fields sent.
- Placing an order is idempotent (`Idempotency-Key`), and the cart is cleared once the order exists.
- Razorpay keys are configurable per restaurant from the admin panel, with a connection test, instead of failing with "not configured".
- Photos and receipts live in the database / are rendered on demand, so the API has no disk to lose and works on any host.
- One menu-items page (the old product had two), consistent ₹ and date formats, mobile-friendly admin, specific error messages.
- **Logo per restaurant:** Admin -> Appearance -> Logo (saved straight away). It is stored in Postgres like dish photos, shrunk to 512 px in the browser, and shown on the customer menu and order pages (a coloured tile with the first letter is used when there is no logo).
- **Menu colours per restaurant:** Admin -> Appearance has ready-made themes, your own colour pickers and a live preview. The customer app derives a full light-to-dark scale from the two chosen colours (and darkens the main colour when needed so white text stays readable) - see `shared/theme.js`.

Not included: table reservations (the old product only had a "Coming soon" page).
