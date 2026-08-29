-- AlterTable
ALTER TABLE "PagoVenta" ADD COLUMN     "grupoPagoId" TEXT;

-- CreateIndex
CREATE INDEX "PagoVenta_grupoPagoId_idx" ON "PagoVenta"("grupoPagoId");
