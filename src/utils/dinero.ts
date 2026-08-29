/**
 * Redondea a centavos (2 decimales). Los montos de dinero en este sistema
 * se manejan como number de JS (no Decimal) en la mayoria de los
 * calculos -- sin este redondeo, restas encadenadas (ej. varios abonos
 * parciales seguidos a la misma nota) pueden dejar un residuo de punto
 * flotante como 0.00000000000003 en vez de exactamente 0. Ese residuo
 * se ve como "$0.00" ya formateado, pero al compararlo con <= 0 para
 * decidir si la nota ya quedo "pagada" da false -- la nota se queda
 * "parcial" para siempre aunque en la pantalla diga saldo $0.00.
 */
export function redondearCentavos(monto: number): number {
  return Math.round((monto + Number.EPSILON) * 100) / 100;
}
