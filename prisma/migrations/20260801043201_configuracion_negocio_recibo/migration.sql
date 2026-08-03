-- CreateTable
CREATE TABLE "Configuracion" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "nombreNegocio" TEXT NOT NULL DEFAULT '',
    "logoBase64" TEXT,
    "telefono" TEXT NOT NULL DEFAULT '',
    "direccion" TEXT NOT NULL DEFAULT '',
    "notasNegocio" TEXT NOT NULL DEFAULT '',
    "mostrarDatosCliente" BOOLEAN NOT NULL DEFAULT true,
    "encabezadoRecibo" TEXT NOT NULL DEFAULT '',
    "piePaginaRecibo" TEXT NOT NULL DEFAULT '',
    "anchoPapelMm" INTEGER NOT NULL DEFAULT 58,
    "imprimirDosVeces" BOOLEAN NOT NULL DEFAULT false,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Configuracion_pkey" PRIMARY KEY ("id")
);
