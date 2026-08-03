-- AlterTable
ALTER TABLE "PagoCompra" ADD COLUMN     "registradoPorId" TEXT;

-- AddForeignKey
ALTER TABLE "PagoCompra" ADD CONSTRAINT "PagoCompra_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
