import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { router } from './routes';

dotenv.config();

const app = express();

app.use(
  cors({
    origin: [
      'https://pos-frontend-258.pages.dev',
      'https://ventas.mrcarnes.com',
      'http://localhost:5173',
    ],
  })
);

app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', mensaje: 'API del sistema de ventas corriendo' });
});

app.use('/api', router);

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});// forzar rebuild 1785825302
