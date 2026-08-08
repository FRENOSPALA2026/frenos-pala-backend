require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const pool = require('./db');
const { asignarSiguienteTurno, intentarAsignarDisponibles } = require('./motor');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Avisos en tiempo real a la TV y a las tablets conectadas
function avisarCambio() {
    io.emit('actualizar_tv');
}
function avisarNuevaAsignacion(resultado) {
    if (resultado && resultado.asignado) {
        io.emit('nueva_asignacion', {
            mecanico_nombre: resultado.mecanico.nombre,
            placa: resultado.turno.placa
        });
    }
}

io.on('connection', (socket) => {
    console.log('🟢 Dispositivo conectado:', socket.id);
    socket.on('disconnect', () => console.log('🔴 Dispositivo desconectado:', socket.id));
});

// ==========================================
// MECÁNICOS
// ==========================================

// Mecánicos ACTIVOS con su turno actual (para la TV)
app.get('/mecanicos', async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT m.*, t.id AS turno_actual_id, t.placa AS placa_actual,
                   t.tipo_servicios, t.hora_inicio
            FROM mecanicos m
            LEFT JOIN turnos t ON m.id = t.mecanico_id AND t.estado_turno = 'EN_PROCESO'
            WHERE m.estado_asistencia = 'ACTIVO'
            ORDER BY m.nombre
        `);
        res.json(r.rows);
    } catch (err) { next(err); }
});

// TODOS los mecánicos, incluidos Pausa/Inactivo (para la pestaña Plantilla)
app.get('/mecanicos/todos', async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT m.*, t.id AS turno_actual_id, t.placa AS placa_actual,
                   t.tipo_servicios, t.hora_inicio
            FROM mecanicos m
            LEFT JOIN turnos t ON m.id = t.mecanico_id AND t.estado_turno = 'EN_PROCESO'
            ORDER BY m.nombre
        `);
        res.json(r.rows);
    } catch (err) { next(err); }
});

app.get('/api/mecanicos/activos', async (req, res, next) => {
    try {
        const r = await pool.query(
            "SELECT id, nombre FROM mecanicos WHERE estado_asistencia = 'ACTIVO' ORDER BY nombre"
        );
        res.json(r.rows);
    } catch (err) { next(err); }
});

app.post('/mecanicos', async (req, res, next) => {
    try {
        const { nombre, sabe_frenos, sabe_suspension, sabe_aceite, sabe_revision, sabe_alineacion } = req.body;
        if (!nombre) return res.status(400).json({ error: 'nombre es obligatorio' });

        const r = await pool.query(
            `INSERT INTO mecanicos (nombre, sabe_frenos, sabe_suspension, sabe_aceite, sabe_revision, sabe_alineacion)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [nombre, !!sabe_frenos, !!sabe_suspension, !!sabe_aceite, !!sabe_revision, !!sabe_alineacion]
        );
        avisarCambio();
        res.json(r.rows[0]);
    } catch (err) { next(err); }
});

app.put('/mecanicos/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { nombre, sabe_frenos, sabe_suspension, sabe_aceite, sabe_revision, sabe_alineacion,
                estado_asistencia, estado_trabajo } = req.body;

        // Miramos cómo estaba ANTES, para saber si de verdad hubo un cambio
        const previo = await pool.query('SELECT estado_asistencia FROM mecanicos WHERE id = $1', [id]);
        const estadoAnterior = previo.rows[0] ? previo.rows[0].estado_asistencia : null;

        const r = await pool.query(
            `UPDATE mecanicos SET
                nombre = COALESCE($1, nombre),
                sabe_frenos = COALESCE($2, sabe_frenos),
                sabe_suspension = COALESCE($3, sabe_suspension),
                sabe_aceite = COALESCE($4, sabe_aceite),
                sabe_revision = COALESCE($5, sabe_revision),
                sabe_alineacion = COALESCE($6, sabe_alineacion),
                estado_asistencia = COALESCE($7, estado_asistencia),
                estado_trabajo = COALESCE($8, estado_trabajo)
             WHERE id = $9 RETURNING *`,
            [nombre, sabe_frenos, sabe_suspension, sabe_aceite, sabe_revision, sabe_alineacion,
             estado_asistencia, estado_trabajo, id]
        );

        if (r.rows.length === 0) return res.status(404).json({ error: 'Mecánico no encontrado' });

        let mecanico = r.rows[0];

        // El cronómetro de espera se reinicia cuando el mecánico ENTRA a turno,
        // es decir cuando pasa de Pausa/Inactivo a Activo. Si ya estaba Activo
        // y el turnero vuelve a tocar "Activo", NO se reinicia: así nadie puede
        // borrar el tiempo de espera de alguien para adelantarlo en la fila.
        const acabaDeEntrarEnTurno =
            mecanico.estado_asistencia === 'ACTIVO' && estadoAnterior !== 'ACTIVO';

        if (mecanico.estado_trabajo === 'DISPONIBLE' &&
            (acabaDeEntrarEnTurno || !mecanico.disponible_desde)) {
            const marcado = await pool.query(
                `UPDATE mecanicos SET disponible_desde = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
                [id]
            );
            mecanico = marcado.rows[0];
        }

        // Si pasa a Pausa o Inactivo, deja de contar
        if (mecanico.estado_asistencia !== 'ACTIVO' && mecanico.disponible_desde) {
            await pool.query(`UPDATE mecanicos SET disponible_desde = NULL WHERE id = $1`, [id]);
            mecanico.disponible_desde = null;
        }

        let asignacion = { asignado: false };

        // Si quedó Activo + Disponible (ej. salió de Pausa), le damos el siguiente turno
        if (mecanico.estado_asistencia === 'ACTIVO' && mecanico.estado_trabajo === 'DISPONIBLE') {
            asignacion = await asignarSiguienteTurno(mecanico.id);
            if (asignacion.asignado) mecanico = asignacion.mecanico;
        }

        avisarCambio();
        avisarNuevaAsignacion(asignacion);
        res.json({ mecanico, asignacion });
    } catch (err) { next(err); }
});

// Elimina un mecánico DE VERDAD (ej. lo despidieron o fue un registro
// de prueba). Sus turnos históricos NO se borran: se conservan la placa,
// el servicio y las horas, pero quedan sin mecánico asociado.
// Es una acción permanente, no se puede deshacer.
app.delete('/mecanicos/:id', async (req, res, next) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;

        await client.query('BEGIN');

        const existe = await client.query('SELECT * FROM mecanicos WHERE id = $1', [id]);
        if (existe.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Mecánico no encontrado' });
        }
        const mecanico = existe.rows[0];

        // Si está atendiendo un carro, ese turno vuelve a la fila de espera
        // para que otro mecánico lo pueda tomar (si no, el carro se perdería).
        const enProceso = await client.query(
            `UPDATE turnos
             SET estado_turno = 'EN_ESPERA', mecanico_id = NULL, hora_inicio = NULL
             WHERE mecanico_id = $1 AND estado_turno = 'EN_PROCESO' RETURNING id`,
            [id]
        );

        // Sus turnos VIP pendientes pasan a la fila general
        await client.query(
            `UPDATE turnos
             SET es_vip = FALSE, mecanico_preferido_id = NULL, nombre_mecanico_preferido = NULL
             WHERE mecanico_preferido_id = $1 AND estado_turno = 'EN_ESPERA'`,
            [id]
        );

        // Soltamos las referencias del historial para poder borrarlo
        await client.query('UPDATE turnos SET mecanico_id = NULL WHERE mecanico_id = $1', [id]);
        await client.query('UPDATE turnos SET mecanico_preferido_id = NULL WHERE mecanico_preferido_id = $1', [id]);

        await client.query('DELETE FROM mecanicos WHERE id = $1', [id]);

        await client.query('COMMIT');

        // Si le quitamos un carro, buscamos quién más lo pueda atender
        if (enProceso.rows.length > 0) {
            const nuevas = await intentarAsignarDisponibles();
            nuevas.forEach(avisarNuevaAsignacion);
        }

        avisarCambio();
        res.json({
            eliminado: true,
            mecanico,
            turnos_devueltos_a_la_fila: enProceso.rows.length
        });
    } catch (err) {
        await client.query('ROLLBACK');
        next(err);
    } finally {
        client.release();
    }
});

// ==========================================
// TURNOS
// ==========================================

app.post('/turnos', async (req, res, next) => {
    try {
        const { placa, tipo_servicios, tipo_servicio, es_vip,
                mecanico_preferido_id, nombre_mecanico_preferido } = req.body;

        // Aceptamos tanto la lista nueva (tipo_servicios) como el formato
        // viejo de un solo servicio (tipo_servicio), por compatibilidad.
        let servicios = tipo_servicios;
        if (!servicios && tipo_servicio) servicios = [tipo_servicio];

        if (!placa || !Array.isArray(servicios) || servicios.length === 0) {
            return res.status(400).json({ error: 'placa y al menos un servicio son obligatorios' });
        }

        // Normalizamos a minúscula y quitamos repetidos
        servicios = [...new Set(servicios.map(s => String(s).toLowerCase().trim()))];

        const VALIDOS = ['frenos', 'suspension', 'aceite', 'revision', 'alineacion'];
        const invalidos = servicios.filter(s => !VALIDOS.includes(s));
        if (invalidos.length > 0) {
            return res.status(400).json({ error: `Servicio no reconocido: ${invalidos.join(', ')}` });
        }

        if (es_vip && !mecanico_preferido_id) {
            return res.status(400).json({ error: 'Un turno VIP necesita mecanico_preferido_id' });
        }

        const r = await pool.query(
            `INSERT INTO turnos (placa, tipo_servicios, es_vip, mecanico_preferido_id, nombre_mecanico_preferido)
             VALUES ($1, $2::text[], $3, $4, $5) RETURNING *`,
            [placa, servicios, !!es_vip,
             es_vip ? mecanico_preferido_id : null,
             es_vip ? nombre_mecanico_preferido : null]
        );
        const turno = r.rows[0];

        // Si hay algún mecánico libre compatible, se le asigna de inmediato
        const asignaciones = await intentarAsignarDisponibles();
        asignaciones.forEach(avisarNuevaAsignacion);
        avisarCambio();

        res.json({
            turno,
            asignado_de_inmediato: asignaciones.some(a => a.turno.id === turno.id),
            asignaciones
        });
    } catch (err) { next(err); }
});

app.get('/turnos/en-espera', async (req, res, next) => {
    try {
        const r = await pool.query(
            "SELECT * FROM turnos WHERE estado_turno = 'EN_ESPERA' ORDER BY hora_llegada ASC"
        );
        res.json(r.rows);
    } catch (err) { next(err); }
});

app.get('/turnos/en-proceso', async (req, res, next) => {
    try {
        const r = await pool.query("SELECT * FROM turnos WHERE estado_turno = 'EN_PROCESO'");
        res.json(r.rows);
    } catch (err) { next(err); }
});

app.get('/turnos/buscar', async (req, res, next) => {
    try {
        const { placa } = req.query;
        if (!placa) return res.status(400).json({ error: 'Debes enviar una placa (?placa=XYZ123)' });

        const r = await pool.query(
            'SELECT * FROM turnos WHERE placa ILIKE $1 ORDER BY hora_llegada DESC',
            [`%${placa}%`]
        );
        if (r.rows.length === 0) {
            return res.status(404).json({ mensaje: 'No se encontró ningún vehículo con esa placa' });
        }
        res.json({ encontrados: r.rows.length, turnos: r.rows });
    } catch (err) { next(err); }
});

// Finaliza un turno, libera al mecánico y le asigna el siguiente carro
async function finalizarTurnoPorId(id) {
    const actual = await pool.query('SELECT * FROM turnos WHERE id = $1', [id]);
    if (actual.rows.length === 0) return null;
    const mecanico_id = actual.rows[0].mecanico_id;

    const finalizado = await pool.query(
        `UPDATE turnos SET estado_turno = 'FINALIZADO', hora_fin = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [id]
    );

    let siguiente = { asignado: false };
    if (mecanico_id) {
        await pool.query(
            `UPDATE mecanicos SET estado_trabajo = 'DISPONIBLE', disponible_desde = CURRENT_TIMESTAMP WHERE id = $1`,
            [mecanico_id]
        );
        siguiente = await asignarSiguienteTurno(mecanico_id);
    }

    avisarCambio();
    avisarNuevaAsignacion(siguiente);
    return { turno: finalizado.rows[0], siguiente_turno: siguiente };
}

app.put('/turnos/:id/finalizar', async (req, res, next) => {
    try {
        const resultado = await finalizarTurnoPorId(req.params.id);
        if (!resultado) return res.status(404).json({ error: 'Turno no encontrado' });
        res.json({ mensaje: 'Turno finalizado', ...resultado });
    } catch (err) { next(err); }
});

// La que usa la app: liberar por MECÁNICO (sin saber el id del turno)
app.put('/mecanicos/:id/liberar', async (req, res, next) => {
    try {
        const activo = await pool.query(
            `SELECT id FROM turnos WHERE mecanico_id = $1 AND estado_turno = 'EN_PROCESO' LIMIT 1`,
            [req.params.id]
        );
        if (activo.rows.length === 0) {
            return res.status(400).json({ error: 'Este mecánico no tiene ningún turno en proceso' });
        }
        const resultado = await finalizarTurnoPorId(activo.rows[0].id);
        res.json({ mensaje: 'Turno finalizado', ...resultado });
    } catch (err) { next(err); }
});

// ==========================================
// INFORMES
// ==========================================
app.get('/api/informes', async (req, res, next) => {
    try {
        const { filtroTiempo, fechaEspecifica, mecanicoId } = req.query;

        // Como un turno puede tener varios servicios, "desarmamos" la lista
        // con unnest: un carro de frenos+suspensión cuenta 1 en cada uno.
        let query = `SELECT s AS tipo_servicio, COUNT(*) AS cantidad
                     FROM turnos, unnest(tipo_servicios) AS s
                     WHERE 1=1`;
        const values = [];
        let i = 1;

        if (filtroTiempo === 'hoy') {
            query += ` AND hora_llegada::date = CURRENT_DATE`;
        } else if (filtroTiempo === 'semana') {
            query += ` AND hora_llegada >= date_trunc('week', CURRENT_DATE)`;
        } else if (filtroTiempo === 'mes') {
            query += ` AND hora_llegada >= date_trunc('month', CURRENT_DATE)`;
        } else if (filtroTiempo === 'ano') {
            query += ` AND hora_llegada >= date_trunc('year', CURRENT_DATE)`;
        } else if (filtroTiempo === 'especifica' && fechaEspecifica) {
            query += ` AND hora_llegada::date = $${i++}`;
            values.push(fechaEspecifica);
        }

        if (mecanicoId && mecanicoId !== 'general') {
            query += ` AND mecanico_id = $${i++}`;
            values.push(mecanicoId);
        }

        query += ` GROUP BY s`;

        const r = await pool.query(query, values);

        const stats = { frenos: 0, suspension: 0, aceite: 0, revision: 0, alineacion: 0 };
        r.rows.forEach(row => {
            if (stats[row.tipo_servicio] !== undefined) stats[row.tipo_servicio] = parseInt(row.cantidad, 10);
        });

        res.json(stats);
    } catch (err) { next(err); }
});

// ==========================================
// MANTENER DESPIERTO EL SERVIDOR (Render gratuito)
// ==========================================
// Render apaga el servicio tras ~15 min sin peticiones. Este endpoint es
// liviano (no toca la base de datos) y sirve para que algo externo lo llame
// cada pocos minutos y el servidor no se duerma.
app.get('/ping', (req, res) => {
    res.json({ ok: true, hora: new Date().toISOString() });
});

// Auto-ping: el servidor se llama a sí mismo cada 10 minutos.
// OJO: esto solo funciona MIENTRAS el servidor esté despierto. Si llega a
// dormirse (por un despliegue, un reinicio o un corte), nada lo despierta
// desde adentro. Por eso conviene además un servicio externo de monitoreo
// (ver README). Se activa poniendo la variable de entorno RENDER_EXTERNAL_URL,
// que Render define automáticamente.
const URL_PROPIA = process.env.RENDER_EXTERNAL_URL;
if (URL_PROPIA) {
    setInterval(() => {
        fetch(`${URL_PROPIA}/ping`)
            .then(() => console.log('💓 Auto-ping enviado'))
            .catch(err => console.log('⚠️ Auto-ping falló:', err.message));
    }, 10 * 60 * 1000); // cada 10 minutos
    console.log(`💓 Auto-ping activado hacia ${URL_PROPIA}`);
}

// Manejo centralizado de errores
app.use((err, req, res, next) => {
    console.error('❌ Error:', err.stack);
    res.status(500).json({ error: 'Error interno del servidor', detalle: err.message });
});

// Render asigna el puerto por variable de entorno — si lo dejas fijo en 3000, no arranca
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Frenos Pala corriendo en el puerto ${PORT}`);
});
