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
import { customers } from "./routes/customers";

const app = express();

// Confia no proxy (Render/Cloudflare) para IP/HTTPS corretos
app.set("trust proxy", 1);

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

// Raiz simples (evita 404 em "/")
app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "listo365-backend" });
});

// Health
app.get("/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, db: true });
  } catch (e) {
    console.error("health db error", e);
    return res.status(500).json({ ok: false, db: false });
  }
});

/**
 * /ready — verifica DB e (opcionalmente) dispara o seed.
 * GET /ready?token=SEU_TOKEN          (apenas health)
 * GET /ready?token=SEU_TOKEN&seed=1   (health + seed)
 * Env:
 *   READY_TOKEN (opcional)
 *   SEED_ON_READY=1 => seed ao chamar /ready
 */
app.get("/ready", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (process.env.READY_TOKEN && token !== process.env.READY_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }

    await prisma.$queryRaw`SELECT 1`;

    let seeded = false;
    const shouldSeed =
      process.env.SEED_ON_READY === "1" || String(req.query.seed || "") === "1";

    if (shouldSeed) {
      try {
        // dist/src/server.js -> dist/prisma/seed.js
        const mod: any = await import("../prisma/seed.js");
        const fn = mod?.runSeed || mod?.default;
        if (typeof fn === "function") {
          await fn();
          seeded = true;
        } else {
          console.warn("Seed module loaded but runSeed() not found");
        }
      } catch (e) {
        console.error("seed failed in /ready:", e);
        return res
          .status(500)
          .json({ ok: false, db: true, seeded: false, error: "seed_failed" });
      }
    }

    return res.json({ ok: true, db: true, seeded });
  } catch (e) {
    console.error("ready failed", e);
    return res.status(500).json({ ok: false, error: "ready_failed" });
  }
});

// Routers (ANTES do 404!)
app.use("/auth", auth);
app.use("/products", products);
app.use("/orders", orders);
app.use("/promotions", promotions);
app.use("/categories", categories);
app.use("/customers", customers);

// Rotas de diagnóstico (temporárias)
app.get("/_routes", (_req, res) => {
  const list: any[] = [];
  // @ts-ignore
  app._router.stack.forEach((m: any) => {
    if (m.route) {
      list.push({
        path: m.route.path,
        methods: Object.keys(m.route.methods).filter((k) => m.route.methods[k]),
      });
    } else if (m.name === "router" && m.handle?.stack) {
      m.handle.stack.forEach((h: any) => {
        if (h.route)
          list.push({
            path: h.route.path,
            methods: Object.keys(h.route.methods).filter(
              (k) => h.route.methods[k]
            ),
          });
      });
    }
  });
  res.json(list);
});

// 404 por último
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.path })
);

// Start
const port = Number(process.env.PORT || 4000);
app.listen(port, async () => {
  console.log(`API on :${port}`);
  // pré-aquece a conexão do Prisma (melhora 1º acesso)
  try {
    await prisma.$connect();
  } catch (e) {
    console.error("prisma connect failed on boot:", e);
  }
});

// Encerramento gracioso
process.on("SIGINT", async () => {
  try {
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
});
process.on("SIGTERM", async () => {
  try {
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
});
