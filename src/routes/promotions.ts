// src/routes/promotions.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";

export const promotions = Router();

promotions.get("/", async (_req, res) => {
  try {
    const now = new Date();
    const list = await prisma.promotion.findMany({
      where: { active: true, startsAt: { lte: now }, endsAt: { gte: now } },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            price: true,
            imageUrl: true,
            images: true, // relation
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
    });

    res.json(list);
  } catch (e: any) {
    console.error("promotions list error:", e?.message || e);
    res.status(500).json({ error: "Failed to load promotions" });
  }
});
