-- CreateTable
CREATE TABLE "ConexionWhatsapp" (
    "id" TEXT NOT NULL DEFAULT 'principal',
    "wabaId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "datasetId" TEXT,
    "tokenCifrado" TEXT NOT NULL,
    "conectadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sincronizadoEn" TIMESTAMP(3),
    "ultimoError" TEXT,

    CONSTRAINT "ConexionWhatsapp_pkey" PRIMARY KEY ("id")
);
