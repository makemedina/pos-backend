import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '../prisma';
import { verificarBloqueo, registrarIntentoFallido, limpiarIntentos } from './loginLimiter';

const RONDAS_BCRYPT = 10;
// Ventana deslizante (se renueva en cada peticion mientras se use la app):
// un dia laboral completo, para que no pida iniciar sesion de nuevo si
// la PWA se queda en segundo plano durante una comida o un rato sin usarse.
const DURACION_SESION_HORAS = 12;
// Tope absoluto: aunque se use todos los dias, la sesion muere a los N dias
// de creada y hay que volver a poner el PIN (SOC 2 CC6.1 / ISO 27001 A.8.5).
const MAX_SESION_DIAS = Number(process.env.SESION_MAX_DIAS) || 7;

const ROLES_VALIDOS = ['vendedor', 'administrador'];
const PIN_REGEX = /^\d{4,8}$/;
// Hash de relleno para que un telefono inexistente tarde lo mismo que uno
// real (si no, el tiempo de respuesta delata que usuarios existen).
const HASH_RELLENO = bcrypt.hashSync('relleno-no-es-un-pin', RONDAS_BCRYPT);

export class PinInvalidoError extends Error {
  constructor() {
    super('El PIN debe tener entre 4 y 8 digitos (solo numeros).');
  }
}

export class DatosUsuarioInvalidosError extends Error {}

export function validarPin(pin: unknown): asserts pin is string {
  if (typeof pin !== 'string' || !PIN_REGEX.test(pin)) throw new PinInvalidoError();
}

/** Lo que se guarda en Sesion.token: el SHA-256 del token, nunca el token. */
export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function expiracionDeslizante(creadaEn: Date) {
  const deslizante = Date.now() + DURACION_SESION_HORAS * 60 * 60 * 1000;
  const absoluta = creadaEn.getTime() + MAX_SESION_DIAS * 24 * 60 * 60 * 1000;
  return new Date(Math.min(deslizante, absoluta));
}

export interface UsuarioSesion {
  id: string;
  nombre: string;
  telefono: string;
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
}

function mapPermisos(usuario: any): UsuarioSesion['permisos'] {
  if (!usuario.permisos) return null;
  return {
    puedeVerCostos: usuario.permisos.puedeVerCostos,
    puedeRegistrarCompras: usuario.permisos.puedeRegistrarCompras,
    puedeVerUtilidad: usuario.permisos.puedeVerUtilidad,
    puedeVerCarteraGeneral: usuario.permisos.puedeVerCarteraGeneral,
    puedeVerGastosTodos: usuario.permisos.puedeVerGastosTodos,
    puedeAutorizar: usuario.permisos.puedeAutorizar,
    puedeRegistrarPagos: usuario.permisos.puedeRegistrarPagos,
  };
}

export class LoginBloqueadoError extends Error {
  minutosRestantes: number;
  constructor(minutosRestantes: number) {
    super(`Demasiados intentos fallidos. Espera ${minutosRestantes} minuto(s) antes de volver a intentar.`);
    this.minutosRestantes = minutosRestantes;
  }
}

/**
 * Verifica telefono+PIN y, si son correctos, crea una fila nueva en Sesion
 * con un token aleatorio. Ese token es lo unico que el frontend guarda y
 * manda en cada llamada posterior (header Authorization: Bearer <token>).
 *
 * Antes de intentar validar el PIN, se revisa si este identificador esta
 * bloqueado por demasiados intentos fallidos recientes -- el PIN es de
 * solo 4 digitos, asi que sin este limite alguien podria probar todas las
 * combinaciones posibles en minutos.
 */
export async function loginUsuario(
  identificador: string,
  pin: string
): Promise<{ token: string; usuario: UsuarioSesion }> {
  if (typeof identificador !== 'string' || typeof pin !== 'string' || !identificador.trim()) {
    throw new Error('Credenciales invalidas');
  }
  const minutosBloqueado = verificarBloqueo(identificador);
  if (minutosBloqueado !== null) {
    throw new LoginBloqueadoError(minutosBloqueado);
  }

  // Se puede iniciar sesion con el telefono o con el nombre, en el mismo campo.
  const usuario = await prisma.usuario.findFirst({
    where: {
      OR: [
        { telefono: identificador },
        { nombre: { equals: identificador, mode: 'insensitive' } },
      ],
    },
    include: { permisos: true },
  });

  if (!usuario || !usuario.activo) {
    await bcrypt.compare(pin, HASH_RELLENO);
    registrarIntentoFallido(identificador);
    throw new Error('Credenciales invalidas');
  }

  const pinValido = await bcrypt.compare(pin, usuario.pin);
  if (!pinValido) {
    registrarIntentoFallido(identificador);
    throw new Error('Credenciales invalidas');
  }

  limpiarIntentos(identificador);

  const token = randomBytes(32).toString('base64url');
  const expiraEn = expiracionDeslizante(new Date());

  await prisma.sesion.create({
    data: { token: hashToken(token), usuarioId: usuario.id, expiraEn },
  });

  return {
    token,
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      telefono: usuario.telefono,
      rolBase: usuario.rolBase,
      permisos: mapPermisos(usuario),
    },
  };
}

/** Usado por el middleware requireAuth en cada request protegida. */
export async function obtenerUsuarioPorToken(token: string) {
  const tokenHash = hashToken(token);
  const sesion = await prisma.sesion.findUnique({
    where: { token: tokenHash },
    include: { usuario: { include: { permisos: true } } },
  });

  if (!sesion || sesion.expiraEn < new Date()) return null;
  if (!sesion.usuario.activo) return null;

  // Ventana deslizante: cada peticion valida renueva la sesion otras
  // DURACION_SESION_HORAS, sin pasar del tope absoluto de MAX_SESION_DIAS.
  await prisma.sesion.update({
    where: { token: tokenHash },
    data: { expiraEn: expiracionDeslizante(sesion.creadaEn) },
  });

  return {
    id: sesion.usuario.id,
    nombre: sesion.usuario.nombre,
    telefono: sesion.usuario.telefono,
    rolBase: sesion.usuario.rolBase,
    permisos: mapPermisos(sesion.usuario),
  };
}

export async function cerrarSesion(token: string) {
  await prisma.sesion.deleteMany({ where: { token: hashToken(token) } });
}

/** Cierra todas las sesiones de un usuario (menos, si se indica, la actual). */
export async function revocarSesionesUsuario(usuarioId: string, exceptoToken?: string | null) {
  const { count } = await prisma.sesion.deleteMany({
    where: { usuarioId, ...(exceptoToken ? { token: { not: hashToken(exceptoToken) } } : {}) },
  });
  return count;
}

/**
 * Confirma que un usuario puede actuar como autorizador de una venta bajo
 * costo o de un ajuste de inventario: debe existir, estar activo, tener el
 * switch puedeAutorizar (o ser administrador), y su PIN debe coincidir con
 * el que se capturo en el momento. Este PIN es el "codigo remoto" que el
 * administrador dicta al vendedor via llamada/whatsapp -- es la version
 * minima viable mientras se construye el flujo de aprobacion push
 * (pendiente #1 de la lista original).
 */
/**
 * Igual que verificarAutorizador, pero identifica al autorizador por su
 * telefono en vez de su ID -- mucho mas practico en campo, ya que el
 * administrador se sabe su telefono de memoria (es el mismo con el que
 * hace login), no un UUID interno.
 * Regresa el ID real del usuario si la autorizacion es valida (para
 * guardarlo en el registro de auditoria), o null si no lo es.
 *
 * Comparte el contador de intentos fallidos con el login (misma clave:
 * el telefono). Sin esto, cualquier vendedor con sesion podria probar
 * los 10,000 PINs del administrador por aqui -- este camino no pasaba por
 * el limite de /auth/login -- y despues entrar como administrador.
 */
export async function verificarAutorizadorPorTelefono(
  telefono: string,
  pin: string
): Promise<string | null> {
  if (verificarBloqueo(telefono) !== null) return null;

  const usuario = await prisma.usuario.findUnique({
    where: { telefono },
    include: { permisos: true },
  });

  const autorizado =
    !!usuario?.activo && (usuario.rolBase === 'administrador' || !!usuario.permisos?.puedeAutorizar);
  if (!autorizado || !(await bcrypt.compare(pin, usuario!.pin))) {
    registrarIntentoFallido(telefono);
    return null;
  }

  limpiarIntentos(telefono);
  return usuario!.id;
}

export async function verificarAutorizador(usuarioId: string, pin: string): Promise<boolean> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    include: { permisos: true },
  });

  if (!usuario || !usuario.activo) return false;
  const autorizado = usuario.rolBase === 'administrador' || usuario.permisos?.puedeAutorizar;
  if (!autorizado) return false;

  return bcrypt.compare(pin, usuario.pin);
}

export async function listarUsuarios() {
  const usuarios = await prisma.usuario.findMany({
    include: { permisos: true },
    orderBy: { nombre: 'asc' },
  });
  // Nunca se manda el hash del PIN al frontend.
  return usuarios.map(({ pin, ...resto }) => resto);
}

export async function crearUsuario(datos: {
  nombre: string;
  telefono: string;
  pin: string;
  rolBase?: string;
}) {
  validarPin(datos.pin);
  if (typeof datos.nombre !== 'string' || !datos.nombre.trim() || typeof datos.telefono !== 'string' || !datos.telefono.trim()) {
    throw new DatosUsuarioInvalidosError('Nombre y telefono son obligatorios.');
  }
  if (datos.rolBase !== undefined && !ROLES_VALIDOS.includes(datos.rolBase)) {
    throw new DatosUsuarioInvalidosError('Rol invalido.');
  }
  const pinHash = await bcrypt.hash(datos.pin, RONDAS_BCRYPT);

  const usuario = await prisma.usuario.create({
    data: {
      nombre: datos.nombre,
      telefono: datos.telefono,
      pin: pinHash,
      rolBase: datos.rolBase ?? 'vendedor',
      permisos: {
        create: {
          puedeVerCostos: false,
          puedeRegistrarCompras: false,
          puedeVerUtilidad: false,
          puedeVerCarteraGeneral: false,
          puedeVerGastosTodos: false,
          puedeAutorizar: false,
          puedeRegistrarPagos: false,
        },
      },
    },
    include: { permisos: true },
  });

  const { pin: _pin, ...sinPin } = usuario;
  return sinPin;
}

export async function cambiarPinUsuario(usuarioId: string, nuevoPin: string) {
  validarPin(nuevoPin);
  const pinHash = await bcrypt.hash(nuevoPin, RONDAS_BCRYPT);
  const usuario = await prisma.usuario.update({
    where: { id: usuarioId },
    data: { pin: pinHash },
  });
  const { pin: _pin, ...sinPin } = usuario;
  return sinPin;
}

export async function actualizarUsuario(
  usuarioId: string,
  datos: { nombre?: string; telefono?: string; activo?: boolean }
) {
  const usuario = await prisma.usuario.update({
    where: { id: usuarioId },
    data: datos,
  });
  const { pin: _pin, ...sinPin } = usuario;
  return sinPin;
}

export async function actualizarPermisosUsuario(
  usuarioId: string,
  permisos: {
    puedeVerCostos: boolean;
    puedeRegistrarCompras: boolean;
    puedeVerUtilidad: boolean;
    puedeVerCarteraGeneral: boolean;
    puedeVerGastosTodos: boolean;
    puedeAutorizar: boolean;
    puedeRegistrarPagos: boolean;
  }
) {
  return prisma.permisosUsuario.upsert({
    where: { usuarioId },
    update: permisos,
    create: { usuarioId, ...permisos },
    include: { usuario: true },
  });
}
