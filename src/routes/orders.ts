// backend/src/routes/orders.ts
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
    // hydrate unitPrice if variantId is provided
    const hydratedItems = await Promise.all(
      body.items.map(async (it) => {
        if (!it.variantId || !variantDelegate?.findUnique) {
          return {
            ...it,
            unitPrice: typeof it.unitPrice === "number" ? it.unitPrice : 0,
            variantName: it.variantName ?? null,
          };
        }
        // ✅ Ajuste para seu modelo Prisma (provável "productVariant")
        const variant = await variantDelegate.findUnique({
          where: { id: it.variantId },
        });
        if (!variant) {
          // evita P2003 explicando a causa
          throw Object.assign(new Error("Variant not found."), {
            code: "VARIANT_NOT_FOUND",
          });
        }
        const fallbackPrice = Number(variant?.price ?? 0);
        const variantName = it.variantName ?? variant?.name ?? null;
        return {
          ...it,
          unitPrice:
            typeof it.unitPrice === "number" ? it.unitPrice : fallbackPrice,
          variantName,
        };
      })
    );

    const totals = calcTotals(hydratedItems);

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
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone ?? null,
          subtotal: totals.subtotal,
          total: totals.total,
          currency: "USD",
          items: {
            create: hydratedItems.map((it) => ({
              productId: it.productId,
              quantity: it.quantity,
              unitPrice: it.unitPrice ?? 0,
              variantId: it.variantId ?? null,
              variantName: it.variantName ?? null,
            })),
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

    // email (best-effort)
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
    // Map Prisma known errors and our custom guard
    if (e?.code === "VARIANT_NOT_FOUND") {
      return res.status(400).json({ error: "variant_not_found" });
    }
    if (e?.code === "P2003") {
      // FK error
      return res
        .status(400)
        .json({ error: "invalid_variant", message: "Invalid variantId." });
    }
    if (e?.code === "P2002") {
      return res
        .status(400)
        .json({ error: "conflict", message: "Duplicated." });
    }
    console.error("[orders.create] unexpected error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
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
            variantId: i.variantId ?? null,
          })),
          "dec"
        );
      } else if (prev === "COMPLETED" && next !== "COMPLETED") {
        await applyStockDelta(
          tx,
          current.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            variantId: i.variantId ?? null,
          })),
          "inc"
        );
      }

      return tx.orderInquiry.update({ where: { id }, data: { status: next } });
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
    data: { note: note ?? null, adminNote: adminNote ?? null },
  });
  res.json({ ok: true });
});

// =============== EXPORT CSV (ADMIN) ===============
orders.get(
  "/export/csv",
  requireAdmin,
  async (_req: Request, res: Response) => {
    const list = await prisma.orderInquiry.findMany({
      orderBy: { createdAt: "desc" },
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

    const header = [
      "order_id",
      "created_at",
      "status",
      "customer_name",
      "customer_email",
      "customer_phone",
      "company",
      "addr_line1",
      "addr_line2",
      "district",
      "city",
      "state",
      "postal_code",
      "country",
      "note",
      "recurrence",
      "subtotal",
      "total",
      "currency",
      "item_product",
      "item_variant",
      "item_sku",
      "item_qty",
      "item_unit",
      "item_line_total",
    ];

    const rows: string[] = [header.join(",")];

    for (const o of list) {
      if (o.items.length === 0) {
        rows.push(
          [
            o.id,
            o.createdAt.toISOString(),
            o.status,
            o.customer?.name || "",
            o.customer?.email || "",
            o.customer?.phone || "",
            o.customer?.company || "",
            o.address?.line1 || "",
            o.address?.line2 || "",
            o.address?.district || "",
            o.address?.city || "",
            o.address?.state || "",
            o.address?.postalCode || "",
            o.address?.country || "",
            o.note || "",
            o.recurrence || "",
            asNum(o.subtotal).toFixed(2),
            asNum(o.total).toFixed(2),
            o.currency || "USD",
            "",
            "",
            "",
            "0",
            "0.00",
            "0.00",
          ]
            .map(csvEscape)
            .join(",")
        );
        continue;
      }

      for (const it of o.items) {
        const unit = asNum(it.unitPrice);
        const line = unit * it.quantity;
        rows.push(
          [
            o.id,
            o.createdAt.toISOString(),
            o.status,
            o.customer?.name || "",
            o.customer?.email || "",
            o.customer?.phone || "",
            o.customer?.company || "",
            o.address?.line1 || "",
            o.address?.line2 || "",
            o.address?.district || "",
            o.address?.city || "",
            o.address?.state || "",
            o.address?.postalCode || "",
            o.address?.country || "",
            o.note || "",
            o.recurrence || "",
            asNum(o.subtotal).toFixed(2),
            asNum(o.total).toFixed(2),
            o.currency || "USD",
            it.product?.name || "",
            it.variant?.name || "",
            it.variant?.sku || "",
            String(it.quantity),
            unit.toFixed(2),
            line.toFixed(2),
          ]
            .map(csvEscape)
            .join(",")
        );
      }
    }

    const csv = rows.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');
    res.status(200).send("\uFEFF" + csv);
  }
);
