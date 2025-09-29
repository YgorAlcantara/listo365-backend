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
  const Body = z.object({
    customer: z.object({
      name: z.string().min(2, "Please enter at least 2 characters."),
      email: z.string().email("Enter a valid email address."),
      phone: z.string().optional().nullable(),
      marketingOptIn: z.boolean().optional().default(false),
      company: z.string().optional().nullable(),
    }),
    address: z
      .object({
        line1: z.string().min(2, "Please enter at least 2 characters."),
        line2: z.string().optional().nullable(),
        district: z.string().optional().nullable(),
        city: z.string().min(1, "City is required."),
        state: z.string().optional().nullable(),
        postalCode: z.string().optional().nullable(),
        country: z.string().optional().default("US"),
      })
      .optional()
      .nullable(),
    items: z
      .array(
        z.object({
          productId: z.string().min(1, "Missing productId."),
          quantity: z.number().int().positive("Quantity must be positive."),
          unitPrice: z.number().nonnegative().optional(),
          variantId: z.string().optional().nullable(),
          variantName: z.string().optional().nullable(),
        })
      )
      .min(1, "Provide at least one item."),
    note: z.string().max(1000, "Max 1000 characters.").optional().nullable(),
    recurrence: z.string().optional().nullable(),
  });

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", issues: parsed.error.issues });
  }
  const body = parsed.data;

  try {
    const variantDelegate = resolveVariantDelegate(prisma);

    const hydratedItems = await Promise.all(
      body.items.map(async (it) => {
        if (it.variantId && variantDelegate?.findUnique) {
          const variant = await variantDelegate.findUnique({
            where: { id: it.variantId },
          });
          if (!variant) {
            const err: any = new Error("Variant not found.");
            err.code = "VARIANT_NOT_FOUND";
            throw err;
          }
          const priceFromVariant = Number(variant?.price ?? 0);
          return {
            ...it,
            unitPrice:
              typeof it.unitPrice === "number"
                ? it.unitPrice
                : priceFromVariant,
          };
        }

        const product = await prisma.product.findUnique({
          where: { id: it.productId },
          select: { price: true },
        });
        const priceFromProduct = Number(product?.price ?? 0);
        return {
          ...it,
          unitPrice:
            typeof it.unitPrice === "number" ? it.unitPrice : priceFromProduct,
        };
      })
    );

    const totals = calcTotals(hydratedItems);

    const created = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.upsert({
        where: { email: body.customer.email.toLowerCase() },
        update: {
          name: body.customer.name,
          phone: body.customer.phone ?? undefined,
          company: body.customer.company ?? undefined,
          marketingOptIn: body.customer.marketingOptIn ?? false,
        },
        create: {
          email: body.customer.email.toLowerCase(),
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
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone ?? null,
          subtotal: totals.subtotal,
          total: totals.total,
          currency: "USD",
          items: {
            create: hydratedItems.map((it) => {
              const base: any = {
                productId: it.productId,
                quantity: it.quantity,
                unitPrice: it.unitPrice ?? 0,
              };
              if (it.variantId) {
                base.variantId = it.variantId;
              }
              return base;
            }),
          },
        },
        include: {
          customer: true,
          address: true,
          items: {
            include: {
              product: { select: { name: true } },
              variant: { select: { name: true, sku: true } },
            },
          },
        },
      });

      return order;
    });

    try {
      await sendNewOrderEmails({
        id: created.id,
        createdAt: created.createdAt.toISOString(),
        status: created.status,
        subtotal: Number(created.subtotal),
        total: Number(created.total),
        customer: {
          name: created.customer?.name || "",
          email: created.customer?.email || "",
          phone: created.customer?.phone || null,
          company: created.customer?.company || null,
          marketingOptIn: !!created.customer?.marketingOptIn,
        },
        address: created.address
          ? {
              line1: created.address.line1,
              line2: created.address.line2,
              district: created.address.district,
              city: created.address.city,
              state: created.address.state,
              postalCode: created.address.postalCode,
              country: created.address.country,
            }
          : null,
        note: created.note || null,
        items: created.items.map((it) => ({
          productId: it.productId,
          productName: it.product?.name || null,
          variantName: it.variant?.name || null,
          quantity: it.quantity,
          unitPrice: Number(it.unitPrice),
        })),
      });
    } catch (e: any) {
      console.warn("[orders] email send failed:", e?.message || e);
    }

    return res.status(201).json(created);
  } catch (e: any) {
    if (e?.code === "VARIANT_NOT_FOUND") {
      return res.status(400).json({ error: "variant_not_found" });
    }
    if (e?.code === "P2003") {
      return res
        .status(400)
        .json({ error: "invalid_fk", message: "Invalid product/variant id." });
    }
    if (e?.code === "P2002") {
      return res
        .status(400)
        .json({ error: "conflict", message: "Duplicated." });
    }
    console.error("[orders.create] unexpected error:", {
      name: e?.name,
      code: e?.code,
      message: e?.message,
      meta: e?.meta,
    });
    return res.status(500).json({ error: "internal_error" });
  }
});

// =============== UPDATE STATUS ===============
orders.patch("/:id/status", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  const { status } = req.body as { status: OrderStatus };

  if (!STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: "invalid_status" });
  }

  try {
    const updated = await prisma.orderInquiry.update({
      where: { id },
      data: { status },
    });
    return res.json(updated);
  } catch (e: any) {
    console.error("[orders.updateStatus] failed:", e);
    return res.status(500).json({ error: "failed_to_update_status" });
  }
});

// =============== UPDATE NOTES ===============
orders.patch("/:id/note", requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id;
  const { note, adminNote } = req.body as {
    note?: string | null;
    adminNote?: string | null;
  };

  try {
    const updated = await prisma.orderInquiry.update({
      where: { id },
      data: { note: note ?? null, adminNote: adminNote ?? null },
    });
    return res.json(updated);
  } catch (e: any) {
    console.error("[orders.updateNote] failed:", e);
    return res.status(500).json({ error: "failed_to_update_notes" });
  }
});

// =============== EXPORT CSV ===============
orders.get("/export/csv", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const orders = await prisma.orderInquiry.findMany({
      orderBy: { createdAt: "desc" },
    });

    const header = [
      "id",
      "createdAt",
      "status",
      "customerName",
      "customerEmail",
      "customerPhone",
      "subtotal",
      "total",
      "currency",
      "note",
      "adminNote",
    ].join(",");

    const rows = orders.map((o) =>
      [
        o.id,
        o.createdAt.toISOString(),
        o.status,
        o.customerName,
        o.customerEmail,
        o.customerPhone ?? "",
        o.subtotal.toString(),
        o.total.toString(),
        o.currency,
        o.note ?? "",
        o.adminNote ?? "",
      ]
        .map(csvEscape)
        .join(",")
    );

    const csv = [header, ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=orders.csv");
    res.send(csv);
  } catch (e: any) {
    console.error("[orders.exportCSV] failed:", e);
    return res.status(500).json({ error: "failed_to_export_csv" });
  }
});
