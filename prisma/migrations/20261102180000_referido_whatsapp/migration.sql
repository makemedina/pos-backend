-- CreateTable
CREATE TABLE "ReferidoWhatsapp" (
    "id" TEXT NOT NULL,
    "mensajeId" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "ctwaClid" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceType" TEXT,
    "headline" TEXT,
    "recibidoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferidoWhatsapp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferidoWhatsapp_mensajeId_key" ON "ReferidoWhatsapp"("mensajeId");

-- CreateIndex
CREATE INDEX "ReferidoWhatsapp_telefono_recibidoEn_idx" ON "ReferidoWhatsapp"("telefono", "recibidoEn");
