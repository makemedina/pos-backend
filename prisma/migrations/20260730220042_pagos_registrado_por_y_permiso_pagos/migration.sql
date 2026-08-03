-- AlterTable
ALTER TABLE "PagoVenta" ADD COLUMN     "registradoPorId" TEXT;

-- AlterTable
ALTER TABLE "PermisosUsuario" ADD COLUMN     "puedeRegistrarPagos" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "PagoVenta" ADD CONSTRAINT "PagoVenta_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
