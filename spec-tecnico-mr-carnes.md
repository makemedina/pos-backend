# Documento técnico de referencia — POS/Inventario Mr Carnes

## 1. Contexto de negocio

Sistema de punto de venta e inventario para un negocio de venta de carnes en campo.

- Los cortes de carne, como "Pierna de cerdo", tienen múltiples marcas, por ejemplo: Norson, Soles, Kowi, Yoreme.
- La misma marca puede comprarse a distintos proveedores.
- Las ventas se realizan en campo desde celulares Android o iPhone, normalmente con internet disponible.
- La impresión de tickets es opcional, mediante impresora térmica Bluetooth y solo funciona en Android.
- En iPhone, el ticket se puede enviar digitalmente por WhatsApp o SMS.
- Referencia de mercado e inspiración: Kyte, con enfoque en venta rápida, caja, variantes, ticket promedio y valor de inventario.

## 2. Arquitectura general

### Frontend
- PWA única construida con React, Vite y TypeScript.
- Una sola base de código sirve tanto para ventas en campo como para el panel administrativo.
- La interfaz cambia según el rol y permisos del usuario autenticado.

### Backend
- Node.js + Express + TypeScript.
- ORM y base de datos: Prisma sobre PostgreSQL.

### Impresión y tickets
- Impresión: Web Bluetooth API, orientada a Android.
- Envío digital: Web Share API para WhatsApp o SMS.

### Ubicación de los proyectos
- Backend: pos-backend (puerto 3000)
- Frontend: pos-frontend (puerto 5173)

## 3. Reglas de negocio clave

### 3.1 Costeo FIFO por lotes
- Cada compra genera un lote nuevo en inventario con su propio costo unitario.
- Nunca se promedian costos entre lotes.
- Una venta descuenta primero el lote más antiguo disponible y puede partirse entre varios lotes.

### 3.2 No vender en negativo
- Si no hay stock suficiente, la venta se bloquea.
- No se permite vender más de lo disponible.

### 3.3 Precio de venta ajustable por transacción
- El precio de venta puede ajustarse por transacción.
- Si el precio ajustado queda por debajo del costo del lote que se vende, se requiere autorización de administrador.
- La autorización se basa en un código o PIN generado de forma remota por el administrador y requiere internet.
- Sin internet, esa venta no puede concretarse con ese precio.

### 3.4 Ajustes manuales de inventario
- Las mermas y ajustes manuales requieren autorización de administrador.
- Su impacto se refleja directamente en el cálculo de utilidad.

### 3.5 Ventas a crédito con pagos parciales
- La utilidad cobrada se calcula con precisión por producto.
- No se calcula de forma proporcional al total de la nota.
- La tabla de asignaciones de pago reparte cada pago entre las líneas de venta.
- Por defecto, el reparto es automático y proporcional al subtotal de cada línea.

### 3.6 Alta rápida de cliente desde checkout
- Se puede crear un cliente desde el mismo proceso de venta.
- Solo se captura nombre y teléfono; el resto se completa después.
- El sistema funciona como CRM real con historial de compras, productos vendidos y margen.

### 3.7 Gastos operativos
- Cualquier usuario puede registrar un gasto sin autorización previa.
- Solo ve sus propios gastos.
- Solo el administrador puede ver, editar o eliminar los gastos de todos.

### 3.8 Corte de caja diario
- No requiere conteo físico de inventario.
- Requiere captura manual de efectivo en caja y saldo en banco.
- Incluye gastos del día y utilidad neta.

### 3.9 Roles y permisos
- Los permisos son switches individuales por usuario, no roles fijos.
- Plantilla base: Vendedor y Administrador, con ajustes finos.
- Switches definidos:
  - puedeVerCostos
  - puedeRegistrarCompras
  - puedeVerUtilidad
  - puedeVerCarteraGeneral
  - puedeVerGastosTodos
  - puedeAutorizar

### 3.10 Alta de variante nueva desde compra
- El stock mínimo nace en 0 por default y se ajusta después en configuración.
- Se puede crear corte y marca sobre la marcha, sin ir al catálogo aparte.
- Flujo de UI sugerido:
  1. Buscar o elegir corte.
  2. Mostrar marcas existentes como chips y opción para nueva marca.
  3. Capturar cantidad y costo.

## 4. Modelo de datos (Prisma / PostgreSQL)

### Entidades principales

- Usuario
  - 1:1 con PermisosUsuario.
  - Maneja vendedores, administradores y permisos por switch.

- Cliente
  - Registra clientes del negocio.
  - Soporta historial de compras y CRM básico.

- Producto
  - Representa el corte de carne, por ejemplo "Pierna de cerdo".

- Variante
  - Representa la marca de un producto.
  - Relación única por producto y marca.

- Proveedor
  - Registra proveedores de compra.

- Compra
  - Registra la compra de inventario.
  - Incluye saldo pendiente, vencimiento, estado de pago y número de factura.

- PagoCompra
  - Registra pagos parciales o totales a proveedores.

- LoteInventario
  - Representa cada lote comprado.
  - Mantiene costo unitario, cantidad inicial y cantidad disponible.

- Venta
  - Registra transacciones de venta.
  - Incluye folio, crédito, saldo pendiente, estado de pago y canal de ticket.

- VentaItem
  - Cada línea de venta con precio, costo y autorización si aplica.

- PagoVenta
  - Registra pagos realizados por el cliente.

- PagoAsignacion
  - Reparte cada pago parcial entre líneas de venta.

- AjusteInventario
  - Registra mermas o correcciones manuales.
  - Puede impactar utilidad.

- Categoria
  - Clasificación general de productos.

- Gasto
  - Registro de gastos operativos.

- CategoriaGasto
  - Clasificación de gastos.

- CorteCaja
  - Registro de corte diario con efectivo y saldo en banco.

## 5. Estado actual del backend

### Stack actual
- Node.js
- Express
- TypeScript
- Prisma
- PostgreSQL

### Estado operativo
- El backend corre correctamente con npm run dev en el puerto 3000.
- La implementación central ya está construida y probada.

### Archivos clave
- prisma/schema.prisma: esquema completo con entidades y relaciones.
- prisma/seed.ts: datos de prueba iniciales.
- src/prisma.ts: cliente Prisma singleton.
- src/services/ventas.service.ts: creación de ventas con FIFO real, bloqueo por stock, autorización por precio bajo y cálculo de utilidad.
- src/services/compras.service.ts: creación de compras, generación de lotes y pagos a proveedores.
- src/services/inventario.service.ts: ajustes de inventario y movimientos por rango de fechas.
- src/services/corte.service.ts: corte del día y guardado de corte de caja.
- src/services/catalogo.service.ts: catálogo con stock calculado, costo de lote más viejo y búsquedas de variantes y productos.
- src/services/clientes.service.ts: búsqueda y alta rápida de clientes.
- src/services/proveedores.service.ts: búsqueda y alta rápida de proveedores.
- src/routes/index.ts: rutas REST centralizadas.
- src/server.ts: arranque del servidor con CORS, JSON y montaje de rutas en /api.

### Rutas disponibles
- Ventas: POST /api/ventas, GET /api/ventas/:id/utilidad
- Compras: POST /api/compras, POST /api/compras/:id/pagos, GET /api/compras/pendientes
- Inventario: POST /api/inventario/ajustes, GET /api/inventario/movimientos
- Corte: GET /api/corte, POST /api/corte/caja
- Catálogo: GET /api/catalogo, GET /api/catalogo/buscar, POST /api/catalogo/variantes, GET /api/catalogo/productos, GET /api/catalogo/productos/:id/variantes
- Clientes: GET /api/clientes, POST /api/clientes
- Proveedores: GET /api/proveedores, POST /api/proveedores

### Pruebas validadas
- Compra con generación de lote.
- Venta con FIFO y cálculo de utilidad.
- Bloqueo de venta por precio bajo sin autorización.
- Bloqueo por stock insuficiente.
- Catálogo con stock correcto.
- Búsqueda y alta de clientes y proveedores.

## 6. Estado actual del frontend

### Stack actual
- React
- Vite
- TypeScript
- PWA con vite-plugin-pwa

### Estado operativo
- El frontend corre con npm run dev en el puerto 5173.
- La app ya muestra catálogo, carrito, checkout y flujo de compra.

### Archivos clave
- vite.config.ts: configuración de React y PWA.
- src/api.ts: cliente fetch con manejo de errores por código.
- src/App.tsx: pantalla principal con catálogo, carrito y checkout.
- src/Carrito.tsx: barra inferior con resumen de venta.
- src/ModalAgregarProducto.tsx: selector de cantidad y precio por kg.
- src/Checkout.tsx: resumen, cliente, método de pago y venta a crédito.
- src/PantallaCompra.tsx: flujo de compra con proveedor, factura, vencimiento y alta rápida de producto/variante.
- src/index.css: estilos de la interfaz.

### Pruebas validadas
- Catálogo con stock real.
- Venta completa registrada contra backend.
- Checkout con cliente y crédito parcial.
- Compra completa con producto existente y con marca nueva.

## 7. Trabajo pendiente

### 7.1 Autorización remota real
- Falta un flujo completo para que el vendedor solicite autorización y el administrador la apruebe en tiempo real desde otro celular.
- El backend ya exige autorizadoPorId, pero el mecanismo de solicitud-aprobación no existe todavía.

### 7.2 Pantalla de ajustes de inventario
- El backend ya soporta crear ajustes manuales.
- Falta la interfaz de usuario para registrar mermas y correcciones.

### 7.3 Permisos configurables por usuario
- La tabla PermisosUsuario existe y se llena en seed.
- Falta la pantalla de configuración y el enforcement real en rutas y frontend.

### 7.4 Pantalla de pagos a proveedor
- El backend ya soporta registrar pagos a compras pendientes.
- Falta una UI dedicada para hacer abonos y ver historial.

### 7.5 Pantalla de pagos de cliente a crédito
- El backend soporta pagos parciales y asignaciones por producto.
- Falta una interfaz para abonos posteriores a ventas ya creadas.

### 7.6 Reportes de cartera y cuentas por pagar
- Existen servicios para facturas pendientes de proveedor.
- Falta el análogo para clientes y pantallas de ambos reportes.

### 7.7 Módulo de gastos
- Reglas de permisos definidas.
- Faltan servicios, rutas y UI para registrar, ver y categorizar gastos.

### 7.8 Corte de caja UI
- El backend ya tiene corte del día y guardado de caja.
- Falta la pantalla de captura y visualización.

### 7.9 Dashboard administrativo
- Falta una vista de resumen con ventas, utilidad, productos más vendidos y desempeño por vendedor.

### 7.10 Reporte de movimientos de inventario
- El backend ya expone movimientos por rango de fechas.
- Falta la UI para consultarlos.

### 7.11 Login con PIN real
- Hoy se usa un vendedor hardcodeado en el frontend.
- Falta autenticación real y gestión de sesión.

### 7.12 Impresión Bluetooth y ticket digital
- Diseñado conceptualmente, pero no implementado.
- Requiere Web Bluetooth API y Web Share API.

### 7.13 Modo offline real
- El PWA existe, pero no hay cola de ventas pendiente de sincronizar ni lógica offline real.

### 7.14 CRM de clientes
- Falta una pantalla de historial de compras y detalle de cliente.

### 7.15 Catálogo/inventario como módulo administrativo
- Hoy el catálogo se ve integrado en la venta.
- Falta una pantalla independiente para administración del inventario.

## 8. Notas de entorno y lecciones aprendidas

- Si el puerto 3000 está ocupado, se puede liberar con: `lsof -ti:3000 | xargs kill -9`
- Verificar siempre con `cat -n archivo` o `wc -l archivo` tras guardar cambios.
- Evitar caracteres especiales no ASCII al pegar código desde el chat para prevenir errores de parseo.
- Si los postinstall de Prisma o esbuild quedan bloqueados por allow-scripts, usar `npm approve-scripts <pkg>`.

## 9. Resumen ejecutivo para desarrollo asistido

Este proyecto ya tiene una base sólida de negocio y de arquitectura. La lógica de ventas con FIFO, control de stock, autorizaciones, utilidad y pagos parciales está implementada en backend. El frontend ya cubre el flujo principal de venta y compra. El trabajo pendiente está concentrado en permisos, autorizaciones remotas, módulos de administración, reportes y experiencia offline.
