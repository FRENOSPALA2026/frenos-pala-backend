-- ============================================================
-- LIMPIEZA — Frenos Pala
-- Supabase -> SQL Editor -> New query -> pega TODO -> Run
-- ============================================================

-- ------------------------------------------------------------
-- 1. QUITAR RESTRICCIONES DUPLICADAS QUE BLOQUEAN EL BORRADO
--    En una migración anterior se crearon dos llaves foráneas extra
--    sin regla de borrado. Esas impiden eliminar un mecánico aunque
--    el código ya libere sus referencias. Las quitamos: las originales
--    (turnos_mecanico_id_fkey y turnos_mecanico_preferido_id_fkey)
--    se quedan y ya traen ON DELETE SET NULL.
-- ------------------------------------------------------------
ALTER TABLE turnos DROP CONSTRAINT IF EXISTS fk_turnos_mecanico;
ALTER TABLE turnos DROP CONSTRAINT IF EXISTS fk_turnos_preferido;

-- ------------------------------------------------------------
-- 2. VER QUIÉNES SON LOS MECÁNICOS DE PRUEBA
--    Ejecuta primero esto solo, para confirmar los nombres exactos
--    antes de borrar nada.
-- ------------------------------------------------------------
SELECT id, nombre, estado_asistencia, estado_trabajo
FROM mecanicos
WHERE nombre ILIKE '%samuel%' OR nombre ILIKE '%paola%';

-- ------------------------------------------------------------
-- 3. BORRAR A SAMUEL Y PAOLA
--    Primero soltamos cualquier turno que los referencie,
--    después sí los eliminamos.
-- ------------------------------------------------------------
UPDATE turnos SET mecanico_id = NULL
WHERE mecanico_id IN (
    SELECT id FROM mecanicos WHERE nombre ILIKE '%samuel%' OR nombre ILIKE '%paola%'
);

UPDATE turnos SET mecanico_preferido_id = NULL, es_vip = FALSE, nombre_mecanico_preferido = NULL
WHERE mecanico_preferido_id IN (
    SELECT id FROM mecanicos WHERE nombre ILIKE '%samuel%' OR nombre ILIKE '%paola%'
);

DELETE FROM mecanicos
WHERE nombre ILIKE '%samuel%' OR nombre ILIKE '%paola%';

-- ------------------------------------------------------------
-- 4. REINICIAR LOS CRONÓMETROS DE ESPERA
--    Todos los mecánicos disponibles arrancan a contar desde cero,
--    en vez de arrastrar la hora en que corriste la migración anterior.
-- ------------------------------------------------------------
UPDATE mecanicos
SET disponible_desde = CURRENT_TIMESTAMP
WHERE estado_trabajo = 'DISPONIBLE' AND estado_asistencia = 'ACTIVO';

-- Los que están en Pausa o Inactivos no deben contar nada
UPDATE mecanicos
SET disponible_desde = NULL
WHERE estado_asistencia <> 'ACTIVO';

-- ------------------------------------------------------------
-- 5. VERIFICACIÓN FINAL — deben quedar solo tus mecánicos reales
-- ------------------------------------------------------------
SELECT id, nombre, estado_asistencia, estado_trabajo, disponible_desde
FROM mecanicos ORDER BY nombre;
