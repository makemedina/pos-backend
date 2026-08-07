-- AlterTable
ALTER TABLE "PagoVenta" ADD COLUMN     "autorizadoPorId" TEXT,
ADD COLUMN     "cancelado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canceladoEn" TIMESTAMP(3),
ADD COLUMN     "canceladoPorId" TEXT;

-- AddForeignKey
ALTER TABLE "PagoVenta" ADD CONSTRAINT "PagoVenta_canceladoPorId_fkey" FOREIGN KEY ("canceladoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoVenta" ADD CONSTRAINT "PagoVenta_autorizadoPorId_fkey" FOREIGN KEY ("autorizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
