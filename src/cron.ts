import cron from 'node-cron';
import { crearBackup, BackupNoConfiguradoError } from './services/backup.service';
import { sugerirDiasCompraAutomaticamente } from './services/clientes.service';

/**
 * Respaldo automatico de toda la base de datos, todos los dias a
 * medianoche hora de Culiacan (America/Mazatlan -- node-cron calcula la
 * hora correcta el mismo sin que este servidor tenga que correr en esa
 * zona horaria).
 */
export function iniciarTareasProgramadas() {
  cron.schedule(
    '0 0 * * *',
    async () => {
      try {
        const info = await crearBackup('automatico');
        console.log(`[backup automatico] Listo: ${info.key} (${info.tamano} bytes)`);
      } catch (err) {
        if (err instanceof BackupNoConfiguradoError) {
          console.warn(`[backup automatico] Omitido: ${err.message}`);
        } else {
          console.error('[backup automatico] Fallo:', err);
        }
      }
    },
    { timezone: 'America/Mazatlan' }
  );

  cron.schedule(
    '30 0 * * *',
    async () => {
      try {
        const { clientesActualizados } = await sugerirDiasCompraAutomaticamente();
        console.log(`[dias de llamada sugeridos] ${clientesActualizados} cliente(s) actualizados`);
      } catch (err) {
        console.error('[dias de llamada sugeridos] Fallo:', err);
      }
    },
    { timezone: 'America/Mazatlan' }
  );

  // Tambien una vez al arrancar, para que un cliente que ya junto
  // suficiente historial no tenga que esperar hasta la madrugada.
  sugerirDiasCompraAutomaticamente()
    .then(({ clientesActualizados }) => {
      console.log(`[dias de llamada sugeridos] (arranque) ${clientesActualizados} cliente(s) actualizados`);
    })
    .catch((err) => console.error('[dias de llamada sugeridos] (arranque) Fallo:', err));
}
