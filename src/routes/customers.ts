import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/auth";
import { z } from "zod";

export const customers = Router();

// GET /customers (ADMIN) — lista com paginação e busca
customers.get("/", requireAdmin, async (req: Request, res: Response) => {
  const Query = z.object({
    q: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  });
  const { q, page, pageSize } = Query.parse(req.query);

  const where: any = {};
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
      { phone: { contains: term, mode: "insensitive" } },
    ];
  }

  const [total, rows] = await prisma.$transaction([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { addresses: { orderBy: { createdAt: "desc" } } },
    }),
  ]);

  res.json({ total, page, pageSize, rows });
});

// GET /customers/:id (ADMIN) — detalhe + últimos pedidos
customers.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  const c = await prisma.customer.findUnique({
    where: { id },
    include: {
      addresses: true,
      OrderInquiry: {
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          items: {
            include: {
              product: { select: { id: true, name: true, slug: true } },
            },
          },
          address: true,
        },
      },
    },
  });
  if (!c) return res.status(404).json({ error: "not_found" });
  res.json(c);
});

// GET /customers/export/csv (ADMIN) — contatos opt-in
customers.get(
  "/export/csv",
  requireAdmin,
  async (_req: Request, res: Response) => {
    const list = await prisma.customer.findMany({
      where: { marketingOptIn: true },
      orderBy: { createdAt: "desc" },
      select: { name: true, email: true, phone: true, createdAt: true },
    });

    const lines: string[] = [];
    lines.push(["Name", "Email", "Phone", "CreatedAt"].join(","));
    for (const c of list) {
      // CSV simples usando JSON.stringify para escapar
      const name = JSON.stringify(c.name ?? "");
      const email = JSON.stringify(c.email ?? "");
      const phone = JSON.stringify(c.phone ?? "");
      const created = JSON.stringify(new Date(c.createdAt).toISOString());
      lines.push([name, email, phone, created].join(","));
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="contacts-optin.csv"'
    );
    res.send(csv);
  }
);
