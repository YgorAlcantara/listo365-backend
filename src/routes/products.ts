import { Router } from "express";
import { prisma } from "../lib/prisma";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { requireAdmin } from "../middleware/auth";

export const products = Router();

/** Ping para debug */
products.get("/_ping", (_req, res) =>
  res.json({ ok: true, scope: "products-router" })
);

/** =========================
 *  Feature flags
 *  ========================= */
const HAS_VARIANT_MODEL = Boolean((prisma as any).productVariant);
const HAS_VARIANT_IMG_MODEL = Boolean((prisma as any).productVariantImage);

const FEATURE_VIS = process.env.FEATURE_VISIBILITY_FLAGS !== "0"; // default ON
const FEATURE_VAR = process.env.FEATURE_VARIANTS !== "0" && HAS_VARIANT_MODEL; // precisa do model
const FEATURE_PROMOS = process.env.FEATURE_PROMOTIONS === "1"; // default OFF

/** helper: aceita http(s) OU caminho absoluto iniciando por "/" */
const urlish = z
  .string()
  .refine(
    (v) => /^https?:\/\//i.test(v) || v.startsWith("/"),
    'Must be an http(s) URL or a path starting with "/"'
  );

/** checa ADMIN com base no header Authorization */
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

/** calcula melhor promoção ativa e preço final (usado apenas se FEATURE_PROMOS=1) */
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

  const sale = FEATURE_PROMOS ? p.sale ?? computeSale(p) : undefined;

  const visPrice = (p as any).visiblePrice ?? false;
  const visPkg = (p as any).visiblePackageSize ?? true;
  const visPdf = (p as any).visiblePdf ?? true;
  const visImgs = (p as any).visibleImages ?? true;
  const visDesc = (p as any).visibleDescription ?? true;

  const show = (flag: boolean) => (isAdmin ? true : !!flag);

  // Variantes
  const variants =
    FEATURE_VAR && Array.isArray(p.variants)
      ? (p.variants as any[]).map((v) => ({
          id: v.id,
          name: v.name,
          price: show(visPrice) ? Number(v.price) : undefined,
          stock: v.stock,
          active: v.active,
          sortOrder: v.sortOrder ?? 0,
          sku: v.sku ?? undefined,
          imageUrl: v.imageUrl ?? null,
          images:
            Array.isArray(v.images) && show(visImgs)
              ? v.images.map((im: any) => im.url)
              : [],
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
    ...(FEATURE_PROMOS && sale ? { sale } : {}),
    visibility: isAdmin
      ? {
          price: visPrice,
          packageSize: visPkg,
          pdf: visPdf,
          images: visImgs,
          description: visDesc,
        }
      : undefined,
    variants,
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

  const select: any = {
    id: true,
    name: true,
    slug: true,
    description: true,
    price: true,
    imageUrl: true,
    active: true,
    stock: true,
    sortOrder: true,
    packageSize: true,
    pdfUrl: true,
    ...(FEATURE_VIS
      ? {
          visibleDescription: true,
          visibleImages: true,
          visiblePackageSize: true,
          visiblePdf: true,
          visiblePrice: true,
        }
      : {}),
    images: {
      select: { url: true, sortOrder: true },
      orderBy: { sortOrder: "asc" as const },
    },
    categories: {
      take: 1,
      select: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            parent: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
      },
    },
    ...(FEATURE_PROMOS
      ? {
          promotions: {
            select: {
              title: true,
              percentOff: true,
              priceOff: true,
              startsAt: true,
              endsAt: true,
              active: true,
            },
          },
        }
      : {}),
  };

  if (FEATURE_VAR) {
    select.variants = {
      select: {
        id: true,
        name: true,
        price: true,
        stock: true,
        active: true,
        sortOrder: true,
        sku: true,
        imageUrl: true,
        ...(HAS_VARIANT_IMG_MODEL
          ? {
              images: {
                select: { url: true, sortOrder: true },
                orderBy: { sortOrder: "asc" as const },
              },
            }
          : {}),
      },
      orderBy: { sortOrder: "asc" as const },
    };
  }

  const list = await prisma.product.findMany({
    where,
    orderBy: [orderBy, { createdAt: "desc" as const }],
    select,
  });

  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");

  res.json(
    list.map((p: any) =>
      serializeProduct(
        { ...p, ...(FEATURE_PROMOS ? { sale: computeSale(p) } : {}) },
        isAdmin
      )
    )
  );
});

/** ======= Validadores ======= */
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
  price: z.coerce.number().nonnegative().catch(0),
  stock: z.coerce.number().int().min(0).catch(0),
  sortOrder: z.coerce.number().int().catch(0),
  active: z.coerce.boolean().catch(true),
  sku: z.string().optional(),
  imageUrl: urlish.optional(), // capa opcional da variante
  images: z.array(urlish).max(10).optional(), // galeria da variante
});

const Upsert = z.object({
  name: z.string().min(2),
  description: z.string().min(2),
  price: z.coerce.number().nonnegative(),
  stock: z.coerce.number().int().min(0),
  active: z.boolean().optional().default(true),
  packageSize: z.string().min(1).max(100).optional(),
  pdfUrl: urlish.optional(),
  images: z.array(urlish).max(10).optional(),
  categoryId: z.string().min(1).optional(),
  imageUrl: urlish.optional(),
  visibility: VisibilityShape,
  variants: z.array(VariantShape).optional(),
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

  // Variants: criar 1 a 1
  if (FEATURE_VAR && body.variants?.length) {
    for (let i = 0; i < body.variants.length; i++) {
      const v = body.variants[i];
      const variant = await (prisma as any).productVariant.create({
        data: {
          productId: created.id,
          name: v.name,
          price: v.price,
          stock: v.stock,
          sortOrder: v.sortOrder ?? (i + 1) * 10,
          active: v.active ?? true,
          sku: v.sku ?? null,
          imageUrl: v.imageUrl ?? null,
        },
        select: { id: true },
      });
      if (HAS_VARIANT_IMG_MODEL && v.images?.length) {
        await (prisma as any).productVariantImage.createMany({
          data: v.images.map((url, idx) => ({
            variantId: variant.id,
            url,
            sortOrder: (idx + 1) * 10,
          })),
        });
      }
    }
  }

  // Retorna já serializado
  const select = selectForReturn();
  const full = await prisma.product.findUnique({
    where: { id: created.id },
    select,
  });

  res
    .status(201)
    .json(
      serializeProduct(
        { ...full!, ...(FEATURE_PROMOS ? { sale: computeSale(full) } : {}) },
        true
      )
    );
});

/** ============== Atualizar (ADMIN) ============== */
// função compartilhada para PUT/PATCH
async function updateProductCore(id: string, bodyRaw: any) {
  const body = Upsert.partial().parse(bodyRaw);

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

  // Categoria
  if (body.categoryId !== undefined) {
    await prisma.productCategory.deleteMany({ where: { productId: id } });
    if (body.categoryId) {
      await prisma.productCategory.create({
        data: { productId: id, categoryId: body.categoryId },
      });
    }
  }

  // Imagens
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

  // Variants — regravação idempotente (permite excluir)
  if (FEATURE_VAR && Object.prototype.hasOwnProperty.call(body, "variants")) {
    await (prisma as any).productVariant.deleteMany({
      where: { productId: id },
    });

    const arr = Array.isArray(body.variants) ? body.variants : [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      const created = await (prisma as any).productVariant.create({
        data: {
          productId: id,
          name: v.name,
          price: v.price ?? 0,
          stock: v.stock ?? 0,
          sortOrder: v.sortOrder ?? (i + 1) * 10,
          active: v.active ?? true,
          sku: v.sku ?? null,
          imageUrl: v.imageUrl ?? null,
        },
        select: { id: true },
      });
      if (HAS_VARIANT_IMG_MODEL && v.images?.length) {
        await (prisma as any).productVariantImage.createMany({
          data: v.images.map((url, idx) => ({
            variantId: created.id,
            url,
            sortOrder: (idx + 1) * 10,
          })),
        });
      }
    }
  }

  const select = selectForReturn();
  const full = await prisma.product.findUnique({ where: { id }, select });
  return serializeProduct(
    { ...full!, ...(FEATURE_PROMOS ? { sale: computeSale(full) } : {}) },
    true
  );
}

function selectForReturn() {
  const select: any = {
    id: true,
    name: true,
    slug: true,
    description: true,
    price: true,
    imageUrl: true,
    active: true,
    stock: true,
    sortOrder: true,
    packageSize: true,
    pdfUrl: true,
    ...(FEATURE_VIS
      ? {
          visibleDescription: true,
          visibleImages: true,
          visiblePackageSize: true,
          visiblePdf: true,
          visiblePrice: true,
        }
      : {}),
    images: {
      select: { url: true, sortOrder: true },
      orderBy: { sortOrder: "asc" as const },
    },
    categories: {
      take: 1,
      select: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            parent: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    },
    ...(FEATURE_PROMOS
      ? {
          promotions: {
            select: {
              title: true,
              percentOff: true,
              priceOff: true,
              startsAt: true,
              endsAt: true,
              active: true,
            },
          },
        }
      : {}),
    ...(FEATURE_VAR
      ? {
          variants: {
            select: {
              id: true,
              name: true,
              price: true,
              stock: true,
              active: true,
              sortOrder: true,
              sku: true,
              imageUrl: true,
              ...(HAS_VARIANT_IMG_MODEL
                ? {
                    images: {
                      select: { url: true, sortOrder: true },
                      orderBy: { sortOrder: "asc" as const },
                    },
                  }
                : {}),
            },
            orderBy: { sortOrder: "asc" as const },
          },
        }
      : {}),
  };
  return select;
}

// PUT (como você já tinha)
products.put("/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const out = await updateProductCore(id, req.body);
  res.json(out);
});

// Alias PATCH — mesmo comportamento do PUT
products.patch("/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const out = await updateProductCore(id, req.body);
  res.json(out);
});

/** Deletar (ADMIN) — arquiva se houver pedidos */
products.delete("/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    // compatível com schemas (orderItem OU orderInquiryItem)
    const ORDER_ITEM =
      (prisma as any).orderItem ?? (prisma as any).orderInquiryItem;
    const usage = ORDER_ITEM
      ? await ORDER_ITEM.count({ where: { productId: id } })
      : 0;

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

/** Exclusão definitiva explícita */
products.delete("/:id/hard", requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const ORDER_ITEM =
      (prisma as any).orderItem ?? (prisma as any).orderInquiryItem;
    const usage = ORDER_ITEM
      ? await ORDER_ITEM.count({ where: { productId: id } })
      : 0;

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
products.patch("/:id/archive", requireAdmin, async (_req, res) => {
  try {
    await prisma.product.update({
      where: { id: _req.params.id },
      data: { active: false },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("archive product failed", err);
    return res.status(500).json({ error: "archive_failed" });
  }
});
products.patch("/:id/unarchive", requireAdmin, async (_req, res) => {
  try {
    await prisma.product.update({
      where: { id: _req.params.id },
      data: { active: true },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("unarchive product failed", err);
    return res.status(500).json({ error: "unarchive_failed" });
  }
});

/** Toggle explícito (ADMIN) */
products.patch("/:id/visibility", requireAdmin, async (req, res) => {
  if (!FEATURE_VIS) {
    return res.status(409).json({
      error: "visibility_flags_not_enabled",
      message:
        "Visibility flags are not enabled. Set FEATURE_VISIBILITY_FLAGS=1 after migrating schema.",
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

/** ========================= Variantes (ADMIN) ========================= */

// PATCH (editar/toggle) variante específica
products.patch(
  "/products/:productId/variants/:variantId", // rota “namespaced” para evitar colisão
  requireAdmin,
  async (req, res) => {
    if (!FEATURE_VAR) return res.status(404).json({ error: "variants_not_enabled" });
    const { productId, variantId } = req.params;

    const VariantPatch = z
      .object({
        name: z.string().min(1).optional(),
        price: z.coerce.number().nonnegative().optional(),
        stock: z.coerce.number().int().min(0).optional(),
        sortOrder: z.coerce.number().int().optional(),
        active: z.coerce.boolean().optional(),
        sku: z.string().nullable().optional(),
        imageUrl: urlish.nullable().optional(),
        images: z.array(urlish).max(10).optional(), // se enviar, regrava galeria
      })
      .partial();

    const b = VariantPatch.parse(req.body);

    // Confere que a variante pertence ao produto
    const exists = await (prisma as any).productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true },
    });
    if (!exists) return res.status(404).json({ error: "variant_not_found" });

    const data: any = {};
    if (b.name !== undefined) data.name = b.name;
    if (b.price !== undefined) data.price = b.price;
    if (b.stock !== undefined) data.stock = b.stock;
    if (b.sortOrder !== undefined) data.sortOrder = b.sortOrder;
    if (b.active !== undefined) data.active = b.active;
    if (b.sku !== undefined) data.sku = b.sku;
    if (b.imageUrl !== undefined) data.imageUrl = b.imageUrl;

    await (prisma as any).productVariant.update({
      where: { id: variantId },
      data,
    });

    // Se enviou images, regrava galeria
    if (HAS_VARIANT_IMG_MODEL && b.images) {
      await (prisma as any).productVariantImage.deleteMany({
        where: { variantId },
      });
      if (b.images.length) {
        await (prisma as any).productVariantImage.createMany({
          data: b.images.map((url, idx) => ({
            variantId,
            url,
            sortOrder: (idx + 1) * 10,
          })),
        });
      }
    }

    return res.json({ ok: true });
  }
);

// DELETE variante
products.delete(
  "/products/:productId/variants/:variantId",
  requireAdmin,
  async (req, res) => {
    if (!FEATURE_VAR) return res.status(404).json({ error: "variants_not_enabled" });
    const { productId, variantId } = req.params;

    const exists = await (prisma as any).productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true },
    });
    if (!exists) return res.status(404).json({ error: "variant_not_found" });

    await prisma.$transaction(
      [
        HAS_VARIANT_IMG_MODEL
          ? (prisma as any).productVariantImage.deleteMany({ where: { variantId } })
          : null,
        (prisma as any).productVariant.delete({ where: { id: variantId } }),
      ].filter(Boolean) as any
    );

    return res.json({ ok: true, deleted: true });
  }
);

/** =========================
 *  GET "/:idOrSlug"  (detalhe)
 *  ========================= */
products.get("/:idOrSlug", async (req, res) => {
  const idOrSlug = req.params.idOrSlug;

  const select: any = {
    id: true,
    name: true,
    slug: true,
    description: true,
    price: true,
    imageUrl: true,
    active: true,
    stock: true,
    sortOrder: true,
    packageSize: true,
    pdfUrl: true,
    ...(FEATURE_VIS
      ? {
          visibleDescription: true,
          visibleImages: true,
          visiblePackageSize: true,
          visiblePdf: true,
          visiblePrice: true,
        }
      : {}),
    images: {
      select: { url: true, sortOrder: true },
      orderBy: { sortOrder: "asc" as const },
    },
    categories: {
      take: 1,
      select: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            parent: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    },
    ...(FEATURE_PROMOS
      ? {
          promotions: {
            select: {
              title: true,
              percentOff: true,
              priceOff: true,
              startsAt: true,
              endsAt: true,
              active: true,
            },
          },
        }
      : {}),
    ...(FEATURE_VAR
      ? {
          variants: {
            select: {
              id: true,
              name: true,
              price: true,
              stock: true,
              active: true,
              sortOrder: true,
              sku: true,
              imageUrl: true,
              ...(HAS_VARIANT_IMG_MODEL
                ? {
                    images: {
                      select: { url: true, sortOrder: true },
                      orderBy: { sortOrder: "asc" as const },
                    },
                  }
                : {}),
            },
            orderBy: { sortOrder: "asc" as const },
          },
        }
      : {}),
  };

  const byId = await prisma.product.findUnique({
    where: { id: idOrSlug },
    select,
  });
  const bySlug = byId
    ? null
    : await prisma.product.findUnique({ where: { slug: idOrSlug }, select });

  const p: any = byId || bySlug;
  if (!p) return res.status(404).json({ error: "not_found" });

  const wantAll = String(req.query.all || "0") === "1";
  const isAdmin = wantAll && isAdminFromReq(req);
  if (!isAdmin && !p.active)
    return res.status(404).json({ error: "not_found" });

  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");

  return res.json(
    serializeProduct(
      { ...p, ...(FEATURE_PROMOS ? { sale: computeSale(p) } : {}) },
      isAdmin
    )
  );
});
