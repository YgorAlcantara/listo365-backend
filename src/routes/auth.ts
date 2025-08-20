// src/routes/auth.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";
import bcrypt from "bcrypt"; // <- usa bcrypt (não bcryptjs)
import jwt from "jsonwebtoken";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";

export const auth = Router();

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(6).max(200),
});

auth.post("/login", async (req, res) => {
  try {
    const body = LoginSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(body.password, user.password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "JWT secret not set" });

    const token = jwt.sign(
      { sub: user.id, uid: user.id, email: user.email, role: user.role },
      secret,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (e: any) {
    if (e?.name === "ZodError") {
      return res.status(400).json({ error: "Invalid payload" });
    }
    console.error(e);
    res.status(500).json({ error: "Login failed" });
  }
});

/** Retorna dados do usuário autenticado */
auth.get("/me", requireAuth, async (req, res) => {
  const uid = (req as any).user?.id as string | undefined;
  if (!uid) return res.status(401).json({ error: "Unauthorized" });

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  if (!user) return res.status(401).json({ error: "User not found" });
  res.json(user);
});

/**
 * Bootstrap de ADMIN (uso único):
 * Protegido por ADMIN_BOOTSTRAP_TOKEN (env). Use 1x e remova a env.
 */
auth.post("/bootstrap-admin", async (req, res) => {
  try {
    const provided = String(req.body?.token || "");
    if (
      !process.env.ADMIN_BOOTSTRAP_TOKEN ||
      provided !== process.env.ADMIN_BOOTSTRAP_TOKEN
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const email = (
      process.env.ADMIN_EMAIL || "admin@listo365.com"
    ).toLowerCase();
    const name = process.env.ADMIN_NAME || "Admin";
    const pass = process.env.ADMIN_PASSWORD || "admin123";

    const hash = await bcrypt.hash(pass, 10);
    const user = await prisma.user.upsert({
      where: { email },
      update: { role: "ADMIN", name, password: hash },
      create: { email, name, password: hash, role: "ADMIN" },
    });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "JWT secret not set" });

    const jwtToken = jwt.sign(
      { sub: user.id, uid: user.id, email: user.email, role: user.role },
      secret,
      { expiresIn: "7d" }
    );

    res.json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role },
      token: jwtToken,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Bootstrap failed" });
  }
});
