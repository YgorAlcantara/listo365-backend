import { Router } from "express";
import { prisma } from "../lib/prisma";

export const promotions = Router();

promotions.get("/", async (_req, res) => {
  try {
    const now = new Date();
    const list = await prisma.promotion.findMany({
      where: {
        active: true,
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            price: true,
            imageUrl: true,
            images: true,
            packageSize: true,
            visiblePrice: true,
            visiblePackageSize: true,
            visiblePdf: true,
            visibleImages: true,
            visibleDescription: true,
          },
        },
      },
      orderBy: { startsAt: "desc" },
      // se quiser limitar:
      // take: 50,
    });

    res.json(list);
  } catch (e: any) {
    console.error("promotions list error:", e?.message || e);
    // Retorna 500 (ou [] se preferir não quebrar vitrine)
    res.status(500).json({ error: "Failed to load promotions" });
    // ou: res.json([]);
  }
});
