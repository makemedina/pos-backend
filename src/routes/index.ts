import { listarCatalogo, buscarVariantes, crearVarianteRapida, buscarProductos, variantesDeProducto, listarProductosGestion, historialVariante } from '../services/catalogo.service';
import { buscarProveedores, crearProveedorRapido } from '../services/proveedores.service';
import { Router } from 'express';
import {
  crearVenta,
  calcularUtilidadVenta,
  StockInsuficienteError,
  PrecioBajoCostoSinAutorizarError,
  ClienteSinCreditoError,
  cancelarVenta,
  VentaYaCanceladaError,
  AutorizacionCancelacionInvalidaError,
} from '../services/ventas.service';
import { crearCompra, registrarPagoCompra, facturasPendientes, pagosCompra, obtenerDetalleCompra, listarHistorialCompras, cancelarCompra, CompraYaCanceladaError, CompraConMercanciaVendidaError, AutorizacionCancelacionInvalidaError as AutorizacionCancelacionCompraInvalidaError, MontoPagoCompraInvalidoError } from '../services/compras.service';
import { crearAjusteInventario, movimientosInventario, detalleMovimientosInventario, lotesDeVariante, AutorizacionInvalidaError, StockInsuficienteParaAjusteError } from '../services/inventario.service';
import { corteDelDia, guardarCorteCaja, listarCortes, actualizarCorteCaja, CorteYaExisteError } from '../services/corte.service';
import {
  buscarClientes,
  crearClienteRapido,
  crearCliente,
  importarClientes,
  cargarSaldosIniciales,
  listarClientesConSaldo,
  obtenerClienteDetalle,
  actualizarCliente,
  ventasDeCliente,
  movimientosDeCliente,
} from '../services/clientes.service';
import {
  actualizarPermisosUsuario,
  cambiarPinUsuario,
  crearUsuario,
  listarUsuarios,
  loginUsuario,
  cerrarSesion,
  LoginBloqueadoError,
} from '../services/auth.service';
import { resumenCarteraClientes, notasClienteCredito, registrarPagoVenta, pagosVenta, MontoPagoInvalidoError } from '../services/cartera.service';
import { crearCategoriaGasto, crearGasto, listarCategoriasGasto, listarGastos, cancelarGasto, GastoYaCanceladoError, AutorizacionCancelacionGastoInvalidaError } from '../services/gastos.service';
import { obtenerDashboard } from '../services/dashboard.service';
import { listarHistorialVentas, obtenerDetalleVenta } from '../services/historial.service';
import { requireAuth, requiereAdmin, requierePermiso } from '../middleware/auth';
import { resetearTransacciones, cargarInventarioInicial, ConfirmacionInvalidaError } from '../services/admin.service';
import { obtenerConfiguracion, actualizarConfiguracion } from '../services/configuracion.service';

export const router = Router();

// ---------- AUTENTICACION (unica ruta publica) ----------

router.post('/auth/login', async (req, res) => {
  try {
    const { telefono, pin } = req.body;
    const resultado = await loginUsuario(telefono, pin);
    res.json(resultado);
  } catch (err) {
    if (err instanceof LoginBloqueadoError) {
      return res.status(429).json({ error: err.message, code: 'LOGIN_BLOQUEADO' });
    }
    console.error(err);
    res.status(401).json({ error: 'Credenciales invalidas' });
  }
});

// A partir de aqui, TODAS las rutas exigen un token de sesion valido.
// Antes no habia ningun middleware: cualquiera podia llamar cualquier
// endpoint (incluido cambiar permisos o el PIN de otro usuario) sin
// autenticarse.
router.use(requireAuth);

// ---------- CONFIGURACION (negocio, recibo, impresora) ----------

router.get('/configuracion', async (_req, res) => {
  try {
    const config = await obtenerConfiguracion();
    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la configuracion' });
  }
});

router.put('/configuracion', requiereAdmin, async (req, res) => {
  try {
    const config = await actualizarConfiguracion(req.body);
    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la configuracion' });
  }
});

// ---------- HERRAMIENTAS DE ADMINISTRACION (uso puntual, no operacion diaria) ----------

router.post('/admin/resetear-transacciones', requiereAdmin, async (req, res) => {
  try {
    await resetearTransacciones(req.body?.confirmacion || '');
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ConfirmacionInvalidaError) {
      return res.status(400).json({ error: err.message, code: 'CONFIRMACION_INVALIDA' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al resetear las transacciones' });
  }
});

router.post('/admin/cargar-inventario-inicial', requiereAdmin, async (req, res) => {
  try {
    const { filas } = req.body;
    if (!Array.isArray(filas) || filas.length === 0) {
      return res.status(400).json({ error: 'Manda al menos una fila.' });
    }
    const resultado = await cargarInventarioInicial(filas);
    res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar el inventario inicial' });
  }
});

router.post('/auth/logout', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) await cerrarSesion(token);
  res.status(204).send();
});

// ---------- USUARIOS (solo administrador) ----------

router.get('/usuarios', requiereAdmin, async (_req, res) => {
  try {
    const usuarios = await listarUsuarios();
    res.json(usuarios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar usuarios' });
  }
});

router.post('/usuarios', requiereAdmin, async (req, res) => {
  try {
    const usuario = await crearUsuario(req.body);
    res.status(201).json(usuario);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear el usuario' });
  }
});

// Un usuario puede cambiar su propio PIN; para cambiar el de otro
// se necesita ser administrador.
router.put('/usuarios/:id/pin', async (req, res) => {
  try {
    const esUnoMismo = req.usuario!.id === req.params.id;
    if (!esUnoMismo && req.usuario!.rolBase !== 'administrador') {
      return res.status(403).json({ error: 'Solo puedes cambiar tu propio PIN' });
    }
    const usuario = await cambiarPinUsuario(req.params.id, req.body.pin);
    res.json(usuario);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar el PIN' });
  }
});

router.put('/usuarios/:id/permisos', requiereAdmin, async (req, res) => {
  try {
    const permisos = await actualizarPermisosUsuario(req.params.id, req.body);
    res.json(permisos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar permisos' });
  }
});

// ---------- GASTOS ----------

router.get('/gastos/categorias', async (_req, res) => {
  try {
    const categorias = await listarCategoriasGasto();
    res.json(categorias);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar categorias de gasto' });
  }
});

router.post('/gastos/categorias', async (req, res) => {
  try {
    const categoria = await crearCategoriaGasto(req.body.nombre, req.body.departamento);
    res.status(201).json(categoria);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la categoria' });
  }
});

router.get('/gastos', async (req, res) => {
  try {
    const gastos = await listarGastos(req.usuario!);
    res.json(gastos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar gastos' });
  }
});

router.post('/gastos', async (req, res) => {
  try {
    // registradoPorId ya no viene del body: siempre es quien esta logueado.
    const gasto = await crearGasto({ ...req.body, registradoPorId: req.usuario!.id });
    res.status(201).json(gasto);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el gasto' });
  }
});

router.post('/gastos/:id/cancelar', async (req, res) => {
  try {
    const { telefono, pin } = req.body || {};
    const gasto = await cancelarGasto(
      req.params.id,
      req.usuario!.id,
      telefono && pin ? { telefono, pin } : undefined
    );
    res.json(gasto);
  } catch (err) {
    if (err instanceof GastoYaCanceladoError) {
      return res.status(409).json({ error: err.message, code: 'GASTO_YA_CANCELADO' });
    }
    if (err instanceof AutorizacionCancelacionGastoInvalidaError) {
      return res.status(403).json({ error: err.message, code: 'REQUIERE_AUTORIZACION' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar el gasto' });
  }
});

// ---------- DASHBOARD ----------

router.get('/dashboard', requierePermiso('puedeVerUtilidad'), async (req, res) => {
  try {
    const dashboard = await obtenerDashboard({
      periodo: req.query.periodo as string | undefined,
      desde: req.query.desde as string | undefined,
      hasta: req.query.hasta as string | undefined,
    });
    res.json(dashboard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar el dashboard' });
  }
});

// ---------- CATALOGO ----------

router.get('/catalogo', async (_req, res) => {
  try {
    const catalogo = await listarCatalogo();
    res.json(catalogo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar el catalogo' });
  }
});

router.get('/catalogo/buscar', async (req, res) => {
  try {
    const query = (req.query.q as string) || '';
    const variantes = await buscarVariantes(query);
    res.json(variantes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar productos' });
  }
});

router.post('/catalogo/variantes', requierePermiso('puedeRegistrarCompras'), async (req, res) => {
  try {
    const { nombreProducto, marca, precioVenta } = req.body;
    const variante = await crearVarianteRapida(nombreProducto, marca, precioVenta);
    res.status(201).json(variante);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la variante' });
  }
});

router.get('/catalogo/productos', async (req, res) => {
  try {
    const query = (req.query.q as string) || '';
    const productos = await buscarProductos(query);
    res.json(productos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar productos' });
  }
});

router.get('/catalogo/productos/:id/variantes', async (req, res) => {
  try {
    const variantes = await variantesDeProducto(req.params.id);
    res.json(variantes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar variantes del producto' });
  }
});

router.get('/catalogo/gestion', requierePermiso('puedeVerCostos'), async (_req, res) => {
  try {
    const productos = await listarProductosGestion();
    res.json(productos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar productos' });
  }
});

router.get('/catalogo/variantes/:id/historial', requierePermiso('puedeVerCostos'), async (req, res) => {
  try {
    const historial = await historialVariante(req.params.id);
    res.json(historial);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el historial del producto' });
  }
});

// ---------- PROVEEDORES ----------

router.get('/proveedores', async (req, res) => {
  try {
    const query = (req.query.q as string) || '';
    const proveedores = await buscarProveedores(query);
    res.json(proveedores);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar proveedores' });
  }
});

router.post('/proveedores', requierePermiso('puedeRegistrarCompras'), async (req, res) => {
  try {
    const { nombre, telefono } = req.body;
    const proveedor = await crearProveedorRapido(nombre, telefono);
    res.status(201).json(proveedor);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear el proveedor' });
  }
});

// ---------- VENTAS ----------

router.post('/ventas', async (req, res) => {
  try {
    // vendedorId ya no viene del body: siempre es quien esta logueado.
    const resultado = await crearVenta({ ...req.body, vendedorId: req.usuario!.id });
    res.status(201).json(resultado);
  } catch (err) {
    if (err instanceof StockInsuficienteError) {
      return res.status(409).json({ error: err.message, code: 'STOCK_INSUFICIENTE' });
    }
    if (err instanceof PrecioBajoCostoSinAutorizarError) {
      return res.status(403).json({ error: err.message, code: 'REQUIERE_AUTORIZACION' });
    }
    if (err instanceof ClienteSinCreditoError) {
      return res.status(403).json({ error: err.message, code: 'CLIENTE_SIN_CREDITO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la venta' });
  }
});

router.get('/ventas/:id/utilidad', requierePermiso('puedeVerUtilidad'), async (req, res) => {
  try {
    const utilidad = await calcularUtilidadVenta(req.params.id);
    res.json(utilidad);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al calcular utilidad' });
  }
});

router.get('/ventas/:id', async (req, res) => {
  try {
    const venta = await obtenerDetalleVenta(req.params.id);
    res.json(venta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el detalle de la venta' });
  }
});

// Cancelar una venta regresa el stock y anula el saldo -- es una accion
// sensible (afecta inventario y cartera), solo el administrador puede hacerla.
router.post('/ventas/:id/cancelar', async (req, res) => {
  try {
    const { telefono, pin } = req.body || {};
    const venta = await cancelarVenta(
      req.params.id,
      req.usuario!.id,
      telefono && pin ? { telefono, pin } : undefined
    );
    res.json(venta);
  } catch (err) {
    if (err instanceof VentaYaCanceladaError) {
      return res.status(409).json({ error: err.message, code: 'VENTA_YA_CANCELADA' });
    }
    if (err instanceof AutorizacionCancelacionInvalidaError) {
      return res.status(403).json({ error: err.message, code: 'REQUIERE_AUTORIZACION' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar la venta' });
  }
});

// ---------- COMPRAS ----------

router.post('/compras', requierePermiso('puedeRegistrarCompras'), async (req, res) => {
  try {
    const compra = await crearCompra({
      ...req.body,
      fechaVencimiento: req.body.fechaVencimiento ? new Date(req.body.fechaVencimiento) : undefined,
      registradoPorId: req.usuario!.id,
    });
    res.status(201).json(compra);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la compra' });
  }
});

router.post('/compras/:id/pagos', requierePermiso('puedeRegistrarCompras'), async (req, res) => {
  try {
    const { monto, metodoPago } = req.body;
    const compra = await registrarPagoCompra(req.params.id, Number(monto), metodoPago, req.usuario!.id);
    res.status(201).json(compra);
  } catch (err) {
    if (err instanceof MontoPagoCompraInvalidoError) {
      return res.status(400).json({ error: err.message, code: 'MONTO_INVALIDO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el pago' });
  }
});

router.get('/compras/pendientes', requierePermiso('puedeVerCarteraGeneral'), async (_req, res) => {
  try {
    const pendientes = await facturasPendientes();
    res.json(pendientes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar facturas pendientes' });
  }
});

router.get('/compras/historial', requierePermiso('puedeVerCostos'), async (req, res) => {
  try {
    const compras = await listarHistorialCompras({
      periodo: req.query.periodo as string | undefined,
      desde: req.query.desde as string | undefined,
      hasta: req.query.hasta as string | undefined,
      proveedorId: req.query.proveedorId as string | undefined,
      estadoPago: req.query.estadoPago as string | undefined,
    });
    res.json(compras);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar el historial de compras' });
  }
});

router.get('/compras/:id', requierePermiso('puedeVerCostos'), async (req, res) => {
  try {
    const compra = await obtenerDetalleCompra(req.params.id);
    res.json(compra);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el detalle de la compra' });
  }
});

router.post('/compras/:id/cancelar', async (req, res) => {
  try {
    const { telefono, pin } = req.body || {};
    const compra = await cancelarCompra(
      req.params.id,
      req.usuario!.id,
      telefono && pin ? { telefono, pin } : undefined
    );
    res.json(compra);
  } catch (err) {
    if (err instanceof CompraYaCanceladaError) {
      return res.status(409).json({ error: err.message, code: 'COMPRA_YA_CANCELADA' });
    }
    if (err instanceof CompraConMercanciaVendidaError) {
      return res.status(409).json({ error: err.message, code: 'MERCANCIA_YA_VENDIDA' });
    }
    if (err instanceof AutorizacionCancelacionCompraInvalidaError) {
      return res.status(403).json({ error: err.message, code: 'REQUIERE_AUTORIZACION' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar la compra' });
  }
});

router.get('/compras/:id/pagos', requierePermiso('puedeVerCarteraGeneral'), async (req, res) => {
  try {
    const pagos = await pagosCompra(req.params.id);
    res.json(pagos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los pagos de la compra' });
  }
});

// ---------- INVENTARIO ----------

router.get('/inventario/lotes/:varianteId', async (req, res) => {
  try {
    const lotes = await lotesDeVariante(req.params.varianteId);
    res.json(lotes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los lotes' });
  }
});

router.post('/inventario/ajustes', async (req, res) => {
  try {
    // solicitadoPorId ya no viene del body: siempre es quien esta logueado.
    const ajuste = await crearAjusteInventario({ ...req.body, solicitadoPorId: req.usuario!.id });
    res.status(201).json(ajuste);
  } catch (err) {
    if (err instanceof AutorizacionInvalidaError) {
      return res.status(403).json({ error: err.message, code: 'REQUIERE_AUTORIZACION' });
    }
    if (err instanceof StockInsuficienteParaAjusteError) {
      return res.status(409).json({ error: err.message, code: 'STOCK_INSUFICIENTE' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el ajuste' });
  }
});

router.get('/inventario/movimientos', requierePermiso('puedeVerCostos'), async (req, res) => {
  try {
    const reporte = await detalleMovimientosInventario({
      periodo: req.query.periodo as string | undefined,
      desde: req.query.desde as string | undefined,
      hasta: req.query.hasta as string | undefined,
      productoId: req.query.productoId as string | undefined,
    });
    res.json(reporte);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar movimientos' });
  }
});

// ---------- CORTE DIARIO ----------

function ocultarUtilidadSiNoTienePermiso<T extends Record<string, any>>(req: any, dato: T): T {
  const puedeVer = req.usuario!.rolBase === 'administrador' || req.usuario!.permisos?.puedeVerUtilidad;
  if (puedeVer) return dato;
  const { utilidadDia, gastosDia, valorInventario, balanzaTotal, balanzaAyer, balanzaEsperada, diferenciaCuadre, ...resto } = dato;
  return resto as T;
}

router.get('/corte', async (req, res) => {
  try {
    const fecha = req.query.fecha ? new Date(req.query.fecha as string) : new Date();
    const corte = await corteDelDia(fecha);
    res.json(ocultarUtilidadSiNoTienePermiso(req, corte));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al armar el corte del dia' });
  }
});

router.post('/corte/caja', async (req, res) => {
  try {
    const { efectivoContado, saldoBancoContado } = req.body;
    // registradoPorId ya no viene del body: siempre es quien esta logueado.
    const corte = await guardarCorteCaja(req.usuario!.id, Number(efectivoContado), Number(saldoBancoContado));
    res.status(201).json(corte);
  } catch (err) {
    if (err instanceof CorteYaExisteError) {
      return res.status(409).json({ error: err.message, code: 'CORTE_YA_EXISTE' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el corte de caja' });
  }
});

router.get('/corte/historial', async (req, res) => {
  try {
    const cortes = await listarCortes();
    const resultado = cortes.map((c) => ocultarUtilidadSiNoTienePermiso(req, c));
    res.json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar el historico de cortes' });
  }
});

// Editar un corte pasado (corregir el conteo) es sensible -- solo administrador.
router.put('/corte/caja/:id', requiereAdmin, async (req, res) => {
  try {
    const { efectivoContado, saldoBancoContado } = req.body;
    const corte = await actualizarCorteCaja(req.params.id, Number(efectivoContado), Number(saldoBancoContado));
    res.json(corte);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el corte de caja' });
  }
});

// ---------- CLIENTES ----------

router.get('/clientes', async (req, res) => {
  try {
    const query = (req.query.q as string) || '';
    const clientes = await buscarClientes(query);
    res.json(clientes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar clientes' });
  }
});

// IMPORTANTE: esta ruta debe ir ANTES que '/clientes/:id', si no Express
// interpretaria "todos" como si fuera un id.
router.get('/clientes/todos', async (req, res) => {
  try {
    const filtro = (req.query.filtro as 'todos' | 'conDeuda' | 'sinDeuda') || 'todos';
    const clientes = await listarClientesConSaldo(filtro);
    res.json(clientes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar clientes' });
  }
});

router.post('/clientes', async (req, res) => {
  try {
    const { nombre, telefono, direccion } = req.body;
    const cliente = direccion
      ? await crearCliente({ nombre, telefono, direccion })
      : await crearClienteRapido(nombre, telefono);
    res.status(201).json(cliente);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear el cliente' });
  }
});

router.post('/clientes/importar', async (req, res) => {
  try {
    const { nombres } = req.body;
    if (!Array.isArray(nombres) || nombres.length === 0) {
      return res.status(400).json({ error: 'Manda al menos un nombre para importar.' });
    }
    const resultado = await importarClientes(nombres);
    res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al importar los clientes' });
  }
});

router.post('/clientes/saldos-iniciales', requiereAdmin, async (req, res) => {
  try {
    const { filas } = req.body;
    if (!Array.isArray(filas) || filas.length === 0) {
      return res.status(400).json({ error: 'Manda al menos una fila.' });
    }
    const resultado = await cargarSaldosIniciales(filas);
    res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar los saldos iniciales' });
  }
});

router.get('/clientes/:id', async (req, res) => {
  try {
    const cliente = await obtenerClienteDetalle(req.params.id);
    res.json(cliente);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el cliente' });
  }
});

router.put('/clientes/:id', async (req, res) => {
  try {
    const { nombre, telefono, direccion, permiteVentaCredito } = req.body;
    const datos: any = { nombre, telefono, direccion };
    // El switch de credito solo lo puede cambiar un administrador, sin
    // importar lo que venga en el body si quien llama no lo es.
    if (permiteVentaCredito !== undefined && req.usuario!.rolBase === 'administrador') {
      datos.permiteVentaCredito = permiteVentaCredito;
    }
    const cliente = await actualizarCliente(req.params.id, datos);
    res.json(cliente);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el cliente' });
  }
});

router.get('/clientes/:id/ventas', async (req, res) => {
  try {
    const ventas = await ventasDeCliente(req.params.id);
    res.json(ventas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las ventas del cliente' });
  }
});

router.get('/clientes/:id/movimientos', async (req, res) => {
  try {
    const movimientos = await movimientosDeCliente(req.params.id);
    res.json(movimientos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los movimientos del cliente' });
  }
});

router.get('/historial/ventas', async (req, res) => {
  try {
    const ventas = await listarHistorialVentas(
      {
        periodo: req.query.periodo as string | undefined,
        desde: req.query.desde as string | undefined,
        hasta: req.query.hasta as string | undefined,
        clienteId: req.query.clienteId as string | undefined,
        metodoPago: req.query.metodoPago as string | undefined,
        incluirCanceladas: req.query.incluirCanceladas === 'true',
      },
      req.usuario!
    );
    res.json(ventas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar el historial de ventas' });
  }
});

// ---------- CARTERA ----------

router.get('/cartera/clientes', requierePermiso('puedeVerCarteraGeneral'), async (_req, res) => {
  try {
    const resumen = await resumenCarteraClientes();
    res.json(resumen);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar cartera de clientes' });
  }
});

router.get('/cartera/clientes/:clienteId/notas', requierePermiso('puedeVerCarteraGeneral'), async (req, res) => {
  try {
    const incluirPagadas = req.query.incluirPagadas === 'true';
    const notas = await notasClienteCredito(req.params.clienteId, incluirPagadas);
    res.json(notas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar las notas del cliente' });
  }
});

router.get('/ventas/:id/pagos', requierePermiso('puedeVerCarteraGeneral'), async (req, res) => {
  try {
    const pagos = await pagosVenta(req.params.id);
    res.json(pagos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los pagos de la venta' });
  }
});

router.post('/ventas/:id/pagos', requierePermiso('puedeRegistrarPagos'), async (req, res) => {
  try {
    const { monto, metodoPago } = req.body;
    const pago = await registrarPagoVenta(req.params.id, Number(monto), metodoPago, req.usuario!.id);
    res.status(201).json(pago);
  } catch (err) {
    if (err instanceof MontoPagoInvalidoError) {
      return res.status(400).json({ error: err.message, code: 'MONTO_INVALIDO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el pago de la venta' });
  }
});
