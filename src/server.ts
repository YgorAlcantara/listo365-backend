import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { prisma } from "./lib/prisma";

import { auth } from "./routes/auth";
import { products } from "./routes/products";
import { orders } from "./routes/orders";
import { promotions } from "./routes/promotions";
import { categories } from "./routes/categories";

const app = express();

// CORS — aceita múltiplas origens no FRONTEND_ORIGIN (separadas por vírgula)
const envOrigins = process.env.FRONTEND_ORIGIN?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: envOrigins && envOrigins.length > 0 ? envOrigins : true,
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// Raiz (só pra não dar "Cannot GET /")
app.get("/", (_req, res) => res.json({ ok: true, name: "Listo365 API" }));

// Health que acorda o DB
app.get("/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch (e) {
    console.error("health db error", e);
    res.status(500).json({ ok: false, db: false });
  }
});

// Ping de debug (pode remover depois)
app.get("/_ping/products", (_req, res) => res.json({ mounted: true }));

// Rotas da aplicação (MONTE TODAS ANTES DO listen)
app.use("/auth", auth);
app.use("/products", products);
app.use("/orders", orders);
app.use("/promotions", promotions);
app.use("/categories", categories);

// 404 JSON (evita HTML “Cannot GET …”)
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.path })
);

// Start
const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`API on :${port}`));
