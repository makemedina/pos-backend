-- CreateTable
CREATE TABLE "Usuario" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "rolBase" TEXT NOT NULL DEFAULT 'vendedor',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermisosUsuario" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "puedeVerCostos" BOOLEAN NOT NULL DEFAULT false,
    "puedeRegistrarCompras" BOOLEAN NOT NULL DEFAULT false,
    "puedeVerUtilidad" BOOLEAN NOT NULL DEFAULT false,
    "puedeVerCarteraGeneral" BOOLEAN NOT NULL DEFAULT false,
    "puedeVerGastosTodos" BOOLEAN NOT NULL DEFAULT false,
    "puedeAutorizar" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PermisosUsuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Producto" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "categoriaId" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Categoria" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "Categoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variante" (
    "id" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "sku" TEXT,
    "precioVenta" DECIMAL(10,2) NOT NULL,
    "stockMinimo" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Variante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proveedor" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT,
    "contacto" TEXT,

    CONSTRAINT "Proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Compra" (
    "id" TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "numeroFactura" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaVencimiento" TIMESTAMP(3),
    "total" DECIMAL(12,2) NOT NULL,
    "saldoPendiente" DECIMAL(12,2) NOT NULL,
    "estadoPago" TEXT NOT NULL DEFAULT 'pendiente',

    CONSTRAINT "Compra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PagoCompra" (
    "id" TEXT NOT NULL,
    "compraId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monto" DECIMAL(12,2) NOT NULL,
    "metodoPago" TEXT NOT NULL,

    CONSTRAINT "PagoCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoteInventario" (
    "id" TEXT NOT NULL,
    "varianteId" TEXT NOT NULL,
    "compraId" TEXT NOT NULL,
    "costoUnitario" DECIMAL(10,2) NOT NULL,
    "cantidadInicial" DECIMAL(10,3) NOT NULL,
    "cantidadDisponible" DECIMAL(10,3) NOT NULL,
    "fechaIngreso" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoteInventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cliente" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "email" TEXT,
    "direccion" TEXT,
    "notas" TEXT,
    "fechaAlta" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venta" (
    "id" TEXT NOT NULL,
    "vendedorId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total" DECIMAL(12,2) NOT NULL,
    "saldoPendiente" DECIMAL(12,2) NOT NULL,
    "esCredito" BOOLEAN NOT NULL DEFAULT false,
    "estadoPago" TEXT NOT NULL DEFAULT 'pendiente',
    "estadoSync" TEXT NOT NULL DEFAULT 'sincronizada',
    "canalTicket" TEXT,

    CONSTRAINT "Venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VentaItem" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "loteId" TEXT NOT NULL,
    "cantidad" DECIMAL(10,3) NOT NULL,
    "precioLista" DECIMAL(10,2) NOT NULL,
    "precioUnitario" DECIMAL(10,2) NOT NULL,
    "costoUnitarioSnapshot" DECIMAL(10,2) NOT NULL,
    "autorizadoPorId" TEXT,
    "motivoAutorizacion" TEXT,

    CONSTRAINT "VentaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PagoVenta" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monto" DECIMAL(12,2) NOT NULL,
    "metodoPago" TEXT NOT NULL,

    CONSTRAINT "PagoVenta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PagoAsignacion" (
    "id" TEXT NOT NULL,
    "pagoId" TEXT NOT NULL,
    "ventaItemId" TEXT NOT NULL,
    "montoAsignado" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PagoAsignacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AjusteInventario" (
    "id" TEXT NOT NULL,
    "loteId" TEXT NOT NULL,
    "solicitadoPorId" TEXT NOT NULL,
    "autorizadoPorId" TEXT,
    "tipo" TEXT NOT NULL,
    "cantidad" DECIMAL(10,3) NOT NULL,
    "motivo" TEXT NOT NULL,
    "impactoUtilidad" DECIMAL(12,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AjusteInventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoriaGasto" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "departamento" TEXT NOT NULL,

    CONSTRAINT "CategoriaGasto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gasto" (
    "id" TEXT NOT NULL,
    "categoriaId" TEXT NOT NULL,
    "registradoPorId" TEXT NOT NULL,
    "concepto" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "metodoPago" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Gasto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorteCaja" (
    "id" TEXT NOT NULL,
    "registradoPorId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "efectivoContado" DECIMAL(12,2) NOT NULL,
    "saldoBancoContado" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "CorteCaja_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_telefono_key" ON "Usuario"("telefono");

-- CreateIndex
CREATE UNIQUE INDEX "PermisosUsuario_usuarioId_key" ON "PermisosUsuario"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX "Variante_sku_key" ON "Variante"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Variante_productoId_marca_key" ON "Variante"("productoId", "marca");

-- AddForeignKey
ALTER TABLE "PermisosUsuario" ADD CONSTRAINT "PermisosUsuario_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Producto" ADD CONSTRAINT "Producto_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "Categoria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variante" ADD CONSTRAINT "Variante_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "Proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoCompra" ADD CONSTRAINT "PagoCompra_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "Compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoteInventario" ADD CONSTRAINT "LoteInventario_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "Variante"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoteInventario" ADD CONSTRAINT "LoteInventario_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "Compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VentaItem" ADD CONSTRAINT "VentaItem_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VentaItem" ADD CONSTRAINT "VentaItem_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "LoteInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VentaItem" ADD CONSTRAINT "VentaItem_autorizadoPorId_fkey" FOREIGN KEY ("autorizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoVenta" ADD CONSTRAINT "PagoVenta_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoAsignacion" ADD CONSTRAINT "PagoAsignacion_pagoId_fkey" FOREIGN KEY ("pagoId") REFERENCES "PagoVenta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoAsignacion" ADD CONSTRAINT "PagoAsignacion_ventaItemId_fkey" FOREIGN KEY ("ventaItemId") REFERENCES "VentaItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AjusteInventario" ADD CONSTRAINT "AjusteInventario_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "LoteInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AjusteInventario" ADD CONSTRAINT "AjusteInventario_solicitadoPorId_fkey" FOREIGN KEY ("solicitadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AjusteInventario" ADD CONSTRAINT "AjusteInventario_autorizadoPorId_fkey" FOREIGN KEY ("autorizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "CategoriaGasto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorteCaja" ADD CONSTRAINT "CorteCaja_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
