import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

type TokenPayload = {
  sub?: string;      // padrão que usamos no login
  uid?: string;      // compatibilidade com versão antiga
  email?: string;
  role?: 'ADMIN' | 'USER' | string;
};

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT secret not set' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as TokenPayload | string;
    if (typeof decoded === 'string') return res.status(401).json({ error: 'Invalid token' });

    const id = decoded.sub ?? decoded.uid;
    if (!id) return res.status(401).json({ error: 'Invalid token (missing subject)' });

    (req as any).user = { id, email: decoded.email, role: decoded.role ?? 'USER' };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // Primeiro valida o token
  requireAuth(req, res, () => {
    const role = (req as any).user?.role;
    if (role === 'ADMIN') return next();
    return res.status(403).json({ error: 'forbidden' });
  });
}
