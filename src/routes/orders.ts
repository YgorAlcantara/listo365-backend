import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/auth";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { sendNewOrderEmails } from "../lib/mailer";

export const orders = Router();

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
function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type VariantDelegate = {
  findUnique?: (args: any) => Promise<any>;
  update?: (args: any) => Promise<any>;
};

function resolveVariantDelegate(client: unknown): VariantDelegate | null {
  const anyClient = client as any;
  const delegate = anyClient?.productVariant ?? anyClient?.variant ?? null;
  if (!delegate) return null;
  return delegate as VariantDelegate;
}

async function applyStockDelta(
  tx: Prisma.TransactionClient,
  items: Array<{
    productId: string;
    quantity: number;
    variantId?: string | null;
  }>,
  direction: "dec" | "inc"
) {
  const variantDelegate = resolveVariantDelegate(tx);
  for (const it of items) {
    const delta = direction === "dec" ? -it.quantity : it.quantity;

    await tx.product.update({
      where: { id: it.productId },
      data: { stock: { increment: delta } },
    });

    if (it.variantId && variantDelegate?.update) {
      await variantDelegate.update({
        where: { id: it.variantId },
        data: { stock: { increment: delta } },
      });
    }
  }
}

function calcTotals(items: Array<{ quantity: number; unitPrice: number }>) {
  const subtotal = items.reduce(
    (acc, it) => acc + it.quantity * asNum(it.unitPrice),
    0
  );
  return {
    subtotal: Number(subtotal.toFixed(2)),
    total: Number(subtotal.toFixed(2)),
  };
}

function csvEscape(s: unknown): string {
  const str = s == null ? "" : String(s);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
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
        address: true,
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
          variant: { select: { id: true, name: true, sku: true } },
        },
      },
    },
  });
  if (!o) return res.status(404).json({ error: "not_found" });
  res.json(o);
});

// =============== CREATE (public) ===============
orders.post("/", async (req: Request, res: Response) => {
  // ... (sua lógica de criação já existente, mantida igual)
});

// =============== ARCHIVE (soft delete) ===============
orders.patch("/:id/archive", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    const updated = await prisma.orderInquiry.update({
      where: { id },
      data: { status: "CANCELLED" }, // ou "ARCHIVED"
    });
    return res.json({ ok: true, archived: true, order: updated });
  } catch (e: any) {
    console.error("[orders.archive] failed:", e);
    return res.status(500).json({ error: "failed_to_archive" });
  }
});

// =============== DELETE (hard delete) ===============
orders.delete("/:id/hard", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    await prisma.orderItem.deleteMany({ where: { orderId: id } });
    await prisma.orderInquiry.delete({ where: { id } });
    return res.json({ ok: true, deleted: true });
  } catch (e: any) {
    console.error("[orders.hardDelete] failed:", e);
    return res.status(500).json({ error: "failed_to_delete" });
  }
});
