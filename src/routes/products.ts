import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';

export const products = Router();

/** helper: aceita http(s) OU caminho absoluto iniciando por "/" */
const urlish = z
  .string()
  .refine(
    (v) => /^https?:\/\//i.test(v) || v.startsWith('/'),
    'Must be an http(s) URL or a path starting with "/"'
  );

/** GET pública com imagens e categoria (1) */
products.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const sortParam = String(req.query.sort || 'sortOrder');

  const where: any = { active: true };
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  // Mapa tipado com literais 'asc' | 'desc'
  const ORDER_MAP = {
    name_asc:   { name: 'asc' as const },
    name_desc:  { name: 'desc' as const },
    price_asc:  { price: 'asc' as const },
    price_desc: { price: 'desc' as const },
    sortOrder:  { sortOrder: 'asc' as const },
  } as const;

  const orderBy = ORDER_MAP[sortParam as keyof typeof ORDER_MAP] ?? ORDER_MAP.sortOrder;

  const list = await prisma.product.findMany({
    where,
    orderBy: [orderBy, { createdAt: 'desc' as const }],
    include: {
      images: { orderBy: { sortOrder: 'asc' as const } },
      categories: {
        include: { category: { include: { parent: true } } },
        take: 1, // 1 categoria (filha)
      },
    },
  });

  res.json(
    list.map((p: any) => {
      const firstCat = p.categories[0]?.category ?? null;
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        price: Number(p.price),
        active: p.active,
        stock: p.stock,
        sortOrder: p.sortOrder,
        packageSize: p.packageSize,
        pdfUrl: p.pdfUrl,
        category: firstCat
          ? {
              id: firstCat.id,
              name: firstCat.name,
              slug: firstCat.slug,
              parent: firstCat.parent
                ? {
                    id: firstCat.parent.id,
                    name: firstCat.parent.name,
                    slug: firstCat.parent.slug,
                  }
                : null,
            }
          : null,
        images: (p.images as any[]).map((im: any) => im.url),
        imageUrl: p.images[0]?.url || p.imageUrl || null,
      };
    })
  );
});

const Upsert = z.object({
  name: z.string().min(2),
  description: z.string().min(2),
  price: z.number().positive(),
  stock: z.number().int().nonnegative(),
  active: z.boolean().optional().default(true),
  packageSize: z.string().min(1).max(100).optional(),
  pdfUrl: urlish.optional(),
  images: z.array(urlish).min(1).max(10).optional(),
  categoryId: z.string().min(1).optional(), // id da categoria filha
  imageUrl: urlish.optional(), // fallback
});

// Criar (ADMIN)
products.post('/', requireAdmin, async (req, res) => {
  const data = Upsert.parse(req.body);
  const slug = data.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const created = await prisma.product.create({
    data: {
      name: data.name,
      slug,
      description: data.description,
      price: data.price,
      stock: data.stock,
      active: data.active ?? true,
      packageSize: data.packageSize,
      pdfUrl: data.pdfUrl,
      imageUrl: data.imageUrl ?? '',
      sortOrder: 0,
    },
  });

  // Categoria única (filha)
  if (data.categoryId) {
    await prisma.productCategory.create({
      data: { productId: created.id, categoryId: data.categoryId },
    });
  }

  // Imagens
  if (data.images?.length) {
    await prisma.productImage.createMany({
      data: data.images.map((url, i) => ({
        productId: created.id,
        url,
        sortOrder: (i + 1) * 10,
      })),
    });
  }

  const full = await prisma.product.findUnique({
    where: { id: created.id },
    include: {
      images: { orderBy: { sortOrder: 'asc' as const } },
      categories: {
        include: { category: { include: { parent: true } } },
        take: 1,
      },
    },
  });

  const firstCat = full?.categories[0]?.category ?? null;

  res.status(201).json({
    id: full!.id,
    name: full!.name,
    slug: full!.slug,
    description: full!.description,
    price: Number(full!.price),
    active: full!.active,
    stock: full!.stock,
    sortOrder: full!.sortOrder,
    packageSize: full!.packageSize,
    pdfUrl: full!.pdfUrl,
    category: firstCat
      ? {
          id: firstCat.id,
          name: firstCat.name,
          slug: firstCat.slug,
          parent: firstCat.parent
            ? {
                id: firstCat.parent.id,
                name: firstCat.parent.name,
                slug: firstCat.parent.slug,
              }
            : null,
        }
      : null,
    images: (full!.images as any[]).map((im: any) => im.url),
    imageUrl: full!.images[0]?.url || full!.imageUrl || null,
  });
});

// Atualizar (ADMIN)
products.put('/:id', requireAdmin, async (req, res) => {
  const data = Upsert.partial().parse(req.body);
  const id = req.params.id;

  const patch: any = {
    description: data.description,
    price: data.price,
    stock: data.stock,
    active: data.active,
    packageSize: data.packageSize,
    pdfUrl: data.pdfUrl,
    imageUrl: data.imageUrl,
  };
  if (data.name) {
    patch.name = data.name;
    patch.slug = data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  await prisma.product.update({ where: { id }, data: patch });

  // Categoria: substitui a existente por 1
  if (data.categoryId !== undefined) {
    await prisma.productCategory.deleteMany({ where: { productId: id } });
    if (data.categoryId) {
      await prisma.productCategory.create({
        data: { productId: id, categoryId: data.categoryId },
      });
    }
  }

  // Imagens: substitui
  if (data.images) {
    await prisma.productImage.deleteMany({ where: { productId: id } });
    if (data.images.length) {
      await prisma.productImage.createMany({
        data: data.images.map((url, i) => ({
          productId: id,
          url,
          sortOrder: (i + 1) * 10,
        })),
      });
    }
  }

  const full = await prisma.product.findUnique({
    where: { id },
    include: {
      images: { orderBy: { sortOrder: 'asc' as const } },
      categories: {
        include: { category: { include: { parent: true } } },
        take: 1,
      },
    },
  });

  const firstCat = full?.categories[0]?.category ?? null;

  res.json({
    id: full!.id,
    name: full!.name,
    slug: full!.slug,
    description: full!.description,
    price: Number(full!.price),
    active: full!.active,
    stock: full!.stock,
    sortOrder: full!.sortOrder,
    packageSize: full!.packageSize,
    pdfUrl: full!.pdfUrl,
    category: firstCat
      ? {
          id: firstCat.id,
          name: firstCat.name,
          slug: firstCat.slug,
          parent: firstCat.parent
            ? {
                id: firstCat.parent.id,
                name: firstCat.parent.name,
                slug: firstCat.parent.slug,
              }
            : null,
        }
      : null,
    images: (full!.images as any[]).map((im: any) => im.url),
    imageUrl: full!.images[0]?.url || full!.imageUrl || null,
  });
});

// Deletar (ADMIN)
products.delete('/:id', requireAdmin, async (req, res) => {
  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// Ordenação (ADMIN)
products.patch('/:id/sort-order', requireAdmin, async (req, res) => {
  const body = z.object({ sortOrder: z.number().int() }).parse(req.body);
  await prisma.product.update({
    where: { id: req.params.id },
    data: { sortOrder: body.sortOrder },
  });
  res.json({ ok: true });
});
