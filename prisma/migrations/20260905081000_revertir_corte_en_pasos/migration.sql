-- Revierte la migracion 20260905062411_corte_en_pasos (el corte de caja
-- en 3 pasos). Vuelve a exigir efectivoContado/saldoBancoContado y los
-- campos calculados juntos, como antes.
ALTER TABLE "CorteCaja" ALTER COLUMN "saldoBancoContado" SET NOT NULL,
ALTER COLUMN "balanzaTotal" SET DEFAULT 0,
ALTER COLUMN "balanzaTotal" SET NOT NULL,
ALTER COLUMN "gastosDia" SET DEFAULT 0,
ALTER COLUMN "gastosDia" SET NOT NULL,
ALTER COLUMN "utilidadDia" SET DEFAULT 0,
ALTER COLUMN "utilidadDia" SET NOT NULL,
ALTER COLUMN "valorInventario" SET DEFAULT 0,
ALTER COLUMN "valorInventario" SET NOT NULL;
