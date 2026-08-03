-- AlterTable
ALTER TABLE "Gasto" ADD COLUMN     "proveedorId" TEXT;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "Proveedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
