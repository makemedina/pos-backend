import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { router } from './routes';
import { whatsappWebhook } from './routes/whatsappWebhook';
import { iniciarTareasProgramadas } from './cron';

dotenv.config();

const app = express();

// Railway pone un proxy delante: sin esto req.ip seria la IP del proxy y el
// limite de intentos por IP y la bitacora no servirian. Solo se confia en
// un salto (el de Railway), no en lo que mande el cliente.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Cabeceras de seguridad (SOC 2 CC6.6 / ISO 27001 A.8.9, A.8.26). La API
// solo devuelve JSON y archivos, asi que la CSP puede ser la mas cerrada.
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// ALLOWED_ORIGINS (opcional, separado por comas) permite agregar el
// dominio de una sucursal nueva sin tener que tocar este archivo -- cada
// sucursal corre su propio backend con su propia base de datos, y cada
// uno se configura con sus propios origenes permitidos en Railway.
const origenesPermitidos = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['https://pos-frontend-258.pages.dev', 'https://ventas.mrcarnes.com', 'http://localhost:5173'];

app.use(cors({ origin: origenesPermitidos }));

// Antes de express.json: necesita el cuerpo crudo para validar la firma de Meta.
app.use('/webhooks/whatsapp', whatsappWebhook);

app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', mensaje: 'API del sistema de ventas corriendo' });
});

// Respuestas con datos del negocio: que ni el navegador ni un proxy las guarden.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api', router);

app.use((_req, res) => {
  res.status(404).json({ error: 'No encontrado' });
});

// Ultimo recurso: nada de stack traces ni mensajes internos hacia afuera.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'La peticion es demasiado grande.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalido.' });
  if (err?.name === 'MulterError') return res.status(400).json({ error: 'Archivo invalido o demasiado grande.' });
  console.error('[error no controlado]', err);
  res.status(500).json({ error: 'Error interno' });
});

process.on('unhandledRejection', (razon) => {
  console.error('[unhandledRejection]', razon);
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  iniciarTareasProgramadas();
});// forzar rebuild 1785825302
