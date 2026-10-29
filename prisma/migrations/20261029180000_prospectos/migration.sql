-- CreateTable
CREATE TABLE "Prospecto" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "nombreContacto" TEXT,
    "telefono" TEXT,
    "colonia" TEXT,
    "ciudad" TEXT,
    "googleMapsUrl" TEXT,
    "origen" TEXT NOT NULL,
    "interes" TEXT,
    "nivelInteres" TEXT NOT NULL DEFAULT 'medio',
    "estado" TEXT NOT NULL DEFAULT 'activo',
    "proximoContacto" TIMESTAMP(3),
    "motivoContacto" TEXT,
    "motivoDescarte" TEXT,
    "clienteId" TEXT,
    "convertidoEn" TIMESTAMP(3),
    "registradoPorId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospecto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotaProspecto" (
    "id" TEXT NOT NULL,
    "prospectoId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'nota',
    "texto" TEXT NOT NULL,
    "autorId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotaProspecto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Prospecto_estado_proximoContacto_idx" ON "Prospecto"("estado", "proximoContacto");

-- CreateIndex
CREATE INDEX "NotaProspecto_prospectoId_idx" ON "NotaProspecto"("prospectoId");

-- AddForeignKey
ALTER TABLE "Prospecto" ADD CONSTRAINT "Prospecto_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospecto" ADD CONSTRAINT "Prospecto_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaProspecto" ADD CONSTRAINT "NotaProspecto_prospectoId_fkey" FOREIGN KEY ("prospectoId") REFERENCES "Prospecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaProspecto" ADD CONSTRAINT "NotaProspecto_autorId_fkey" FOREIGN KEY ("autorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
