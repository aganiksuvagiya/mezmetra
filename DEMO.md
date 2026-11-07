# Tea Post demo (about 5 minutes)

A ready-made demo restaurant, **Tea Post**: 20 chai, coffee, snack and cold-drink items with options (size, sugar, extras),
5 tables, 5% GST, and a chai-brown colour theme.

## Before the meeting

1. Start everything: `SEED_DEMO=true npm run dev` (creates Tea Post the first time; safe to repeat).
2. Admin login: `http://localhost:5180` with the Tea Post account from the top of `backend/src/seed.js`
   (email `teapost@tableseva.local`, the password is the `TEAPOST_PASSWORD` default there).
3. To scan with a phone on the same Wi-Fi, set your computer's address in `backend/.env` and restart the API
   (see README, "Try it on your phone"):
   `CUSTOMER_APP_URL=http://192.168.1.22:5174`
4. The demo photos are stock photos (credits below) kept in `backend/seed-assets/tea-post/`; seeding a new database (for example Aiven)
   attaches them automatically. For the real pitch upload Tea Post's own photos:
   Admin -> **Menu -> Items** -> edit an item -> **Photo** (the browser shrinks them automatically).
5. Payments are **UPI only** for now. The demo restaurants are seeded with a placeholder UPI ID (`mezmitra.demo@okaxis`, or `SEED_UPI_ID`),
   which UPI apps reject. Before the meeting put a real UPI ID in Admin -> **Payments** (it must **not** be the account on the phone you
   pay from: apps refuse paying yourself). Cash and Razorpay are switched off in the product (`PAYMENT_METHODS`).

## Photos in the demo

The dish photos in the Tea Post demo are free stock photos from **[Pexels](https://www.pexels.com)**, used under the
[Pexels License](https://www.pexels.com/license/) (free to use, including commercially; attribution is not required but
appreciated). They are *not* Tea Post's own food, so use them for the demo only and upload the cafe's real photos for the pitch
(Admin -> **Menu -> Items** -> edit -> **Photo**).

| Dish | Pexels photo |
|---|---|
| Cutting Chai | [34324342](https://www.pexels.com/photo/34324342/) |
| Masala Chai | [37186989](https://www.pexels.com/photo/37186989/) |
| Adrak Chai | [29650995](https://www.pexels.com/photo/29650995/) |
| Elaichi Chai | [20270270](https://www.pexels.com/photo/20270270/) |
| Kesar Chai | [12419206](https://www.pexels.com/photo/12419206/) |
| Lemon Tea | [10307718](https://www.pexels.com/photo/10307718/) |
| Filter Coffee | [16128085](https://www.pexels.com/photo/16128085/) |
| Cappuccino | [6747870](https://www.pexels.com/photo/6747870/) |
| Cold Coffee | [4869290](https://www.pexels.com/photo/4869290/) |
| Hot Chocolate | [5264675](https://www.pexels.com/photo/5264675/) |
| Bun Maska | [15997563](https://www.pexels.com/photo/15997563/) |
| Samosa (2 pcs) | [5031949](https://www.pexels.com/photo/5031949/) |
| Vada Pav | [17433353](https://www.pexels.com/photo/17433353/) |
| Khari Biscuit | [31909870](https://www.pexels.com/photo/31909870/) |
| Masala Maggi | [8108045](https://www.pexels.com/photo/8108045/) |
| Veg Sandwich | [14410236](https://www.pexels.com/photo/14410236/) |
| Cheese Sandwich | [13689802](https://www.pexels.com/photo/13689802/) |
| Pakora Plate | [30174012](https://www.pexels.com/photo/30174012/) |
| Masala Chaas | [8489749](https://www.pexels.com/photo/8489749/) |
| Fresh Lime Soda | [4045205](https://www.pexels.com/photo/4045205/) |

## The story to tell

1. **Scan.** Show the QR for a table (Admin -> **Tables -> QR codes**, or print them) and scan it with the phone camera.
   The Tea Post menu opens, no app to install.
2. **Browse.** Chef's picks, category chips, search ("chai").
3. **Order.** Tap **+** on *Cutting Chai* (one tap), open *Masala Chai* (choose Large, less sugar), add *Bun Maska*.
   Open the cart, add a note ("no sugar in one"), and **Place order**.
4. **Pay.** Tap *Pay with UPI app* (the amount is already filled in), pay in Google Pay / PhonePe / Paytm, come back and tap *I've paid*.
5. **Kitchen side.** On the laptop open Admin, switch **New-order sound** on in the sidebar (one click; browsers need it), then place
   the order from the phone: the laptop chimes, the tab title shows `(1)` and Admin -> **Orders** has the order, live. **Accept**, press **Confirm UPI payment** once the money is in, **Complete**.
   The customer's phone updates by itself ("Your order is being prepared", then "Order completed").
6. **Owner's view.** **Dashboard**: today's revenue, top-selling items, payment split. **Appearance**: change the colours and
   show the menu on the phone changing. **Menu -> Items**: switch an item off, change a price.

## Talking points

- No app for customers, no hardware: just a printed QR on each table.
- Orders go straight to the counter; no one shouts orders across the stall.
- Prices, items, photos, taxes and colours are all controlled by the owner from the admin panel.
- Customers' phones show live order status; payments are recorded per order, so end-of-day cash tallies are easy.
- Works for multiple outlets later (each restaurant has its own menu, tables and colours).

## Limits to be upfront about

- Online payments confirm automatically only with Razorpay; plain UPI links need a staff confirmation.
- The in-page camera scanner needs `https`; on plain `http` use the phone's own camera app.
- This is a local demo database. Production needs the Aiven database and hosting (see README).
