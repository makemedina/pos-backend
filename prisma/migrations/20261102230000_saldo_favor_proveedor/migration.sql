-- AlterTable
ALTER TABLE "Proveedor" ADD COLUMN "saldoAFavor" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PagoCompra" ADD COLUMN "excedenteAFavor" DECIMAL(12,2) NOT NULL DEFAULT 0;
