import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Admin padrão
  const password = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { email: 'admin@listo365.com' },
    update: {},
    create: { email: 'admin@listo365.com', name: 'Admin', password },
  });

  // Categoria + produtos exemplo
  const cleaning = await prisma.category.upsert({
    where: { slug: 'cleaning' },
    update: {},
    create: { name: 'Cleaning', slug: 'cleaning' },
  });

  const products = [
    { name: 'Multi-Surface Cleaner 1L', slug: 'multi-surface-cleaner-1l', description: 'Limpeza diária multiuso.', price: 29.9, imageUrl: 'https://picsum.photos/seed/cleaner1/800/600', stock: 100 },
    { name: 'Glass & Window Spray 500ml', slug: 'glass-window-spray-500ml', description: 'Limpeza de vidros sem marcas.', price: 24.5, imageUrl: 'https://picsum.photos/seed/glass1/800/600', stock: 80 },
  ];

  for (const p of products) {
    const prod = await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: p,
    });
    await prisma.productCategory.upsert({
      where: { productId_categoryId: { productId: prod.id, categoryId: cleaning.id } },
      update: {},
      create: { productId: prod.id, categoryId: cleaning.id },
    });
  }

  console.log('Seed concluído.');
}

main().finally(() => prisma.$disconnect());
