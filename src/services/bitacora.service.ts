import type { Request } from 'express';
import { prisma } from '../prisma';

// Bitacora de seguridad (SOC 2 CC7.2 / ISO 27001 A.8.15). Registrar nunca
// debe tumbar la operacion que se esta auditando: si falla el insert, se
// deja en el log del servidor y se sigue.

export type ResultadoBitacora = 'ok' | 'fallo' | 'bloqueado';

export const RETENCION_BITACORA_DIAS = Number(process.env.BITACORA_RETENCION_DIAS) || 365;

export function ipDe(req: Request): string | null {
  return req.ip ?? null;
}

export async function registrarEvento(
  req: Request | null,
  evento: string,
  opciones: {
    resultado?: ResultadoBitacora;
    usuarioId?: string | null;
    objetivo?: string | null;
    detalle?: Record<string, unknown>;
  } = {}
) {
  try {
    await prisma.bitacoraSeguridad.create({
      data: {
        evento,
        resultado: opciones.resultado ?? 'ok',
        usuarioId: opciones.usuarioId ?? req?.usuario?.id ?? null,
        objetivo: opciones.objetivo ?? null,
        ip: req ? ipDe(req) : null,
        userAgent: req?.get('user-agent')?.slice(0, 300) ?? null,
        detalle: (opciones.detalle as any) ?? undefined,
      },
    });
  } catch (err) {
    console.error('[bitacora] No se pudo registrar', evento, err);
  }
}

export async function listarBitacora(filtros: { desde?: Date; evento?: string; usuarioId?: string; limite?: number }) {
  return prisma.bitacoraSeguridad.findMany({
    where: {
      creadoEn: filtros.desde ? { gte: filtros.desde } : undefined,
      evento: filtros.evento ? { startsWith: filtros.evento } : undefined,
      usuarioId: filtros.usuarioId || undefined,
    },
    orderBy: { creadoEn: 'desc' },
    take: Math.min(Math.max(filtros.limite ?? 200, 1), 1000),
  });
}

/** Borra lo que ya paso el periodo de retencion. Lo llama el cron diario. */
export async function purgarBitacoraYSesiones() {
  const limite = new Date(Date.now() - RETENCION_BITACORA_DIAS * 24 * 60 * 60 * 1000);
  const bitacora = await prisma.bitacoraSeguridad.deleteMany({ where: { creadoEn: { lt: limite } } });
  const sesiones = await prisma.sesion.deleteMany({ where: { expiraEn: { lt: new Date() } } });
  return { bitacora: bitacora.count, sesiones: sesiones.count };
}
