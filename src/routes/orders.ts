import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { z } from 'zod';
import nodemailer from 'nodemailer';

export const orders = Router();

const Item = z.object({ productId: z.string(), quantity: z.number().int().positive(), unitPrice: z.number().positive() });
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
      items: { create: data.items.map(i => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice })) },
    },
    include: { items: { include: { product: true } } },
  });

  const total = order.items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0);
  const html = `
    <h2>New product request</h2>
    <p><strong>Name:</strong> ${order.customerName}</p>
    <p><strong>Email:</strong> ${order.customerEmail}</p>
    ${order.customerPhone ? `<p><strong>Phone:</strong> ${order.customerPhone}</p>` : ''}
    ${order.note ? `<p><strong>Notes:</strong> ${order.note}</p>` : ''}
    <h3>Items</h3>
    <ul>
      ${order.items.map(i => `<li>${i.product.name} × ${i.quantity} — ${money.format(Number(i.unitPrice) * i.quantity)}</li>`).join('')}
    </ul>
    <p><strong>Total:</strong> ${money.format(total)}</p>
  `;

  // Envia em background para não travar a resposta
  if (process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.COMPANY_ORDERS_EMAIL) {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = port === 465; // Gmail SSL
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.COMPANY_ORDERS_EMAIL,
      replyTo: order.customerEmail,
      subject: `New request — ${order.customerName}`,
      html,
    })
    .then(() => console.log('Mail sent for order', order.id))
    .catch((err) => console.error('Mail error for order', order.id, err));
  }

  // responde já
  res.json({ ok: true, id: order.id });
});
