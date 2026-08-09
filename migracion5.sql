-- ============================================================
-- MIGRACIÓN 5 — Tiempo activo de cada mecánico
-- Supabase -> SQL Editor -> New query -> pega TODO -> Run
-- Seguro de ejecutar varias veces. No borra datos.
-- ============================================================

-- ------------------------------------------------------------
-- SESIONES DE TRABAJO
--
-- Cada vez que un mecánico pasa a ACTIVO se abre una sesión, y al pasar
-- a Pausa o Inactivo se cierra. Sumando esas sesiones se sabe cuántas
-- horas estuvo realmente disponible en un día, semana, mes o año.
--
-- Se guarda en una tabla aparte (y no en una columna del mecánico)
-- porque un mismo mecánico entra y sale varias veces al día, y hace
-- falta el detalle de cada tramo para poder sumar por rango de fechas.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sesiones_mecanico (
    id          SERIAL PRIMARY KEY,
    mecanico_id INTEGER NOT NULL REFERENCES mecanicos(id) ON DELETE CASCADE,
    inicio      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fin         TIMESTAMP   -- NULL = sesión todavía abierta (sigue en turno)
);

CREATE INDEX IF NOT EXISTS idx_sesiones_mecanico ON sesiones_mecanico (mecanico_id);
CREATE INDEX IF NOT EXISTS idx_sesiones_inicio   ON sesiones_mecanico (inicio);
CREATE INDEX IF NOT EXISTS idx_sesiones_abiertas ON sesiones_mecanico (mecanico_id)
    WHERE fin IS NULL;

-- ------------------------------------------------------------
-- ARRANQUE: a los que YA están activos les abrimos su sesión ahora.
-- Su tiempo empieza a contar desde este momento (no hay forma de
-- recuperar las horas anteriores, porque nunca se registraron).
-- ------------------------------------------------------------
INSERT INTO sesiones_mecanico (mecanico_id, inicio)
SELECT m.id, CURRENT_TIMESTAMP
FROM mecanicos m
WHERE m.estado_asistencia = 'ACTIVO'
  AND NOT EXISTS (
      SELECT 1 FROM sesiones_mecanico s
      WHERE s.mecanico_id = m.id AND s.fin IS NULL
  );

-- Seguridad: si algún mecánico quedó con dos sesiones abiertas por un
-- error, cerramos las viejas y dejamos solo la más reciente.
UPDATE sesiones_mecanico s
SET fin = CURRENT_TIMESTAMP
WHERE s.fin IS NULL
  AND s.id <> (
      SELECT MAX(s2.id) FROM sesiones_mecanico s2
      WHERE s2.mecanico_id = s.mecanico_id AND s2.fin IS NULL
  );

-- ------------------------------------------------------------
-- VERIFICACIÓN
-- ------------------------------------------------------------
SELECT m.nombre, m.estado_asistencia, s.inicio AS sesion_abierta_desde
FROM mecanicos m
LEFT JOIN sesiones_mecanico s ON s.mecanico_id = m.id AND s.fin IS NULL
ORDER BY m.nombre;
