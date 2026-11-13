-- Cargo por servicio a domicilio que se suma al total de la nota.
ALTER TABLE "Venta" ADD COLUMN "cargoDomicilio" DECIMAL(12,2) NOT NULL DEFAULT 0;
