# MezMitra

QR-code table ordering for restaurants. Diners scan the code on their table, browse the menu on their phone, place an
order and pay at the counter or online (Razorpay). Staff manage the menu, tables and live orders from an admin panel.

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
SEED_DEMO=true npm run dev      # API :4000, admin :5180, customer menu :5174
```

- Admin panel: http://localhost:5180 - sign in with the demo vendor from `backend/src/seed.js` (change it before real use), or sign up as a new restaurant.
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

On plain `http://` the *in-page* camera scanner is disabled by the browser (it needs `https`); use the phone's camera app or "Use a photo of the QR code". UPI app buttons work over `http`.

```bash
npm test          # backend end-to-end tests (in-memory database, mocked Razorpay)
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
   npm run db:check      # connects, prints the Postgres version and whether TLS is on
   npm run db:migrate    # applies backend/migrations/*.sql (also runs automatically when the API starts)
   npm run db:seed       # optional demo restaurant
   npm run dev
   ```
5. The free plan has small limits (storage, connections, possible inactivity power-off - read Aiven's current free-plan terms).
   The API keeps its pool small (`DATABASE_POOL_MAX=5`). Item photos are stored in the database (max 512 KB each, the admin
   panel shrinks them first), so keep an eye on storage; if you outgrow it, move photos to object storage and keep `photo_url`.

All SQL is plain PostgreSQL 14+, so moving to another provider later (Supabase, Neon, RDS, your own server) is a
`pg_dump` / restore plus a new `DATABASE_URL`.

## Configuration (`backend/.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. Empty = local PGlite. |
| `DATABASE_CA_CERT_PATH` / `DATABASE_CA_CERT` | CA certificate so the TLS certificate is verified (recommended on Aiven). |
| `APP_SECRET` | **Required in production**, 32+ chars. Signs login tokens and encrypts stored Razorpay secrets (AES-256-GCM). Changing it logs everyone out and invalidates saved Razorpay secrets. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API (your admin and customer URLs). |
| `CUSTOMER_APP_URL` | Public URL of the customer app. It is the base of every table QR link. |
| `ALLOW_SIGNUP` | `false` to stop new restaurants signing up. |
| `SUPER_ADMIN_EMAILS` | Emails (comma separated) of the platform owner's account(s). They get **Platform** in the admin sidebar: every restaurant with its numbers, and a switch to suspend or reactivate it. Empty = nobody has access. |
| `SMTP_URL`, `MAIL_FROM` | Email for password reset. `SMTP_URL` is any provider's SMTP address, e.g. `smtps://user:app-password@smtp.gmail.com:465` (Gmail needs an *app password*). Empty = no email is sent; in development the email is printed in the API console instead. |
| `ADMIN_APP_URL` | Public URL of the admin site (default `http://localhost:5180`): the base of the link inside the reset email. |
| `PAYMENT_METHODS` | Ways of paying the product offers: any of `upi`, `cash`, `razorpay`, comma separated. **Default `upi` (UPI only).** Restaurants can only switch on what is listed here; use `upi,cash,razorpay` to bring the others back. |
| `TRUST_PROXY` | How many reverse proxies sit in front of the API: `1` on Render/Fly/Heroku, `0` when none (default in production is `1`). Needed for correct per-IP rate limits. |

Web apps: set `VITE_API_URL` (build time) to the API's public URL when they are not served from the same origin.

## Password reset, sold-out dishes, reports

- **Forgot password:** *Sign in -> Forgot password?* emails a one-time link (valid 60 minutes, newest link only, at most one email a minute
  per account). The answer is the same whether or not the email has an account. Choosing a new password signs out sessions started
  before it. Needs `SMTP_URL` / `MAIL_FROM` / `ADMIN_APP_URL`; without SMTP the link is printed in the API console (development only).
- **Sold out:** *Menu -> Items -> Mark sold out* is one tap. The dish stays on the menu, greyed out and labelled "Sold out", and cannot
  be ordered; carts drop it. **All back in stock** clears every sold-out dish at once (end of the day). This is separate from the
  *Available* switch, which hides a dish completely.
- **Reports:** *Reports* shows a day (or up to 92 days) of sales: money received (counted on the day it was paid, like the dashboard),
  split by UPI / cash / online, orders placed, unpaid orders and best sellers, with a **CSV** (one row per order, opens in Excel/Sheets) and
  a **PDF** download.

## Demo data (sample orders and prices)

For a client demo: `npm run demo:prices` makes every Tea Post dish Rs 1 (extras free), so a real UPI payment costs almost nothing, and
`npm run demo:history` adds 4 paid, completed sample orders over the last 2 days so the dashboard, Orders and Reports are not empty.
`npm run demo:history -- --busy` makes a busy cafe (about 30 orders a day for 14 days). Sample orders are marked and never mix with
real ones: run `npm run demo:history -- --remove` to delete only them, and `npm run demo:prices -- --restore` for the seed.js prices.
Add `--email you@x.in` to use another restaurant.
`npm run demo:qr` rebuilds the printable QR cards (PDF + PNGs in `demo/tea-post/`) from the address in `CUSTOMER_APP_URL`; run it again whenever that address (for example the Wi-Fi) changes.

## Platform owner (all restaurants)

Sign up an account of your own (Admin -> Sign up), put its email in `SUPER_ADMIN_EMAILS` and restart the API. That account now has
**Platform -> All restaurants** in the sidebar: every restaurant with its orders, paid revenue, tables, dishes and whether it has a UPI
ID, search and filters, and **Suspend / Reactivate**. A suspended restaurant cannot sign in (it sees your optional reason), its admin
API is refused on the very next request, and its tables stop taking orders; its data is kept and reactivating restores everything.
Platform owner accounts cannot be suspended. Removing an email from `SUPER_ADMIN_EMAILS` removes the access.

## Payments: UPI only for now

> **Personal UPI ID?** Google Pay and PhonePe refuse the pay-with-app buttons for an ordinary UPI ID ("bank limit exceeded", "security reasons"), so the buttons are **off by default**: diners pay by typing the UPI ID (a QR code is shown too). Turn on *Show UPI app buttons* in Admin -> Payments only for a business (merchant) UPI ID.

By default (`PAYMENT_METHODS=upi`) diners pay with a UPI app (Google Pay, PhonePe, Paytm ...): the order page opens the app with the
exact amount filled in, the diner taps "I've paid", and the restaurant confirms the money arrived (**Orders -> Confirm UPI payment**).
A restaurant has to enter its UPI ID in **Admin -> Payments** before diners can order; until then the Dashboard shows a reminder and the
menu refuses orders with a clear message. Cash and Razorpay are hidden everywhere (admin, customer menu, API) until `PAYMENT_METHODS`
lists them again; nothing is deleted, so switching them back on needs no migration.

## Online payments (Razorpay)

Only used when `PAYMENT_METHODS` includes `razorpay`.

Each restaurant brings its own Razorpay account: **Admin -> Payments** -> enter the Key ID and Key Secret from the Razorpay
dashboard (use `rzp_test_...` keys first), press **Test connection**, then turn online payments on. Secrets are stored encrypted
and are never sent back to the browser. Diners then see **Pay online** on their order page; the API creates the Razorpay order,
the browser opens Razorpay Checkout, and the API verifies Razorpay's HMAC signature before marking the order paid. If a
restaurant has no keys the diner is simply told to pay at the counter, and staff can record the payment (**Orders -> Record cash payment**).

Not built yet: a Razorpay **webhook**. Today a payment is confirmed when the diner's browser returns from Checkout; if the diner
closes the tab right after paying, staff must reconcile it from the Razorpay dashboard. A webhook endpoint is the recommended next step before taking live payments.

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
   - `DATABASE_CA_CERT`: the full contents of `backend/aiven-ca.pem` (paste all lines, including BEGIN/END).
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
5. **Before real restaurants:** change or delete the demo accounts from `backend/src/seed.js`, set `ALLOW_SIGNUP=false` if you
   onboard restaurants yourself, and add your custom domains (Cloudflare Pages -> Custom domains; Render -> Custom domains).

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
