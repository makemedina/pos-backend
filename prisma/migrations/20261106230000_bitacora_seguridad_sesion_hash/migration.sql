-- Bitacora de seguridad
CREATE TABLE "BitacoraSeguridad" (
    "id" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evento" TEXT NOT NULL,
    "resultado" TEXT NOT NULL DEFAULT 'ok',
    "usuarioId" TEXT,
    "objetivo" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "detalle" JSONB,

    CONSTRAINT "BitacoraSeguridad_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BitacoraSeguridad_creadoEn_idx" ON "BitacoraSeguridad"("creadoEn");
CREATE INDEX "BitacoraSeguridad_evento_creadoEn_idx" ON "BitacoraSeguridad"("evento", "creadoEn");
CREATE INDEX "BitacoraSeguridad_usuarioId_creadoEn_idx" ON "BitacoraSeguridad"("usuarioId", "creadoEn");

CREATE INDEX "Sesion_usuarioId_idx" ON "Sesion"("usuarioId");

-- Las sesiones existentes guardaban el token en claro. Se reemplaza por
-- su SHA-256 para que nadie tenga que volver a iniciar sesion.
-- sha256() es nativo desde PostgreSQL 11 (no necesita pgcrypto).
UPDATE "Sesion" SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex') WHERE length("token") <> 64;
