-- CreateTable
CREATE TABLE "DepositoBanco" (
    "id" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "notas" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registradoPorId" TEXT NOT NULL,
    "cancelado" BOOLEAN NOT NULL DEFAULT false,
    "canceladoEn" TIMESTAMP(3),
    "canceladoPorId" TEXT,
    "autorizadoPorId" TEXT,

    CONSTRAINT "DepositoBanco_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepositoBanco_fecha_idx" ON "DepositoBanco"("fecha");

-- CreateIndex
CREATE INDEX "DepositoBanco_registradoPorId_idx" ON "DepositoBanco"("registradoPorId");

-- AddForeignKey
ALTER TABLE "DepositoBanco" ADD CONSTRAINT "DepositoBanco_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositoBanco" ADD CONSTRAINT "DepositoBanco_canceladoPorId_fkey" FOREIGN KEY ("canceladoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositoBanco" ADD CONSTRAINT "DepositoBanco_autorizadoPorId_fkey" FOREIGN KEY ("autorizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
