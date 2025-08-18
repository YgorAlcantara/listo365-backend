// src/routes/orders.ts
import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/auth";
import { z } from "zod";
import { Prisma } from "@prisma/client"; // <<< ADICIONE ESTA LINHA

export const orders = Router();

// ping
orders.get("/_ping", (_req, res) =>
  res.json({ ok: true, scope: "orders-router" })
);

type OrderStatus =
  | "RECEIVED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "REFUSED"
  | "CANCELLED";

const STATUS_VALUES: OrderStatus[] = [
  "RECEIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "REFUSED",
  "CANCELLED",
];

// ---------- helpers ----------
async function applyStockDelta(
  tx: Prisma.TransactionClient, // <<< AQUI: era typeof prisma
  items: Array<{ productId: string; quantity: number }>,
  direction: "dec" | "inc"
) {
  for (const it of items) {
    const delta = direction === "dec" ? -it.quantity : it.quantity;
    await tx.product.update({
      where: { id: it.productId },
      data: { stock: { increment: delta } },
    });
  }
}

function calcTotals(items: Array<{ quantity: number; unitPrice: number }>) {
  const subtotal = items.reduce(
    (acc, it) => acc + it.quantity * (Number(it.unitPrice) || 0),
    0
  );
  return {
    subtotal: Number(subtotal.toFixed(2)),
    total: Number(subtotal.toFixed(2)),
  };
}

// =============== LIST ===============
orders.get("/", requireAdmin, async (req: Request, res: Response) => {
  const Query = z.object({
    q: z.string().optional(),
    status: z.enum(STATUS_VALUES as [OrderStatus, ...OrderStatus[]]).optional(),
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
      { customerName: { contains: term, mode: "insensitive" } },
      { customerEmail: { contains: term, mode: "insensitive" } },
      { customerPhone: { contains: term, mode: "insensitive" } },
    ];
  }

  const [total, rows] = await prisma.$transaction([
    prisma.orderInquiry.count({ where }),
    prisma.orderInquiry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        customer: true,
        items: {
          select: {
            id: true,
            quantity: true,
            unitPrice: true,
            productId: true,
          },
        },
      },
    }),
  ]);

  res.json({ total, page, pageSize, rows });
});

// =============== DETAIL ===============
orders.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  const o = await prisma.orderInquiry.findUnique({
    where: { id },
    include: {
      customer: true,
      address: true,
      items: {
        include: {
          product: { select: { id: true, name: true, slug: true } },
        },
      },
    },
  });
  if (!o) return res.status(404).json({ error: "not_found" });
  res.json(o);
});

// =============== CREATE (public) ===============
orders.post("/", async (req: Request, res: Response) => {
  const Body = z.object({
    customer: z.object({
      name: z.string().min(2),
      email: z.string().email(),
      phone: z.string().optional().nullable(),
      marketingOptIn: z.boolean().optional().default(false),
      company: z.string().optional().nullable(),
    }),
    address: z
      .object({
        line1: z.string().min(2),
        line2: z.string().optional().nullable(),
        district: z.string().optional().nullable(),
        city: z.string().min(1),
        state: z.string().optional().nullable(),
        postalCode: z.string().optional().nullable(),
        country: z.string().optional().default("US"),
      })
      .optional()
      .nullable(),
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().positive(),
          unitPrice: z.number().nonnegative().default(0),
        })
      )
      .min(1),
    note: z.string().max(1000).optional().nullable(),
    recurrence: z.string().optional().nullable(),
  });

  const body = Body.parse(req.body);
  const totals = calcTotals(body.items);

  const created = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.upsert({
      where: { email: body.customer.email },
      update: {
        name: body.customer.name,
        phone: body.customer.phone ?? undefined,
        company: body.customer.company ?? undefined,
        marketingOptIn: body.customer.marketingOptIn ?? false,
      },
      create: {
        email: body.customer.email,
        name: body.customer.name,
        phone: body.customer.phone ?? undefined,
        company: body.customer.company ?? undefined,
        marketingOptIn: body.customer.marketingOptIn ?? false,
      },
    });

    let addressId: string | null = null;
    if (body.address) {
      const addr = await tx.address.create({
        data: {
          customerId: customer.id,
          line1: body.address.line1,
          line2: body.address.line2 ?? undefined,
          district: body.address.district ?? undefined,
          city: body.address.city,
          state: body.address.state ?? undefined,
          postalCode: body.address.postalCode ?? undefined,
          country: body.address.country ?? "US",
        },
        select: { id: true },
      });
      addressId = addr.id;
    }

    const order = await tx.orderInquiry.create({
      data: {
        customerId: customer.id,
        addressId,
        status: "RECEIVED",
        note: body.note ?? null,
        adminNote: null,
        recurrence: body.recurrence ?? null,

        // snapshot
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone ?? null,

        subtotal: totals.subtotal,
        total: totals.total,
        currency: "USD",

        items: {
          create: body.items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
            unitPrice: it.unitPrice ?? 0,
          })),
        },
      },
      include: {
        customer: true,
        address: true,
        items: true,
      },
    });

    return order;
  });

  res.status(201).json(created);
});

// =============== CHANGE STATUS (ADMIN) ===============
orders.patch(
  "/:id/status",
  requireAdmin,
  async (req: Request, res: Response) => {
    const Body = z.object({
      status: z.enum(STATUS_VALUES as [OrderStatus, ...OrderStatus[]]),
    });
    const { status: next } = Body.parse(req.body);
    const id = req.params.id;

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.orderInquiry.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!current) throw new Error("not_found");

      const prev = current.status as OrderStatus;

      if (prev !== "COMPLETED" && next === "COMPLETED") {
        await applyStockDelta(
          tx,
          current.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
          })),
          "dec"
        );
      } else if (prev === "COMPLETED" && next !== "COMPLETED") {
        await applyStockDelta(
          tx,
          current.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
          })),
          "inc"
        );
      }

      return tx.orderInquiry.update({
        where: { id },
        data: { status: next },
      });
    });

    res.json({ ok: true, status: updated.status });
  }
);

// =============== NOTES (ADMIN) ===============
orders.patch("/:id/note", requireAdmin, async (req: Request, res: Response) => {
  const Body = z.object({
    note: z.string().max(2000).optional().nullable(),
    adminNote: z.string().max(4000).optional().nullable(),
  });
  const { note, adminNote } = Body.parse(req.body);
  const id = req.params.id;

  await prisma.orderInquiry.update({
    where: { id },
    data: {
      note: note ?? null,
      adminNote: adminNote ?? null,
    },
  });

  res.json({ ok: true });
});
