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

// CORS
const envOrigins = process.env.FRONTEND_ORIGIN?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: envOrigins && envOrigins.length ? envOrigins : true,
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// Health
app.get("/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch {
    res.status(500).json({ ok: false, db: false });
  }
});

// 🚩 MONTE TODAS AS ROTAS **ANTES** do 404
app.use("/auth", auth);
app.use("/products", products);
app.use("/orders", orders);
app.use("/promotions", promotions);
app.use("/categories", categories);

// (opcional) debug de rotas
app.get("/_routes", (_req, res) => {
  const routes: any[] = [];
  // @ts-ignore
  app._router.stack.forEach((m: any) => {
    if (m.route) {
      routes.push({
        path: m.route.path,
        methods: Object.keys(m.route.methods).filter((k) => m.route.methods[k]),
      });
    } else if (m.name === "router" && m.handle?.stack) {
      m.handle.stack.forEach((h: any) => {
        if (h.route)
          routes.push({
            path: h.route.path,
            methods: Object.keys(h.route.methods).filter(
              (k) => h.route.methods[k]
            ),
          });
      });
    }
  });
  res.json(routes);
});

// 🚩 Handler 404 SEMPRE POR ÚLTIMO
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.path })
);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`API on :${port}`));
