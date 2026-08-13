import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { router } from './routes';
import { iniciarTareasProgramadas } from './cron';

dotenv.config();

const app = express();

// ALLOWED_ORIGINS (opcional, separado por comas) permite agregar el
// dominio de una sucursal nueva sin tener que tocar este archivo -- cada
// sucursal corre su propio backend con su propia base de datos, y cada
// uno se configura con sus propios origenes permitidos en Railway.
const origenesPermitidos = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['https://pos-frontend-258.pages.dev', 'https://ventas.mrcarnes.com', 'http://localhost:5173'];

app.use(cors({ origin: origenesPermitidos }));

app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', mensaje: 'API del sistema de ventas corriendo' });
});

app.use('/api', router);

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  iniciarTareasProgramadas();
});// forzar rebuild 1785825302
