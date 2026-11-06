-- Crea (o actualiza) el usuario de base de datos con el que se conecta la app.
--
-- Por que existe: el usuario que trae Postgres de Railway ("postgres") es
-- superusuario. Un superusuario puede, ademas de leer y escribir datos,
-- crear otros usuarios, leer archivos del servidor y hasta ejecutar
-- comandos del sistema operativo (COPY ... FROM PROGRAM). Si la app se
-- conecta con ese usuario y su contrasena se filtra, el dano no se limita
-- a los datos.
--
-- El usuario que crea este script es dueno de las tablas de la app (asi
-- puede correr migraciones y restaurar respaldos), pero NO es
-- superusuario: no puede crear usuarios, ni bases, ni tocar el servidor.
--
-- Se corre con un superusuario, conectado a la base de la app:
--
--   psql "<URL del superusuario>" -v rol=pos_app -v clave='<contrasena larga>' \
--        -f prisma/sql/crear-rol-app.sql
--
-- Se puede volver a correr sin problema: si el usuario ya existe solo le
-- cambia la contrasena, y vuelve a pasarle los objetos que no sean suyos.

\set ON_ERROR_STOP on

\if :{?rol}
\else
  \echo 'Falta -v rol=<nombre>'
  \quit
\endif
\if :{?clave}
\else
  \echo 'Falta -v clave=<contrasena>'
  \quit
\endif

BEGIN;

-- 1. El usuario, sin ningun poder especial.
SELECT format('CREATE ROLE %I LOGIN', :'rol')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'rol')
\gexec

SELECT format(
  'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'rol', :'clave'
)
\gexec

-- 2. Puede conectarse a esta base y crear tablas en el esquema public
--    (las migraciones lo necesitan).
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', current_database(), :'rol')
\gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'rol')
\gexec

-- 3. Se vuelve dueno de todo lo que hay en public: tablas (sus indices y
--    secuencias de autoincremento se van con ellas), secuencias sueltas,
--    vistas, tipos enum y funciones.
SELECT set_config('pos.rol', :'rol', true);

DO $$
DECLARE
  rol text := current_setting('pos.rol');
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND pg_get_userbyid(c.relowner) <> rol
      -- las secuencias de columnas autoincrementables cambian de dueno junto con su tabla
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      ))
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO %I',
      CASE r.relkind
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END,
      r.relname, rol
    );
  END LOOP;

  FOR r IN
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd')
      AND pg_get_userbyid(t.typowner) <> rol
  LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO %I', r.typname, rol);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS firma
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_userbyid(p.proowner) <> rol
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.firma, rol);
  END LOOP;
END
$$;

COMMIT;

-- Resumen: lo que quedo a nombre de otro usuario deberia ser 0.
SELECT
  :'rol' AS usuario_app,
  (SELECT rolsuper FROM pg_roles WHERE rolname = :'rol') AS es_superusuario,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
      AND pg_get_userbyid(c.relowner) <> :'rol') AS objetos_de_otro_dueno;
