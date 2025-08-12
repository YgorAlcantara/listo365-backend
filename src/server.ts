import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { auth } from './routes/auth';
import { products } from './routes/products';
import { orders } from './routes/orders';
import { promotions } from './routes/promotions';

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN?.split(',') || true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/auth', auth);
app.use('/products', products);
app.use('/orders', orders);
app.use('/promotions', promotions);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`API on :${port}`));
