-- AlterTable
ALTER TABLE "Venta" ADD COLUMN     "metaRevisadaEn" TIMESTAMP(3);

-- Las ventas que ya existian se avisaban a Meta al momento de registrarse,
-- asi que se marcan como revisadas para no mandarlas otra vez.
UPDATE "Venta" SET "metaRevisadaEn" = NOW();

-- CreateIndex
CREATE INDEX "Venta_metaRevisadaEn_idx" ON "Venta"("metaRevisadaEn");
