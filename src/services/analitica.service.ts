import { prisma } from '../prisma';

// Un cliente se marca "en riesgo" cuando su ritmo de compra o su volumen
// reciente cae a este porcentaje o menos de lo que es NORMAL PARA EL --
// no es un numero fijo igual para todos: un cliente que compra cada 3
// dias y uno que compra cada mes tienen "normales" distintos, y cada uno
// se compara solo contra su propio historial.
export const UMBRAL_RIESGO_PORCENTAJE = 70;

// Ventana usada para medir "volumen reciente" (senal de "esta comprando
// menos"), en dias.
const VENTANA_RECIENTE_DIAS = 30;

// Hacen falta al menos 3 compras para saber cual es el ritmo normal de un
// cliente (2 intervalos entre compras) -- con menos, no hay suficiente
// historial para decir que algo cambio.
const COMPRAS_MINIMAS_PARA_ANALIZAR = 3;

const UN_DIA_MS = 1000 * 60 * 60 * 24;

// El negocio no abre los domingos -- para el ritmo de compra ("cada
// cuantos dias compra" / "cuantos dias lleva sin comprar"), contar el
// domingo como un dia habil mas haria que un cliente que compra cada
// semana (ej. lunes a lunes) se vea con un intervalo de 7 dias en vez de
// los 6 dias habiles reales, distorsionando la comparacion.
function diasHabilesEntre(inicio: Date, fin: Date): number {
  const cursor = new Date(inicio);
  cursor.setHours(0, 0, 0, 0);
  const finNormalizado = new Date(fin);
  finNormalizado.setHours(0, 0, 0, 0);

  let dias = 0;
  while (cursor < finNormalizado) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() !== 0) dias++; // getDay() === 0 -> domingo
  }
  return dias;
}

export type MotivoRiesgo = 'dejo_de_comprar' | 'compra_menos' | 'ambos';

export interface ClienteEnRiesgo {
  id: string;
  nombre: string;
  telefono: string;
  ultimaCompra: Date;
  diasSinComprar: number;
  intervaloPromedioDias: number;
  ritmoPct: number;
  gastoRecientePct: number | null;
  motivo: MotivoRiesgo;
  // El menor de los porcentajes disponibles -- entre mas bajo, mas
  // urgente. Se usa para ordenar la lista de mas a menos prioritario.
  prioridadPct: number;
}

/**
 * Detecta clientes que dejaron de comprar (o van tarde segun su propio
 * ritmo historico) y/o que estan comprando un volumen menor al que
 * acostumbran, para saber a quien llamarle a ofrecer producto.
 *
 * Cada cliente se compara SOLO contra su propio historial (no contra un
 * promedio general del negocio), asi que aplica igual de bien a un
 * cliente que compra diario que a uno que compra una vez al mes.
 */
export async function clientesEnRiesgo(): Promise<ClienteEnRiesgo[]> {
  const clientes = await prisma.cliente.findMany({
    include: {
      ventas: {
        where: { cancelada: false },
        select: { fecha: true, total: true },
        orderBy: { fecha: 'asc' },
      },
    },
  });

  const hoy = new Date();
  const resultado: ClienteEnRiesgo[] = [];

  for (const c of clientes) {
    if (c.ventas.length < COMPRAS_MINIMAS_PARA_ANALIZAR) continue;

    const fechas = c.ventas.map((v) => v.fecha);
    const primeraCompra = fechas[0];
    const ultimaCompra = fechas[fechas.length - 1];
    const diasSinComprar = diasHabilesEntre(ultimaCompra, hoy);

    // Senal 1: ritmo de compra. Cuanto tardaba normalmente entre una
    // compra y la siguiente (en dias habiles, sin contar domingos),
    // contra cuanto lleva tardando ahora.
    let sumaIntervalos = 0;
    for (let i = 1; i < fechas.length; i++) {
      sumaIntervalos += diasHabilesEntre(fechas[i - 1], fechas[i]);
    }
    const intervaloPromedioDias = sumaIntervalos / (fechas.length - 1);
    const ritmoPct = Math.min(
      100,
      Math.round((intervaloPromedioDias / Math.max(diasSinComprar, 1)) * 100)
    );

    // Senal 2: volumen reciente (ultimos 30 dias) contra lo que gastaba
    // por mes ANTES de esa ventana -- solo si ya tiene historial de mas
    // de 30 dias, si no no hay con que comparar todavia.
    const inicioVentanaReciente = new Date(hoy.getTime() - VENTANA_RECIENTE_DIAS * UN_DIA_MS);
    let gastoReciente = 0;
    let gastoAnterior = 0;
    for (const v of c.ventas) {
      if (v.fecha >= inicioVentanaReciente) gastoReciente += Number(v.total);
      else gastoAnterior += Number(v.total);
    }
    const diasConHistorialAnterior = (inicioVentanaReciente.getTime() - primeraCompra.getTime()) / UN_DIA_MS;

    let gastoRecientePct: number | null = null;
    if (diasConHistorialAnterior >= VENTANA_RECIENTE_DIAS) {
      const promedioDiarioAnterior = gastoAnterior / diasConHistorialAnterior;
      const gastoEsperado = promedioDiarioAnterior * VENTANA_RECIENTE_DIAS;
      gastoRecientePct = gastoEsperado > 0 ? Math.round((gastoReciente / gastoEsperado) * 100) : null;
    }

    const enRiesgoRitmo = ritmoPct <= UMBRAL_RIESGO_PORCENTAJE;
    const enRiesgoVolumen = gastoRecientePct !== null && gastoRecientePct <= UMBRAL_RIESGO_PORCENTAJE;

    if (!enRiesgoRitmo && !enRiesgoVolumen) continue;

    const motivo: MotivoRiesgo =
      enRiesgoRitmo && enRiesgoVolumen ? 'ambos' : enRiesgoRitmo ? 'dejo_de_comprar' : 'compra_menos';

    const candidatos = [ritmoPct, gastoRecientePct].filter((x): x is number => x !== null);

    resultado.push({
      id: c.id,
      nombre: c.nombre,
      telefono: c.telefono,
      ultimaCompra,
      diasSinComprar,
      intervaloPromedioDias: Math.round(intervaloPromedioDias),
      ritmoPct,
      gastoRecientePct,
      motivo,
      prioridadPct: Math.min(...candidatos),
    });
  }

  return resultado.sort((a, b) => a.prioridadPct - b.prioridadPct);
}
