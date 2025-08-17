import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";
import type { Prisma } from "@prisma/client";

export const orders = Router();

const StatusEnum = z.enum([
  "RECEIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "REFUSED",
  "CANCELLED",
]);
type OrderStatus = z.infer<typeof StatusEnum>;

// include padrão dos pedidos
function buildOrderInclude() {
  return {
    customer: true,
    address: true,
    items: {
      include: {
        product: { select: { id: true, name: true, slug: true, stock: true } },
      },
      orderBy: { id: "asc" as const },
    },
  } as const;
}

// GET /orders (ADMIN) — paginação, busca, filtros
orders.get("/", requireAdmin, async (req: Request, res: Response) => {
  const Query = z.object({
    q: z.string().optional(),
    status: StatusEnum.optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  });

  const { q, status, page, pageSize } = Query.parse(req.query);

  const where: any = {};
  if (status) where.status = status;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { id: { contains: term, mode: "insensitive" } },
      { note: { contains: term, mode: "insensitive" } },
      { adminNote: { contains: term, mode: "insensitive" } },
      { customer: { name: { contains: term, mode: "insensitive" } } },
      { customer: { email: { contains: term, mode: "insensitive" } } },
      { customer: { phone: { contains: term, mode: "insensitive" } } },
    ];
  }

  const [total, rows] = await prisma.$transaction([
    prisma.orderInquiry.count({ where }),
    prisma.orderInquiry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: buildOrderInclude(),
    }),
  ]);

  res.json({ total, page, pageSize, rows });
});

// GET /orders/:id (ADMIN) — detalhe
orders.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  const order = await prisma.orderInquiry.findUnique({
    where: { id },
    include: buildOrderInclude(),
  });
  if (!order) return res.status(404).json({ error: "not_found" });
  res.json(order);
});

// PATCH /orders/:id/status (ADMIN) — ajusta estoque ao mudar para/desde COMPLETED
orders.patch(
  "/:id/status",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const Body = z.object({ status: StatusEnum });
    const { status: next } = Body.parse(req.body);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const current = await tx.orderInquiry.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!current) throw new Error("not_found");

      const prev = current.status as OrderStatus;

      // Sai de COMPLETED -> repõe estoque
      if (prev === "COMPLETED" && next !== "COMPLETED") {
        for (const it of current.items) {
          await tx.product.update({
            where: { id: it.productId },
            data: { stock: { increment: it.quantity } },
          });
        }
      }

      // Entra em COMPLETED -> baixa estoque
      if (prev !== "COMPLETED" && next === "COMPLETED") {
        for (const it of current.items) {
          await tx.product.update({
            where: { id: it.productId },
            data: { stock: { decrement: it.quantity } },
          });
        }
      }

      await tx.orderInquiry.update({ where: { id }, data: { status: next } });
    });

    const updated = await prisma.orderInquiry.findUnique({
      where: { id },
      include: buildOrderInclude(),
    });

    res.json(updated);
  }
);

// PATCH /orders/:id/note (ADMIN) — notas públicas/admin
orders.patch("/:id/note", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  const Body = z.object({
    note: z.string().optional(),
    adminNote: z.string().optional(),
  });
  const { note, adminNote } = Body.parse(req.body);

  const up = await prisma.orderInquiry.update({
    where: { id },
    data: { note: note ?? null, adminNote: adminNote ?? null },
    include: buildOrderInclude(),
  });

  res.json(up);
});

// POST /orders (público) — cria um pedido/inquiry com cliente/endereço/itens
orders.post("/", async (req: Request, res: Response) => {
  const Body = z.object({
    customer: z.object({
      name: z.string().min(2),
      email: z.string().email(),
      phone: z.string().optional(),
      marketingOptIn: z.boolean().default(false),
      address: z
        .object({
          line1: z.string().min(1),
          line2: z.string().optional(),
          city: z.string().min(1),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          country: z.string().min(2),
        })
        .optional(),
    }),
    note: z.string().optional(),
    recurrence: z.string().optional(),
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().positive(),
          unitPrice: z.number().nonnegative(),
        })
      )
      .min(1),
  });

  const body = Body.parse(req.body);

  const created = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // upsert customer por email
      const customer = await tx.customer.upsert({
        where: { email: body.customer.email },
        update: {
          name: body.customer.name,
          phone: body.customer.phone ?? null,
          marketingOptIn: body.customer.marketingOptIn,
        },
        create: {
          name: body.customer.name,
          email: body.customer.email,
          phone: body.customer.phone ?? null,
          marketingOptIn: body.customer.marketingOptIn,
        },
      });

      // endereço opcional
      let addressId: string | null = null;
      if (body.customer.address) {
        const addr = await tx.address.create({
          data: {
            customerId: customer.id,
            line1: body.customer.address.line1,
            line2: body.customer.address.line2 ?? null,
            city: body.customer.address.city,
            state: body.customer.address.state ?? null,
            postalCode: body.customer.address.postalCode ?? null,
            country: body.customer.address.country,
            isPrimary: true,
          },
        });
        addressId = addr.id;
      }

      // cabeçalho do pedido
      const order = await tx.orderInquiry.create({
        data: {
          customerId: customer.id,
          addressId,
          status: "RECEIVED",
          note: body.note ?? null,
          adminNote: null,
          recurrence: body.recurrence ?? null,
        },
      });

      // itens (Decimal: pode enviar number diretamente no Prisma v6)
      await tx.orderItem.createMany({
        data: body.items.map((it) => ({
          orderId: order.id,
          productId: it.productId,
          quantity: it.quantity,
          unitPrice: it.unitPrice, // sem Prisma.Decimal
        })),
      });

      return order;
    }
  );

  const full = await prisma.orderInquiry.findUnique({
    where: { id: created.id },
    include: buildOrderInclude(),
  });

  res.status(201).json(full);
});
