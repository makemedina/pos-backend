-- AlterTable
ALTER TABLE "Venta" ADD COLUMN     "cancelada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canceladaEn" TIMESTAMP(3),
ADD COLUMN     "canceladaPorId" TEXT;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_canceladaPorId_fkey" FOREIGN KEY ("canceladaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
