import "dotenv/config";
import express, { NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
import { prisma } from "./lib/prisma";

import { auth } from "./routes/auth";
import { products } from "./routes/products";
import { orders } from "./routes/orders";
import { promotions } from "./routes/promotions";
import { categories } from "./routes/categories";
import { customers } from "./routes/customers";

const app = express();

// Behind proxy/CDN (Render/Fly/Cloudflare/etc.)
app.set("trust proxy", 1);
app.use(compression({ threshold: 512 }));

// ---- CORS robusto (lista múltipla + preflight + headers básicos) ----
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/postman
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  // ✅ inclui PUT (estava faltando)
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // inclui Accept; Authorization + Content-Type já estavam OK
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  // expor filename do CSV, etc.
  exposedHeaders: ["Content-Disposition"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Body & cookies
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Root
app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "listo365-backend" });
});

// Health (DB ping only)
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

// Readiness (opcional, com seed)
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
        const mod: any = await import("../prisma/seed.js");
        const fn = mod?.runSeed || mod?.default || mod?.main;
        if (typeof fn === "function") {
          await fn();
          seeded = true;
        } else {
          console.warn("Seed module loaded but no run function was found");
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

// Routers
app.use("/auth", auth);
app.use("/products", products);
app.use("/orders", orders);
app.use("/promotions", promotions);
app.use("/categories", categories);
app.use("/customers", customers);

// Error handler global — garante resposta JSON + CORS mesmo em erros
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: NextFunction
  ) => {
    console.error("unhandled error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  }
);

// Diagnostics (dev only)
if (process.env.NODE_ENV !== "production") {
  // @ts-ignore
  app.get("/_routes", (_req, res) => {
    const list: any[] = [];
    // @ts-ignore
    app._router.stack.forEach((m: any) => {
      if (m.route) {
        list.push({
          path: m.route.path,
          methods: Object.keys(m.route.methods).filter(
            (k) => m.route.methods[k]
          ),
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
}

// 404
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.path })
);

// Start
const port = Number(process.env.PORT || 4000);
app.listen(port, async () => {
  console.log(`API listening on :${port}`);
  try {
    await prisma.$connect();
  } catch (e) {
    console.error("prisma connect failed on boot:", e);
  }
});

// Graceful shutdown
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
