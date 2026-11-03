-- AlterTable
ALTER TABLE "Venta" ADD COLUMN "idLocal" TEXT;

-- AlterTable
ALTER TABLE "PagoVenta" ADD COLUMN "consumosSaldoFavor" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Venta_idLocal_key" ON "Venta"("idLocal");
