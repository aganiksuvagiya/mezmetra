import { createDb } from './db.js';
import { DEMO, MENU, TEA_POST, TEA_POST_MENU } from './seed.js';
import { toPaise } from './lib/money.js';

// Prices for a demo restaurant, so a real UPI payment during a demo costs almost nothing.
//   npm run demo:prices                       (Tea Post: every dish Rs 1, extras free)
//   npm run demo:prices -- --price 5          (every dish Rs 5)
//   npm run demo:prices -- --restore          (back to the prices written in seed.js)
//   npm run demo:prices -- --email you@x.in   (another restaurant; --restore only knows the two demo restaurants)
// Old orders keep the prices they were placed with.

/** Every dish costs `rupees`; paid extras (a "Large" size ...) become free so a dish stays exactly that price. */
export async function setAllPrices(db, { vendorId, rupees }) {
  return db.tx(async (t) => {
    const items = await t.query(`UPDATE items SET price_paise = $2, updated_at = now() WHERE vendor_id = $1`, [vendorId, toPaise(rupees)]);
    const options = await t.query(
      `UPDATE options SET price_paise = 0
        WHERE price_paise <> 0 AND group_id IN (SELECT g.id FROM option_groups g JOIN items i ON i.id = g.item_id WHERE i.vendor_id = $1)`,
      [vendorId],
    );
    return { items: items.rowCount, options: options.rowCount };
  });
}

/** Puts the prices of a seeded demo menu back (matched by dish, group and option name). */
export async function restorePrices(db, { vendorId, menu }) {
  return db.tx(async (t) => {
    let items = 0;
    let options = 0;
    for (const category of menu) {
      for (const item of category.items) {
        items += (await t.query(`UPDATE items SET price_paise = $3, updated_at = now() WHERE vendor_id = $1 AND name = $2`, [vendorId, item.name, toPaise(item.price)])).rowCount;
        for (const group of item.groups) {
          for (const [name, price] of group.options) {
            options += (
              await t.query(
                `UPDATE options o SET price_paise = $5
                   FROM option_groups g JOIN items i ON i.id = g.item_id
                  WHERE o.group_id = g.id AND i.vendor_id = $1 AND i.name = $2 AND g.name = $3 AND o.name = $4`,
                [vendorId, item.name, group.name, name, toPaise(price)],
              )
            ).rowCount;
          }
        }
      }
    }
    return { items, options };
  });
}

// CLI
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
  const email = String(arg('email', TEA_POST.email)).toLowerCase();
  const db = await createDb();
  try {
    const vendor = (await db.query(`SELECT id, name FROM vendors WHERE lower(email) = $1`, [email])).rows[0];
    if (!vendor) {
      console.error(`No restaurant with the email ${email}.`);
      process.exitCode = 1;
    } else if (args.includes('--restore')) {
      const menu = email === TEA_POST.email.toLowerCase() ? TEA_POST_MENU : email === DEMO.email.toLowerCase() ? MENU : null;
      if (!menu) {
        console.error('--restore only works for the two demo restaurants from seed.js.');
        process.exitCode = 1;
      } else {
        const r = await restorePrices(db, { vendorId: vendor.id, menu });
        console.log(`${vendor.name}: restored ${r.items} dish prices and ${r.options} extras to the seed.js prices.`);
      }
    } else {
      const rupees = Number(arg('price', 1));
      if (!Number.isFinite(rupees) || rupees < 0 || rupees > 100000) {
        console.error('--price must be a number of rupees, like 1 or 5.');
        process.exitCode = 1;
      } else {
        const r = await setAllPrices(db, { vendorId: vendor.id, rupees });
        console.log(`${vendor.name}: ${r.items} dishes now cost Rs ${rupees}, ${r.options} paid extras made free. Run with --restore to undo.`);
      }
    }
  } finally {
    await db.close();
  }
}
