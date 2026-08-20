/*
  Warnings:

  - Added the required column `actualizadoEn` to the `LlamadaCliente` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "LlamadaCliente" ADD COLUMN     "actualizadoEn" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "hecha" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hizoPedido" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notas" TEXT;
