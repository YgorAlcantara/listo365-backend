import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';

export const products = Router();

products.get('/', async (_req, res) => {
  const list = await prisma.product.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' } });
  res.json(list.map(p => ({ ...p, price: Number(p.price) })));
});

const UpsertSchema = z.object({
  name: z.string().min(2),
  description: z.string().min(2),
  price: z.number().positive(),
  imageUrl: z.string().url(),
  stock: z.number().int().nonnegative(),
  active: z.boolean().optional().default(true),
});

products.post('/', requireAuth, async (req, res) => {
  const data = UpsertSchema.parse(req.body);
  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const created = await prisma.product.create({ data: { ...data, slug } });
  res.json({ ...created, price: Number(created.price) });
});

products.put('/:id', requireAuth, async (req, res) => {
  const data = UpsertSchema.partial().parse(req.body);
  const updated = await prisma.product.update({ where: { id: req.params.id }, data });
  res.json({ ...updated, price: Number(updated.price) });
});

products.delete('/:id', requireAuth, async (req, res) => {
  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
