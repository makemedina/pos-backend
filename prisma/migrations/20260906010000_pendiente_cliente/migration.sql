-- AlterTable
ALTER TABLE "Pendiente" ADD COLUMN     "clienteId" TEXT;

-- AddForeignKey
ALTER TABLE "Pendiente" ADD CONSTRAINT "Pendiente_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;
