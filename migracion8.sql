-- ============================================================
-- MIGRACIÓN 8 — Garantías
-- Supabase -> SQL Editor -> New query -> pega TODO -> Run
-- Seguro de ejecutar varias veces, aunque ya la hayas corrido antes.
-- ============================================================
--
-- CÓMO FUNCIONA:
--
-- Cuando llega un vehículo por garantía todavía no se sabe por qué falló:
-- eso se descubre al revisarlo. Por eso al registrarlo solo se anota QUIÉN
-- hizo el trabajo anterior, y el carro entra a la fila normal.
--
-- Si el mecánico responsable está en el taller, el turnero puede además
-- marcar "turno preferencial" para mandárselo a él.
--
-- Al terminar se preguntan dos cosas:
--   1. La causa: falló el repuesto, o el trabajo quedó mal hecho
--   2. Si se le cobró al cliente
--
-- De la causa depende a quién se le cuenta la garantía en los informes.
-- Del cobro depende dónde queda el mecánico en la fila.

-- ------------------------------------------------------------
-- 1. CAMPOS DE GARANTÍA
-- ------------------------------------------------------------
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS es_garantia BOOLEAN NOT NULL DEFAULT FALSE;

-- Quién hizo el trabajo que falló. Se anota al registrar el vehículo.
-- No decide a quién se le asigna: de eso se encarga la fila normal.
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS mecanico_responsable_id INTEGER
    REFERENCES mecanicos(id) ON DELETE SET NULL;
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS nombre_mecanico_responsable VARCHAR(100);

-- REPUESTO = falló la pieza  ·  MECANICO = el trabajo quedó mal hecho.
-- Queda vacío hasta que se termina el trabajo y se sabe la causa.
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS tipo_garantia VARCHAR(20);

-- TRUE si se le cobró al cliente. Se llena al finalizar.
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS garantia_cobrada BOOLEAN;

-- Marca de espera que traía el mecánico antes de recibir la garantía.
-- Es lo que permite devolverle su puesto si no se cobró.
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS espera_previa_mecanico TIMESTAMP;

ALTER TABLE turnos DROP CONSTRAINT IF EXISTS turnos_tipo_garantia_valido;
ALTER TABLE turnos ADD CONSTRAINT turnos_tipo_garantia_valido
    CHECK (tipo_garantia IS NULL OR tipo_garantia IN ('REPUESTO', 'MECANICO'));

-- Restricción de una versión anterior del diseño, cuando la garantía iba
-- obligatoriamente al mecánico responsable. Ya no aplica.
ALTER TABLE turnos DROP CONSTRAINT IF EXISTS turnos_garantia_con_mecanico;

CREATE INDEX IF NOT EXISTS idx_turnos_garantia
    ON turnos (es_garantia) WHERE es_garantia = TRUE;
CREATE INDEX IF NOT EXISTS idx_turnos_responsable
    ON turnos (mecanico_responsable_id) WHERE mecanico_responsable_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. VERIFICACIÓN
-- ------------------------------------------------------------
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'turnos'
  AND column_name IN ('es_garantia','tipo_garantia','garantia_cobrada',
                      'espera_previa_mecanico','mecanico_responsable_id',
                      'nombre_mecanico_responsable')
ORDER BY column_name;
