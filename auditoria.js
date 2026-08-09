// ==========================================
// REGISTRO DE ACCIONES (AUDITORÍA)
// ==========================================
// Este proyecto nació para acabar con la manipulación de turnos. Sin un
// registro, el sistema no puede responder "¿por qué este carro se saltó
// la fila?". Aquí queda constancia de cada acción, con quién la hizo.
//
// El registro nunca debe tumbar la operación: si falla al guardar, se
// anota en consola y el taller sigue trabajando.

const pool = require('./db');

async function registrar({ accion, detalle, usuario, placa, mecanicoId, turnoId, datos }) {
    try {
        await pool.query(
            `INSERT INTO auditoria (accion, detalle, usuario, placa, mecanico_id, turno_id, datos)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                accion,
                detalle || null,
                usuario || 'desconocido',
                placa || null,
                mecanicoId || null,
                turnoId || null,
                datos ? JSON.stringify(datos) : null
            ]
        );
    } catch (err) {
        console.error('⚠️ No se pudo guardar en auditoría:', err.message);
    }
}

/// Saca de la petición quién dice ser el usuario (lo manda la app).
function usuarioDe(req) {
    const u = req.headers['x-usuario'];
    return u === 'admin' || u === 'turnero' ? u : 'desconocido';
}

module.exports = { registrar, usuarioDe };
