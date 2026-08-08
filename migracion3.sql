-- ============================================================
-- MIGRACIÓN 3 — Cronómetro de tiempo disponible
-- Supabase -> SQL Editor -> New query -> pega TODO -> Run
-- Seguro de ejecutar varias veces.
-- ============================================================

-- Guarda el momento exacto en que el mecánico quedó libre.
-- Con esto podemos mostrar "lleva 12:35 esperando" y ordenar
-- la fila por quién lleva más tiempo sin carro.
ALTER TABLE mecanicos ADD COLUMN IF NOT EXISTS disponible_desde TIMESTAMP;

-- A los que ya están disponibles y no tienen la marca, se la ponemos ahora.
UPDATE mecanicos
SET disponible_desde = CURRENT_TIMESTAMP
WHERE estado_trabajo = 'DISPONIBLE' AND disponible_desde IS NULL;

-- Los que están ocupados no deben tener marca (no están esperando).
UPDATE mecanicos
SET disponible_desde = NULL
WHERE estado_trabajo = 'OCUPADO';

-- Verificación
SELECT id, nombre, estado_trabajo, disponible_desde
FROM mecanicos ORDER BY disponible_desde NULLS LAST;
