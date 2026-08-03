# Backend — Sistema de ventas/inventario/proveedores

## Que trae este proyecto

Ya esta implementada la logica de negocio central que definimos:

- **Compras** (`src/services/compras.service.ts`): registra la compra, crea un
  lote de inventario independiente por producto, y maneja la cuenta por pagar
  (con pago inicial opcional).
- **Ventas** (`src/services/ventas.service.ts`): descuenta inventario usando
  **FIFO** (primero el lote mas viejo), bloquea la venta si no hay stock
  suficiente, exige autorizacion si el precio queda bajo el costo del lote, y
  calcula la **utilidad devengada vs. cobrada** con precision por producto
  (reparto proporcional de pagos parciales).
- **Inventario** (`src/services/inventario.service.ts`): ajustes manuales
  (merma) que afectan directamente la utilidad, y el reporte de
  entradas/salidas por rango de fechas.
- **Corte diario** (`src/services/corte.service.ts`): junta inventario,
  ventas, compras, cartera, cuentas por pagar y gastos del dia.

El esquema completo de base de datos esta en `prisma/schema.prisma`.

## Paso 1: instalar dependencias

Abre Terminal, entra a la carpeta del proyecto y corre:

```bash
cd pos-backend
npm install
```

## Paso 2: crear la base de datos

Con PostgreSQL ya instalado y corriendo (ver instrucciones que te di para Mac),
crea la base de datos:

```bash
createdb pos_carnes
```

## Paso 3: configurar variables de entorno

Copia el archivo de ejemplo y ajusta el usuario/password de tu Postgres local:

```bash
cp .env.example .env
```

Abre `.env` en VS Code y ajusta `DATABASE_URL` si tu usuario de Postgres no es
el default. Si no le pusiste password a Postgres localmente, puede quedar asi:

```
DATABASE_URL="postgresql://TU_USUARIO@localhost:5432/pos_carnes?schema=public"
```

(Tu usuario de Mac normalmente ya es tambien tu usuario de Postgres local; para
ver cual es, corre `whoami` en Terminal.)

## Paso 4: crear las tablas en la base de datos

Esto lee `prisma/schema.prisma` y crea todas las tablas automaticamente:

```bash
npm run prisma:migrate
```

Te va a pedir un nombre para esta migracion, puedes poner algo como `inicial`.

## Paso 5: correr el servidor

```bash
npm run dev
```

Deberias ver: `Servidor corriendo en http://localhost:3000`

Prueba que funciona abriendo esa direccion en tu navegador — deberias ver un
JSON con `{"status":"ok", ...}`.

## Explorar la base de datos visualmente (opcional pero util)

Prisma trae una herramienta visual para ver y editar los datos sin escribir
SQL:

```bash
npm run prisma:studio
```

Esto abre una pagina en tu navegador donde ves todas las tablas.

## Endpoints disponibles por ahora

| Metodo | Ruta | Que hace |
|---|---|---|
| POST | `/api/ventas` | Registra una venta (aplica FIFO y valida costo) |
| GET | `/api/ventas/:id/utilidad` | Calcula utilidad devengada y cobrada |
| POST | `/api/compras` | Registra una compra (crea lotes) |
| POST | `/api/compras/:id/pagos` | Registra un pago a una compra |
| GET | `/api/compras/pendientes` | Facturas pendientes de pago |
| POST | `/api/inventario/ajustes` | Registra una merma/ajuste |
| GET | `/api/inventario/movimientos?desde=...&hasta=...` | Entradas/salidas por rango |
| GET | `/api/corte?fecha=...` | Corte del dia |
| POST | `/api/corte/caja` | Guarda el conteo de efectivo/banco |

## Siguiente paso

Todavia faltan por implementar: catalogo de productos/variantes (CRUD basico),
clientes, gastos, usuarios/permisos, y la autenticacion con PIN. La estructura
de base de datos para todo esto ya existe en el schema — lo que falta es la
capa de rutas/servicios, que seguimos construyendo juntos.
