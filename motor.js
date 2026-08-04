// ==========================================
// MOTOR LÓGICO DE ASIGNACIÓN — Frenos Pala
// ==========================================
// El "cerebro" del sistema. Decide qué turno le toca a un mecánico apenas
// queda disponible, en este orden de prioridad:
//
//   1. Fila oculta VIP  -> ¿hay un cliente de confianza esperando por ÉL?
//   2. Fila de la fosa  -> revisión / alineación (comparten infraestructura,
//                          pero cada mecánico solo toma la que sabe hacer)
//   3. Fila general     -> frenos / suspensión, FIFO con salto de habilidades
//
// Corre dentro de una transacción con bloqueo de fila (FOR UPDATE / SKIP LOCKED)
// para que dos liberaciones simultáneas nunca se roben el mismo turno.

const pool = require('./db');

async function asignarSiguienteTurno(mecanicoId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: mecRows } = await client.query(
            'SELECT * FROM mecanicos WHERE id = $1 FOR UPDATE',
            [mecanicoId]
        );
        const mecanico = mecRows[0];

        if (!mecanico) {
            await client.query('ROLLBACK');
            return { asignado: false, motivo: 'Mecánico no encontrado' };
        }

        if (mecanico.estado_asistencia !== 'ACTIVO' || mecanico.estado_trabajo !== 'DISPONIBLE') {
            await client.query('ROLLBACK');
            return { asignado: false, motivo: 'El mecánico no está disponible' };
        }

        let turno = null;

        // 1. Fila oculta VIP
        let r = await client.query(
            `SELECT * FROM turnos
             WHERE estado_turno = 'EN_ESPERA' AND es_vip = TRUE AND mecanico_preferido_id = $1
             ORDER BY hora_llegada ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [mecanicoId]
        );
        turno = r.rows[0];

        // 2. Fila de la fosa (revisión / alineación)
        const serviciosFosa = [];
        if (mecanico.sabe_revision) serviciosFosa.push('revision');
        if (mecanico.sabe_alineacion) serviciosFosa.push('alineacion');

        if (!turno && serviciosFosa.length > 0) {
            r = await client.query(
                `SELECT * FROM turnos
                 WHERE estado_turno = 'EN_ESPERA' AND es_vip = FALSE AND tipo_servicio = ANY($1::text[])
                 ORDER BY hora_llegada ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
                [serviciosFosa]
            );
            turno = r.rows[0];
        }

        // 3. Fila general (frenos / suspensión), con salto de habilidades
        const serviciosGenerales = [];
        if (mecanico.sabe_frenos) serviciosGenerales.push('frenos');
        if (mecanico.sabe_suspension) serviciosGenerales.push('suspension');

        if (!turno && serviciosGenerales.length > 0) {
            r = await client.query(
                `SELECT * FROM turnos
                 WHERE estado_turno = 'EN_ESPERA' AND es_vip = FALSE AND tipo_servicio = ANY($1::text[])
                 ORDER BY hora_llegada ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
                [serviciosGenerales]
            );
            turno = r.rows[0];
        }

        if (!turno) {
            await client.query('COMMIT');
            return { asignado: false, motivo: 'No hay turnos pendientes para su perfil' };
        }

        const { rows: turnoRows } = await client.query(
            `UPDATE turnos
             SET mecanico_id = $1, estado_turno = 'EN_PROCESO', hora_inicio = CURRENT_TIMESTAMP
             WHERE id = $2 RETURNING *`,
            [mecanicoId, turno.id]
        );

        await client.query(`UPDATE mecanicos SET estado_trabajo = 'OCUPADO' WHERE id = $1`, [mecanicoId]);

        await client.query('COMMIT');
        return { asignado: true, turno: turnoRows[0], mecanico };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function intentarAsignarDisponibles() {
    const { rows: libres } = await pool.query(
        `SELECT id FROM mecanicos WHERE estado_asistencia = 'ACTIVO' AND estado_trabajo = 'DISPONIBLE'`
    );

    const asignados = [];
    for (const m of libres) {
        const resultado = await asignarSiguienteTurno(m.id);
        if (resultado.asignado) asignados.push(resultado);
    }
    return asignados;
}

module.exports = { asignarSiguienteTurno, intentarAsignarDisponibles };
