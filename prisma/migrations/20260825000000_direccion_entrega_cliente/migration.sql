-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "direccionEntrega" TEXT;

-- AlterTable
ALTER TABLE "Configuracion" DROP COLUMN "direccionEntrega";
