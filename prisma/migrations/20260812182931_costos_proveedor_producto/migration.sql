-- CreateTable
CREATE TABLE "CostoProveedorProducto" (
    "id" TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "varianteId" TEXT NOT NULL,
    "costo" DECIMAL(10,2) NOT NULL,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostoProveedorProducto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CostoProveedorProducto_proveedorId_varianteId_key" ON "CostoProveedorProducto"("proveedorId", "varianteId");

-- AddForeignKey
ALTER TABLE "CostoProveedorProducto" ADD CONSTRAINT "CostoProveedorProducto_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "Proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostoProveedorProducto" ADD CONSTRAINT "CostoProveedorProducto_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "Variante"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
