// Limite de intentos de login para frenar ataques de fuerza bruta contra
// el PIN (que solo tiene 4 digitos, 10,000 combinaciones -- sin esto,
// alguien con acceso a la red podria probarlas todas en minutos).
//
// Se guarda en memoria (no en la base de datos): es mas simple y no
// necesita migracion. La contraparte es que se reinicia si el servidor
// se reinicia -- aceptable para este tamaño de negocio, donde el objetivo
// es frenar un ataque automatizado, no llevar una bitacora permanente.

const MAX_INTENTOS = 5;
const DURACION_BLOQUEO_MIN = 15;

interface EstadoIntentos {
  intentos: number;
  bloqueadoHasta: number | null; // timestamp en ms
}

const intentosPorIdentificador = new Map<string, EstadoIntentos>();

function normalizar(identificador: string) {
  return identificador.trim().toLowerCase();
}

/** Revisa si este identificador (telefono o nombre) esta bloqueado ahora. Si lo esta, regresa los minutos que faltan. */
export function verificarBloqueo(identificador: string): number | null {
  const clave = normalizar(identificador);
  const estado = intentosPorIdentificador.get(clave);
  if (!estado?.bloqueadoHasta) return null;

  const restante = estado.bloqueadoHasta - Date.now();
  if (restante <= 0) {
    // Ya paso el bloqueo -- se limpia para que pueda intentar de nuevo.
    intentosPorIdentificador.delete(clave);
    return null;
  }
  return Math.ceil(restante / 60000);
}

/** Se llama cuando el PIN es incorrecto. Si llega al limite, bloquea. */
export function registrarIntentoFallido(identificador: string) {
  const clave = normalizar(identificador);
  const estado = intentosPorIdentificador.get(clave) ?? { intentos: 0, bloqueadoHasta: null };
  estado.intentos += 1;

  if (estado.intentos >= MAX_INTENTOS) {
    estado.bloqueadoHasta = Date.now() + DURACION_BLOQUEO_MIN * 60 * 1000;
  }

  intentosPorIdentificador.set(clave, estado);
}

/** Se llama cuando el login es exitoso, para reiniciar el contador. */
export function limpiarIntentos(identificador: string) {
  intentosPorIdentificador.delete(normalizar(identificador));
}

// ---- Limite por IP ----
// El limite por identificador no frena a quien prueba PINs comunes contra
// muchos telefonos distintos. Este cuenta los fallos por IP en una ventana
// fija: pasado el maximo, esa IP no puede intentar login por un rato.
const MAX_FALLOS_POR_IP = 30;
const VENTANA_IP_MIN = 15;
const fallosPorIp = new Map<string, { fallos: number; desde: number }>();

export function ipBloqueada(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const estado = fallosPorIp.get(ip);
  if (!estado) return false;
  if (Date.now() - estado.desde > VENTANA_IP_MIN * 60 * 1000) {
    fallosPorIp.delete(ip);
    return false;
  }
  return estado.fallos >= MAX_FALLOS_POR_IP;
}

export function registrarFalloIp(ip: string | undefined | null) {
  if (!ip) return;
  const ahora = Date.now();
  const estado = fallosPorIp.get(ip);
  if (!estado || ahora - estado.desde > VENTANA_IP_MIN * 60 * 1000) {
    fallosPorIp.set(ip, { fallos: 1, desde: ahora });
  } else {
    estado.fallos += 1;
  }
  // Evita que el mapa crezca sin limite si llegan miles de IPs distintas.
  if (fallosPorIp.size > 10000) {
    for (const [clave, valor] of fallosPorIp) {
      if (ahora - valor.desde > VENTANA_IP_MIN * 60 * 1000) fallosPorIp.delete(clave);
    }
  }
}
