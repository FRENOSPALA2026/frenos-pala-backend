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

// Si ya tiene historial no se borra (se perdería): se marca Inactivo
app.delete('/mecanicos/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const tiene = await pool.query(
            'SELECT 1 FROM turnos WHERE mecanico_id = $1 OR mecanico_preferido_id = $1 LIMIT 1',
            [id]
        );

        if (tiene.rows.length > 0) {
            await pool.query(`UPDATE mecanicos SET estado_asistencia = 'INACTIVO' WHERE id = $1`, [id]);
            avisarCambio();
            return res.json({
                eliminado: false,
                mensaje: 'Este mecánico ya tiene turnos en su historial, se marcó como Inactivo en vez de borrarlo.'
            });
        }

        const borrado = await pool.query('DELETE FROM mecanicos WHERE id = $1 RETURNING *', [id]);
        if (borrado.rows.length === 0) return res.status(404).json({ error: 'Mecánico no encontrado' });

        avisarCambio();
        res.json({ eliminado: true, mecanico: borrado.rows[0] });
    } catch (err) { next(err); }
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
        await pool.query(`UPDATE mecanicos SET estado_trabajo = 'DISPONIBLE' WHERE id = $1`, [mecanico_id]);
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
