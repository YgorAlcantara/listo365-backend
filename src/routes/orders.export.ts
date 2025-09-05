// src/routes/orders.export.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

function csvEscape(v: any) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get("/orders/export/csv", async (req, res) => {
  try {
    const orders = await prisma.orderInquiry.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        customer: true,
        address: true,
        items: { include: { product: true, variant: true } },
      },
    });

    const headers = [
      "orderId",
      "createdAt",
      "status",
      "customer_name",
      "customer_email",
      "customer_phone",
      "company",
      "opt_in",
      "addr_line1",
      "addr_line2",
      "district",
      "city",
      "state",
      "postalCode",
      "country",
      "items_count",
      "items",          // "Name (Variant) xQty @Unit"
      "note",
      "total_snapshot", // soma quantity*unitPrice (quando houver)
    ];

    const rows = orders.map((o) => {
      const total = (o.items || []).reduce((acc, it) => {
        const unit = Number(it.unitPrice ?? 0);
        return acc + unit * (it.quantity ?? 0);
      }, 0);

      const itemsStr = (o.items || [])
        .map((it) => {
          const prod = it.product?.name || it.productId;
          const variant = it.variant?.name ? ` (${it.variant.name})` : "";
          const unit = Number(it.unitPrice ?? 0);
          const qty = it.quantity ?? 0;
          const unitTxt = unit ? `@$${unit.toFixed(2)}` : "@—";
          return `${prod}${variant} x${qty} ${unitTxt}`;
        })
        .join(" | ");

      return [
        o.id,
        o.createdAt ? new Date(o.createdAt).toISOString() : "",
        o.status || "",
        o.customer?.name || "",
        o.customer?.email || "",
        o.customer?.phone || "",
        o.customer?.company || "",
        o.customer?.marketingOptIn ? "yes" : "no",
        o.address?.line1 || "",
        o.address?.line2 || "",
        o.address?.district || "",
        o.address?.city || "",
        o.address?.state || "",
        o.address?.postalCode || "",
        o.address?.country || "",
        (o.items || []).length,
        itemsStr,
        o.note || "",
        total ? `$${total.toFixed(2)}` : "",
      ].map(csvEscape).join(",");
    });

    const out = [headers.join(","), ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');
    res.send(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to export CSV" });
  }
});

export default router;