-- CreateTable
CREATE TABLE "NotaCliente" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "autorId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotaCliente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotaCliente_clienteId_idx" ON "NotaCliente"("clienteId");

-- AddForeignKey
ALTER TABLE "NotaCliente" ADD CONSTRAINT "NotaCliente_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaCliente" ADD CONSTRAINT "NotaCliente_autorId_fkey" FOREIGN KEY ("autorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

