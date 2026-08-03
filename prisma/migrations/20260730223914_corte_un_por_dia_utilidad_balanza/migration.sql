/*
  Warnings:

  - A unique constraint covering the columns `[fecha]` on the table `CorteCaja` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `actualizadoEn` to the `CorteCaja` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "CorteCaja" ADD COLUMN     "actualizadoEn" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "balanzaAnterior" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "balanzaTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "gastosDia" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "utilidadDia" DECIMAL(12,2) NOT NULL DEFAULT 0,
ALTER COLUMN "fecha" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "CorteCaja_fecha_key" ON "CorteCaja"("fecha");
