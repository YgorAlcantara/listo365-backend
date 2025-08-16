import { Router } from "express";
import { prisma } from "../lib/prisma";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { requireAdmin } from "../middleware/auth";

export const products = Router();

/** helper: aceita http(s) OU caminho absoluto iniciando por "/" */
const urlish = z
  .string()
  .refine(
    (v) => /^https?:\/\//i.test(v) || v.startsWith("/"),
    'Must be an http(s) URL or a path starting with "/"'
  );

// --- helper p/ checar se é admin quando ?all=1 ---
function isAdminFromReq(req: any): boolean {
  try {
    const h = req.headers?.authorization || "";
    if (!h.startsWith("Bearer ")) return false;
    const token = h.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
    return (decoded?.role ?? "USER") === "ADMIN";
  } catch {
    return false;
  }
}

/** calcula melhor promoção ativa (agora) e preço final */
function computeSale(p: any) {
  const now = new Date();
  const actives = (p.promotions || []).filter(
    (pr: any) =>
      pr.active &&
      new Date(pr.startsAt) <= now &&
      now <= new Date(pr.endsAt) &&
      (pr.percentOff || pr.priceOff)
  );

  if (!actives.length) return null;

  // escolhe a de maior desconto efetivo
  const base = Number(p.price);
  let best: any = null;
  let bestPrice = base;

  for (const pr of actives) {
    let newPrice = base;
    if (pr.percentOff) newPrice = base * (1 - pr.percentOff / 100);
    if (pr.priceOff) newPrice = Math.min(newPrice, base - Number(pr.priceOff));
    if (newPrice < bestPrice) {
      bestPrice = Math.max(0, Number(newPrice.toFixed(2)));
      best = pr;
    }
  }

  if (!best || bestPrice >= base) return null;
  return {
    title: best.title,
    percentOff: best.percentOff ?? undefined,
    priceOff: best.priceOff ? Number(best.priceOff) : undefined,
    startsAt: best.startsAt,
    endsAt: best.endsAt,
    salePrice: bestPrice,
  };
}

/** GET — pública; ?q, ?sort, e ?all=1 (apenas ADMIN)  */
products.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const sortParam = String(req.query.sort || "sortOrder");
  const allFlag = String(req.query.all || "0") === "1";
  const isAdmin = allFlag && isAdminFromReq(req);

  const where: any = {};
  if (!isAdmin) where.active = true;

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
    ];
  }

  const ORDER_MAP = {
    name_asc: { name: "asc" as const },
    name_desc: { name: "desc" as const },
    price_asc: { price: "asc" as const },
    price_desc: { price: "desc" as const },
    sortOrder: { sortOrder: "asc" as const },
  } as const;

  const orderBy =
    ORDER_MAP[sortParam as keyof typeof ORDER_MAP] ?? ORDER_MAP.sortOrder;

  const list = await prisma.product.findMany({
    where,
    orderBy: [orderBy, { createdAt: "desc" as const }],
    include: {
      images: { orderBy: { sortOrder: "asc" as const } },
      categories: {
        include: { category: { include: { parent: true } } },
        take: 1,
      },
      promotions: true, // para calcular sale
    },
  });

  res.json(
    list.map((p: any) => {
      const firstCat = p.categories[0]?.category ?? null;
      const sale = computeSale(p);
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
        sale, // { salePrice, percentOff/priceOff, title, startsAt, endsAt } | null
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
products.post("/", requireAdmin, async (req, res) => {
  const data = Upsert.parse(req.body);
  const slug = data.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

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
      imageUrl: data.imageUrl ?? "",
      sortOrder: 0,
    },
  });

  if (data.categoryId) {
    await prisma.productCategory.create({
      data: { productId: created.id, categoryId: data.categoryId },
    });
  }

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
      images: { orderBy: { sortOrder: "asc" as const } },
      categories: {
        include: { category: { include: { parent: true } } },
        take: 1,
      },
      promotions: true,
    },
  });

  const firstCat = full?.categories[0]?.category ?? null;
  const sale = computeSale(full);

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
    sale,
  });
});

// Atualizar (ADMIN)
products.put("/:id", requireAdmin, async (req, res) => {
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
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  await prisma.product.update({ where: { id }, data: patch });

  if (data.categoryId !== undefined) {
    await prisma.productCategory.deleteMany({ where: { productId: id } });
    if (data.categoryId) {
      await prisma.productCategory.create({
        data: { productId: id, categoryId: data.categoryId },
      });
    }
  }

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
      images: { orderBy: { sortOrder: "asc" as const } },
      categories: {
        include: { category: { include: { parent: true } } },
        take: 1,
      },
      promotions: true,
    },
  });

  const firstCat = full?.categories[0]?.category ?? null;
  const sale = computeSale(full);

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
    sale,
  });
});

// Deletar (ADMIN) — seguro: arquiva se houver pedidos
products.delete("/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const usage = await prisma.orderItem.count({ where: { productId: id } });

    if (usage > 0) {
      await prisma.product.update({ where: { id }, data: { active: false } });
      return res.status(200).json({
        ok: true,
        archived: true,
        message:
          "Product is linked to orders and was archived (disabled) instead of deleted.",
      });
    }

    await prisma.$transaction([
      prisma.productImage.deleteMany({ where: { productId: id } }),
      prisma.productCategory.deleteMany({ where: { productId: id } }),
      prisma.promotion.deleteMany({ where: { productId: id } }),
      prisma.product.delete({ where: { id } }),
    ]);

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("delete product failed", err);
    return res.status(500).json({ error: "delete_failed" });
  }
});

// Exclusão definitiva explícita — só se NÃO houver pedidos
products.delete("/:id/hard", requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const usage = await prisma.orderItem.count({ where: { productId: id } });
    if (usage > 0) {
      return res.status(409).json({
        error: "in_use",
        message: "This product has related orders. Archive it instead.",
      });
    }
    await prisma.$transaction([
      prisma.productImage.deleteMany({ where: { productId: id } }),
      prisma.productCategory.deleteMany({ where: { productId: id } }),
      prisma.promotion.deleteMany({ where: { productId: id } }),
      prisma.product.delete({ where: { id } }),
    ]);
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("hard delete failed", err);
    return res.status(500).json({ error: "hard_delete_failed" });
  }
});

// Ordenação (ADMIN)
products.patch("/:id/sort-order", requireAdmin, async (req, res) => {
  const body = z.object({ sortOrder: z.number().int() }).parse(req.body);
  await prisma.product.update({
    where: { id: req.params.id },
    data: { sortOrder: body.sortOrder },
  });
  res.json({ ok: true });
});

// Arquivar / Desarquivar (ADMIN)
products.patch("/:id/archive", requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await prisma.product.update({ where: { id }, data: { active: false } });
    return res.json({ ok: true });
  } catch (err) {
    console.error("archive product failed", err);
    return res.status(500).json({ error: "archive_failed" });
  }
});

products.patch("/:id/unarchive", requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await prisma.product.update({ where: { id }, data: { active: true } });
    return res.json({ ok: true });
  } catch (err) {
    console.error("unarchive product failed", err);
    return res.status(500).json({ error: "unarchive_failed" });
  }
});

// Agendar/atualizar promoção (sale) — percentOff OU priceOff
products.put("/:id/sale", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const Body = z
    .object({
      title: z.string().min(1).max(80).default("Sale"),
      description: z.string().max(300).optional(),
      percentOff: z.number().int().min(1).max(90).optional(),
      priceOff: z.number().positive().optional(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      active: z.boolean().default(true),
    })
    .refine((b) => !!b.percentOff || !!b.priceOff, {
      message: "Provide percentOff or priceOff",
    });

  const body = Body.parse(req.body);

  // simples: apaga promoções ativas colidentes e cria uma nova
  await prisma.promotion.deleteMany({ where: { productId: id, active: true } });

  const created = await prisma.promotion.create({
    data: {
      productId: id,
      title: body.title,
      description: body.description,
      percentOff: body.percentOff ?? null,
      priceOff: body.priceOff ?? null,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      active: body.active,
    },
  });

  res.json({
    ok: true,
    promotion: {
      id: created.id,
      title: created.title,
      percentOff: created.percentOff ?? undefined,
      priceOff: created.priceOff ? Number(created.priceOff) : undefined,
      startsAt: created.startsAt,
      endsAt: created.endsAt,
      active: created.active,
    },
  });
});
