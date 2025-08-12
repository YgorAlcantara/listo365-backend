import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { z } from 'zod';
import { Resend } from 'resend';

export const orders = Router();

const Item = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive(),
});
const OrderSchema = z.object({
  customerName: z.string().min(2),
  customerEmail: z.string().email(),
  customerPhone: z.string().optional(),
  note: z.string().optional(),
  items: z.array(Item).min(1),
});

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

orders.post('/', async (req, res) => {
  const data = OrderSchema.parse(req.body);

  const order = await prisma.orderInquiry.create({
    data: {
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerPhone: data.customerPhone,
      note: data.note,
      items: {
        create: data.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
      },
    },
    include: { items: { include: { product: true } } },
  });

  // Anota os tipos direto na callback:
  const total = order.items.reduce(
    (s: number, i: { unitPrice: unknown; quantity: number }) =>
      s + Number(i.unitPrice) * i.quantity,
    0
  );

  const html = `
    <h2>New product request</h2>
    <p><strong>Name:</strong> ${order.customerName}</p>
    <p><strong>Email:</strong> ${order.customerEmail}</p>
    ${order.customerPhone ? `<p><strong>Phone:</strong> ${order.customerPhone}</p>` : ''}
    ${order.note ? `<p><strong>Notes:</strong> ${order.note}</p>` : ''}
    <h3>Items</h3>
    <ul>
      ${order.items
        .map(
          (i: { product: { name: string }; quantity: number; unitPrice: unknown }) =>
            `<li>${i.product.name} × ${i.quantity} — ${money.format(
              Number(i.unitPrice) * i.quantity
            )}</li>`
        )
        .join('')}
    </ul>
    <p><strong>Total:</strong> ${money.format(total)}</p>
  `;

  const key = process.env.RESEND_API_KEY;
  const to = process.env.COMPANY_ORDERS_EMAIL;
  const from = process.env.EMAIL_FROM || 'Listo365 <onboarding@resend.dev>';

  if (key && to) {
    const resend = new Resend(key);
    resend.emails
      .send({
        from,
        to: [to],
        replyTo: order.customerEmail,
        subject: `New request — ${order.customerName}`,
        html,
      })
      .then(() => console.log('Resend: mail sent', order.id))
      .catch((err: unknown) => {
        console.error('Resend: mail error', order.id, err);
      });
  }

  res.json({ ok: true, id: order.id });
});
