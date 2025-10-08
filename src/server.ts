// backend/src/server.ts
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

// Proxy/CDN (Render, Fly.io, Cloudflare etc.)
app.set("trust proxy", 1);
app.use(compression({ threshold: 512 }));

/**
 * ==============================
 * CORS CONFIG
 * ==============================
 */
const envOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowVercelPreview = true;
const vercelPreviewRegex = /\.vercel\.app$/i;

const corsOptions: cors.CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/postman
    if (envOrigins.includes(origin)) return cb(null, true);
    if (/^https?:\/\/localhost(:\d+)?$/i.test(origin)) return cb(null, true);
    if (
      allowVercelPreview &&
      vercelPreviewRegex.test(new URL(origin).hostname)
    )
      return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
  ],
  exposedHeaders: ["Content-Disposition"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Body & cookies
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

/**
 * ==============================
 * ROOT
 * ==============================
 */
app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "listo365-backend" });
});

/**
 * ==============================
 * HEALTH CHECK (com reconexão automática)
 * ==============================
 */
app.get("/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return res.json({ ok: true, db: true });
  } catch (e) {
    console.error("⚠️ health db error", e);
    try {
      await prisma.$disconnect();
      await prisma.$connect();
      console.log("🔁 Prisma reconnected during health check");
      return res.json({ ok: true, db: true, reconnected: true });
    } catch {
      return res.status(500).json({ ok: false, db: false });
    }
  }
});

/**
 * ==============================
 * READINESS (com seed opcional e fallback .ts/.js)
 * ==============================
 */
app.get("/ready", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (process.env.READY_TOKEN && token !== process.env.READY_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }

    // Testa conexão com o banco
    await prisma.$queryRawUnsafe("SELECT 1");

    let seeded = false;
    const shouldSeed =
      process.env.SEED_ON_READY === "1" || String(req.query.seed || "") === "1";

    if (shouldSeed) {
      try {
        // tenta primeiro o build compilado (.js)
        let seedModule: any;
        try {
          seedModule = await import("../prisma/seed.js");
        } catch {
          // fallback para rodar localmente (usando ts-node/dev)
          seedModule = await import("../prisma/seed.ts");
        }

        const runSeed = seedModule?.runSeed || seedModule?.default || seedModule?.main;
        if (typeof runSeed === "function") {
          await runSeed();
          seeded = true;
          console.log("✅ Database seeded successfully");
        } else {
          console.warn("⚠️ Seed module loaded, but no valid export found");
        }
      } catch (err) {
        console.error("❌ Seed failed in /ready:", err);
        return res
          .status(500)
          .json({ ok: false, db: true, seeded: false, error: "seed_failed" });
      }
    }

    return res.json({ ok: true, db: true, seeded });
  } catch (err) {
    console.error("ready failed", err);
    return res.status(500).json({ ok: false, error: "ready_failed" });
  }
});

/**
 * ==============================
 * ROUTERS
 * ==============================
 */
app.use("/auth", auth);
app.use("/products", products);
app.use("/orders", orders);
app.use("/promotions", promotions);
app.use("/categories", categories);
app.use("/customers", customers);

/**
 * ==============================
 * ERROR HANDLER GLOBAL
 * ==============================
 */
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

// 404
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.path })
);

/**
 * ==============================
 * FUNÇÃO DE RECONEXÃO AUTOMÁTICA
 * ==============================
 */
async function connectWithRetry(retries = 10, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      await prisma.$connect();
      console.log("✅ Prisma connected successfully");
      return;
    } catch (err) {
      console.warn(`⚠️ Prisma connect attempt ${i + 1}/${retries} failed`);
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.error("❌ Prisma failed after all retries");
}

/**
 * ==============================
 * START SERVER
 * ==============================
 */
const port = Number(process.env.PORT || 4000);
app.listen(port, async () => {
  console.log(`🚀 API listening on :${port}`);
  console.log("[CORS] FRONTEND_ORIGIN =", envOrigins.join(", ") || "(vazio)");
  await connectWithRetry();
});

/**
 * ==============================
 * GRACEFUL SHUTDOWN
 * ==============================
 */
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

/**
 * ==============================
 * KEEP-ALIVE (evita hibernação Supabase Free)
 * ==============================
 */
if (process.env.NODE_ENV === "production") {
  setInterval(async () => {
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      console.log("🩺 DB keep-alive ping ok");
    } catch (e) {
      console.warn("⚠️ DB ping failed, reconnecting...");
      try {
        await prisma.$disconnect();
        await prisma.$connect();
        console.log("✅ Prisma reconnected (keep-alive)");
      } catch (err) {
        console.error("❌ Reconnect failed:", err);
      }
    }
  }, 240000); // a cada 4 minutos
}
