import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { toPaise } from './lib/money.js';

const DEMO_UPI_ID = process.env.SEED_UPI_ID || 'mezmitra.demo@okaxis';

// Demo data for local development and sales demos. Re-running is safe: a vendor that already exists is skipped.
// Change these (or set SEED_EMAIL / SEED_PASSWORD / TEAPOST_PASSWORD) before using the app for real.
export const DEMO = {
  email: process.env.SEED_EMAIL || 'demo@tableseva.local',
  password: process.env.SEED_PASSWORD || 'tableseva-demo-123',
  name: 'Demo Kitchen',
};

export const MENU = [
  {
    category: 'Starters',
    description: 'Small plates to start with.',
    items: [
      { name: 'Paneer Tikka', description: 'Cottage cheese marinated in spiced yoghurt and grilled in the tandoor.', price: 279, featured: true, groups: [] },
      { name: 'Crispy Corn', description: 'Golden fried sweet corn tossed with pepper, salt and spring onion.', price: 199, groups: [] },
      { name: 'Hara Bhara Kabab', description: 'Spinach and green pea patties, pan-seared with a mint chutney.', price: 229, groups: [] },
    ],
  },
  {
    category: 'Pizza',
    description: 'Freshly baked pizzas with premium ingredients.',
    items: [
      {
        name: 'Margherita Pizza',
        description: 'Fresh mozzarella, rich tomato sauce and basil on a crispy hand-tossed crust.',
        price: 499,
        featured: true,
        groups: [
          { name: 'Size', required: true, multi: false, options: [['Regular', 0], ['Large', 150]] },
          { name: 'Extras', required: false, multi: true, options: [['Extra cheese', 60], ['Olives', 40]] },
        ],
      },
      {
        name: 'Pepperoni Pizza',
        description: 'Mozzarella, savoury pepperoni slices and our signature tomato sauce.',
        price: 899,
        diet: 'nonveg',
        groups: [],
      },
    ],
  },
  {
    category: 'Chinese',
    description: 'Noodles, fried rice and stir-fried favourites.',
    items: [
      { name: 'Veg Manchurian', description: 'Crisp vegetable dumplings tossed in a tangy, spicy soy-garlic gravy.', price: 399, groups: [] },
      { name: 'Hakka Noodles', description: 'Wok-tossed noodles with crunchy vegetables and a hint of soy.', price: 249, groups: [] },
      {
        name: 'Veg Fried Rice',
        description: 'Fragrant rice stir-fried with seasonal vegetables.',
        price: 229,
        groups: [{ name: 'Spice level', required: true, multi: false, options: [['Mild', 0], ['Medium', 0], ['Spicy', 0]] }],
      },
    ],
  },
  {
    category: 'Drinks',
    description: 'Hot, cold and everything in between.',
    items: [
      { name: 'Masala Chai', description: 'Strong tea simmered with ginger, cardamom and milk.', price: 40, groups: [] },
      {
        name: 'Cold Coffee',
        description: 'Chilled coffee blended with milk and ice cream.',
        price: 129,
        groups: [{ name: 'Size', required: true, multi: false, options: [['Regular', 0], ['Large', 40]] }],
      },
      { name: 'Fresh Lime Soda', description: 'Lime, soda and mint, sweet or salted.', price: 79, groups: [] },
    ],
  },
  {
    category: 'Desserts',
    description: 'Something sweet to finish.',
    items: [
      { name: 'Gulab Jamun', description: 'Two warm milk-solid dumplings soaked in rose-scented syrup.', price: 99, groups: [] },
      { name: 'Brownie with Ice Cream', description: 'Warm chocolate brownie topped with a scoop of vanilla ice cream.', price: 179, featured: true, diet: 'egg', groups: [] },
    ],
  },
];


// A second demo restaurant for showing MezMitra to a tea cafe: chai, coffee and snacks, with a chai-brown theme.
export const TEA_POST = {
  email: process.env.TEAPOST_EMAIL || 'teapost@tableseva.local',
  password: process.env.TEAPOST_PASSWORD || 'teapost-demo-123',
  name: 'Tea Post',
  taxPercent: 5,
  theme: { primary: '#7a3e1d', accent: '#e8a317' },
};

// Free stock photos from Pexels (credits in DEMO.md), stored in seed-assets/tea-post/<pexels id>.jpg.
// Seeding attaches them so a fresh database (Aiven, a new host) gets the same Tea Post as the local one.
const TEA_POST_PHOTOS = {
  'Cutting Chai': '34324342',
  'Masala Chai': '37186989',
  'Adrak Chai': '29650995',
  'Elaichi Chai': '20270270',
  'Kesar Chai': '12419206',
  'Lemon Tea': '10307718',
  'Filter Coffee': '16128085',
  Cappuccino: '6747870',
  'Cold Coffee': '4869290',
  'Hot Chocolate': '5264675',
  'Bun Maska': '15997563',
  'Samosa (2 pcs)': '5031949',
  'Vada Pav': '17433353',
  'Khari Biscuit': '31909870',
  'Masala Maggi': '8108045',
  'Veg Sandwich': '14410236',
  'Cheese Sandwich': '13689802',
  'Pakora Plate': '30174012',
  'Masala Chaas': '8489749',
  'Fresh Lime Soda': '4045205',
};

const SUGAR = { name: 'Sugar', required: false, multi: false, options: [['Regular', 0], ['Less sugar', 0], ['No sugar', 0]] };

export const TEA_POST_MENU = [
  {
    category: 'Chai',
    description: 'Brewed fresh, all day.',
    items: [
      { name: 'Cutting Chai', description: 'Half a glass of strong, sweet tea, the way Mumbai likes it.', price: 20, featured: true, groups: [SUGAR] },
      {
        name: 'Masala Chai',
        description: 'Our signature blend with ginger, cardamom and a pinch of masala.',
        price: 35,
        featured: true,
        groups: [{ name: 'Size', required: true, multi: false, options: [['Regular', 0], ['Large', 15]] }, SUGAR],
      },
      { name: 'Adrak Chai', description: 'Fresh ginger tea to wake you up.', price: 30, groups: [SUGAR] },
      { name: 'Elaichi Chai', description: 'Milk tea scented with crushed cardamom.', price: 35, groups: [SUGAR] },
      { name: 'Kesar Chai', description: 'Saffron-infused tea, rich and fragrant.', price: 55, featured: true, groups: [SUGAR] },
      { name: 'Lemon Tea', description: 'Hot black tea with lemon and a drizzle of honey.', price: 30, groups: [] },
    ],
  },
  {
    category: 'Coffee & More',
    description: 'For the coffee people.',
    items: [
      { name: 'Filter Coffee', description: 'Strong South-Indian style decoction with frothy milk.', price: 40, groups: [SUGAR] },
      { name: 'Cappuccino', description: 'Espresso, steamed milk and a deep layer of foam.', price: 90, groups: [] },
      {
        name: 'Cold Coffee',
        description: 'Chilled coffee blended with milk and ice cream.',
        price: 120,
        groups: [{ name: 'Size', required: true, multi: false, options: [['Regular', 0], ['Large', 30]] }],
      },
      { name: 'Hot Chocolate', description: 'Thick, velvety chocolate, served steaming.', price: 110, groups: [] },
    ],
  },
  {
    category: 'Snacks',
    description: 'The best company for a cup of chai.',
    items: [
      { name: 'Bun Maska', description: 'Soft bun with a generous layer of butter. Dip it in your chai.', price: 35, featured: true, groups: [] },
      { name: 'Samosa (2 pcs)', description: 'Crisp pastry filled with spiced potato and peas, served with chutney.', price: 30, groups: [] },
      { name: 'Vada Pav', description: "Mumbai's favourite: a spicy potato fritter tucked in a pav with chutneys.", price: 25, groups: [] },
      { name: 'Khari Biscuit', description: 'Flaky, buttery biscuits, made for dunking.', price: 20, groups: [] },
      {
        name: 'Masala Maggi',
        description: 'Maggi noodles tossed with onion, tomato and our house masala.',
        price: 60,
        groups: [{ name: 'Extras', required: false, multi: true, options: [['Extra cheese', 20], ['Extra masala', 0]] }],
      },
      { name: 'Veg Sandwich', description: 'Grilled sandwich with cucumber, tomato, onion and green chutney.', price: 70, groups: [] },
      { name: 'Cheese Sandwich', description: 'Grilled sandwich loaded with melted cheese.', price: 90, groups: [] },
      { name: 'Pakora Plate', description: 'Crunchy onion and potato fritters with mint chutney.', price: 60, groups: [] },
    ],
  },
  {
    category: 'Cold Drinks',
    description: 'Something cool for a warm day.',
    items: [
      { name: 'Masala Chaas', description: 'Spiced buttermilk with roasted cumin and fresh mint.', price: 30, groups: [] },
      {
        name: 'Fresh Lime Soda',
        description: 'Lime, soda and mint.',
        price: 50,
        groups: [{ name: 'Taste', required: true, multi: false, options: [['Sweet', 0], ['Salted', 0], ['Sweet & salted', 0]] }],
      },
    ],
  },
];

const TEA_POST_TABLES = [
  ['T-01', 4, 'Indoor'],
  ['T-02', 4, 'Indoor'],
  ['T-03', 2, 'Indoor'],
  ['T-04', 4, 'Outdoor'],
  ['T-05', 6, 'Outdoor'],
];

const DEMO_TABLES = [
  ['T-01', 4, 'Indoor'],
  ['T-02', 2, 'Indoor'],
  ['T-03', 6, 'Outdoor'],
];

const PHOTO_DIR = new URL('../seed-assets/tea-post/', import.meta.url);

/** The photo file for a seed item, or null when there is none (the menu then simply shows its themed placeholder). */
function readPhoto(id) {
  if (!id) return null;
  try {
    return fs.readFileSync(new URL(`${id}.jpg`, PHOTO_DIR));
  } catch {
    return null;
  }
}

/** Create one restaurant with its menu and tables. Skips quietly when the email is already registered. */
async function seedVendor(db, def, { log }) {
  const existing = await db.query(`SELECT id FROM vendors WHERE lower(email) = lower($1)`, [def.email]);
  if (existing.rowCount > 0) {
    log(`[seed] ${def.name} (${def.email}) already exists, nothing to do`);
    return false;
  }
  const hash = await bcrypt.hash(def.password, 10);
  await db.tx(async (t) => {
    const vendor = await t.query(
      `INSERT INTO vendors (name, email, password_hash, tax_percent, theme_primary, theme_accent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [def.name, def.email, hash, def.taxPercent ?? 0, def.theme?.primary ?? '#2f6f62', def.theme?.accent ?? '#e8872a'],
    );
    const vendorId = vendor.rows[0].id;
    // Demo restaurants take UPI out of the box. The UPI ID is a placeholder: replace it in Admin -> Payments with one you own
    // (and that is not the account you pay from) before trying a real payment.
    await t.query(`INSERT INTO vendor_payment_settings (vendor_id, upi_enabled, upi_id) VALUES ($1, true, $2)`, [vendorId, def.upiId ?? DEMO_UPI_ID]);

    for (const [ci, cat] of def.menu.entries()) {
      const c = await t.query(`INSERT INTO categories (vendor_id, name, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`, [
        vendorId,
        cat.category,
        cat.description,
        ci,
      ]);
      for (const item of cat.items) {
        const i = await t.query(
          `INSERT INTO items (vendor_id, category_id, name, description, price_paise, is_featured, diet)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          // The demo menus are vegetarian unless an item says otherwise (diet: 'egg' | 'nonveg' | 'jain').
          [vendorId, c.rows[0].id, item.name, item.description, toPaise(item.price), Boolean(item.featured), item.diet ?? 'veg'],
        );
        const photo = readPhoto(def.photos?.[item.name]);
        if (photo) {
          await t.query(`INSERT INTO item_photos (item_id, mime, data) VALUES ($1, 'image/jpeg', $2)`, [i.rows[0].id, photo]);
          await t.query(`UPDATE items SET has_photo = true, photo_version = 1 WHERE id = $1`, [i.rows[0].id]);
        }
        for (const [gi, g] of item.groups.entries()) {
          const grp = await t.query(
            `INSERT INTO option_groups (item_id, name, multi_select, required, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [i.rows[0].id, g.name, g.multi, g.required, gi],
          );
          for (const [oi, [name, price]] of g.options.entries()) {
            await t.query(`INSERT INTO options (group_id, name, price_paise, sort_order) VALUES ($1, $2, $3, $4)`, [
              grp.rows[0].id,
              name,
              toPaise(price),
              oi,
            ]);
          }
        }
      }
    }

    for (const [number, capacity, area] of def.tables) {
      await t.query(`INSERT INTO dining_tables (vendor_id, number, capacity, area) VALUES ($1, $2, $3, $4)`, [vendorId, number, capacity, area]);
    }
  });
  log(`[seed] created ${def.name} (${def.email}) with its menu and ${def.tables.length} tables`);
  return true;
}

/** Seeds every demo restaurant. Resolves to true when at least one was created. */
export async function seed(db, { log = console.log } = {}) {
  const demo = await seedVendor(db, { ...DEMO, menu: MENU, tables: DEMO_TABLES }, { log });
  const tea = await seedVendor(db, { ...TEA_POST, menu: TEA_POST_MENU, tables: TEA_POST_TABLES, photos: TEA_POST_PHOTOS }, { log });
  return demo || tea;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const db = await createDb();
  try {
    await migrate(db);
    await seed(db);
  } finally {
    await db.close();
  }
}
