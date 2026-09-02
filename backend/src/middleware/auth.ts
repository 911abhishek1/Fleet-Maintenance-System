import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; role: string };
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

export const requireFleetManager = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'FLEET_MANAGER') {
    res.status(403).json({ error: 'Forbidden: Requires Fleet Manager role' });
    return;
  }
  next();
};

export const requireTechnician = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'TECHNICIAN') {
    res.status(403).json({ error: 'Forbidden: Requires Technician role' });
    return;
  }
  next();
};
