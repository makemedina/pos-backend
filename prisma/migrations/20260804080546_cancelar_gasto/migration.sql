-- AlterTable
ALTER TABLE "Gasto" ADD COLUMN     "autorizadoPorId" TEXT,
ADD COLUMN     "cancelado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canceladoEn" TIMESTAMP(3),
ADD COLUMN     "canceladoPorId" TEXT;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_canceladoPorId_fkey" FOREIGN KEY ("canceladoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_autorizadoPorId_fkey" FOREIGN KEY ("autorizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
