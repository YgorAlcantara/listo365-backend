// prisma/seed.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

// Preferir DIRECT_URL para seeds/migrations (sem pooler)
const db = new PrismaClient({
  log: ["error"],
  datasources: {
    db: {
      url: process.env.DIRECT_URL || process.env.DATABASE_URL!,
    },
  },
});

const FEATURE_VARIANTS = process.env.FEATURE_VARIANTS === "1";

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
    // Atualiza para manter senha/role consistentes em dev
    await db.user.update({
      where: { email },
      data: { password: hash, name, role: "ADMIN" },
    });
    console.log(`↻ Admin updated: ${email}`);
  }
}

type CatSeed = { name: string; children?: string[] };
const CATEGORY_TREE: CatSeed[] = [
  {
    name: "Floor Care",
    children: [
      "Floor Finishes",
      "Floor Strippers",
      "Neutral & Specialty Cleaners",
    ],
  },
  {
    name: "Bathroom Cleaners",
    children: ["Acid Bathroom Cleaners", "Non-Acid Bathroom & Bowl Cleaners"],
  },
  { name: "Glass Cleaners", children: ["Ready-To-Use on Glass"] },
  { name: "Carpet Care", children: ["Pre-Treatment"] },
  { name: "Cleaners/Degreasers", children: ["Super Heavy Duty Concentrate"] },
];

async function upsertCategories() {
  const idMap = new Map<string, string>(); // slug -> id

  for (const parent of CATEGORY_TREE) {
    const pslug = slugify(parent.name);
    const p = await db.category.upsert({
      where: { slug: pslug },
      create: { name: parent.name, slug: pslug },
      update: { name: parent.name },
    });
    idMap.set(pslug, p.id);

    for (const sub of parent.children ?? []) {
      const sslug = slugify(sub);
      const c = await db.category.upsert({
        where: { slug: sslug },
        create: { name: sub, slug: sslug, parentId: p.id },
        update: { name: sub, parentId: p.id },
      });
      idMap.set(sslug, c.id);
    }
  }

  console.log(`✅ Categories ensured (${idMap.size})`);
  return idMap;
}

// -------------------- data --------------------
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
  price: number;
  stock: number;
  packageSize?: string;
  pdfUrl?: string;
  images: string[];
  visiblePrice?: boolean;
  visiblePackageSize?: boolean;
  visiblePdf?: boolean;
  visibleImages?: boolean;
  visibleDescription?: boolean;
  categorySlug?: string; // opcional: vincular a uma subcategoria
  variants?: SeedVariant[]; // opcional: quando FEATURE_VARIANTS=1
};

// 8 produtos demo (alguns com preço oculto para "Request a quote")
const PRODUCTS: SeedProduct[] = [
  {
    name: "All-Purpose Cleaner",
    description: "Versatile surface cleaner for daily use.",
    price: 12.99,
    stock: 120,
    packageSize: "1 gal / 32 oz",
    pdfUrl: "https://example.com/files/all-purpose-cleaner.pdf",
    images: [
      "https://images.unsplash.com/photo-1581578017421-cc63ea4b3bbc?q=80&w=1200",
      "https://images.unsplash.com/photo-1584824486539-53bb4646bdbc?q=80&w=1200",
    ],
    visiblePrice: true,
    visiblePdf: true,
    categorySlug: "neutral-specialty-cleaners",
    variants: FEATURE_VARIANTS
      ? [
          { name: "32 oz", price: 5.49, stock: 300, sortOrder: 10 },
          { name: "1 gal", price: 12.99, stock: 120, sortOrder: 20 },
        ]
      : undefined,
  },
  {
    name: "Industrial Degreaser",
    description: "Heavy-duty degreaser for kitchen and machinery.",
    price: 24.5,
    stock: 80,
    packageSize: "1 gal",
    pdfUrl: "https://example.com/files/industrial-degreaser.pdf",
    images: [
      "https://images.unsplash.com/photo-1585386959984-a4155223168f?q=80&w=1200",
    ],
    visiblePrice: true,
    visiblePdf: true,
    categorySlug: "super-heavy-duty-concentrate",
  },
  {
    name: "Sodium Hypochlorite 12%",
    description: "High-grade bleach for industrial cleaning and sanitation.",
    price: 99.9,
    stock: 120,
    packageSize: "20 L",
    pdfUrl: "https://example.com/files/sodium-hypochlorite.pdf",
    images: [
      "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?q=80&w=1200",
      "https://images.unsplash.com/photo-1522335789203-b1dc0e48aa58?q=80&w=1200",
    ],
    visiblePrice: false, // quote-only
    visiblePdf: true,
    categorySlug: "non-acid-bathroom-bowl-cleaners",
    variants: FEATURE_VARIANTS
      ? [
          { name: "20 L", price: 99.9, stock: 120, sortOrder: 10 },
          { name: "200 L", price: 899.0, stock: 15, sortOrder: 20 },
        ]
      : undefined,
  },
  {
    name: "Hydrogen Peroxide 35%",
    description: "Food-grade H2O2 suitable for various industrial processes.",
    price: 149.0,
    stock: 80,
    packageSize: "5 L",
    pdfUrl: "https://example.com/files/hydrogen-peroxide.pdf",
    images: [
      "https://images.unsplash.com/photo-1608528577891-48b7361f0f2a?q=80&w=1200",
      "https://images.unsplash.com/photo-1581539250439-c96689b516dd?q=80&w=1200",
    ],
    visiblePrice: false,
    visiblePdf: true,
    categorySlug: "ready-to-use-on-glass",
  },
  {
    name: "Glass Cleaner RTU",
    description: "Ready-to-use glass cleaner for a streak-free finish.",
    price: 7.25,
    stock: 200,
    packageSize: "32 oz",
    images: [
      "https://images.unsplash.com/photo-1498354178607-a79df2916198?q=80&w=1200",
    ],
    visiblePrice: true,
    categorySlug: "ready-to-use-on-glass",
  },
  {
    name: "Floor Finish High-Gloss",
    description: "Durable, high-gloss finish ideal for high traffic areas.",
    price: 39.9,
    stock: 60,
    packageSize: "1 gal",
    images: [
      "https://images.unsplash.com/photo-1519710164239-da123dc03ef4?q=80&w=1200",
    ],
    visiblePrice: true,
    categorySlug: "floor-finishes",
  },
  {
    name: "Floor Stripper Concentrate",
    description: "Powerful stripper for removing old floor finishes.",
    price: 34.0,
    stock: 50,
    packageSize: "1 gal",
    images: [
      "https://images.unsplash.com/photo-1577415136625-98323107c6f6?q=80&w=1200",
    ],
    visiblePrice: true,
    categorySlug: "floor-strippers",
  },
  {
    name: "Carpet Pre-Treatment",
    description: "Pre-treatment for heavy soil and traffic lanes.",
    price: 18.75,
    stock: 150,
    packageSize: "32 oz",
    images: [
      "https://images.unsplash.com/photo-1602201622453-0d214a0a9cf8?q=80&w=1200",
    ],
    visiblePrice: true,
    categorySlug: "pre-treatment",
  },
];

// -------------------- upserts --------------------
async function upsertProduct(
  p: SeedProduct,
  i: number,
  categoryIdBySlug?: Map<string, string>
) {
  const slug = slugify(p.name);
  const cover = p.images[0] ?? "";
  const sortOrder = (i + 1) * 10;

  const found = await db.product.findUnique({ where: { slug } });

  // Dados base
  const baseData: any = {
    name: p.name,
    description: p.description,
    price: p.price,
    stock: p.stock,
    packageSize: p.packageSize,
    pdfUrl: p.pdfUrl,
    imageUrl: cover,
    sortOrder,
    active: true,
  };

  // Flags (se fornecidas)
  if ("visiblePrice" in p) baseData.visiblePrice = !!p.visiblePrice;
  if ("visiblePackageSize" in p)
    baseData.visiblePackageSize = !!p.visiblePackageSize;
  if ("visiblePdf" in p) baseData.visiblePdf = !!p.visiblePdf;
  if ("visibleImages" in p) baseData.visibleImages = !!p.visibleImages;
  if ("visibleDescription" in p)
    baseData.visibleDescription = !!p.visibleDescription;

  let productId: string;

  if (found) {
    await db.product.update({ where: { slug }, data: baseData });
    productId = found.id;
    console.log(`↻ Product updated: ${p.name}`);

    // Recria imagens
    await db.productImage.deleteMany({ where: { productId } });
    if (p.images.length) {
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
      data: { slug, ...baseData },
      select: { id: true },
    });
    productId = created.id;
    console.log(`✅ Product created: ${p.name}`);

    if (p.images.length) {
      await db.productImage.createMany({
        data: p.images.map((url, idx) => ({
          productId,
          url,
          sortOrder: (idx + 1) * 10,
        })),
      });
    }
  }

  // Categoria (primeira categoria)
  if (categoryIdBySlug) {
    await db.productCategory.deleteMany({ where: { productId } });
    const catSlug = p.categorySlug ? slugify(p.categorySlug) : null;
    const catId = catSlug ? categoryIdBySlug.get(catSlug) : undefined;
    if (catId) {
      await db.productCategory.create({
        data: { productId, categoryId: catId },
      });
    }
  }

  // Variants
  if (FEATURE_VARIANTS) {
    // Apaga e recria idempotente (dados demo)
    await db.productVariant.deleteMany({ where: { productId } });
    const vs = Array.isArray(p.variants) ? p.variants : [];
    if (vs.length) {
      await db.productVariant.createMany({
        data: vs.map((v, idx) => ({
          productId,
          name: v.name,
          price: v.price,
          stock: v.stock ?? 0,
          sortOrder: v.sortOrder ?? (idx + 1) * 10,
          active: v.active ?? true,
          sku: v.sku ?? null,
        })),
      });
    }
  }
}

// -------------------- entrypoint --------------------
export async function runSeed() {
  await ensureAdmin();
  const categoryIdBySlug = await upsertCategories();

  for (let i = 0; i < PRODUCTS.length; i++) {
    await upsertProduct(PRODUCTS[i], i, categoryIdBySlug);
  }

  console.log("✔ Seed finished");
}

export default runSeed;

// Permite: `ts-node prisma/seed.ts` ou node dist/prisma/seed.js
if (require.main === module) {
  runSeed()
    .then(() => db.$disconnect())
    .catch(async (e) => {
      console.error(e);
      await db.$disconnect();
      process.exit(1);
    });
}
