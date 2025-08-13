import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/auth';

export const categories = Router();

/** GET /categories -> lista hierárquica (pai + filhos) */
categories.get('/', async (_req, res) => {
  const parents = await prisma.category.findMany({
    where: { parentId: null },
    orderBy: { name: 'asc' },
    include: { children: { orderBy: { name: 'asc' } } },
  });
  res.json(parents);
});

/** POST /categories/seed  (rodar 1x) */
categories.post('/seed', requireAdmin, async (_req, res) => {
  function slugify(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  const ensure = async (name: string, parentId: string | null) => {
    const slug = slugify(name);
    const found = await prisma.category.findFirst({ where: { slug } });
    if (found) return found;
    return prisma.category.create({ data: { name, slug, parentId } });
  };

  // Pai + filhos conforme você pediu
  const floor = await ensure('Floor Care', null);
  await ensure('Floor Finishes', floor.id);
  await ensure('Floor Strippers', floor.id);
  await ensure('Neutral & Specialty Cleaners', floor.id);

  const bath = await ensure('Bathroom Cleaners', null);
  await ensure('Acid Bathroom Cleaners', bath.id);
  await ensure('Non-Acid Bathroom & Bowl Cleaners', bath.id);

  const glass = await ensure('Glass Cleaners', null);
  await ensure('Ready-To-Use on Glass', glass.id);

  const carpet = await ensure('Carpet Care', null);
  await ensure('Pre-Treatment', carpet.id);

  const deg = await ensure('Cleaners/Degreasers', null);
  await ensure('Super Heavy Duty Concentrate', deg.id);

  res.json({ ok: true });
});
