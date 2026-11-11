-- Subcategorias de gasto que se pueden ocultar sin borrarlas
ALTER TABLE "CategoriaGasto" ADD COLUMN "activa" BOOLEAN NOT NULL DEFAULT true;
