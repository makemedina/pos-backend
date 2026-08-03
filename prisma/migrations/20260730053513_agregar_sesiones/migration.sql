-- CreateTable
CREATE TABLE "Sesion" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "creadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiraEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sesion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sesion_token_key" ON "Sesion"("token");

-- AddForeignKey
ALTER TABLE "Sesion" ADD CONSTRAINT "Sesion_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
