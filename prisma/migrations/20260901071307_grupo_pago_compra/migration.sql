-- AlterTable
ALTER TABLE "PagoCompra" ADD COLUMN     "grupoPagoId" TEXT;

-- CreateIndex
CREATE INDEX "PagoCompra_grupoPagoId_idx" ON "PagoCompra"("grupoPagoId");
