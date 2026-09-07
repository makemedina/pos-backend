-- CreateTable
CREATE TABLE "Pendiente" (
    "id" TEXT NOT NULL,
    "concepto" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "hecho" BOOLEAN NOT NULL DEFAULT false,
    "notas" TEXT,
    "registradoPorId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pendiente_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Pendiente" ADD CONSTRAINT "Pendiente_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
