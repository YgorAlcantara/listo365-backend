// src/routes/categories.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";

export const categories = Router();

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Lista pais com filhos
categories.get("/", async (_req, res) => {
  const roots = await prisma.category.findMany({
    where: { parentId: null },
    orderBy: { name: "asc" },
    include: { children: { orderBy: { name: "asc" } } },
  });
  res.json(roots);
});

// Seed da árvore “default”
categories.post("/seed", requireAdmin, async (_req, res) => {
  const tree: Array<{ name: string; children?: string[] }> = [
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

  for (const parent of tree) {
    const p = await prisma.category.upsert({
      where: { slug: slugify(parent.name) },
      create: { name: parent.name, slug: slugify(parent.name) },
      update: {},
    });
    for (const childName of parent.children ?? []) {
      await prisma.category.upsert({
        where: { slug: slugify(childName) },
        create: { name: childName, slug: slugify(childName), parentId: p.id },
        update: { parentId: p.id },
      });
    }
  }
  res.json({ ok: true });
});

// Criar categoria (parent ou sub)
categories.post("/", requireAdmin, async (req, res) => {
  const body = z
    .object({ name: z.string().min(2), parentId: z.string().optional() })
    .parse(req.body);
  const created = await prisma.category.create({
    data: {
      name: body.name,
      slug: slugify(body.name),
      parentId: body.parentId || null,
    },
    include: { children: true, parent: true },
  });
  res.status(201).json(created);
});
