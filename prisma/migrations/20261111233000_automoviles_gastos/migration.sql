-- AlterTable
ALTER TABLE "CategoriaGasto" ADD COLUMN     "usoAutomovil" TEXT NOT NULL DEFAULT 'no';

-- AlterTable
ALTER TABLE "Gasto" ADD COLUMN     "automovilId" TEXT;

-- CreateTable
CREATE TABLE "Automovil" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "placas" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Automovil_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Gasto_automovilId_idx" ON "Gasto"("automovilId");

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_automovilId_fkey" FOREIGN KEY ("automovilId") REFERENCES "Automovil"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Transporte y combustible exige automovil; Mantenimiento y reparaciones
-- lo deja elegir (puede ser de algo que no es vehiculo).
UPDATE "CategoriaGasto" SET "usoAutomovil" = 'obligatorio'
WHERE "nombre" = 'Transporte y combustible' AND "departamento" = 'Operativos';
UPDATE "CategoriaGasto" SET "usoAutomovil" = 'opcional'
WHERE "nombre" = 'Mantenimiento y reparaciones' AND "departamento" = 'Operativos';
