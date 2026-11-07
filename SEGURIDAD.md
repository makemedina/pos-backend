# Seguridad y hardening — Mr Carnes POS

Referencias: **SOC 2** (Trust Services Criteria 2017, rev. 2022: CC = criterios comunes, A = disponibilidad, C = confidencialidad) e **ISO/IEC 27001:2022** (Anexo A).

Alcance: `pos-backend` (Railway, dos servicios: Culiacán y Tijuana), `pos-frontend` (Cloudflare Pages), Postgres en Railway, respaldos en Cloudflare R2, integraciones con Meta (CAPI, WhatsApp Cloud API).

Este documento no es una certificación. SOC 2 requiere una auditoría de un CPA y la ISO 27001 una certificadora acreditada. Lo que sí hace es dejar los controles técnicos implementados y una lista de lo que falta, para que el negocio esté listo si algún día se audita (o si un cliente grande lo pide).

---

## 1. Controles técnicos implementados

| Control | Qué hace | SOC 2 | ISO 27001:2022 |
|---|---|---|---|
| Autenticación obligatoria | Todas las rutas `/api` exigen sesión, menos `/auth/login` (`middleware/auth.ts`) | CC6.1 | A.8.5 |
| Mínimo privilegio | Rol administrador/vendedor + 7 permisos granulares (`requierePermiso`) | CC6.3 | A.5.15, A.8.2 |
| PIN con hash | bcrypt (10 rondas); el hash nunca sale en ninguna respuesta (incluido `PUT /usuarios/:id/permisos`, que antes lo filtraba) | CC6.1 | A.8.5, A.5.17 |
| Política de PIN | 4 a 8 dígitos, validado en el servidor al crear o cambiar | CC6.1 | A.5.17 |
| Anti fuerza bruta | 5 fallos por teléfono → bloqueo 15 min; 30 fallos por IP en 15 min → bloqueo de la IP; el PIN de autorización comparte el contador | CC6.1, CC6.8 | A.8.5 |
| Anti enumeración | Teléfono inexistente tarda lo mismo que uno real (bcrypt de relleno) y da el mismo mensaje | CC6.1 | A.8.5 |
| Tokens de sesión | 256 bits aleatorios; en la base se guarda solo el SHA-256 (una copia de la base o un respaldo filtrado no sirve para entrar) | CC6.1, C1.1 | A.8.5, A.8.24 |
| Duración de sesión | 12 h de inactividad y **tope absoluto de 7 días** (`SESION_MAX_DIAS`) | CC6.1 | A.8.5 |
| Revocación | Cambiar el PIN cierra las otras sesiones del usuario; dar de baja cierra todas | CC6.2 | A.5.18 |
| Baja de usuarios | `PUT /usuarios/:id/activo` + botón “Dar de baja” en Usuarios (antes no había forma de quitarle acceso a alguien) | CC6.2, CC6.3 | A.5.18, A.6.5 |
| Bitácora de seguridad | Tabla `BitacoraSeguridad`: login ok/fallo/bloqueado, logout, alta/edición/baja de usuarios, cambio de PIN y permisos, configuración, reset de datos, respaldos (crear/descargar/borrar/restaurar). Con IP y user-agent. `GET /api/admin/bitacora` | CC7.2, CC7.3 | A.8.15, A.8.16 |
| Retención | Cron diario: borra bitácora de más de 365 días (`BITACORA_RETENCION_DIAS`) y sesiones vencidas | CC7.2, C1.2 | A.8.10, A.5.33 |
| Cabeceras HTTP (API) | HSTS, `nosniff`, `X-Frame-Options: DENY`, CSP `default-src 'none'`, `Referrer-Policy`, `Cache-Control: no-store`; sin `X-Powered-By` | CC6.6 | A.8.9, A.8.26 |
| Cabeceras HTTP (frontend) | `public/_headers` en Cloudflare Pages: HSTS, `nosniff`, `DENY`, `Permissions-Policy` | CC6.6 | A.8.9 |
| CORS | Solo los orígenes de `ALLOWED_ORIGINS` | CC6.6 | A.8.20 |
| IP real | `trust proxy = 1` (un salto, el de Railway) para que límites y bitácora usen la IP del cliente | CC7.2 | A.8.15 |
| Errores | Manejador global: JSON genérico, sin stack traces; 404 genérico; `unhandledRejection` ya no tumba el proceso | CC7.4 | A.8.28 |
| Validación de entrada | JSON máx. 5 MB, archivos máx. 8 MB, tipos de imagen validados, permisos y rol validados en el servidor | CC8.1 | A.8.28 |
| Webhook firmado | `/webhooks/whatsapp` valida `X-Hub-Signature-256` con `timingSafeEqual` | CC6.6 | A.8.20 |
| Cifrado de secretos en base | Token de WhatsApp cifrado con AES-GCM | C1.1 | A.8.24 |
| Base sin superusuario | La app se conecta con un rol sin `SUPERUSER`/`CREATEROLE` (`prisma/sql/crear-rol-app.sql`) | CC6.3 | A.8.2, A.8.18 |
| Base no expuesta | Postgres sin proxy TCP público | CC6.6 | A.8.20, A.8.22 |
| Respaldos | `pg_dump` diario a R2 + respaldo automático antes de reset/restauración; restaurar exige escribir `RESTAURAR` | A1.2, A1.3 | A.8.13 |
| Integridad de dinero | Cancelaciones idempotentes, bloqueo de lotes (`FOR UPDATE`), idempotencia de ventas offline | PI1.3 | A.8.28 |
| Dependencias | `npm audit` en 0 vulnerabilidades (se actualizaron express, body-parser, multer, proxy-addr; override de `qs`; se quitaron `uuid` y `zod`, que no se usaban) | CC7.1 | A.8.8 |
| Secretos fuera del repo | `.env*` en `.gitignore`; secretos solo en variables de Railway | CC6.1 | A.8.4, A.5.17 |

---

## 2. Pendientes técnicos (siguiente ronda)

Ordenados por riesgo.

1. **2FA en las consolas** (no es código): GitHub, Railway, Cloudflare, Meta Business y la cuenta de Google de `contacto@mrcarnes.com`. Es el control con más impacto: quien entra a Railway tiene la base completa. — CC6.1 / A.5.17, A.8.5
2. **Rotar contraseñas de Postgres y llaves VAPID** pendientes del incidente de Railway del 2026-10-21. — CC7.4 / A.5.26
3. **Prueba de restauración trimestral**: restaurar el último respaldo en una base aparte y anotar fecha, duración y resultado. Un respaldo que nunca se restauró no cuenta como control. — A1.3 / A.8.13
4. **Cifrar los respaldos** antes de subirlos a R2 (p. ej. `age` o `gpg` con llave fuera de R2), y política de retención en el bucket (lifecycle). — C1.1 / A.8.24
5. **Pantalla de bitácora** en el frontend (el endpoint ya existe) y alerta push al admin ante: login bloqueado, usuario creado, permisos cambiados, restauración. — CC7.2, CC7.3 / A.8.16
6. **Content-Security-Policy en el frontend**, primero en `Report-Only`, incluyendo `connect.facebook.net`, el API y R2. — CC6.6 / A.8.26
7. **Token en `localStorage`**: es vulnerable si hay un XSS. Mitigación realista sin romper iOS: la CSP del punto 6. A futuro: cookie `HttpOnly; Secure; SameSite=Strict`.
8. **Límites de intentos en memoria**: se reinician con cada deploy y no se comparten entre réplicas. Si algún día hay más de una réplica, moverlos a Postgres.
9. **CI en GitHub**: `npm audit --omit=dev`, `tsc --noEmit` y Dependabot en ambos repos; protección de rama `main` (requiere PR). — CC8.1 / A.8.25, A.8.32
10. **PIN de administrador de 6+ dígitos** (el servidor ya lo permite; falta cambiarlo).
11. **Logs estructurados** (JSON con request id) para poder correlacionar en Railway. — A.8.15

---

## 3. Controles de proceso (no son código)

SOC 2 e ISO 27001 piden evidencia de que estas cosas se hacen. Para un negocio de este tamaño basta con una hoja de cálculo o una carpeta con fecha.

| Proceso | Frecuencia | Evidencia | SOC 2 | ISO |
|---|---|---|---|---|
| Revisión de accesos: quién tiene usuario en el POS, Railway, GitHub, Cloudflare, Meta; quitar a quien ya no esté | Trimestral | Captura de la lista + fecha | CC6.2, CC6.3 | A.5.18 |
| Baja de empleado: “Dar de baja” en el POS el mismo día, cambiar PIN de autorización si lo conocía | Al salir | Evento `usuario.desactivado` en bitácora | CC6.2 | A.6.5 |
| Revisión de la bitácora (logins fallidos, cambios de permisos) | Mensual | Nota con fecha | CC7.2 | A.8.15 |
| Prueba de restauración de respaldo | Trimestral | Registro de la prueba | A1.3 | A.8.13 |
| Actualización de dependencias (`npm audit`) | Mensual | Commit | CC7.1 | A.8.8 |
| Inventario de activos y proveedores (Railway, Cloudflare, Meta, GitHub, Google) con qué datos maneja cada uno | Anual | Tabla | CC9.2 | A.5.9, A.5.19, A.5.23 |
| Plan de respuesta a incidentes (ver abajo) | Revisar anual | Este documento | CC7.3–CC7.5 | A.5.24–A.5.27 |
| Política de seguridad firmada por empleados (uso del POS, no compartir PIN) | Al contratar | Firma | CC1.4, CC2.2 | A.5.1, A.6.2 |
| Evaluación de riesgos | Anual | Tabla riesgo/impacto/control | CC3.1–CC3.4 | 6.1.2, A.5.7 |

---

## 4. Respuesta a incidentes (resumen)

1. **Detectar**: aviso de un proveedor (como Railway el 2026-10-21), bitácora con fallos raros, datos que no cuadran.
2. **Contener**: dar de baja usuarios sospechosos (cierra sus sesiones); si hay sospecha general, borrar todas las sesiones (`DELETE FROM "Sesion"`) y rotar secretos.
3. **Rotar** en este orden: R2 (tiene respaldos completos) → `META_APP_SECRET` / tokens de Meta → contraseña de Postgres → VAPID. Luego `railway redeploy` en ambos servicios.
4. **Investigar**: `GET /api/admin/bitacora`, logs de Railway, historial de GitHub.
5. **Recuperar**: restaurar respaldo si hubo alteración de datos.
6. **Notificar**: si se expusieron datos personales de clientes, la LFPDPPP obliga a avisar a los titulares afectados.
7. **Aprender**: anotar qué pasó y qué control se agrega.

---

## 5. Variables de entorno de seguridad

| Variable | Default | Uso |
|---|---|---|
| `ALLOWED_ORIGINS` | dominios de Culiacán + localhost | Orígenes CORS permitidos |
| `SESION_MAX_DIAS` | 7 | Vida máxima de una sesión aunque se use a diario |
| `BITACORA_RETENCION_DIAS` | 365 | Cuánto se guarda la bitácora |
