-- AlterTable
ALTER TABLE "Compra" ADD COLUMN     "autorizadaPorId" TEXT,
ADD COLUMN     "cancelada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canceladaEn" TIMESTAMP(3),
ADD COLUMN     "canceladaPorId" TEXT;

-- AlterTable
ALTER TABLE "Venta" ADD COLUMN     "autorizadaPorId" TEXT;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_canceladaPorId_fkey" FOREIGN KEY ("canceladaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_autorizadaPorId_fkey" FOREIGN KEY ("autorizadaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_autorizadaPorId_fkey" FOREIGN KEY ("autorizadaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
