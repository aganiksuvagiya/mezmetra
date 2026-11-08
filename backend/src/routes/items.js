import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError, notFound, parse } from '../lib/errors.js';
import { itemOut, loadOptionGroups } from '../lib/serialize.js';
import { toPaise } from '../lib/money.js';
import { detectImageMime } from '../lib/image.js';

const optionSchema = z.object({
  name: z.string().trim().min(1, 'Option name is required').max(80),
  price: z.number().min(0).max(100000).default(0),
});
const groupSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(80),
  multi_select: z.boolean().default(false),
  required: z.boolean().default(false),
  options: z.array(optionSchema).min(1, 'Add at least one option to each group').max(30),
});

// Defaults belong to create only (see categories.js for why).
const fields = {
  category_id: z.number().int().positive(),
  name: z.string().trim().min(1, 'Enter an item name').max(120),
  description: z.string().trim().max(1000),
  price: z.number().min(0, 'Price cannot be negative').max(1_000_000),
  is_active: z.boolean(),
  is_featured: z.boolean(),
  is_sold_out: z.boolean(),
  option_groups: z.array(groupSchema).max(10),
};
const createSchema = z.object({
  category_id: fields.category_id,
  name: fields.name,
  description: fields.description.default(''),
  price: fields.price,
  is_active: fields.is_active.default(true),
  is_featured: fields.is_featured.default(false),
  is_sold_out: fields.is_sold_out.default(false),
  option_groups: fields.option_groups.default([]),
});
const patchSchema = z.object(fields).partial();

const listSchema = z.object({
  category_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'inactive', 'sold_out']).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});

const SELECT = `
  SELECT i.*, c.name AS category_name
    FROM items i JOIN categories c ON c.id = i.category_id`;

const MAX_PHOTO_BYTES = 512 * 1024;

async function replaceOptionGroups(t, itemId, groups) {
  await t.query(`DELETE FROM option_groups WHERE item_id = $1`, [itemId]);
  for (const [gi, g] of groups.entries()) {
    const { rows } = await t.query(
      `INSERT INTO option_groups (item_id, name, multi_select, required, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [itemId, g.name, g.multi_select, g.required, gi],
    );
    for (const [oi, o] of g.options.entries()) {
      await t.query(`INSERT INTO options (group_id, name, price_paise, sort_order) VALUES ($1, $2, $3, $4)`, [
        rows[0].id,
        o.name,
        toPaise(o.price),
        oi,
      ]);
    }
  }
}

export function itemsRouter(db) {
  const router = Router();

  async function loadOne(q, id, vendorId) {
    const { rows } = await q.query(`${SELECT} WHERE i.id = $1 AND i.vendor_id = $2`, [id, vendorId]);
    if (!rows[0]) throw notFound('Item');
    const groups = await loadOptionGroups(q, [rows[0].id]);
    return itemOut(rows[0], groups.get(rows[0].id) ?? []);
  }

  async function assertCategory(q, categoryId, vendorId) {
    const { rowCount } = await q.query(`SELECT 1 FROM categories WHERE id = $1 AND vendor_id = $2`, [categoryId, vendorId]);
    if (!rowCount) throw new HttpError(400, 'VALIDATION_ERROR', 'category_id: Choose one of your categories');
  }

  router.get('/', async (req, res) => {
    const q = parse(listSchema, req.query);
    const where = ['i.vendor_id = $1'];
    const params = [req.vendorId];
    if (q.category_id) {
      params.push(q.category_id);
      where.push(`i.category_id = $${params.length}`);
    }
    if (q.status === 'sold_out') where.push('i.is_sold_out');
    else if (q.status) where.push(`i.is_active = ${q.status === 'active'}`);
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(i.name ILIKE $${params.length} OR i.description ILIKE $${params.length})`);
    }
    const total = await db.query(`SELECT count(*) AS n FROM items i WHERE ${where.join(' AND ')}`, params);
    params.push(q.per_page, (q.page - 1) * q.per_page);
    const { rows } = await db.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const groups = await loadOptionGroups(db, rows.map((r) => r.id));
    // How many dishes are sold out in the whole menu (not just on this page): drives the "all back in stock" button.
    const soldOut = await db.query(`SELECT count(*) AS n FROM items WHERE vendor_id = $1 AND is_sold_out`, [req.vendorId]);
    res.json({
      data: rows.map((r) => itemOut(r, groups.get(r.id) ?? [])),
      meta: { page: q.page, per_page: q.per_page, total: total.rows[0].n, sold_out: Number(soldOut.rows[0].n) },
    });
  });

  router.post('/', async (req, res) => {
    const body = parse(createSchema, req.body);
    const item = await db.tx(async (t) => {
      await assertCategory(t, body.category_id, req.vendorId);
      const { rows } = await t.query(
        `INSERT INTO items (vendor_id, category_id, name, description, price_paise, is_active, is_featured, is_sold_out)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [req.vendorId, body.category_id, body.name, body.description, toPaise(body.price), body.is_active, body.is_featured, body.is_sold_out],
      );
      await replaceOptionGroups(t, rows[0].id, body.option_groups);
      return loadOne(t, rows[0].id, req.vendorId);
    });
    res.status(201).json({ data: item });
  });

  // End of the day: every dish is back in stock. (Declared before the "/:id" routes.)
  router.post('/restock', async (req, res) => {
    const { rowCount } = await db.query(`UPDATE items SET is_sold_out = false, updated_at = now() WHERE vendor_id = $1 AND is_sold_out`, [req.vendorId]);
    res.json({ data: { restocked: rowCount } });
  });

  router.get('/:id', async (req, res) => {
    res.json({ data: await loadOne(db, req.params.id, req.vendorId) });
  });

  router.patch('/:id', async (req, res) => {
    const body = parse(patchSchema, req.body);
    const item = await db.tx(async (t) => {
      if (body.category_id !== undefined) await assertCategory(t, body.category_id, req.vendorId);
      const { rowCount } = await t.query(
        `UPDATE items SET
           category_id = COALESCE($3, category_id),
           name        = COALESCE($4, name),
           description = COALESCE($5, description),
           price_paise = COALESCE($6, price_paise),
           is_active   = COALESCE($7, is_active),
           is_featured = COALESCE($8, is_featured),
           is_sold_out = COALESCE($9, is_sold_out),
           updated_at  = now()
         WHERE id = $1 AND vendor_id = $2`,
        [
          req.params.id,
          req.vendorId,
          body.category_id ?? null,
          body.name ?? null,
          body.description ?? null,
          body.price === undefined ? null : toPaise(body.price),
          body.is_active ?? null,
          body.is_featured ?? null,
          body.is_sold_out ?? null,
        ],
      );
      if (!rowCount) throw notFound('Item');
      if (body.option_groups !== undefined) await replaceOptionGroups(t, Number(req.params.id), body.option_groups);
      return loadOne(t, req.params.id, req.vendorId);
    });
    res.json({ data: item });
  });

  router.delete('/:id', async (req, res) => {
    const { rowCount } = await db.query(`DELETE FROM items WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
    if (!rowCount) throw notFound('Item');
    res.status(204).end();
  });

  // Photo upload: send the raw image bytes as the body with Content-Type image/jpeg|png|webp.
  // Photos are kept in Postgres (bytea), so the app has no disk or object-storage dependency; the cap
  // keeps a small free database healthy. The admin UI downsizes images before uploading.
  router.put(
    '/:id/photo',
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_PHOTO_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'Send a JPEG, PNG or WebP image as the request body');
      }
      const mime = detectImageMime(req.body);
      if (!mime) throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'File is not a valid JPEG, PNG or WebP image');
      await db.tx(async (t) => {
        const own = await t.query(`SELECT 1 FROM items WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
        if (!own.rowCount) throw notFound('Item');
        await t.query(
          `INSERT INTO item_photos (item_id, mime, data) VALUES ($1, $2, $3)
           ON CONFLICT (item_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
          [req.params.id, mime, req.body],
        );
        await t.query(`UPDATE items SET has_photo = true, photo_version = photo_version + 1, updated_at = now() WHERE id = $1`, [
          req.params.id,
        ]);
      });
      res.json({ data: await loadOne(db, req.params.id, req.vendorId) });
    },
  );

  router.delete('/:id/photo', async (req, res) => {
    await db.tx(async (t) => {
      const own = await t.query(`SELECT 1 FROM items WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
      if (!own.rowCount) throw notFound('Item');
      await t.query(`DELETE FROM item_photos WHERE item_id = $1`, [req.params.id]);
      await t.query(`UPDATE items SET has_photo = false, photo_version = photo_version + 1, updated_at = now() WHERE id = $1`, [
        req.params.id,
      ]);
    });
    res.json({ data: await loadOne(db, req.params.id, req.vendorId) });
  });

  return router;
}
