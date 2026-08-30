-- AlterTable
ALTER TABLE "Cliente"
ADD COLUMN     "calle" TEXT,
ADD COLUMN     "calleEntrega" TEXT,
ADD COLUMN     "ciudad" TEXT,
ADD COLUMN     "ciudadEntrega" TEXT,
ADD COLUMN     "codigoPostal" TEXT,
ADD COLUMN     "codigoPostalEntrega" TEXT,
ADD COLUMN     "colonia" TEXT,
ADD COLUMN     "coloniaEntrega" TEXT,
ADD COLUMN     "estado" TEXT,
ADD COLUMN     "estadoEntrega" TEXT;

-- No perder las direcciones que ya existian como texto libre: se copian
-- tal cual al nuevo campo "calle" (el mas parecido) para que no queden
-- huerfanas -- se pueden repartir a mano en los campos nuevos despues,
-- la proxima vez que se edite ese cliente.
UPDATE "Cliente" SET "calle" = "direccion" WHERE "direccion" IS NOT NULL AND "direccion" != '';
UPDATE "Cliente" SET "calleEntrega" = "direccionEntrega" WHERE "direccionEntrega" IS NOT NULL AND "direccionEntrega" != '';

-- AlterTable
ALTER TABLE "Cliente"
DROP COLUMN "direccion",
DROP COLUMN "direccionEntrega";
