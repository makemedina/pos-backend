import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// El PIN del primer administrador se pasa por variable de entorno, nunca
// fijo en el codigo: este repo es publico. Si el usuario ya existe, no se
// le toca nada -- antes cada corrida del seed le regresaba el PIN a 0000.
const PIN_ADMIN = process.env.SEED_ADMIN_PIN;

async function main() {
  if (!PIN_ADMIN || !/^\d{4,}$/.test(PIN_ADMIN)) {
    throw new Error('Define SEED_ADMIN_PIN (4 digitos o mas) para correr el seed.');
  }

  const admin = await prisma.usuario.upsert({
    where: { telefono: '6621234567' },
    update: {},
    create: {
      nombre: 'Marco (Admin)',
      telefono: '6621234567',
      pin: await bcrypt.hash(PIN_ADMIN, 10),
      rolBase: 'administrador',
      permisos: {
        create: {
          puedeVerCostos: true,
          puedeRegistrarCompras: true,
          puedeVerUtilidad: true,
          puedeVerCarteraGeneral: true,
          puedeVerGastosTodos: true,
          puedeAutorizar: true,
          puedeRegistrarPagos: true,
        },
      },
    },
  });

  console.log('Administrador creado/verificado:');
  console.log({
    id: admin.id,
    nombre: admin.nombre,
    telefono: admin.telefono,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });