import { PrismaClient } from '@prisma/client';

// Instancia unica de Prisma para toda la app
export const prisma = new PrismaClient();
