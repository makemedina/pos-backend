/*
  Warnings:

  - You are about to drop the column `balanzaAnterior` on the `CorteCaja` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "CorteCaja" DROP COLUMN "balanzaAnterior",
ADD COLUMN     "valorInventario" DECIMAL(12,2) NOT NULL DEFAULT 0;
