// prisma/seed.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import fs from "fs";
import path from "path";

// Use DIRECT_URL para seed/migrations (sem pooler)
const db = new PrismaClient({
  log: ["error"],
  datasources: {
    db: {
      url: process.env.DIRECT_URL || process.env.DATABASE_URL!,
    },
  },
});

const FEATURE_VARIANTS =
  String(process.env.FEATURE_VARIANTS || "").trim() === "1";

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
 * Árvore de categorias cobrindo os produtos informados
 *
 * Floor Care
 *   - Floor Finishes
 *   - Floor Strippers
 *   - Neutral Cleaners
 * Carpet Care
 *   - Multi-Purpose
 * Glass Cleaners & Polishes
 *   - Glass & Multi-Surface Cleaners
 * Cleaners & Degreasers
 *   - Super Heavy Duty Concentrate
 * Restroom Care
 *   - Porcelain & Tile Cleaners
 *   - Non-Acid Bathroom & Bowl Cleaners
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

// -------------------- data types --------------------
type SeedVariant = {
  name: string;
  price: number;
  stock?: number;
  sortOrder?: number;
  active?: boolean;
  sku?: string;
};
type SeedProduct = {
  name: string;
  description: string;
  price: number; // baseline (0 para quote-only)
  stock: number; // 0 default
  images: string[]; // capa + demais
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

// -------------------- fallback products (caso JSON não exista) --------------------
const FALLBACK_PRODUCTS: SeedProduct[] = [
  {
    name: "Acabado Asombroso",
    description:
      "High-gloss floor finish for a durable, scuff-resistant shine.",
    price: 0,
    stock: 0,
    images: ["https://placehold.co/1200x900?text=Acabado%20Asombroso"],
    visiblePrice: false,
    packageSize: "5 Gallon | 1 Gallon",
    categorySlug: "floor-finishes",
    variants: [
      {
        name: "5 Gallon",
        price: 0,
        stock: 0,
        sortOrder: 10,
        active: true,
        sku: "100698-500000",
      },
      {
        name: "1 Gallon",
        price: 0,
        stock: 0,
        sortOrder: 20,
        active: true,
        sku: "100698-500000",
      },
    ],
  },
  {
    name: "Antiespumante Asombroso",
    description: "Defoamer for carpet extractors and autoscrubbers.",
    price: 0,
    stock: 0,
    images: ["https://placehold.co/1200x900?text=Antiespumante%20Asombroso"],
    visiblePrice: false,
    packageSize: "1 Gallon",
    categorySlug: "multi-purpose",
    variants: [
      {
        name: "1 Gallon",
        price: 0,
        stock: 0,
        sortOrder: 10,
        sku: "100801-500000",
      },
    ],
  },
  {
    name: "Cristal Cristalino",
    description: "Streak-free glass & multi-surface cleaner.",
    price: 0,
    stock: 0,
    images: ["https://placehold.co/1200x900?text=Cristal%20Cristalino"],
    visiblePrice: false,
    packageSize: "One Quart",
    categorySlug: "glass-multi-surface-cleaners",
    variants: [
      {
        name: "One Quart",
        price: 0,
        stock: 0,
        sortOrder: 10,
        sku: "101233-500000",
      },
    ],
  },
  {
    name: "Desengrasante Destructor",
    description: "Super heavy-duty degreaser for tough soils.",
    price: 0,
    stock: 0,
    images: ["https://placehold.co/1200x900?text=Desengrasante%20Destructor"],
    visiblePrice: false,
    packageSize: "1 Gallon",
    categorySlug: "super-heavy-duty-concentrate",
    variants: [
      {
        name: "1 Gallon",
        price: 0,
        stock: 0,
        sortOrder: 10,
        sku: "101295-50000",
      },
    ],
  },
  {
    name: "Grout Guerrero",
    description: "Porcelain & tile cleaner for restrooms.",
    price: 0,
    stock: 0,
    images: ["https://placehold.co/1200x900?text=Grout%20Guerrero"],
    visiblePrice: false,
    packageSize: "1 Gallon | One Quart",
    categorySlug: "porcelain-tile-cleaners",
    variants: [
      {
        name: "1 Gallon",
        price: 0,
        stock: 0,
        sortOrder: 10,
        sku: "100926-50000",
      },
      {
        name: "One Quart",
        price: 0,
        stock: 0,
        sortOrder: 20,
        sku: "100926-50000",
      },
    ],
  },
  {
    name: "Pisos Perfectos",
    description: "Neutral floor cleaner for daily maintenance.",
    price: 0,
    stock: 0,
    images: ["https://placehold.co/1200x900?text=Pisos%20Perfectos"],
    visiblePrice: false,
    packageSize: "1 Gallon",
    categorySlug: "neutral-cleaners",
    variants: [
      {
        name: "1 Gallon",
        price: 0,
        stock: 0,
        sortOrder: 10,
        sku: "101217-500000",
      },
    ],
  },
  {
    name: "Removedor Robusto",
    description: "Fast-acting floor finish stripper.",
    price: 0,
    stock: 0,
    images: ["https://placehold.co/1200x900?text=Removedor%20Robusto"],
    visiblePrice: false,
    packageSize: "5 Gallon | 1 Gallon",
    categorySlug: "floor-strippers",
    variants: [
      {
        name: "5 Gallon",
        price: 0,
        stock: 0,
        sortOrder: 10,
        sku: "100698-500000",
      },
      {
        name: "1 Gallon",
        price: 0,
        stock: 0,
        sortOrder: 20,
        sku: "100698-500000",
      },
    ],
  },
  {
    name: "Toilet Total",
    description: "Non-acid bowl & restroom cleaner.",
    price: 0,
    stock: 0,
    images: ["https://placehold.co/1200x900?text=Toilet%20Total"],
    visiblePrice: false,
    packageSize: "One Quart",
    categorySlug: "non-acid-bathroom-bowl-cleaners",
    variants: [
      {
        name: "One Quart",
        price: 0,
        stock: 0,
        sortOrder: 10,
        sku: "100975-500000",
      },
    ],
  },
];

// -------------------- load from JSON (optional) --------------------
function loadProductsJson(): SeedProduct[] {
  try {
    const file = path.resolve(process.cwd(), "prisma", "products.seed.json");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
      throw new Error("Invalid products JSON structure");
    return parsed as SeedProduct[];
  } catch (e: any) {
    console.warn(
      "⚠ products.seed.json not found or invalid. Using fallback list.",
      e?.message || e
    );
    return FALLBACK_PRODUCTS;
  }
}

// -------------------- upsert product (TUDO dentro desta função) --------------------
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
    price: p.price ?? 0, // baseline 0 (quote-only)
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

  // ----- single category link -----
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

  // ----- Variants (somente se feature ativa E modelo existe no Client) -----
  if (FEATURE_VARIANTS) {
    const hasVariantModel =
      !!(db as any)?._dmmf?.modelMap?.ProductVariant ||
      !!(db as any).productVariant;

    if (!hasVariantModel) {
      console.warn(
        "⚠ FEATURE_VARIANTS=1, mas @prisma/client atual não tem o model ProductVariant. Rode `npx prisma generate` (com schema contendo o model) e reinicie."
      );
    } else {
      await (db as any).productVariant.deleteMany({ where: { productId } });
      const vs = Array.isArray(p.variants) ? p.variants : [];
      if (vs.length) {
        await (db as any).productVariant.createMany({
          data: vs.map((v: SeedVariant, idx: number) => ({
            productId,
            name: v.name,
            price: v.price ?? 0,
            stock: v.stock ?? 0,
            sortOrder: v.sortOrder ?? (idx + 1) * 10,
            active: v.active ?? true,
            sku: v.sku ?? null,
          })),
        });
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
