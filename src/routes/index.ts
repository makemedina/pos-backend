import { listarCatalogo, buscarVariantes, crearVarianteRapida, buscarProductos, variantesDeProducto, listarProductosGestion, historialVariante, actualizarProducto, NombreProductoInvalidoError, NombreProductoDuplicadoError } from '../services/catalogo.service';
import { buscarProveedores, crearProveedorRapido, importarProveedores, listarProveedores, actualizarProveedor, eliminarProveedor, ProveedorConInformacionLigadaError } from '../services/proveedores.service';
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
import { crearCompra, registrarPagoCompra, facturasPendientes, pagosCompra, obtenerDetalleCompra, listarHistorialCompras, cancelarCompra, cargarFacturasIniciales, CompraYaCanceladaError, CompraConMercanciaVendidaError, AutorizacionCancelacionInvalidaError as AutorizacionCancelacionCompraInvalidaError, MontoPagoCompraInvalidoError } from '../services/compras.service';
import { crearAjusteInventario, movimientosInventario, detalleMovimientosInventario, lotesDeVariante, AutorizacionInvalidaError, StockInsuficienteParaAjusteError } from '../services/inventario.service';
import { corteDelDia, guardarCorteCaja, listarCortes, actualizarCorteCaja, eliminarCorteCaja, CorteYaExisteError } from '../services/corte.service';
import { fechaLocalDesdeString } from '../utils/fecha';
import {
  buscarClientes,
  crearClienteRapido,
  crearCliente,
  importarClientes,
  cargarSaldosIniciales,
  migrarSaldoInicialANotas,
  listarClientesConSaldo,
  obtenerClienteDetalle,
  actualizarCliente,
  eliminarCliente,
  ClienteConInformacionLigadaError,
  ventasDeCliente,
  movimientosDeCliente,
  ultimosPreciosCliente,
} from '../services/clientes.service';
import {
  actualizarPermisosUsuario,
  cambiarPinUsuario,
  actualizarUsuario,
  crearUsuario,
  listarUsuarios,
  loginUsuario,
  cerrarSesion,
  LoginBloqueadoError,
} from '../services/auth.service';
import {
  resumenCarteraClientes,
  notasClienteCredito,
  registrarPagoVenta,
  registrarPagoMultiNota,
  pagosVenta,
  cancelarPagoVenta,
  MontoPagoInvalidoError,
  PagoYaCanceladoError,
  AutorizacionCancelacionPagoInvalidaError,
} from '../services/cartera.service';
import { crearCategoriaGasto, crearGasto, listarCategoriasGasto, listarGastos, cancelarGasto, GastoYaCanceladoError, AutorizacionCancelacionGastoInvalidaError } from '../services/gastos.service';
import { registrarDeposito, listarDepositos, cancelarDeposito, MontoDepositoInvalidoError, DepositoYaCanceladoError, AutorizacionCancelacionDepositoInvalidaError } from '../services/depositos.service';
import {
  crearCotizacion,
  listarCotizacionesPendientes,
  obtenerCotizacion,
  confirmarCotizacion,
  cancelarCotizacion,
  CotizacionSinItemsError,
  CotizacionYaResueltaError,
} from '../services/cotizaciones.service';
import { obtenerDashboard } from '../services/dashboard.service';
import { listarHistorialVentas, obtenerDetalleVenta } from '../services/historial.service';
import { requireAuth, requiereAdmin, requierePermiso } from '../middleware/auth';
import {
  ejecutarReset,
  cargarInventarioInicial,
  ConfirmacionInvalidaError,
  DependenciaResetInvalidaError,
  type OpcionesReset,
} from '../services/admin.service';
import { obtenerConfiguracion, actualizarConfiguracion, SaldoBancoInsuficienteError } from '../services/configuracion.service';
import { crearBackup, listarBackups, descargarBackup, eliminarBackup, restaurarBackup, BackupNoConfiguradoError } from '../services/backup.service';

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
    const confirmacion = req.body?.confirmacion || '';
    const opciones = (req.body?.opciones || {}) as OpcionesReset;
    if (confirmacion !== 'BORRAR TODO') {
      throw new ConfirmacionInvalidaError();
    }

    // Red de seguridad automatica antes de borrar nada: si los respaldos
    // no estan configurados en este ambiente, se sigue permitiendo el
    // reset (igual que el backup automatico de medianoche lo omite en
    // ese caso), pero se avisa en la respuesta para que el admin lo sepa.
    // Si SI estan configurados pero el respaldo falla por otra razon
    // (pg_dump, R2, etc.), se aborta sin borrar nada -- mejor no arriesgar
    // un borrado sin red de seguridad que fallar aqui.
    let respaldoCreado = false;
    try {
      await crearBackup('pre-reset');
      respaldoCreado = true;
    } catch (err) {
      if (err instanceof BackupNoConfiguradoError) {
        // sin red de seguridad disponible, mismo criterio que el cron
      } else {
        console.error('[reset] Fallo el respaldo previo, se aborta sin borrar nada:', err);
        const detalle = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: `No se pudo crear el respaldo previo, no se borró nada: ${detalle}` });
      }
    }

    await ejecutarReset(confirmacion, opciones);
    res.json({ ok: true, respaldoCreado });
  } catch (err) {
    if (err instanceof ConfirmacionInvalidaError) {
      return res.status(400).json({ error: err.message, code: 'CONFIRMACION_INVALIDA' });
    }
    if (err instanceof DependenciaResetInvalidaError) {
      return res.status(400).json({ error: err.message, code: 'DEPENDENCIA_INVALIDA' });
    }
    console.error('[reset] Fallo el borrado:', err);
    const detalle = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Error al resetear los datos: ${detalle}` });
  }
});

router.post('/admin/cargar-inventario-inicial', requiereAdmin, async (req, res) => {
  try {
    const { filas, fecha } = req.body;
    if (!Array.isArray(filas) || filas.length === 0) {
      return res.status(400).json({ error: 'Manda al menos una fila.' });
    }
    const resultado = await cargarInventarioInicial(filas, fecha ? fechaLocalDesdeString(fecha) : undefined);
    res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar el inventario inicial' });
  }
});

router.post('/admin/cargar-facturas-iniciales', requiereAdmin, async (req, res) => {
  try {
    const { filas, fecha } = req.body;
    if (!Array.isArray(filas) || filas.length === 0) {
      return res.status(400).json({ error: 'Manda al menos una fila.' });
    }
    const resultado = await cargarFacturasIniciales(filas, fecha ? fechaLocalDesdeString(fecha) : undefined);
    res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar las facturas iniciales' });
  }
});

// ---------- RESPALDOS (pg_dump completo, subido a Cloudflare R2) ----------

router.post('/admin/backups', requiereAdmin, async (_req, res) => {
  try {
    const info = await crearBackup('manual');
    res.status(201).json(info);
  } catch (err) {
    if (err instanceof BackupNoConfiguradoError) {
      return res.status(503).json({ error: err.message, code: 'BACKUP_NO_CONFIGURADO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al crear el respaldo' });
  }
});

router.get('/admin/backups', requiereAdmin, async (_req, res) => {
  try {
    const lista = await listarBackups();
    res.json(lista);
  } catch (err) {
    if (err instanceof BackupNoConfiguradoError) {
      return res.status(503).json({ error: err.message, code: 'BACKUP_NO_CONFIGURADO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al listar los respaldos' });
  }
});

router.get('/admin/backups/descargar', requiereAdmin, async (req, res) => {
  try {
    const key = req.query.key as string;
    if (!key) return res.status(400).json({ error: 'Falta el respaldo a descargar.' });
    const stream = await descargarBackup(key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
    stream.pipe(res);
  } catch (err) {
    if (err instanceof BackupNoConfiguradoError) {
      return res.status(503).json({ error: err.message, code: 'BACKUP_NO_CONFIGURADO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al descargar el respaldo' });
  }
});

router.delete('/admin/backups', requiereAdmin, async (req, res) => {
  try {
    const key = req.query.key as string;
    if (!key) return res.status(400).json({ error: 'Falta el respaldo a eliminar.' });
    await eliminarBackup(key);
    res.status(204).send();
  } catch (err) {
    if (err instanceof BackupNoConfiguradoError) {
      return res.status(503).json({ error: err.message, code: 'BACKUP_NO_CONFIGURADO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el respaldo' });
  }
});

// Restaurar reemplaza TODA la base de datos con lo que traiga el
// respaldo elegido -- por eso exige la misma confirmacion explicita por
// escrito que ya se usa para "reiniciar transacciones", y crea un
// respaldo de seguridad "pre-restauracion" automaticamente antes de
// tocar nada (ver backup.service.ts).
router.post('/admin/backups/restaurar', requiereAdmin, async (req, res) => {
  try {
    const { key, confirmacion } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Falta el respaldo a restaurar.' });
    if (confirmacion !== 'RESTAURAR') {
      return res.status(400).json({ error: 'Escribe RESTAURAR para confirmar.', code: 'CONFIRMACION_INVALIDA' });
    }
    await restaurarBackup(key);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof BackupNoConfiguradoError) {
      return res.status(503).json({ error: err.message, code: 'BACKUP_NO_CONFIGURADO' });
    }
    console.error(err);
    res.status(500).json({ error: (err as Error).message || 'Error al restaurar el respaldo' });
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

router.put('/usuarios/:id', async (req, res) => {
  try {
    const esUnoMismo = req.usuario!.id === req.params.id;
    if (!esUnoMismo && req.usuario!.rolBase !== 'administrador') {
      return res.status(403).json({ error: 'Solo puedes editar tus propios datos' });
    }
    const { nombre, telefono } = req.body;
    const usuario = await actualizarUsuario(req.params.id, { nombre, telefono });
    res.json(usuario);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el usuario' });
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
    if (err instanceof SaldoBancoInsuficienteError) {
      return res.status(400).json({ error: err.message, code: 'SALDO_BANCO_INSUFICIENTE' });
    }
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

// ---------- DEPOSITOS A BANCO (traspaso interno de efectivo a banco) ----------

router.get('/depositos', async (req, res) => {
  try {
    const depositos = await listarDepositos(req.usuario!);
    res.json(depositos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar depositos' });
  }
});

router.post('/depositos', async (req, res) => {
  try {
    const deposito = await registrarDeposito(Number(req.body.monto), req.body.notas, req.usuario!.id);
    res.status(201).json(deposito);
  } catch (err) {
    if (err instanceof MontoDepositoInvalidoError) {
      return res.status(400).json({ error: err.message, code: 'MONTO_INVALIDO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el deposito' });
  }
});

router.post('/depositos/:id/cancelar', async (req, res) => {
  try {
    const { telefono, pin } = req.body || {};
    const deposito = await cancelarDeposito(
      req.params.id,
      req.usuario!.id,
      telefono && pin ? { telefono, pin } : undefined
    );
    res.json(deposito);
  } catch (err) {
    if (err instanceof DepositoYaCanceladoError) {
      return res.status(409).json({ error: err.message, code: 'DEPOSITO_YA_CANCELADO' });
    }
    if (err instanceof AutorizacionCancelacionDepositoInvalidaError) {
      return res.status(403).json({ error: err.message, code: 'REQUIERE_AUTORIZACION' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar el deposito' });
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

router.put('/catalogo/productos/:id', requierePermiso('puedeRegistrarCompras'), async (req, res) => {
  try {
    const producto = await actualizarProducto(req.params.id, req.body.nombre);
    res.json(producto);
  } catch (err) {
    if (err instanceof NombreProductoInvalidoError) {
      return res.status(400).json({ error: err.message, code: 'NOMBRE_INVALIDO' });
    }
    if (err instanceof NombreProductoDuplicadoError) {
      return res.status(409).json({ error: err.message, code: 'NOMBRE_DUPLICADO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el producto' });
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

router.get('/proveedores/todos', async (req, res) => {
  try {
    const proveedores = await listarProveedores();
    res.json(proveedores);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar los proveedores' });
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

router.put('/proveedores/:id', requierePermiso('puedeRegistrarCompras'), async (req, res) => {
  try {
    const { nombre, telefono } = req.body;
    const proveedor = await actualizarProveedor(req.params.id, { nombre, telefono });
    res.json(proveedor);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el proveedor' });
  }
});

router.delete('/proveedores/:id', requiereAdmin, async (req, res) => {
  try {
    await eliminarProveedor(req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err instanceof ProveedorConInformacionLigadaError) {
      return res.status(409).json({ error: err.message, code: 'TIENE_INFORMACION_LIGADA' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el proveedor' });
  }
});

router.post('/proveedores/importar', async (req, res) => {
  try {
    const { nombres } = req.body;
    if (!Array.isArray(nombres) || nombres.length === 0) {
      return res.status(400).json({ error: 'Manda al menos un nombre para importar.' });
    }
    const resultado = await importarProveedores(nombres);
    res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al importar los proveedores' });
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

// ---------- COTIZACIONES ----------

router.post('/cotizaciones', async (req, res) => {
  try {
    const cotizacion = await crearCotizacion({ ...req.body, vendedorId: req.usuario!.id });
    res.status(201).json(cotizacion);
  } catch (err) {
    if (err instanceof CotizacionSinItemsError) {
      return res.status(400).json({ error: err.message, code: 'SIN_ITEMS' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la cotizacion' });
  }
});

router.get('/cotizaciones', async (_req, res) => {
  try {
    const cotizaciones = await listarCotizacionesPendientes();
    res.json(cotizaciones);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar cotizaciones' });
  }
});

router.get('/cotizaciones/:id', async (req, res) => {
  try {
    const cotizacion = await obtenerCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'Cotizacion no encontrada' });
  }
});

router.post('/cotizaciones/:id/confirmar', async (req, res) => {
  try {
    const resultado = await confirmarCotizacion(req.params.id, { ...req.body, vendedorId: req.usuario!.id });
    res.status(201).json(resultado);
  } catch (err) {
    if (err instanceof CotizacionYaResueltaError) {
      return res.status(409).json({ error: err.message, code: 'COTIZACION_YA_RESUELTA' });
    }
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
    res.status(500).json({ error: 'Error al confirmar la cotizacion' });
  }
});

router.post('/cotizaciones/:id/cancelar', async (req, res) => {
  try {
    const cotizacion = await cancelarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (err) {
    if (err instanceof CotizacionYaResueltaError) {
      return res.status(409).json({ error: err.message, code: 'COTIZACION_YA_RESUELTA' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar la cotizacion' });
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
    if (err instanceof SaldoBancoInsuficienteError) {
      return res.status(400).json({ error: err.message, code: 'SALDO_BANCO_INSUFICIENTE' });
    }
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
    if (err instanceof SaldoBancoInsuficienteError) {
      return res.status(400).json({ error: err.message, code: 'SALDO_BANCO_INSUFICIENTE' });
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
    const fecha = req.query.fecha ? fechaLocalDesdeString(req.query.fecha as string) : new Date();
    const corte = await corteDelDia(fecha);
    res.json(ocultarUtilidadSiNoTienePermiso(req, corte));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al armar el corte del dia' });
  }
});

router.post('/corte/caja', async (req, res) => {
  try {
    const { efectivoContado, saldoBancoContado, fecha } = req.body;

    // Elegir una fecha distinta a "hoy" es para casos especiales (como
    // capturar el punto de partida de ayer al arrancar el sistema) --
    // solo el administrador puede hacerlo.
    if (fecha && req.usuario!.rolBase !== 'administrador') {
      return res.status(403).json({ error: 'Solo un administrador puede capturar un corte con otra fecha.' });
    }

    // registradoPorId ya no viene del body: siempre es quien esta logueado.
    const corte = await guardarCorteCaja(
      req.usuario!.id,
      Number(efectivoContado),
      Number(saldoBancoContado),
      fecha ? fechaLocalDesdeString(fecha) : undefined
    );
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

router.delete('/corte/caja/:id', requiereAdmin, async (req, res) => {
  try {
    await eliminarCorteCaja(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el corte de caja' });
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
    const { filas, fecha } = req.body;
    if (!Array.isArray(filas) || filas.length === 0) {
      return res.status(400).json({ error: 'Manda al menos una fila.' });
    }
    const resultado = await cargarSaldosIniciales(filas, req.usuario!.id, fecha ? fechaLocalDesdeString(fecha) : undefined);
    res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar los saldos iniciales' });
  }
});

router.post('/clientes/migrar-saldo-inicial', requiereAdmin, async (req, res) => {
  try {
    const { fecha } = req.body;
    const resultado = await migrarSaldoInicialANotas(req.usuario!.id, fecha ? fechaLocalDesdeString(fecha) : undefined);
    res.status(201).json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al migrar los saldos iniciales' });
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

router.delete('/clientes/:id', requiereAdmin, async (req, res) => {
  try {
    await eliminarCliente(req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err instanceof ClienteConInformacionLigadaError) {
      return res.status(409).json({ error: err.message, code: 'TIENE_INFORMACION_LIGADA' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el cliente' });
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

router.get('/clientes/:id/ultimos-precios', async (req, res) => {
  try {
    const precios = await ultimosPreciosCliente(req.params.id);
    res.json(precios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los ultimos precios del cliente' });
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

router.post('/cartera/clientes/:clienteId/pagos', requierePermiso('puedeRegistrarPagos'), async (req, res) => {
  try {
    const { asignaciones, metodoPago } = req.body;
    if (!Array.isArray(asignaciones) || asignaciones.length === 0) {
      return res.status(400).json({ error: 'Debes enviar al menos una asignacion de pago', code: 'MONTO_INVALIDO' });
    }
    const asignacionesNormalizadas = asignaciones.map((a: any) => ({
      ventaId: String(a.ventaId),
      monto: Number(a.monto),
    }));
    const resultado = await registrarPagoMultiNota(
      req.params.clienteId,
      asignacionesNormalizadas,
      metodoPago,
      req.usuario!.id
    );
    res.status(201).json(resultado);
  } catch (err) {
    if (err instanceof MontoPagoInvalidoError) {
      return res.status(400).json({ error: err.message, code: 'MONTO_INVALIDO' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el pago repartido entre notas' });
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

router.post('/ventas/:ventaId/pagos/:pagoId/cancelar', requierePermiso('puedeRegistrarPagos'), async (req, res) => {
  try {
    const { telefono, pin } = req.body || {};
    const pago = await cancelarPagoVenta(
      req.params.pagoId,
      req.usuario!.id,
      telefono && pin ? { telefono, pin } : undefined
    );
    res.json(pago);
  } catch (err) {
    if (err instanceof PagoYaCanceladoError) {
      return res.status(409).json({ error: err.message, code: 'PAGO_YA_CANCELADO' });
    }
    if (err instanceof AutorizacionCancelacionPagoInvalidaError) {
      return res.status(403).json({ error: err.message, code: 'REQUIERE_AUTORIZACION' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar el pago' });
  }
});
