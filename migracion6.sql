-- ============================================================
-- MIGRACIÓN 6 — CORRECCIÓN DE ZONA HORARIA
-- Supabase -> SQL Editor -> New query -> pega TODO -> Run
-- ============================================================
--
-- QUÉ PASÓ:
-- En migracion4.sql se cambió la zona horaria de la base de datos a
-- 'America/Bogota'. Fue un error: todo el código está escrito asumiendo
-- que la base guarda las horas en UTC y hace la conversión al mostrarlas.
--
-- Con la base en hora de Bogotá, los cronómetros mostraban 5 horas de más
-- (los famosos "300 minutos"), porque el navegador leía una hora local
-- como si fuera UTC.
--
-- SOLUCIÓN: la base vuelve a UTC. Las conversiones a hora de Colombia se
-- siguen haciendo en las consultas de informes, que ya estaban correctas.

-- ------------------------------------------------------------
-- 1. DEVOLVER LA BASE A UTC
-- ------------------------------------------------------------
DO $$
DECLARE db TEXT;
BEGIN
    SELECT current_database() INTO db;
    EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', db);
END $$;

-- ------------------------------------------------------------
-- 2. REINICIAR LOS CRONÓMETROS EN VIVO
--    Los que se guardaron mientras la base estaba en hora de Bogotá
--    quedaron corridos 5 horas. Como son contadores del momento actual
--    (no historial), lo correcto es reiniciarlos desde cero.
-- ------------------------------------------------------------

-- Tiempo que lleva disponible cada mecánico
UPDATE mecanicos
SET disponible_desde = CURRENT_TIMESTAMP
WHERE estado_trabajo = 'DISPONIBLE' AND estado_asistencia = 'ACTIVO';

UPDATE mecanicos
SET disponible_desde = NULL
WHERE estado_asistencia <> 'ACTIVO' OR estado_trabajo <> 'DISPONIBLE';

-- Sesiones de trabajo: cerramos las abiertas y empezamos de nuevo,
-- para que el informe de horas arranque limpio.
DELETE FROM sesiones_mecanico;

INSERT INTO sesiones_mecanico (mecanico_id, inicio)
SELECT id, CURRENT_TIMESTAMP
FROM mecanicos
WHERE estado_asistencia = 'ACTIVO';

-- Vehículos que están siendo atendidos ahora mismo
UPDATE turnos
SET hora_inicio = CURRENT_TIMESTAMP
WHERE estado_turno = 'EN_PROCESO';

-- ------------------------------------------------------------
-- 3. TURNOS DE PRUEBA
--    Si los vehículos que tienes registrados son solo de prueba, esta
--    línea los borra y deja todo limpio para la entrega.
--    Si YA tienes datos reales que quieras conservar, NO la ejecutes:
--    bórrala antes de dar Run (está comentada por seguridad).
-- ------------------------------------------------------------
-- DELETE FROM turnos;
-- UPDATE mecanicos SET estado_trabajo = 'DISPONIBLE',
--                      disponible_desde = CURRENT_TIMESTAMP
-- WHERE estado_asistencia = 'ACTIVO';

-- ------------------------------------------------------------
-- VERIFICACIÓN
-- La diferencia debe ser cercana a CERO (unos pocos segundos).
-- Si muestra 5 horas, la zona horaria no se aplicó: cierra la pestaña
-- del SQL Editor, ábrela de nuevo y vuelve a ejecutar la consulta.
-- ------------------------------------------------------------
SELECT
    CURRENT_TIMESTAMP AS hora_de_la_base,
    NOW() AT TIME ZONE 'UTC' AS deberia_ser_esta,
    EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - (NOW() AT TIME ZONE 'UTC')))/60
        AS diferencia_en_minutos;
