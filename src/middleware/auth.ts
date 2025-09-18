// src/middleware/auth.ts
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { resolveJwtSecret } from "../lib/jwtSecret";

/** User object anexado ao request após autenticação */
export type AuthedUser = {
  id: string;
  email?: string;
  role?: "ADMIN" | "USER" | string;
};

/** Request estendido para conter o usuário autenticado */
export interface AuthedRequest extends Request {
  user?: AuthedUser;
}

/** Payload esperado no JWT */
type TokenPayload = {
  sub?: string; // subject (id do usuário)
  uid?: string; // compat com tokens antigos
  email?: string;
  role?: "ADMIN" | "USER" | string;
  iat?: number;
  exp?: number;
};

/** Extrai token do Header Authorization (Bearer) ou cookie "token" */
function getTokenFromReq(req: Request): string | null {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  // fallback opcional por cookie
  const cookieToken = (req as any)?.cookies?.token as string | undefined;
  return cookieToken || null;
}

/** Autentica qualquer usuário (ADMIN/USER) e injeta req.user */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const secret = resolveJwtSecret();
  if (!secret) return res.status(500).json({ error: "JWT secret not set" });

  try {
    const decoded = jwt.verify(token, secret) as TokenPayload;
    const id = decoded.sub ?? decoded.uid;
    if (!id)
      return res.status(401).json({ error: "Invalid token (missing subject)" });

    req.user = { id, email: decoded.email, role: decoded.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/** Exige ADMIN: roda requireAuth e valida no banco a role === ADMIN */
export async function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
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

      // normaliza req.user com dados atuais do banco
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
