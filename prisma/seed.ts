import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.usuario.upsert({
    where: { telefono: '6621234567' },
    update: {
      pin: await bcrypt.hash('0000', 10),
      rolBase: 'administrador',
    },
    create: {
      nombre: 'Marco (Admin)',
      telefono: '6621234567',
      pin: await bcrypt.hash('0000', 10),
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