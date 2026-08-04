-- ==========================================
-- ESQUEMA DE BASE DE DATOS — Frenos Pala
-- ==========================================
-- Seguro de ejecutar aunque las tablas ya existan: usa IF NOT EXISTS en todo,
-- así que si ya tienes datos cargados no los pierdes al volver a correrlo.
--   psql -U tu_usuario -d frenos_pala -f schema.sql

CREATE TABLE IF NOT EXISTS mecanicos (
    id                 SERIAL PRIMARY KEY,
    nombre             VARCHAR(100) NOT NULL,
    sabe_frenos        BOOLEAN NOT NULL DEFAULT FALSE,
    sabe_suspension    BOOLEAN NOT NULL DEFAULT FALSE,
    sabe_revision      BOOLEAN NOT NULL DEFAULT FALSE,
    sabe_alineacion    BOOLEAN NOT NULL DEFAULT FALSE,
    -- ACTIVO / PAUSA / INACTIVO -> lo maneja la pestaña "Plantilla" de la app
    estado_asistencia  VARCHAR(20) NOT NULL DEFAULT 'ACTIVO'
                       CHECK (estado_asistencia IN ('ACTIVO', 'PAUSA', 'INACTIVO')),
    -- DISPONIBLE / OCUPADO -> lo maneja el motor lógico, no el turnero directamente
    estado_trabajo     VARCHAR(20) NOT NULL DEFAULT 'DISPONIBLE'
                       CHECK (estado_trabajo IN ('DISPONIBLE', 'OCUPADO')),
    fecha_creacion     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turnos (
    id                     SERIAL PRIMARY KEY,
    placa                  VARCHAR(15) NOT NULL,
    -- revision y alineacion comparten la misma infraestructura física (la fosa),
    -- pero se guardan distintos porque no todos los mecánicos hacen ambas cosas.
    tipo_servicio          VARCHAR(20) NOT NULL
                           CHECK (tipo_servicio IN ('frenos', 'suspension', 'revision', 'alineacion')),
    es_vip                 BOOLEAN NOT NULL DEFAULT FALSE,
    mecanico_preferido_id  INTEGER REFERENCES mecanicos(id),
    nombre_mecanico_preferido VARCHAR(100),
    mecanico_id            INTEGER REFERENCES mecanicos(id),
    estado_turno           VARCHAR(20) NOT NULL DEFAULT 'EN_ESPERA'
                           CHECK (estado_turno IN ('EN_ESPERA', 'EN_PROCESO', 'FINALIZADO')),
    hora_llegada           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    hora_inicio            TIMESTAMP,
    hora_fin               TIMESTAMP
);

-- Por si la tabla ya existía de una versión anterior con menos columnas
ALTER TABLE mecanicos ADD COLUMN IF NOT EXISTS sabe_revision BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mecanicos ADD COLUMN IF NOT EXISTS sabe_alineacion BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS nombre_mecanico_preferido VARCHAR(100);

-- Índices para las consultas más frecuentes del dashboard y del motor
CREATE INDEX IF NOT EXISTS idx_turnos_estado ON turnos (estado_turno);
CREATE INDEX IF NOT EXISTS idx_turnos_placa ON turnos (placa);
CREATE INDEX IF NOT EXISTS idx_turnos_mecanico ON turnos (mecanico_id);
CREATE INDEX IF NOT EXISTS idx_mecanicos_estados ON mecanicos (estado_asistencia, estado_trabajo);
