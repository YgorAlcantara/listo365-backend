import "dotenv/config";
import express from "express";
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

app.set("trust proxy", 1);
app.use(compression({ threshold: 512 }));

// ---- CORS (lista múltipla + shim defensivo) ----
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// inclui origens de dev por padrão (não atrapalha prod)
const defaultDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const allowSet = new Set<string>([...allowedOrigins, ...defaultDevOrigins]);

// 1) cors() oficial
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl/postman
      if (allowSet.has(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

// 2) shim defensivo: garante headers mesmo se algo escapar
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && allowSet.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With"
    );
  }
  if (req.method === "OPTIONS") {
    // log útil p/ depurar preflight
    if (origin) console.log(`[CORS] Preflight OK for ${origin} -> ${req.path}`);
    return res.sendStatus(204);
  }
  next();
});

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

// Diagnostics (dev only)
if (process.env.NODE_ENV !== "production") {
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
  console.log(
    `[CORS] Allowed origins: ${[...allowSet].join(", ") || "(all via cors())"}`
  );
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
