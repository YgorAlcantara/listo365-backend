// backend/src/lib/mailer.ts
// Robust Resend mailer: never throws to caller; logs clearly.

export type EmailOrderItem = {
  productId: string;
  productName?: string | null;
  variantName?: string | null;
  quantity: number;
  unitPrice: number; // normalized number
};

export type EmailOrder = {
  id: string;
  createdAt: string; // ISO
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
    city?: string | null;
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
  if (!Number.isFinite(n)) n = 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

function htmlEscape(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toPlainText(html: string) {
  // very simple html->text fallback for email clients
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function orderHtml(o: EmailOrder) {
  const addrHtml = o.address
    ? `
      <p style="margin:4px 0 0 0;font-size:13px;color:#444;">
        ${htmlEscape(o.address.line1 || "")}
        ${o.address.line2 ? `<br/>${htmlEscape(o.address.line2)}` : ""}
        <br/>${htmlEscape(
          [o.address.city || "", o.address.state || "", o.address.postalCode || ""]
            .filter(Boolean)
            .join(", ")
        )}
        <br/>${htmlEscape(o.address.country || "US")}
      </p>`
    : `<p style="margin:4px 0 0 0;font-size:13px;color:#666;">—</p>`;

  const itemsHtml = (o.items || [])
    .map(
      (it) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;">
          ${htmlEscape(it.productName || it.productId)}${
        it.variantName ? ` <span style="color:#666;">(${htmlEscape(it.variantName)})</span>` : ""
      }
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${
          it.quantity
        }</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${money(
          it.unitPrice
        )}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${money(
          it.unitPrice * it.quantity
        )}</td>
      </tr>`
    )
    .join("");

  const createdLocal = new Date(o.createdAt).toLocaleString("en-US", {
    hour12: false,
  });

  const noteBlock = o.note
    ? `<div style="border:1px solid #eee;border-radius:10px;padding:10px;margin-top:16px;">
         <div style="font-size:12px;color:#666;font-weight:600;margin-bottom:4px;">Customer note</div>
         <div style="font-size:13px;color:#222;white-space:pre-wrap;">${htmlEscape(o.note)}</div>
       </div>`
    : "";

  return `
  <div style="font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;">
    <h2 style="margin:0 0 8px 0;color:#111;">New Quote Request — #${htmlEscape(o.id)}</h2>
    <div style="font-size:12px;color:#666;margin-bottom:16px;">${createdLocal}</div>

    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:10px;overflow:hidden;">
      <thead>
        <tr style="background:#fafafa;">
          <th style="text-align:left;padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Item</th>
          <th style="text-align:center;padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Qty</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Unit</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Total</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
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

    <div style="display:flex;gap:16px;margin-top:16px;flex-wrap:wrap;">
      <div style="flex:1;min-width:280px;border:1px solid #eee;border-radius:10px;padding:10px;">
        <div style="font-size:12px;color:#666;font-weight:600;margin-bottom:6px;">Customer</div>
        <div style="font-size:13px;color:#111;">${htmlEscape(o.customer.name)}</div>
        <div style="font-size:13px;color:#444;">${htmlEscape(o.customer.email)}</div>
        ${o.customer.phone ? `<div style="font-size:13px;color:#444;">${htmlEscape(o.customer.phone)}</div>` : ""}
        ${o.customer.company ? `<div style="font-size:13px;color:#444;">${htmlEscape(o.customer.company)}</div>` : ""}
      </div>
      <div style="flex:1;min-width:280px;border:1px solid #eee;border-radius:10px;padding:10px;">
        <div style="font-size:12px;color:#666;font-weight:600;margin-bottom:6px;">Address</div>
        ${addrHtml}
      </div>
    </div>

    ${noteBlock}
  </div>`;
}

async function sendResendEmail({
  to,
  subject,
  html,
  replyTo,
}: {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
}) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.EMAIL_FROM || "Listo365 <onboarding@resend.dev>";
  const apiUrl = process.env.RESEND_API_URL || "https://api.resend.com/emails";

  if (!apiKey) {
    console.warn("[mailer] RESEND_API_KEY missing — emails disabled.");
    return { ok: false, reason: "NO_API_KEY" };
  }

  const body = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: toPlainText(html),
    ...(replyTo ? { reply_to: replyTo } : {}),
  };

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const txt = await resp.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = JSON.parse(txt);
    } catch {
      // keep txt raw
    }

    if (!resp.ok) {
      console.warn("[mailer] Resend error:", resp.status, resp.statusText, parsed || txt);
      return { ok: false, status: resp.status, statusText: resp.statusText, body: parsed || txt };
    }

    console.log("[mailer] Resend ok:", parsed || txt);
    return { ok: true, body: parsed || txt };
  } catch (e: any) {
    console.warn("[mailer] Resend request failed:", e?.message || e);
    return { ok: false, reason: "FETCH_FAILED", error: String(e?.message || e) };
  }
}

/**
 * Public API used by orders route
 */
export async function sendNewOrderEmails(order: EmailOrder) {
  const html = orderHtml(order);
  const replyTo = order.customer?.email || undefined;

  // Company notification
  const companyTo = process.env.COMPANY_ORDERS_EMAIL || "";
  if (!companyTo) {
    console.warn("[mailer] COMPANY_ORDERS_EMAIL not set — skipping company email.");
  } else {
    await sendResendEmail({
      to: companyTo,
      subject: `New Quote — #${order.id}`,
      html,
      replyTo,
    });
  }

  // Customer confirmation (best-effort)
  const customerTo = order.customer?.email;
  if (customerTo) {
    await sendResendEmail({
      to: customerTo,
      subject: `We received your quote request — #${order.id}`,
      html: `<div style="font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;">
               <p>Hello ${htmlEscape(order.customer.name)},</p>
               <p>Thanks! We’ve received your request. Our team will get back to you shortly.</p>
               <hr style="border:none;border-top:1px solid #eee;margin:16px 0;"/>
               ${html}
             </div>`,
      replyTo: process.env.COMPANY_ORDERS_EMAIL || undefined,
    });
  }
}

// Backward compatibility
export const sendOrderEmails = sendNewOrderEmails;
