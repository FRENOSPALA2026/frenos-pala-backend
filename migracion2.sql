-- ============================================================
-- MIGRACIÓN 2 — Servicios múltiples + Cambio de aceite
-- Supabase -> SQL Editor -> New query -> pega TODO -> Run
-- Es seguro ejecutarlo varias veces. No borra datos.
-- ============================================================

-- ------------------------------------------------------------
-- 1. NUEVA HABILIDAD: CAMBIO DE ACEITE
-- ------------------------------------------------------------
ALTER TABLE mecanicos ADD COLUMN IF NOT EXISTS sabe_aceite BOOLEAN NOT NULL DEFAULT FALSE;

-- ------------------------------------------------------------
-- 2. UN VEHÍCULO AHORA PUEDE NECESITAR VARIOS SERVICIOS
--    Pasamos de una sola columna de texto a una lista.
--    Ej: un carro que necesita frenos Y suspensión guarda
--        {frenos,suspension} en vez de solo 'frenos'.
-- ------------------------------------------------------------
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS tipo_servicios TEXT[];

-- Migramos los turnos viejos: lo que tenían en tipo_servicio
-- pasa a ser una lista de un solo elemento.
UPDATE turnos
SET tipo_servicios = ARRAY[LOWER(tipo_servicio)]
WHERE tipo_servicios IS NULL AND tipo_servicio IS NOT NULL;

-- Por si quedó algún turno sin nada
UPDATE turnos SET tipo_servicios = ARRAY['frenos'] WHERE tipo_servicios IS NULL;

-- La columna vieja ya no se usa, pero la dejamos por si acaso.
-- Quitamos la obligatoriedad para que no estorbe en los inserts nuevos.
ALTER TABLE turnos ALTER COLUMN tipo_servicio DROP NOT NULL;

-- ------------------------------------------------------------
-- 3. NORMALIZAR ESTADOS (deben ir siempre en MAYÚSCULA)
--    Este era el problema por el que las placas no aparecían.
-- ------------------------------------------------------------
UPDATE turnos    SET estado_turno      = UPPER(estado_turno);
UPDATE mecanicos SET estado_asistencia = UPPER(estado_asistencia),
                     estado_trabajo    = UPPER(estado_trabajo);

ALTER TABLE turnos    ALTER COLUMN estado_turno      SET DEFAULT 'EN_ESPERA';
ALTER TABLE mecanicos ALTER COLUMN estado_asistencia SET DEFAULT 'ACTIVO';
ALTER TABLE mecanicos ALTER COLUMN estado_trabajo    SET DEFAULT 'DISPONIBLE';

-- Los servicios, en cambio, van siempre en minúscula
UPDATE turnos SET tipo_servicios = ARRAY(SELECT LOWER(s) FROM unnest(tipo_servicios) AS s);

-- ------------------------------------------------------------
-- 4. ÍNDICE para que el motor busque rápido en las listas
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_turnos_servicios ON turnos USING GIN (tipo_servicios);

-- ------------------------------------------------------------
-- VERIFICACIÓN
-- ------------------------------------------------------------
SELECT id, placa, tipo_servicios, estado_turno, mecanico_id, es_vip
FROM turnos ORDER BY id DESC LIMIT 10;
