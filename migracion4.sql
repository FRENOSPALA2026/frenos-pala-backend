-- ============================================================
-- MIGRACIÓN 4 — Auditoría, cancelación de turnos y zona horaria
-- Supabase -> SQL Editor -> New query -> pega TODO -> Run
-- Seguro de ejecutar varias veces. No borra datos.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ZONA HORARIA
--    La base debe quedarse en UTC. El backend convierte a hora de
--    Colombia al generar los informes.
--
--    (En una versión anterior este archivo cambiaba la zona de la base
--    a 'America/Bogota'. Era un error: hacía que los cronómetros
--    mostraran 5 horas de más. Si ya lo ejecutaste así, corre
--    migracion6.sql para dejarlo bien.)
-- ------------------------------------------------------------
DO $$
DECLARE db TEXT;
BEGIN
    SELECT current_database() INTO db;
    EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', db);
END $$;

-- ------------------------------------------------------------
-- 2. TURNOS CANCELADOS
--    Permite corregir un error de digitación sin tener que "atender"
--    un carro que nunca existió. El turno no se borra: queda marcado
--    como CANCELADO para que el historial siga siendo confiable.
-- ------------------------------------------------------------
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS motivo_cancelacion TEXT;
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS hora_cancelacion TIMESTAMP;

-- Quitamos la restricción vieja de estado_turno si existe, para poder
-- agregar el estado nuevo CANCELADO.
DO $$
DECLARE nombre_restriccion TEXT;
BEGIN
    SELECT conname INTO nombre_restriccion
    FROM pg_constraint
    WHERE conrelid = 'turnos'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%estado_turno%'
    LIMIT 1;

    IF nombre_restriccion IS NOT NULL THEN
        EXECUTE format('ALTER TABLE turnos DROP CONSTRAINT %I', nombre_restriccion);
    END IF;
END $$;

ALTER TABLE turnos ADD CONSTRAINT turnos_estado_valido
    CHECK (estado_turno IN ('EN_ESPERA', 'EN_PROCESO', 'FINALIZADO', 'CANCELADO'));

-- ------------------------------------------------------------
-- 3. REGISTRO DE ACCIONES (AUDITORÍA)
--    Guarda quién hizo qué y cuándo. Es lo que permite responder
--    "¿por qué este carro se saltó la fila?" con evidencia, que era
--    el objetivo original del proyecto.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auditoria (
    id          SERIAL PRIMARY KEY,
    accion      VARCHAR(40) NOT NULL,   -- INGRESO, LIBERAR, CANCELAR, ASIGNAR...
    detalle     TEXT,                   -- descripción legible de lo ocurrido
    usuario     VARCHAR(40),            -- 'turnero' o 'admin'
    placa       VARCHAR(15),
    mecanico_id INTEGER,
    turno_id    INTEGER,
    datos       JSONB,                  -- información extra por si se necesita
    fecha       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auditoria_fecha  ON auditoria (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_accion ON auditoria (accion);
CREATE INDEX IF NOT EXISTS idx_auditoria_placa  ON auditoria (placa);

-- ------------------------------------------------------------
-- 4. VERIFICACIÓN
-- ------------------------------------------------------------
SELECT 'Turnos por estado' AS revision, estado_turno AS valor, COUNT(*) AS cantidad
FROM turnos GROUP BY estado_turno
UNION ALL
SELECT 'Registros de auditoría', '-', COUNT(*)::bigint FROM auditoria;
