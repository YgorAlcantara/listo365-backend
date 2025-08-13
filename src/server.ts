import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { prisma } from './lib/prisma';
import { auth } from './routes/auth';
import { products } from './routes/products';
import { orders } from './routes/orders';
import { promotions } from './routes/promotions';
import { categories } from './routes/categories';




const app = express();

// ---- CORS (aceita múltiplas origens no .env) ----
const envOrigins = process.env.FRONTEND_ORIGIN
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: envOrigins && envOrigins.length > 0 ? envOrigins : true, // se não setar, permite todas (dev)
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// ---- Healthcheck que acorda o DB ----
app.get('/health', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await prisma.$queryRaw`SELECT 1`; // wake Neon/DB
    res.json({ ok: true, db: true });
  } catch (e) {
    console.error('health db error', e);
    res.status(500).json({ ok: false, db: false });
  }
});

// ---- Rotas da aplicação ----
app.use('/auth', auth);
app.use('/products', products);
app.use('/orders', orders);
app.use('/promotions', promotions);

// ---- Start ----
const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`API on :${port}`));

app.use('/categories', categories);
