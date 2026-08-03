import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.usuario.upsert({
    where: { telefono: '6621234567' },
    update: { pin: await bcrypt.hash('0000', 10) },
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
        },
      },
    },
  });

  const proveedor = await prisma.proveedor.upsert({
    where: { id: 'proveedor-seed-1' },
    update: {},
    create: {
      id: 'proveedor-seed-1',
      nombre: 'Carnes Guerrero',
      telefono: '6627654321',
      contacto: 'Don Beto',
    },
  });

  const categoria = await prisma.categoria.upsert({
    where: { id: 'categoria-cerdo' },
    update: {},
    create: { id: 'categoria-cerdo', nombre: 'Cerdo' },
  });

  const producto = await prisma.producto.upsert({
    where: { id: 'producto-pierna' },
    update: {},
    create: {
      id: 'producto-pierna',
      nombre: 'Pierna de cerdo',
      categoriaId: categoria.id,
    },
  });

  const variante = await prisma.variante.upsert({
    where: { productoId_marca: { productoId: producto.id, marca: 'Norson' } },
    update: {},
    create: {
      productoId: producto.id,
      marca: 'Norson',
      precioVenta: 68.0,
      stockMinimo: 5,
    },
  });

  const cliente = await prisma.cliente.upsert({
    where: { id: 'cliente-seed-1' },
    update: {},
    create: {
      id: 'cliente-seed-1',
      nombre: 'Maria Gonzalez',
      telefono: '6629998877',
    },
  });

  console.log('Datos de prueba creados:');
  console.log({ adminId: admin.id, proveedorId: proveedor.id, varianteId: variante.id, clienteId: cliente.id });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });