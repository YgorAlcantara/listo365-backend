// src/routes/products.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { requireAdmin } from "../middleware/auth";

export const products = Router();

/** ping simples para debug */
products.get("/_ping", (_req, res) =>
  res.json({ ok: true, scope: "products-router" })
);

/** Toggle de recurso para (des)ativar escrita dos campos de visibilidade
 *  Coloque FEATURE_VISIBILITY_FLAGS=1 no ambiente quando o schema tiver as colunas.
 */
const FEATURE_VIS = process.env.FEATURE_VISIBILITY_FLAGS === "1";

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
    const role = decoded?.role ?? "USER";
    const id = decoded?.sub ?? decoded?.uid; // compat
    return !!id && role === "ADMIN";
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

/** serialização respeitando flags de visibilidade (no público) */
function serializeProduct(p: any, isAdmin: boolean) {
  const firstCat = p.categories?.[0]?.category ?? null;
  const sale = p.sale ?? computeSale(p);

  // Se o Client não tiver as colunas, use defaults seguros
  const visPrice = (p as any).visiblePrice ?? false;
  const visPkg = (p as any).visiblePackageSize ?? true;
  const visPdf = (p as any).visiblePdf ?? true;
  const visImgs = (p as any).visibleImages ?? true;
  const visDesc = (p as any).visibleDescription ?? true;

  const show = (flag: boolean) => (isAdmin ? true : !!flag);

  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: show(visDesc) ? p.description : undefined,
    price: show(visPrice) ? Number(p.price) : undefined,
    active: p.active,
    stock: p.stock,
    sortOrder: p.sortOrder,
    packageSize: show(visPkg) ? p.packageSize : undefined,
    pdfUrl: show(visPdf) ? p.pdfUrl : undefined,
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
    images: show(visImgs) ? (p.images as any[]).map((im: any) => im.url) : [],
    imageUrl: show(visImgs) ? p.images?.[0]?.url || p.imageUrl || null : null,
    sale, // { salePrice, percentOff/priceOff, ... } | null
    visibility: isAdmin
      ? {
          price: visPrice,
          packageSize: visPkg,
          pdf: visPdf,
          images: visImgs,
          description: visDesc,
        }
      : undefined,
  };
}

/** =========================
 *  GET "/" (lista pública; ?q, ?sort; ?all=1 só p/ ADMIN)
 *  ========================= */
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
      promotions: true,
    },
  });

  res.json(
    list.map((p: any) =>
      serializeProduct({ ...p, sale: computeSale(p) }, isAdmin)
    )
  );
});

/** payload de criação/edição */
const Upsert = z.object({
  name: z.string().min(2),
  description: z.string().min(2),
  price: z.number().positive(),
  stock: z.number().int().nonnegative(),
  active: z.boolean().optional().default(true),
  packageSize: z.string().min(1).max(100).optional(),
  pdfUrl: urlish.optional(),
  images: z.array(urlish).min(1).max(10).optional(),
  categoryId: z.string().min(1).optional(),
  imageUrl: urlish.optional(),

  // flags de visibilidade (opcionais no create/update)
  visiblePrice: z.boolean().optional(),
  visiblePackageSize: z.boolean().optional(),
  visiblePdf: z.boolean().optional(),
  visibleImages: z.boolean().optional(),
  visibleDescription: z.boolean().optional(),
});

/** Criar (ADMIN) */
products.post("/", requireAdmin, async (req, res) => {
  const data = Upsert.parse(req.body);
  const slug = data.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  // use 'any' para não travar tipagem quando o Client não tem as colunas
  const createData: any = {
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
  };

  if (FEATURE_VIS) {
    if (data.visiblePrice !== undefined) createData.visiblePrice = data.visiblePrice;
    if (data.visiblePackageSize !== undefined)
      createData.visiblePackageSize = data.visiblePackageSize;
    if (data.visiblePdf !== undefined) createData.visiblePdf = data.visiblePdf;
    if (data.visibleImages !== undefined) createData.visibleImages = data.visibleImages;
    if (data.visibleDescription !== undefined)
      createData.visibleDescription = data.visibleDescription;
  }

  const created = await prisma.product.create({ data: createData });

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

  res
    .status(201)
    .json(serializeProduct({ ...full!, sale: computeSale(full) }, true));
});

/** Atualizar (ADMIN) */
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

  if (FEATURE_VIS) {
    if (data.visiblePrice !== undefined) patch.visiblePrice = data.visiblePrice;
    if (data.visiblePackageSize !== undefined)
      patch.visiblePackageSize = data.visiblePackageSize;
    if (data.visiblePdf !== undefined) patch.visiblePdf = data.visiblePdf;
    if (data.visibleImages !== undefined) patch.visibleImages = data.visibleImages;
    if (data.visibleDescription !== undefined)
      patch.visibleDescription = data.visibleDescription;
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

  res.json(serializeProduct({ ...full!, sale: computeSale(full) }, true));
});

/** Deletar (ADMIN) — seguro: arquiva se houver pedidos */
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

/** Exclusão definitiva explícita — só se NÃO houver pedidos */
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

/** Ordenação (ADMIN) */
products.patch("/:id/sort-order", requireAdmin, async (req, res) => {
  const body = z.object({ sortOrder: z.number().int() }).parse(req.body);
  await prisma.product.update({
    where: { id: req.params.id },
    data: { sortOrder: body.sortOrder },
  });
  res.json({ ok: true });
});

/** Arquivar / Desarquivar (ADMIN) */
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

/** Toggle de visibilidade (ADMIN) */
products.patch("/:id/visibility", requireAdmin, async (req, res) => {
  if (!FEATURE_VIS) {
    return res.status(409).json({
      error: "visibility_flags_not_enabled",
      message:
        "Visibility flags are not enabled in this environment. Set FEATURE_VISIBILITY_FLAGS=1 after migrating schema.",
    });
  }

  const Body = z.object({
    price: z.boolean().optional(),
    packageSize: z.boolean().optional(),
    pdf: z.boolean().optional(),
    images: z.boolean().optional(),
    description: z.boolean().optional(),
  });
  const b = Body.parse(req.body);

  const data: any = {};
  if (b.price !== undefined) data.visiblePrice = b.price;
  if (b.packageSize !== undefined) data.visiblePackageSize = b.packageSize;
  if (b.pdf !== undefined) data.visiblePdf = b.pdf;
  if (b.images !== undefined) data.visibleImages = b.images;
  if (b.description !== undefined) data.visibleDescription = b.description;

  const updated = await prisma.product.update({
    where: { id: req.params.id },
    data,
  });

  const vis = {
    price: (updated as any).visiblePrice ?? false,
    packageSize: (updated as any).visiblePackageSize ?? true,
    pdf: (updated as any).visiblePdf ?? true,
    images: (updated as any).visibleImages ?? true,
    description: (updated as any).visibleDescription ?? true,
  };

  res.json({ ok: true, visibility: vis });
});

/** Agendar/atualizar promoção (sale) — percentOff OU priceOff */
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

/** =========================
 *  GET "/:idOrSlug"  (detalhe)
 *  ========================= */
products.get("/:idOrSlug", async (req, res) => {
  const idOrSlug = req.params.idOrSlug;

  const byId = await prisma.product.findUnique({
    where: { id: idOrSlug },
    include: {
      images: { orderBy: { sortOrder: "asc" as const } },
      categories: {
        include: { category: { include: { parent: true } } },
        take: 1,
      },
      promotions: true,
    },
  });

  const bySlug = byId
    ? null
    : await prisma.product.findUnique({
        where: { slug: idOrSlug },
        include: {
          images: { orderBy: { sortOrder: "asc" as const } },
          categories: {
            include: { category: { include: { parent: true } } },
            take: 1,
          },
          promotions: true,
        },
      });

  const p: any = byId || bySlug;
  if (!p) return res.status(404).json({ error: "not_found" });

  // se não for admin, produto inativo não é visível
  const wantAll = String(req.query.all || "0") === "1";
  const isAdmin = wantAll && isAdminFromReq(req);
  if (!isAdmin && !p.active)
    return res.status(404).json({ error: "not_found" });

  return res.json(serializeProduct({ ...p, sale: computeSale(p) }, isAdmin));
});
