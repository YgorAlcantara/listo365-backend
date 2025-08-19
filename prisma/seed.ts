// prisma/seed.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const db = new PrismaClient({
  log: ["error"],
  datasources: {
    db: {
      // usa DIRECT_URL (sem pooler) se existir, senão cai no DATABASE_URL
      url: process.env.DIRECT_URL || process.env.DATABASE_URL!,
    },
  },
});

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function ensureAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@listo365.com";
  const password = process.env.SEED_ADMIN_PASSWORD || "Admin#123";
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
    console.log(`✅ Admin updated (password reset): ${email}`);
  }
}

type P = {
  name: string;
  description: string;
  price: number;
  stock: number;
  packageSize?: string;
  pdfUrl?: string;
  images: string[]; // [principal, ...outras]
  visiblePrice?: boolean;
  visiblePackageSize?: boolean;
  visiblePdf?: boolean;
  visibleImages?: boolean;
  visibleDescription?: boolean;
};

const PRODUCTS: P[] = [
  {
    name: "Sodium Hypochlorite 12%",
    description: "High-grade bleach for industrial cleaning and sanitation.",
    price: 99.9,
    stock: 120,
    packageSize: "20 L",
    pdfUrl: "https://SEU-DOMINIO/files/sodium-hypochlorite.pdf",
    images: [
      "https://SEU-DOMINIO/images/sodium-1.jpg",
      "https://SEU-DOMINIO/images/sodium-2.jpg",
      "https://SEU-DOMINIO/images/sodium-3.jpg",
    ],
    visiblePrice: false,
    visiblePackageSize: true,
    visiblePdf: true,
    visibleImages: true,
    visibleDescription: true,
  },
  {
    name: "Hydrogen Peroxide 35%",
    description: "Food-grade H2O2 suitable for various industrial processes.",
    price: 149.0,
    stock: 80,
    packageSize: "5 L",
    pdfUrl: "https://SEU-DOMINIO/files/hydrogen-peroxide.pdf",
    images: [
      "https://SEU-DOMINIO/images/h2o2-1.jpg",
      "https://SEU-DOMINIO/images/h2o2-2.jpg",
    ],
    visiblePrice: false,
    visiblePackageSize: true,
    visiblePdf: true,
    visibleImages: true,
    visibleDescription: true,
  },
  // adicione os outros 6 aqui
];

async function upsertProduct(p: P, i: number) {
  const slug = slugify(p.name);
  const principal = p.images[0] ?? "";

  const found = await db.product.findUnique({ where: { slug } });
  if (found) {
    const data: any = {
      name: p.name,
      description: p.description,
      price: p.price,
      stock: p.stock,
      packageSize: p.packageSize,
      pdfUrl: p.pdfUrl,
      imageUrl: principal,
      sortOrder: (i + 1) * 10,
      active: true,
    };
    if ("visiblePrice" in p) data.visiblePrice = p.visiblePrice;
    if ("visiblePackageSize" in p)
      data.visiblePackageSize = p.visiblePackageSize;
    if ("visiblePdf" in p) data.visiblePdf = p.visiblePdf;
    if ("visibleImages" in p) data.visibleImages = p.visibleImages;
    if ("visibleDescription" in p)
      data.visibleDescription = p.visibleDescription;

    await db.product.update({ where: { slug }, data });

    await db.productImage.deleteMany({ where: { productId: found.id } });
    if (p.images.length) {
      await db.productImage.createMany({
        data: p.images.map((url, idx) => ({
          productId: found.id,
          url,
          sortOrder: (idx + 1) * 10,
        })),
      });
    }
    console.log(`↻ Updated product: ${p.name}`);
    return;
  }

  const created = await db.product.create({
    data: {
      name: p.name,
      slug,
      description: p.description,
      price: p.price,
      stock: p.stock,
      active: true,
      packageSize: p.packageSize,
      pdfUrl: p.pdfUrl,
      imageUrl: principal,
      sortOrder: (i + 1) * 10,
      ...(p.visiblePrice !== undefined ? { visiblePrice: p.visiblePrice } : {}),
      ...(p.visiblePackageSize !== undefined
        ? { visiblePackageSize: p.visiblePackageSize }
        : {}),
      ...(p.visiblePdf !== undefined ? { visiblePdf: p.visiblePdf } : {}),
      ...(p.visibleImages !== undefined
        ? { visibleImages: p.visibleImages }
        : {}),
      ...(p.visibleDescription !== undefined
        ? { visibleDescription: p.visibleDescription }
        : {}),
    },
  });

  if (p.images.length) {
    await db.productImage.createMany({
      data: p.images.map((url, idx) => ({
        productId: created.id,
        url,
        sortOrder: (idx + 1) * 10,
      })),
    });
  }
  console.log(`✅ Created product: ${p.name}`);
}

async function main() {
  await ensureAdmin();
  for (let i = 0; i < PRODUCTS.length; i++) {
    await upsertProduct(PRODUCTS[i], i);
  }
  console.log("✔ Seed finished");
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
