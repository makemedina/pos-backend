import { Request, Response, NextFunction } from 'express';
import { obtenerUsuarioPorToken } from '../services/auth.service';

// Le agregamos el campo "usuario" a Request. Antes de esto no existia
// ningun lugar donde una ruta pudiera saber quien esta llamando.
declare global {
  namespace Express {
    interface Request {
      usuario?: {
        id: string;
        nombre: string;
        rolBase: string;
        permisos: {
          puedeVerCostos: boolean;
          puedeRegistrarCompras: boolean;
          puedeVerUtilidad: boolean;
          puedeVerCarteraGeneral: boolean;
          puedeVerGastosTodos: boolean;
          puedeAutorizar: boolean;
          puedeRegistrarPagos: boolean;
        } | null;
      };
    }
  }
}

/**
 * Exige un token de sesion valido (header "Authorization: Bearer <token>").
 * Si el token no existe, no es valido, o ya expiro, responde 401.
 * En caso contrario, deja al usuario autenticado disponible en req.usuario.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const usuario = await obtenerUsuarioPorToken(token);
  if (!usuario) {
    return res.status(401).json({ error: 'Sesion invalida o expirada' });
  }

  req.usuario = usuario;
  next();
}

/** El administrador siempre pasa; cualquier otro rol es rechazado. */
export function requiereAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.usuario?.rolBase === 'administrador') return next();
  return res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
}

/**
 * Exige un switch de permiso especifico. El administrador siempre pasa
 * (la plantilla base de administrador tiene autoridad total), cualquier
 * otro usuario necesita el switch correspondiente activado.
 */
export function requierePermiso(
  permiso:
    | 'puedeVerCostos'
    | 'puedeRegistrarCompras'
    | 'puedeVerUtilidad'
    | 'puedeVerCarteraGeneral'
    | 'puedeVerGastosTodos'
    | 'puedeAutorizar'
    | 'puedeRegistrarPagos'
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.usuario?.rolBase === 'administrador') return next();
    if (req.usuario?.permisos?.[permiso]) return next();
    return res.status(403).json({ error: 'No tienes permiso para hacer esto' });
  };
}
