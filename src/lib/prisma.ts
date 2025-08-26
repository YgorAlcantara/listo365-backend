// src/lib/prisma.ts
import { PrismaClient } from "@prisma/client";

/**
 * Single Prisma instance across hot reloads (dev) and workers (SSR).
 * - In prod: minimal logging (errors).
 * - In dev: control via PRISMA_LOG="query,info,warn,error" (default warn,error).
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function getLogLevels(): ("query" | "info" | "warn" | "error")[] {
  if (process.env.NODE_ENV === "production") return ["error"];
  const raw = process.env.PRISMA_LOG?.trim();
  if (!raw) return ["warn", "error"];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x): x is "query" | "info" | "warn" | "error" =>
      ["query", "info", "warn", "error"].includes(x)
    );
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: getLogLevels(),
    // datasources: { db: { url: process.env.DATABASE_URL } }, // opcional: deixe o default do Prisma
  });

// Evita múltiplas instâncias em dev/hot-reload
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
