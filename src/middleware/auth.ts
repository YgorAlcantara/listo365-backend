import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";

export type AuthedUser = {
  id: string;
  email?: string;
  role?: "ADMIN" | "USER" | string;
};

export interface AuthedRequest extends Request {
  user?: AuthedUser;
}

type TokenPayload = {
  sub?: string; // subject atual
  uid?: string; // compat com tokens antigos
  email?: string;
  role?: "ADMIN" | "USER" | string;
  iat?: number;
  exp?: number;
};

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: "JWT secret not set" });

  try {
    const decoded = jwt.verify(token, secret) as TokenPayload;
    const id = decoded.sub ?? decoded.uid;
    if (!id)
      return res.status(401).json({ error: "Invalid token (missing subject)" });

    // Anexa o usuário ao request (sem forçar role aqui)
    req.user = { id, email: decoded.email, role: decoded.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export async function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  // Encadeia o requireAuth e depois valida no banco
  return requireAuth(req, res, async () => {
    try {
      const uid = req.user?.id;
      if (!uid) return res.status(401).json({ error: "Unauthorized" });

      const dbUser = await prisma.user.findUnique({
        where: { id: uid },
        select: { id: true, email: true, role: true },
      });

      if (!dbUser) return res.status(401).json({ error: "User not found" });
      if (dbUser.role !== "ADMIN")
        return res.status(403).json({ error: "Forbidden" });

      // Mantém req.user alinhado ao banco
      req.user = {
        id: dbUser.id,
        email: dbUser.email ?? undefined,
        role: dbUser.role,
      };
      next();
    } catch (e) {
      console.error("requireAdmin error:", e);
      return res.status(500).json({ error: "Internal error" });
    }
  });
}
