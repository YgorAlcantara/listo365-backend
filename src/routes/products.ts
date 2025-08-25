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

/** Feature flags */
const FEATURE_VIS = process.env.FEATURE_VISIBILITY_FLAGS === "1";
const FEATURE_VAR = process.env.FEATURE_VARIANTS === "1";

/** helper: aceita http(s) OU caminho absoluto iniciando por "/" */
const urlish = z
  .string()
  .refine(
    (v) => /^https?:\/\//i.test(v) || v.startsWith("/"),
    'Must be an http(s) URL or a path starting with "/"'
  );

/** --- helper p/ checar ADMIN quando ?all=1 --- */
function isAdminFromReq(req: any): boolean {
  try {
    const h = req.headers?.authorization || "";
    if (!h.startsWith("Bearer ")) return false;
    const token = h.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
    const role = decoded?.role ?? "USER";
    const id = decoded?.sub ?? decoded?.uid;
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

  // Defaults seguros se colunas não existem
  const visPrice = (p as any).visiblePrice ?? false;
  const visPkg = (p as any).visiblePackageSize ?? true;
  const visPdf = (p as any).visiblePdf ?? true;
  const visImgs = (p as any).visibleImages ?? true;
  const visDesc = (p as any).visibleDescription ?? true;

  const show = (flag: boolean) => (isAdmin ? true : !!flag);

  // variants (se existirem)
  const variants = Array.isArray(p.variants)
    ? (p.variants as any[]).map((v) => ({
        id: v.id,
        name: v.name,
        price: show(visPrice) ? Number(v.price) : undefined,
        stock: v.stock,
        active: v.active,
        sortOrder: v.sortOrder ?? 0,
        sku: v.sku ?? undefined,
      }))
    : undefined;

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
    sale,
    visibility: isAdmin
      ? {
          price: visPrice,
          packageSize: visPkg,
          pdf: visPdf,
          images: visImgs,
          description: visDesc,
        }
      : undefined,
    variants, // só vem se feature tiver populado
  };
}

/** =========================
 *  GET "/" (lista; ?q, ?sort; ?all=1 p/ ADMIN)
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

  // include condicional de variants
  const include: any = {
    images: { orderBy: { sortOrder: "asc" as const } },
    categories: {
      include: { category: { include: { parent: true } } },
      take: 1,
    },
    promotions: true,
  };
  if (FEATURE_VAR) {
    include.variants = { orderBy: { sortOrder: "asc" as const } };
  }

  const list = await prisma.product.findMany({
    where,
    orderBy: [orderBy, { createdAt: "desc" as const }],
    include,
  });

  res.json(
    list.map((p: any) =>
      serializeProduct({ ...p, sale: computeSale(p) }, isAdmin)
    )
  );
});

/** payload de criação/edição */
const VisibilityShape = z
  .object({
    price: z.boolean().optional(),
    packageSize: z.boolean().optional(),
    pdf: z.boolean().optional(),
    images: z.boolean().optional(),
    description: z.boolean().optional(),
  })
  .partial()
  .optional();

const VariantShape = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  price: z.coerce.number().nonnegative(),
  stock: z.coerce.number().int().min(0),
  sortOrder: z.coerce.number().int().optional().default(0),
  active: z.boolean().optional().default(true),
  sku: z.string().optional(),
});

const Upsert = z.object({
  name: z.string().min(2),
  description: z.string().min(2),
  price: z.coerce.number().nonnegative(), // ✅ permite 0
  stock: z.coerce.number().int().min(0),
  active: z.boolean().optional().default(true),
  packageSize: z.string().min(1).max(100).optional(),
  pdfUrl: urlish.optional(),
  images: z.array(urlish).max(10).optional(),
  categoryId: z.string().min(1).optional(),
  imageUrl: urlish.optional(),
  // novos
  visibility: VisibilityShape, // { price, packageSize, pdf, images, description }
  variants: z.array(VariantShape).optional(), // tamanhos/opções
});

/** Criar (ADMIN) */
products.post("/", requireAdmin, async (req, res) => {
  const body = Upsert.parse(req.body);
  const slug = body.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const createData: any = {
    name: body.name,
    slug,
    description: body.description,
    price: body.price,
    stock: body.stock,
    active: body.active ?? true,
    packageSize: body.packageSize,
    pdfUrl: body.pdfUrl,
    imageUrl: body.imageUrl ?? "",
    sortOrder: 0,
  };

  // mapear visibility -> colunas (se habilitado)
  if (FEATURE_VIS && body.visibility) {
    const v = body.visibility;
    if (v.price !== undefined) createData.visiblePrice = v.price;
    if (v.packageSize !== undefined)
      createData.visiblePackageSize = v.packageSize;
    if (v.pdf !== undefined) createData.visiblePdf = v.pdf;
    if (v.images !== undefined) createData.visibleImages = v.images;
    if (v.description !== undefined)
      createData.visibleDescription = v.description;
  }

  const created = await prisma.product.create({ data: createData });

  if (body.categoryId) {
    await prisma.productCategory.create({
      data: { productId: created.id, categoryId: body.categoryId },
    });
  }

  if (body.images?.length) {
    await prisma.productImage.createMany({
      data: body.images.map((url, i) => ({
        productId: created.id,
        url,
        sortOrder: (i + 1) * 10,
      })),
    });
  }

  // Variants (opcional + feature flag)
  if (FEATURE_VAR && body.variants && body.variants.length) {
    const pv = (prisma as any).productVariant;
    if (pv) {
      await pv.createMany({
        data: body.variants.map((v, i) => ({
          productId: created.id,
          name: v.name,
          price: v.price,
          stock: v.stock,
          sortOrder: v.sortOrder ?? (i + 1) * 10,
          active: v.active ?? true,
          sku: v.sku ?? null,
        })),
      });
    }
  }

  const include: any = {
    images: { orderBy: { sortOrder: "asc" as const } },
    categories: {
      include: { category: { include: { parent: true } } },
      take: 1,
    },
    promotions: true,
  };
  if (FEATURE_VAR)
    include.variants = { orderBy: { sortOrder: "asc" as const } };

  const full = await prisma.product.findUnique({
    where: { id: created.id },
    include,
  });
  res
    .status(201)
    .json(serializeProduct({ ...full!, sale: computeSale(full) }, true));
});

/** Atualizar (ADMIN) */
products.put("/:id", requireAdmin, async (req, res) => {
  const body = Upsert.partial().parse(req.body);
  const id = req.params.id;

  const patch: any = {
    description: body.description,
    price: body.price,
    stock: body.stock,
    active: body.active,
    packageSize: body.packageSize,
    pdfUrl: body.pdfUrl,
    imageUrl: body.imageUrl,
  };
  if (body.name) {
    patch.name = body.name;
    patch.slug = body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  if (FEATURE_VIS && body.visibility) {
    const v = body.visibility;
    if (v.price !== undefined) patch.visiblePrice = v.price;
    if (v.packageSize !== undefined) patch.visiblePackageSize = v.packageSize;
    if (v.pdf !== undefined) patch.visiblePdf = v.pdf;
    if (v.images !== undefined) patch.visibleImages = v.images;
    if (v.description !== undefined) patch.visibleDescription = v.description;
  }

  await prisma.product.update({ where: { id }, data: patch });

  if (body.categoryId !== undefined) {
    await prisma.productCategory.deleteMany({ where: { productId: id } });
    if (body.categoryId) {
      await prisma.productCategory.create({
        data: { productId: id, categoryId: body.categoryId },
      });
    }
  }

  if (body.images) {
    await prisma.productImage.deleteMany({ where: { productId: id } });
    if (body.images.length) {
      await prisma.productImage.createMany({
        data: body.images.map((url, i) => ({
          productId: id,
          url,
          sortOrder: (i + 1) * 10,
        })),
      });
    }
  }

  // Variants (regrava simples: apaga e cria de novo)
  if (FEATURE_VAR && body.variants) {
    const pv = (prisma as any).productVariant;
    if (pv) {
      await pv.deleteMany({ where: { productId: id } });
      if (body.variants.length) {
        await pv.createMany({
          data: body.variants.map((v: any, i: number) => ({
            productId: id,
            name: v.name,
            price: v.price,
            stock: v.stock,
            sortOrder: v.sortOrder ?? (i + 1) * 10,
            active: v.active ?? true,
            sku: v.sku ?? null,
          })),
        });
      }
    }
  }

  const include: any = {
    images: { orderBy: { sortOrder: "asc" as const } },
    categories: {
      include: { category: { include: { parent: true } } },
      take: 1,
    },
    promotions: true,
  };
  if (FEATURE_VAR)
    include.variants = { orderBy: { sortOrder: "asc" as const } };

  const full = await prisma.product.findUnique({ where: { id }, include });
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
    await prisma.$transaction(
      [
        prisma.productImage.deleteMany({ where: { productId: id } }),
        prisma.productCategory.deleteMany({ where: { productId: id } }),
        prisma.promotion.deleteMany({ where: { productId: id } }),
        ...(FEATURE_VAR
          ? [
              (prisma as any).productVariant?.deleteMany({
                where: { productId: id },
              }),
            ]
          : []),
        prisma.product.delete({ where: { id } }),
      ].filter(Boolean) as any
    );
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
    await prisma.$transaction(
      [
        prisma.productImage.deleteMany({ where: { productId: id } }),
        prisma.productCategory.deleteMany({ where: { productId: id } }),
        prisma.promotion.deleteMany({ where: { productId: id } }),
        ...(FEATURE_VAR
          ? [
              (prisma as any).productVariant?.deleteMany({
                where: { productId: id },
              }),
            ]
          : []),
        prisma.product.delete({ where: { id } }),
      ].filter(Boolean) as any
    );
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("hard delete failed", err);
    return res.status(500).json({ error: "hard_delete_failed" });
  }
});

/** Ordenação (ADMIN) */
products.patch("/:id/sort-order", requireAdmin, async (req, res) => {
  const body = z.object({ sortOrder: z.coerce.number().int() }).parse(req.body);
  await prisma.product.update({
    where: { id: req.params.id },
    data: { sortOrder: body.sortOrder },
  });
  res.json({ ok: true });
});

/** Arquivar / Desarquivar (ADMIN) */
products.patch("/:id/archive", requireAdmin, async (req, res) => {
  try {
    await prisma.product.update({
      where: { id: req.params.id },
      data: { active: false },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("archive product failed", err);
    return res.status(500).json({ error: "archive_failed" });
  }
});
products.patch("/:id/unarchive", requireAdmin, async (req, res) => {
  try {
    await prisma.product.update({
      where: { id: req.params.id },
      data: { active: true },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("unarchive product failed", err);
    return res.status(500).json({ error: "unarchive_failed" });
  }
});

/** Toggle explícito (ADMIN) — opcional se preferir PATCH direto */
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

/** =========================
 *  GET "/:idOrSlug"  (detalhe)
 *  ========================= */
products.get("/:idOrSlug", async (req, res) => {
  const idOrSlug = req.params.idOrSlug;

  const include: any = {
    images: { orderBy: { sortOrder: "asc" as const } },
    categories: {
      include: { category: { include: { parent: true } } },
      take: 1,
    },
    promotions: true,
  };
  if (FEATURE_VAR)
    include.variants = { orderBy: { sortOrder: "asc" as const } };

  const byId = await prisma.product.findUnique({
    where: { id: idOrSlug },
    include,
  });
  const bySlug = byId
    ? null
    : await prisma.product.findUnique({ where: { slug: idOrSlug }, include });

  const p: any = byId || bySlug;
  if (!p) return res.status(404).json({ error: "not_found" });

  const wantAll = String(req.query.all || "0") === "1";
  const isAdmin = wantAll && isAdminFromReq(req);
  if (!isAdmin && !p.active)
    return res.status(404).json({ error: "not_found" });

  return res.json(serializeProduct({ ...p, sale: computeSale(p) }, isAdmin));
});
