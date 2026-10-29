import { prisma } from '../prisma';
import { notificarClienteNuevoAMeta } from './metaCapi.service';
import { telefonoClienteValido, MENSAJE_TELEFONO_INVALIDO } from './clientes.service';

export const ORIGENES_PROSPECTO = ['visita', 'anuncio', 'redes', 'recomendacion', 'otro'] as const;
export const NIVELES_INTERES = ['alto', 'medio', 'bajo'] as const;
export const ESTADOS_PROSPECTO = ['activo', 'convertido', 'descartado'] as const;
export const TIPOS_NOTA_PROSPECTO = ['visita', 'llamada', 'whatsapp', 'redes', 'nota'] as const;

// Al convertirlo, el origen del prospecto se traduce al de Cliente (ver
// Cliente.origen). Solo "anuncio" se reporta a Meta como Lead; "redes" sin
// anuncio queda como "otro" para no ensuciar el aprendizaje de Meta.
const ORIGEN_CLIENTE_DESDE_PROSPECTO: Record<string, string> = {
  visita: 'vendedor',
  anuncio: 'anuncio',
  redes: 'otro',
  recomendacion: 'recomendacion',
  otro: 'otro',
};

const ETIQUETA_TIPO_NOTA: Record<string, string> = {
  visita: 'Visita',
  llamada: 'Llamada',
  whatsapp: 'WhatsApp',
  redes: 'Mensaje en redes',
  nota: 'Nota',
};

function normalizarFecha(fecha: Date) {
  const f = new Date(fecha);
  f.setHours(0, 0, 0, 0);
  return f;
}

export class DatoProspectoInvalidoError extends Error {}

export class NotaProspectoAjenaError extends Error {
  constructor() {
    super('Solo quien escribió la nota o un administrador la puede borrar.');
  }
}

export class ProspectoYaConvertidoError extends Error {
  constructor() {
    super('Este prospecto ya se convirtió en cliente.');
  }
}

export interface DatosProspecto {
  nombre?: string;
  nombreContacto?: string | null;
  telefono?: string | null;
  colonia?: string | null;
  ciudad?: string | null;
  googleMapsUrl?: string | null;
  origen?: string;
  interes?: string | null;
  nivelInteres?: string;
  estado?: string;
  proximoContacto?: Date | null;
  motivoContacto?: string | null;
  motivoDescarte?: string | null;
}

// Valida/limpia lo que llega del formulario: los textos vacios se guardan
// como null y el telefono, si viene, debe ser un celular de 10 digitos
// (para que funcionen los botones de llamar/WhatsApp y la conversion).
function limpiarDatos(datos: DatosProspecto) {
  const limpio: DatosProspecto = { ...datos };
  for (const campo of ['nombreContacto', 'colonia', 'ciudad', 'googleMapsUrl', 'interes', 'motivoContacto', 'motivoDescarte'] as const) {
    if (limpio[campo] !== undefined) limpio[campo] = limpio[campo]?.trim() || null;
  }
  if (limpio.nombre !== undefined) {
    limpio.nombre = limpio.nombre.trim();
    if (!limpio.nombre) throw new DatoProspectoInvalidoError('El nombre es obligatorio.');
  }
  if (limpio.telefono !== undefined) {
    const tel = limpio.telefono?.trim();
    if (!tel) {
      limpio.telefono = null;
    } else {
      const valido = telefonoClienteValido(tel);
      if (!valido) throw new DatoProspectoInvalidoError(MENSAJE_TELEFONO_INVALIDO);
      limpio.telefono = valido;
    }
  }
  if (limpio.origen !== undefined && !ORIGENES_PROSPECTO.includes(limpio.origen as never)) {
    throw new DatoProspectoInvalidoError('Elige cómo llegó el prospecto.');
  }
  if (limpio.nivelInteres !== undefined && !NIVELES_INTERES.includes(limpio.nivelInteres as never)) {
    throw new DatoProspectoInvalidoError('Nivel de interés inválido.');
  }
  if (limpio.estado !== undefined && !ESTADOS_PROSPECTO.includes(limpio.estado as never)) {
    throw new DatoProspectoInvalidoError('Estado inválido.');
  }
  if (limpio.proximoContacto) limpio.proximoContacto = normalizarFecha(limpio.proximoContacto);
  return limpio;
}

const INCLUIR_RESUMEN = {
  registradoPor: { select: { nombre: true } },
  cliente: { select: { id: true, nombre: true } },
  notas: { orderBy: { creadoEn: 'desc' as const }, take: 1 },
  _count: { select: { notas: true } },
};

function aResumen(p: {
  notas: { tipo: string; texto: string; creadoEn: Date }[];
  _count: { notas: number };
  registradoPor: { nombre: string };
  [k: string]: unknown;
}) {
  const { notas, _count, registradoPor, ...resto } = p;
  return {
    ...resto,
    registradoPorNombre: registradoPor.nombre,
    ultimoContacto: notas[0] ?? null,
    totalNotas: _count.notas,
  };
}

/**
 * Prospectos por estado. Los activos se ordenan por el siguiente contacto
 * agendado (los vencidos y de hoy primero; los sin fecha al final).
 */
export async function listarProspectos(estado: string = 'activo') {
  const prospectos = await prisma.prospecto.findMany({
    where: estado === 'todos' ? {} : { estado },
    include: INCLUIR_RESUMEN,
    orderBy:
      estado === 'activo'
        ? [{ proximoContacto: { sort: 'asc', nulls: 'last' } }, { creadoEn: 'desc' }]
        : [{ actualizadoEn: 'desc' }],
  });
  return prospectos.map(aResumen);
}

/** Prospectos activos con seguimiento agendado para hoy o ya vencido -- alimenta "Llamadas de hoy". */
export async function prospectosPorContactarHoy() {
  const hoy = normalizarFecha(new Date());
  const prospectos = await prisma.prospecto.findMany({
    where: { estado: 'activo', proximoContacto: { lte: hoy } },
    include: INCLUIR_RESUMEN,
    orderBy: [{ proximoContacto: 'asc' }, { nombre: 'asc' }],
  });
  return prospectos.map(aResumen);
}

export async function obtenerProspecto(id: string) {
  const p = await prisma.prospecto.findUniqueOrThrow({
    where: { id },
    include: {
      registradoPor: { select: { nombre: true } },
      cliente: { select: { id: true, nombre: true } },
      notas: { include: { autor: { select: { nombre: true } } }, orderBy: { creadoEn: 'desc' } },
    },
  });
  const { notas, registradoPor, ...resto } = p;
  return {
    ...resto,
    registradoPorNombre: registradoPor.nombre,
    notas: notas.map((n) => ({
      id: n.id,
      tipo: n.tipo,
      texto: n.texto,
      creadoEn: n.creadoEn,
      autorId: n.autorId,
      autorNombre: n.autor.nombre,
    })),
  };
}

/**
 * Alta de un prospecto. Si se escribe algo en "primera nota", queda como la
 * primera entrada de su bitacora (tipo visita o redes segun como llego).
 */
export async function crearProspecto(datos: DatosProspecto & { notaInicial?: string }, registradoPorId: string) {
  const { notaInicial, ...resto } = datos;
  if (!resto.nombre) throw new DatoProspectoInvalidoError('El nombre es obligatorio.');
  if (!resto.origen) throw new DatoProspectoInvalidoError('Elige cómo llegó el prospecto.');
  const limpio = limpiarDatos(resto);
  const texto = notaInicial?.trim();
  const tipoNota = limpio.origen === 'visita' ? 'visita' : limpio.origen === 'anuncio' || limpio.origen === 'redes' ? 'redes' : 'nota';

  const prospecto = await prisma.prospecto.create({
    data: {
      ...limpio,
      nombre: limpio.nombre!,
      origen: limpio.origen!,
      estado: 'activo',
      registradoPorId,
      ...(texto ? { notas: { create: { tipo: tipoNota, texto, autorId: registradoPorId } } } : {}),
    },
  });
  return obtenerProspecto(prospecto.id);
}

export async function actualizarProspecto(id: string, datos: DatosProspecto) {
  const limpio = limpiarDatos(datos);
  // Volver a "activo" un prospecto descartado limpia el motivo de descarte.
  if (limpio.estado === 'activo') limpio.motivoDescarte = null;
  await prisma.prospecto.update({ where: { id }, data: limpio });
  return obtenerProspecto(id);
}

/**
 * Registra un contacto en la bitacora. Opcionalmente reagenda en el mismo
 * paso el siguiente contacto (o lo quita, con proximoContacto = null) --
 * es el flujo normal: "le hablé, me dijo que el viernes".
 */
export async function agregarNotaProspecto(
  prospectoId: string,
  datos: { tipo: string; texto: string; proximoContacto?: Date | null; motivoContacto?: string | null },
  autorId: string
) {
  if (!TIPOS_NOTA_PROSPECTO.includes(datos.tipo as never)) throw new DatoProspectoInvalidoError('Tipo de contacto inválido.');
  const texto = datos.texto.trim();
  if (!texto) throw new DatoProspectoInvalidoError('Escribe la nota antes de guardarla.');

  await prisma.$transaction([
    prisma.notaProspecto.create({ data: { prospectoId, tipo: datos.tipo, texto, autorId } }),
    // Se toca el prospecto siempre para que actualizadoEn refleje el ultimo contacto.
    prisma.prospecto.update({
      where: { id: prospectoId },
      data: {
        ...(datos.proximoContacto !== undefined
          ? {
              proximoContacto: datos.proximoContacto ? normalizarFecha(datos.proximoContacto) : null,
              motivoContacto: datos.proximoContacto ? datos.motivoContacto?.trim() || null : null,
            }
          : {}),
      },
    }),
  ]);
  return obtenerProspecto(prospectoId);
}

export async function eliminarNotaProspecto(notaId: string, usuarioId: string, esAdmin: boolean) {
  const nota = await prisma.notaProspecto.findUniqueOrThrow({ where: { id: notaId } });
  if (nota.autorId !== usuarioId && !esAdmin) throw new NotaProspectoAjenaError();
  await prisma.notaProspecto.delete({ where: { id: notaId } });
}

/**
 * Convierte el prospecto en Cliente: lo da de alta (o lo liga al cliente que
 * ya exista con ese mismo telefono, para no duplicarlo), copia su bitacora a
 * las notas del cliente y lo marca como convertido. El Lead a Meta sale aqui,
 * solo si es un cliente nuevo que vino de anuncio.
 */
export async function convertirProspectoEnCliente(id: string, telefonoCapturado: string | undefined, autorId: string) {
  const prospecto = await prisma.prospecto.findUniqueOrThrow({
    where: { id },
    include: { notas: { orderBy: { creadoEn: 'asc' } } },
  });
  if (prospecto.estado === 'convertido') throw new ProspectoYaConvertidoError();

  const telefono = telefonoClienteValido(telefonoCapturado || prospecto.telefono || '');
  if (!telefono) {
    throw new DatoProspectoInvalidoError(`Para convertirlo en cliente hace falta su teléfono. ${MENSAJE_TELEFONO_INVALIDO}`);
  }

  const existente = await prisma.cliente.findFirst({ where: { telefono } });

  const notasCopiadas = prospecto.notas.map((n) => ({
    texto: `[Prospecto · ${ETIQUETA_TIPO_NOTA[n.tipo] ?? n.tipo}] ${n.texto}`,
    autorId: n.autorId,
    creadoEn: n.creadoEn,
  }));
  if (prospecto.interes) {
    notasCopiadas.push({ texto: `[Prospecto · Interés] ${prospecto.interes}`, autorId, creadoEn: new Date() });
  }

  const cliente = await prisma.$transaction(async (tx) => {
    const c =
      existente ??
      (await tx.cliente.create({
        data: {
          nombre: prospecto.nombre,
          nombreContacto: prospecto.nombreContacto,
          telefono,
          colonia: prospecto.colonia,
          ciudad: prospecto.ciudad,
          googleMapsUrl: prospecto.googleMapsUrl,
          origen: ORIGEN_CLIENTE_DESDE_PROSPECTO[prospecto.origen] ?? 'otro',
        },
      }));
    if (notasCopiadas.length > 0) {
      await tx.notaCliente.createMany({ data: notasCopiadas.map((n) => ({ ...n, clienteId: c.id })) });
    }
    await tx.prospecto.update({
      where: { id },
      data: { estado: 'convertido', clienteId: c.id, convertidoEn: new Date(), telefono, proximoContacto: null, motivoContacto: null },
    });
    return c;
  });

  if (!existente) notificarClienteNuevoAMeta(cliente.id);
  return { clienteId: cliente.id, clienteNombre: cliente.nombre, yaExistia: !!existente };
}

export async function eliminarProspecto(id: string) {
  await prisma.prospecto.delete({ where: { id } });
}
