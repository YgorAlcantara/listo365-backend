// backend/src/lib/mailer.ts
// Envio via Resend usando fetch (Node 18+). Sem axios, sem import.meta.

export type EmailOrderItem = {
  productId: string;
  productName?: string | null;
  variantName?: string | null;
  quantity: number;
  unitPrice: number; // já normalizado para número
};

export type EmailOrder = {
  id: string;
  createdAt: string;
  status: string;
  customer: {
    name: string;
    email: string;
    phone?: string | null;
    company?: string | null;
    marketingOptIn?: boolean;
  };
  address?: {
    line1: string;
    line2?: string | null;
    district?: string | null;
    city?: string;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  } | null;
  note?: string | null;
  subtotal: number;
  total: number;
  items: EmailOrderItem[];
};

function money(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

function htmlEscape(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function orderHtml(o: EmailOrder) {
  const address = o.address
    ? `
      <p style="margin:4px 0 0 0;font-size:13px;color:#444;">
        ${htmlEscape(o.address.line1)}${o.address.line2 ? `<br/>${htmlEscape(o.address.line2)}` : ""}
        <br/>${htmlEscape([o.address.city || "", o.address.state || "", o.address.postalCode || ""].filter(Boolean).join(", "))}
        <br/>${htmlEscape(o.address.country || "US")}
      </p>`
    : `<p style="margin:4px 0 0 0;font-size:13px;color:#666;">—</p>`;

  const items = o.items
    .map(
      (it) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;">
          ${htmlEscape(it.productName || it.productId)}${it.variantName ? ` <span style="color:#666;">(${htmlEscape(it.variantName)})</span>` : ""}
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${it.quantity}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${money(it.unitPrice)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${money(it.unitPrice * it.quantity)}</td>
      </tr>`
    )
    .join("");

  return `
  <div style="font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;">
    <h2 style="margin:0 0 8px 0;color:#111;">New Quote Request — #${o.id}</h2>
    <div style="font-size:12px;color:#666;margin-bottom:16px;">${new Date(o.createdAt).toLocaleString()}</div>

    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:10px;overflow:hidden;">
      <thead>
        <tr style="background:#fafafa;">
          <th style="text-align:left;padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Item</th>
          <th style="text-align:center;padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Qty</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Unit</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Total</th>
        </tr>
      </thead>
      <tbody>${items}</tbody>
      <tfoot>
        <tr>
          <td colspan="3" style="padding:10px;text-align:right;font-size:13px;color:#222;">Subtotal</td>
          <td style="padding:10px;text-align:right;font-weight:600;">${money(o.subtotal)}</td>
        </tr>
        <tr>
          <td colspan="3" style="padding:10px;text-align:right;font-size:13px;color:#222;border-top:1px solid #eee;">Total</td>
          <td style="padding:10px;text-align:right;font-weight:700;border-top:1px solid #eee;">${money(o.total)}</td>
        </tr>
      </tfoot>
    </table>

    <div style="display:flex;gap:16px;margin-top:16px;">
      <div style="flex:1;border:1px solid #eee;border-radius:10px;padding:10px;">
        <div style="font-size:12px;color:#666;font-weight:600;margin-bottom:6px;">Customer</div>
        <div style="font-size:13px;color:#111;">${htmlEscape(o.customer.name)}</div>
        <div style="font-size:13px;color:#444;">${htmlEscape(o.customer.email)}</div>
        ${o.customer.phone ? `<div style="font-size:13px;color:#444;">${htmlEscape(o.customer.phone)}</div>` : ""}
        ${o.customer.company ? `<div style="font-size:13px;color:#444;">${htmlEscape(o.customer.company)}</div>` : ""}
      </div>
      <div style="flex:1;border:1px solid #eee;border-radius:10px;padding:10px;">
        <div style="font-size:12px;color:#666;font-weight:600;margin-bottom:6px;">Address</div>
        ${address}
      </div>
    </div>

    ${
      o.note
        ? `<div style="border:1px solid #eee;border-radius:10px;padding:10px;margin-top:16px;">
            <div style="font-size:12px;color:#666;font-weight:600;margin-bottom:4px;">Customer note</div>
            <div style="font-size:13px;color:#222;white-space:pre-wrap;">${htmlEscape(o.note)}</div>
          </div>`
        : ""
    }
  </div>`;
}

async function sendResendEmail({
  to,
  subject,
  html,
}: {
  to: string | string[];
  subject: string;
  html: string;
}) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.EMAIL_FROM || "Listo365 <onboarding@resend.dev>";
  if (!apiKey) {
    console.warn("[mailer] RESEND_API_KEY ausente — e-mails desabilitados.");
    return;
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `[mailer] Resend error ${resp.status}: ${resp.statusText} ${body}`
    );
  }
}

export async function sendNewOrderEmails(order: EmailOrder) {
  const html = orderHtml(order);
  const companyTo =
    process.env.COMPANY_ORDERS_EMAIL || "orders@example.com";

  // Envia para a empresa
  await sendResendEmail({
    to: companyTo,
    subject: `New Quote — #${order.id}`,
    html,
  });

  // Confirmação para o cliente (silenciosa se falhar)
  if (order.customer?.email) {
    try {
      await sendResendEmail({
        to: order.customer.email,
        subject: `We received your quote request — #${order.id}`,
        html: `<div style="font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;">
                 <p>Hello ${htmlEscape(order.customer.name)},</p>
                 <p>Thanks! We’ve received your request. Our team will get back to you shortly.</p>
                 <hr style="border:none;border-top:1px solid #eee;margin:16px 0;"/>
                 ${html}
               </div>`,
      });
    } catch (e) {
      console.warn("[mailer] failed to send customer confirmation:", e);
    }
  }
}