import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { router } from './routes';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', mensaje: 'API del sistema de ventas corriendo' });
});

app.use('/api', router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
