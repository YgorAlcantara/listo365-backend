import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const promotions = Router();

promotions.get('/', async (_req, res) => {
  const now = new Date();
  const list = await prisma.promotion.findMany({
    where: { active: true, startsAt: { lte: now }, endsAt: { gte: now } },
    include: { product: true },
    orderBy: { startsAt: 'desc' },
  });
  res.json(list.map(p => ({ ...p, product: { ...p.product, price: Number(p.product.price) } })));
});
