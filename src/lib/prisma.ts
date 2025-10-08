// src/lib/prisma.ts
import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton otimizado para Render + Supabase Free:
 * - Usa engine binária (evita problemas com Data Proxy)
 * - Tenta reconectar automaticamente se a conexão cair
 * - Ping periódico (mantém pool ativo)
 * - Respeita DATABASE_URL e DIRECT_URL via env
 * - Evita múltiplas instâncias em dev (hot reload)
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Define os níveis de log dinamicamente
function getLogLevels(): ("query" | "info" | "warn" | "error")[] {
  if (process.env.NODE_ENV === "production") return ["error"];
  const raw = process.env.PRISMA_LOG?.trim();
  if (!raw) return ["warn", "error"];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is "query" | "info" | "warn" | "error" =>
      ["query", "info", "warn", "error"].includes(x)
    );
}

// Cria a instância principal
function createPrismaClient() {
  const prisma = new PrismaClient({
    log: getLogLevels(),
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

  // Keep-alive (evita timeout no Supabase Free)
  if (process.env.NODE_ENV === "production") {
    setInterval(async () => {
      try {
        await prisma.$queryRawUnsafe("SELECT 1");
        console.log("🩺 Prisma keep-alive OK");
      } catch (e) {
        console.warn("⚠️ Prisma ping failed, reconnecting...");
        try {
          await prisma.$disconnect();
          await prisma.$connect();
          console.log("✅ Prisma reconnected successfully");
        } catch (err) {
          console.error("❌ Prisma reconnect failed:", err);
        }
      }
    }, 240000); // a cada 4 minutos
  }

  return prisma;
}

// Exporta instância única
export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Evita múltiplas instâncias em dev/hot reload
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
