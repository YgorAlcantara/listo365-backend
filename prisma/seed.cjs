// prisma/seed.cjs
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  // Admin (idempotente)
  const email = 'admin@listo365.com';
  const password = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, password, name: 'Admin', role: 'ADMIN' },
  });

  // Produtos demo (idempotente por slug)
  await prisma.product.upsert({
    where: { slug: 'all-purpose-cleaner' },
    update: {},
    create: {
      name: 'All-Purpose Cleaner',
      slug: 'all-purpose-cleaner',
      description: 'Versatile surface cleaner for daily use.',
      price: 12.99,
      imageUrl: 'https://images.unsplash.com/photo-1581578017421-cc63ea4b3bbc?q=80&w=800',
      stock: 120,
      active: true,
    },
  });

  await prisma.product.upsert({
    where: { slug: 'industrial-degreaser' },
    update: {},
    create: {
      name: 'Industrial Degreaser',
      slug: 'industrial-degreaser',
      description: 'Heavy-duty degreaser for kitchen and machinery.',
      price: 24.5,
      imageUrl: 'https://images.unsplash.com/photo-1585386959984-a4155223168f?q=80&w=800',
      stock: 80,
      active: true,
    },
  });

  console.log('Seed completed.');
}
main().catch((e) => {
  console.error('Seed error:', e);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
