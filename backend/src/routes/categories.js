import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound, parse } from '../lib/errors.js';
import { categoryOut } from '../lib/serialize.js';

// Defaults belong to create only: in zod 4 a default inside .partial() would still be applied and
// silently overwrite existing values on PATCH.
const fields = {
  name: z.string().trim().min(1, 'Enter a category name').max(80),
  description: z.string().trim().max(500),
  is_active: z.boolean(),
  sort_order: z.number().int().min(0).max(100000),
};
const createSchema = z.object({
  name: fields.name,
  description: fields.description.default(''),
  is_active: fields.is_active.default(true),
  sort_order: fields.sort_order.default(0),
});
const patchSchema = z.object(fields).partial();

const listSchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

const SELECT = `
  SELECT c.*, (SELECT count(*) FROM items i WHERE i.category_id = c.id) AS item_count
    FROM categories c`;

export function categoriesRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    const q = parse(listSchema, req.query);
    const where = ['c.vendor_id = $1'];
    const params = [req.vendorId];
    if (q.status) where.push(`c.is_active = ${q.status === 'active'}`);
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`c.name ILIKE $${params.length}`);
    }
    const total = await db.query(`SELECT count(*) AS n FROM categories c WHERE ${where.join(' AND ')}`, params);
    params.push(q.per_page, (q.page - 1) * q.per_page);
    const { rows } = await db.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.sort_order, c.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows.map(categoryOut), meta: { page: q.page, per_page: q.per_page, total: total.rows[0].n } });
  });

  router.post('/', async (req, res) => {
    const body = parse(createSchema, req.body);
    const { rows } = await db.query(
      `INSERT INTO categories (vendor_id, name, description, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *, 0 AS item_count`,
      [req.vendorId, body.name, body.description, body.is_active, body.sort_order],
    );
    res.status(201).json({ data: categoryOut(rows[0]) });
  });

  router.get('/:id', async (req, res) => {
    const { rows } = await db.query(`${SELECT} WHERE c.id = $1 AND c.vendor_id = $2`, [req.params.id, req.vendorId]);
    if (!rows[0]) throw notFound('Category');
    res.json({ data: categoryOut(rows[0]) });
  });

  // Only the fields present in the body are changed.
  router.patch('/:id', async (req, res) => {
    const body = parse(patchSchema, req.body);
    const { rows } = await db.query(
      `UPDATE categories SET
         name        = COALESCE($3, name),
         description = COALESCE($4, description),
         is_active   = COALESCE($5, is_active),
         sort_order  = COALESCE($6, sort_order),
         updated_at  = now()
       WHERE id = $1 AND vendor_id = $2
       RETURNING *, (SELECT count(*) FROM items i WHERE i.category_id = categories.id) AS item_count`,
      [req.params.id, req.vendorId, body.name ?? null, body.description ?? null, body.is_active ?? null, body.sort_order ?? null],
    );
    if (!rows[0]) throw notFound('Category');
    res.json({ data: categoryOut(rows[0]) });
  });

  router.delete('/:id', async (req, res) => {
    const used = await db.query(
      `SELECT count(*) AS n FROM items WHERE category_id = $1 AND vendor_id = $2`,
      [req.params.id, req.vendorId],
    );
    if (used.rows[0].n > 0) {
      throw conflict('CATEGORY_NOT_EMPTY', `This category still has ${used.rows[0].n} item(s). Delete or move them first.`);
    }
    const { rowCount } = await db.query(`DELETE FROM categories WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
    if (!rowCount) throw notFound('Category');
    res.status(204).end();
  });

  return router;
}
