// prisma/seed.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import fs from "fs";
import path from "path";

// Seeds/migrations: usar DIRECT_URL (sem pooler) quando disponível
const db = new PrismaClient({
  log: ["error"],
  datasources: {
    db: {
      url: process.env.DIRECT_URL || process.env.DATABASE_URL!,
    },
  },
});

const FEATURE_VARIANTS =
  String(process.env.FEATURE_VARIANTS || "").trim() !== "0";

// -------------------- helpers --------------------
function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function ensureAdmin() {
  const email = (
    process.env.SEED_ADMIN_EMAIL || "admin@listo365.com"
  ).toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || "admin123";
  const name = process.env.SEED_ADMIN_NAME || "Admin";
  const hash = await bcrypt.hash(password, 10);

  const existing = await db.user.findUnique({ where: { email } });
  if (!existing) {
    await db.user.create({
      data: { email, password: hash, name, role: "ADMIN" },
    });
    console.log(`✅ Admin created: ${email}`);
  } else {
    await db.user.update({
      where: { email },
      data: { password: hash, name, role: "ADMIN" },
    });
    console.log(`↻ Admin updated: ${email}`);
  }
}

/**
 * Árvore de categorias final
 */
const CATEGORY_TREE: Array<{ name: string; children?: string[] }> = [
  {
    name: "Floor Care",
    children: ["Floor Finishes", "Floor Strippers", "Neutral Cleaners"],
  },
  { name: "Carpet Care", children: ["Multi-Purpose"] },
  {
    name: "Glass Cleaners & Polishes",
    children: ["Glass & Multi-Surface Cleaners"],
  },
  { name: "Cleaners & Degreasers", children: ["Super Heavy Duty Concentrate"] },
  {
    name: "Restroom Care",
    children: [
      "Porcelain & Tile Cleaners",
      "Non-Acid Bathroom & Bowl Cleaners",
    ],
  },
];

async function upsertCategories() {
  const idBySlug = new Map<string, string>(); // slug -> id

  for (const parent of CATEGORY_TREE) {
    const pslug = slugify(parent.name);
    const p = await db.category.upsert({
      where: { slug: pslug },
      create: { name: parent.name, slug: pslug },
      update: { name: parent.name },
    });
    idBySlug.set(pslug, p.id);

    for (const child of parent.children ?? []) {
      const cslug = slugify(child);
      const c = await db.category.upsert({
        where: { slug: cslug },
        create: { name: child, slug: cslug, parentId: p.id },
        update: { name: child, parentId: p.id },
      });
      idBySlug.set(cslug, c.id);
    }
  }

  console.log(`✅ Categories ensured (${idBySlug.size})`);
  return idBySlug;
}

// -------------------- types --------------------
type SeedVariant = {
  name: string;
  price?: number;
  stock?: number;
  sortOrder?: number;
  active?: boolean;
  sku?: string;
  imageUrl?: string | null;
  images?: string[];
};
type SeedProduct = {
  name: string;
  description: string;
  price?: number; // baseline (0 => quote-only)
  stock?: number; // 0 default
  images?: string[]; // capa + demais
  packageSize?: string;
  visiblePrice?: boolean; // false => esconde preço no público
  visiblePackageSize?: boolean; // default true
  visiblePdf?: boolean; // default true
  visibleImages?: boolean; // default true
  visibleDescription?: boolean; // default true
  categorySlug?: string; // slug da subcategoria (ou pai)
  pdfUrl?: string;
  variants?: SeedVariant[]; // se FEATURE_VARIANTS=1
};

// -------------------- data loader --------------------
function loadProductsJson(): SeedProduct[] {
  try {
    const file = path.resolve(process.cwd(), "prisma", "products.seed.json");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
      throw new Error("Invalid products JSON structure");
    return parsed as SeedProduct[];
  } catch (e: any) {
    console.warn("⚠ products.seed.json not found or invalid.", e?.message || e);
    return [];
  }
}

// -------------------- upserts --------------------
async function upsertProduct(
  p: SeedProduct,
  i: number,
  categoryIdBySlug?: Map<string, string>
) {
  const slug = slugify(p.name);
  const cover = p.images?.[0] ?? "";
  const sortOrder = (i + 1) * 10;

  // campos base
  const base: any = {
    name: p.name,
    description: p.description,
    price: p.price ?? 0,
    stock: p.stock ?? 0,
    packageSize: p.packageSize,
    pdfUrl: p.pdfUrl,
    imageUrl: cover,
    sortOrder,
    active: true,
  };
  if ("visiblePrice" in p) base.visiblePrice = !!p.visiblePrice;
  if ("visiblePackageSize" in p)
    base.visiblePackageSize = p.visiblePackageSize ?? true;
  if ("visiblePdf" in p) base.visiblePdf = p.visiblePdf ?? true;
  if ("visibleImages" in p) base.visibleImages = p.visibleImages ?? true;
  if ("visibleDescription" in p)
    base.visibleDescription = p.visibleDescription ?? true;

  const found = await db.product.findUnique({ where: { slug } });
  let productId: string;

  if (found) {
    await db.product.update({ where: { slug }, data: base });
    productId = found.id;
    console.log(`↻ Product updated: ${p.name}`);

    await db.productImage.deleteMany({ where: { productId } });
    if (p.images?.length) {
      await db.productImage.createMany({
        data: p.images.map((url, idx) => ({
          productId,
          url,
          sortOrder: (idx + 1) * 10,
        })),
      });
    }
  } else {
    const created = await db.product.create({
      data: { slug, ...base },
      select: { id: true },
    });
    productId = created.id;
    console.log(`✅ Product created: ${p.name}`);

    if (p.images?.length) {
      await db.productImage.createMany({
        data: p.images.map((url, idx) => ({
          productId,
          url,
          sortOrder: (idx + 1) * 10,
        })),
      });
    }
  }

  // categoria principal (1:1)
  if (categoryIdBySlug) {
    await db.productCategory.deleteMany({ where: { productId } });
    const catSlug = p.categorySlug ? slugify(p.categorySlug) : "";
    const catId = catSlug ? categoryIdBySlug.get(catSlug) : undefined;
    if (catId) {
      await db.productCategory.create({
        data: { productId, categoryId: catId },
      });
    }
  }

  // Variantes (somente se feature ativa E modelo existe no Client)
  if (FEATURE_VARIANTS) {
    const hasVariantModel =
      !!(db as any)?.productVariant &&
      typeof (db as any).productVariant.deleteMany === "function";
    const hasVariantImgModel = !!(db as any)?.productVariantImage;

    if (!hasVariantModel) {
      console.warn(
        "⚠ FEATURE_VARIANTS=1, mas @prisma/client atual não tem o model ProductVariant. Rode `npx prisma generate` (com schema contendo o model) e reinicie."
      );
    } else {
      // Delete tudo (cascata removerá imagens das variantes)
      await (db as any).productVariant.deleteMany({ where: { productId } });

      const vs = Array.isArray(p.variants) ? p.variants : [];
      for (let idx = 0; idx < vs.length; idx++) {
        const v = vs[idx];
        const createdVar = await (db as any).productVariant.create({
          data: {
            productId,
            name: v.name,
            price: v.price ?? 0,
            stock: v.stock ?? 0,
            sortOrder: v.sortOrder ?? (idx + 1) * 10,
            active: v.active ?? true,
            sku: v.sku ?? null,
            imageUrl: v.imageUrl ?? null,
          },
          select: { id: true },
        });
        if (hasVariantImgModel && v.images?.length) {
          await (db as any).productVariantImage.createMany({
            data: v.images.map((url, j) => ({
              variantId: createdVar.id,
              url,
              sortOrder: (j + 1) * 10,
            })),
          });
        }
      }
    }
  }
}

// -------------------- entrypoint --------------------
export async function runSeed() {
  await ensureAdmin();
  const categoryIdBySlug = await upsertCategories();

  const products = loadProductsJson();
  for (let i = 0; i < products.length; i++) {
    await upsertProduct(products[i], i, categoryIdBySlug);
  }

  console.log("✔ Seed finished");
}

export default runSeed;

if (require.main === module) {
  runSeed()
    .then(() => db.$disconnect())
    .catch(async (e) => {
      console.error(e);
      await db.$disconnect();
      process.exit(1);
    });
}
