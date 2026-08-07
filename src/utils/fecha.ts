// Convierte un string "YYYY-MM-DD" (el que mandan los <input type="date">
// del frontend, o un date-only ISO string) a medianoche LOCAL de ese dia.
//
// Ojo: "new Date('2026-07-30')" NO sirve para esto -- un string de solo
// fecha se interpreta como medianoche UTC (por spec de ECMAScript), y si
// luego se le hace .setHours(0,0,0,0) (que opera en hora LOCAL del
// proceso), el dia se recorre uno hacia atras en cualquier servidor con
// zona horaria detras de UTC (Culiacan es UTC-7). Construir la fecha
// directamente con los componentes Y/M/D evita ese doble brinco de zona
// horaria.
export function fechaLocalDesdeString(fechaStr: string): Date {
  const [anio, mes, dia] = fechaStr.split('-').map(Number);
  return new Date(anio, mes - 1, dia);
}
