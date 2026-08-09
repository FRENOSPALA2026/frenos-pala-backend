-- ============================================================
-- MIGRACIÓN 7 — Evitar vehículos duplicados
-- Supabase -> SQL Editor -> New query -> pega TODO -> Run
-- ============================================================
--
-- EL PROBLEMA:
-- Cuando la tablet reintentaba enviar un registro guardado sin conexión,
-- podía crear el mismo vehículo dos veces. Pasa cuando el servidor SÍ
-- recibió la petición pero tardó tanto en responder (Render dormido tarda
-- hasta 50 segundos en despertar) que la app se rindió y lo reintentó.
--
-- LA SOLUCIÓN:
-- Cada registro lleva una "clave única" generada en la tablet. Si llega
-- dos veces la misma clave, el servidor sabe que es el mismo carro y
-- devuelve el que ya creó, en vez de crear otro.

ALTER TABLE turnos ADD COLUMN IF NOT EXISTS clave_unica VARCHAR(60);

-- Índice único: la base misma impide que se repita una clave, aunque
-- lleguen dos peticiones exactamente al mismo tiempo.
-- (Los turnos viejos tienen la clave vacía; por eso el índice solo
--  aplica a los que sí la tienen.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_clave_unica
    ON turnos (clave_unica) WHERE clave_unica IS NOT NULL;

-- ------------------------------------------------------------
-- LIMPIAR LOS DUPLICADOS QUE YA SE CREARON
-- Busca vehículos con la misma placa registrados con menos de
-- 2 minutos de diferencia, y cancela el más reciente de cada par.
-- El mecánico que lo tenía queda libre automáticamente.
-- ------------------------------------------------------------
WITH duplicados AS (
    SELECT t2.id, t2.mecanico_id
    FROM turnos t1
    JOIN turnos t2
      ON t1.placa = t2.placa
     AND t2.id > t1.id
     AND t2.hora_llegada - t1.hora_llegada < interval '2 minutes'
    WHERE t1.estado_turno IN ('EN_ESPERA', 'EN_PROCESO')
      AND t2.estado_turno IN ('EN_ESPERA', 'EN_PROCESO')
)
UPDATE turnos
SET estado_turno = 'CANCELADO',
    hora_cancelacion = CURRENT_TIMESTAMP,
    motivo_cancelacion = 'Registro duplicado por reintento sin conexión'
WHERE id IN (SELECT id FROM duplicados);

-- Liberamos a los mecánicos que estaban atendiendo esos duplicados
UPDATE mecanicos
SET estado_trabajo = 'DISPONIBLE',
    disponible_desde = CURRENT_TIMESTAMP
WHERE id IN (
    SELECT mecanico_id FROM turnos
    WHERE motivo_cancelacion = 'Registro duplicado por reintento sin conexión'
      AND mecanico_id IS NOT NULL
)
AND id NOT IN (
    SELECT mecanico_id FROM turnos
    WHERE estado_turno = 'EN_PROCESO' AND mecanico_id IS NOT NULL
);

-- ------------------------------------------------------------
-- VERIFICACIÓN: no debe quedar ninguna placa repetida en atención
-- ------------------------------------------------------------
SELECT placa, COUNT(*) AS veces
FROM turnos
WHERE estado_turno IN ('EN_ESPERA', 'EN_PROCESO')
GROUP BY placa
HAVING COUNT(*) > 1;
