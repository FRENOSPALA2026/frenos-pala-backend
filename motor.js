// ==========================================
// MOTOR LÓGICO DE ASIGNACIÓN — Frenos Pala
// ==========================================
// Decide qué turno le toca a un mecánico apenas queda disponible.
//
// REGLA CLAVE (servicios múltiples):
//   Un vehículo puede necesitar varios servicios a la vez (ej. frenos +
//   suspensión). Un mecánico solo puede tomarlo si sabe hacer TODOS.
//   Si sabe solo uno de los dos, el sistema lo salta y busca al siguiente
//   carro que sí pueda atender completo.
//
// ORDEN DE PRIORIDAD:
//   1. Fila oculta VIP  -> ¿hay un cliente de confianza esperando por ÉL?
//   2. Fila de la fosa  -> carros que necesitan revisión y/o alineación
//                          (ocupan las plataformas, infraestructura única)
//   3. Fila general     -> frenos, suspensión y cambio de aceite
//
// Corre en una transacción con bloqueo de fila (FOR UPDATE / SKIP LOCKED)
// para que dos liberaciones simultáneas nunca se roben el mismo turno.

const pool = require('./db');
const { registrar } = require('./auditoria');

// Servicios que se hacen sobre las plataformas (fila aislada)
const SERVICIOS_FOSA = ['revision', 'alineacion'];

// Lista de servicios que sabe hacer un mecánico
function habilidadesDe(mecanico) {
    const skills = [];
    if (mecanico.sabe_frenos) skills.push('frenos');
    if (mecanico.sabe_suspension) skills.push('suspension');
    if (mecanico.sabe_aceite) skills.push('aceite');
    if (mecanico.sabe_revision) skills.push('revision');
    if (mecanico.sabe_alineacion) skills.push('alineacion');
    return skills;
}

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

        const habilidades = habilidadesDe(mecanico);

        if (habilidades.length === 0) {
            await client.query('COMMIT');
            return { asignado: false, motivo: 'El mecánico no tiene habilidades asignadas' };
        }

        let turno = null;

        // ---- 1. FILA OCULTA VIP ----
        // El cliente pidió expresamente a este mecánico, así que va primero.
        //
        // Aun siendo preferencial se exige que sepa hacer TODOS los servicios
        // (<@). Si no, el carro quedaría asignado a alguien que no puede
        // terminarlo, y se atascaría ahí para siempre. Prefiero que espere
        // en la fila oculta hasta que se corrijan sus habilidades.
        let r = await client.query(
            `SELECT * FROM turnos
             WHERE estado_turno = 'EN_ESPERA' AND es_vip = TRUE
               AND mecanico_preferido_id = $1
               AND tipo_servicios <@ $2::text[]
             ORDER BY hora_llegada ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [mecanicoId, habilidades]
        );
        turno = r.rows[0];

        // ---- 2. FILA DE LA FOSA ----
        // Carros que necesitan revisión y/o alineación (usan las plataformas).
        //   &&  pregunta: "¿este carro tiene algún servicio de fosa?"
        //   <@  pregunta: "¿el mecánico sabe hacer TODOS sus servicios?"
        if (!turno) {
            r = await client.query(
                `SELECT * FROM turnos
                 WHERE estado_turno = 'EN_ESPERA' AND es_vip = FALSE
                   AND tipo_servicios && $1::text[]
                   AND tipo_servicios <@ $2::text[]
                 ORDER BY hora_llegada ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
                [SERVICIOS_FOSA, habilidades]
            );
            turno = r.rows[0];
        }

        // ---- 3. FILA GENERAL ----
        // Todo lo que NO toca las plataformas: frenos, suspensión, aceite.
        // Igual que arriba: si el mecánico no sabe hacer todos los servicios
        // del primer carro, el sistema lo salta y busca el siguiente.
        if (!turno) {
            r = await client.query(
                `SELECT * FROM turnos
                 WHERE estado_turno = 'EN_ESPERA' AND es_vip = FALSE
                   AND NOT (tipo_servicios && $1::text[])
                   AND tipo_servicios <@ $2::text[]
                 ORDER BY hora_llegada ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
                [SERVICIOS_FOSA, habilidades]
            );
            turno = r.rows[0];
        }

        if (!turno) {
            await client.query('COMMIT');
            return {
                asignado: false,
                motivo: 'No hay turnos pendientes que este mecánico pueda atender completos'
            };
        }

        const { rows: turnoRows } = await client.query(
            `UPDATE turnos
             SET mecanico_id = $1, estado_turno = 'EN_PROCESO', hora_inicio = CURRENT_TIMESTAMP
             WHERE id = $2 RETURNING *`,
            [mecanicoId, turno.id]
        );

        // Al quedar ocupado ya no está esperando: limpiamos disponible_desde
        await client.query(
            `UPDATE mecanicos SET estado_trabajo = 'OCUPADO', disponible_desde = NULL WHERE id = $1`,
            [mecanicoId]
        );

        await client.query('COMMIT');

        // Dejamos constancia de por qué este carro fue para este mecánico.
        // Es la evidencia que permite responder si alguien reclama.
        const via = turnoRows[0].es_vip ? 'turno preferencial'
                  : (turnoRows[0].tipo_servicios || []).some(x => SERVICIOS_FOSA.includes(x))
                      ? 'fila de plataformas'
                      : 'fila general';
        registrar({
            accion: 'ASIGNAR',
            detalle: `${mecanico.nombre} recibió ${turnoRows[0].placa} por ${via}`,
            usuario: 'sistema',
            placa: turnoRows[0].placa,
            mecanicoId: mecanico.id,
            turnoId: turnoRows[0].id,
            datos: { via, servicios: turnoRows[0].tipo_servicios }
        });

        return { asignado: true, turno: turnoRows[0], mecanico };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function intentarAsignarDisponibles() {
    // Si no hay nadie esperando, no tiene sentido recorrer a todo el personal.
    const hayEspera = await pool.query(
        `SELECT 1 FROM turnos WHERE estado_turno = 'EN_ESPERA' LIMIT 1`
    );
    if (hayEspera.rows.length === 0) return [];

    // ⚖️ EL ORDEN ES LO QUE HACE JUSTO AL SISTEMA.
    //
    // Cuando hay varios mecánicos libres, el carro debe ser para el que
    // lleva MÁS tiempo esperando, no para cualquiera. Sin este ORDER BY,
    // PostgreSQL devuelve los mecánicos en el orden que le convenga (que
    // suele ser estable), así que siempre recibirían trabajo los mismos
    // — exactamente el desequilibrio que este sistema vino a eliminar.
    //
    // NULLS FIRST: si alguien no tiene marca de tiempo (caso raro), se
    // atiende primero en vez de dejarlo al final indefinidamente.
    const { rows: libres } = await pool.query(
        `SELECT id FROM mecanicos
         WHERE estado_asistencia = 'ACTIVO' AND estado_trabajo = 'DISPONIBLE'
         ORDER BY disponible_desde ASC NULLS FIRST, id ASC`
    );

    const asignados = [];
    for (const m of libres) {
        const resultado = await asignarSiguienteTurno(m.id);
        if (resultado.asignado) asignados.push(resultado);
    }
    return asignados;
}

module.exports = { asignarSiguienteTurno, intentarAsignarDisponibles, habilidadesDe, SERVICIOS_FOSA };
