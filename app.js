// El servidor SIEMPRE trabaja en UTC. La conversión a hora de Colombia
// se hace solo al generar informes. Sin esta línea, correr el servidor
// en un computador de Colombia desfasaría todos los cronómetros 5 horas.
process.env.TZ = 'UTC';

require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const pool = require('./db');
const { asignarSiguienteTurno, intentarAsignarDisponibles } = require('./motor');
const { registrar, usuarioDe } = require('./auditoria');

// Zona horaria del taller. La base guarda en UTC; sin esto, un carro que
// entra a las 8 PM quedaría contado como del día siguiente en los informes.
const ZONA = 'America/Bogota';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// PROTECCIÓN DE ESCRITURA (opcional)
// ==========================================
// Sin esto, cualquiera que conozca la dirección del servidor podría crear
// o borrar mecánicos desde un navegador. Las consultas (GET) siguen libres
// porque la TV necesita leerlas sin complicaciones.
//
// Se activa poniendo la variable de entorno API_TOKEN en Render. Si no está
// definida, el sistema funciona igual que antes (sin pedir clave), para no
// romper nada mientras se configura.
const API_TOKEN = process.env.API_TOKEN;

// Consultas que SÍ requieren clave aunque sean de lectura, porque exponen
// información sensible: el historial completo de placas del taller y el
// registro de quién hizo cada cosa. La TV no las necesita.
const LECTURAS_PROTEGIDAS = [
    '/turnos/buscar'   // permite listar todas las placas del taller
    // (las rutas /api/auditoria* se cubren aparte, más abajo)
];

function esLecturaProtegida(ruta) {
    // /turnos/en-espera y /turnos/en-proceso siguen abiertas porque son las
    // que alimentan la TV y la pantalla de clientes de la sala de espera.
    if (ruta.startsWith('/api/auditoria')) return true;
    return LECTURAS_PROTEGIDAS.includes(ruta);
}

app.use((req, res, next) => {
    if (!API_TOKEN) return next();            // protección desactivada
    if (req.path === '/ping') return next();

    const necesitaClave = req.method !== 'GET' || esLecturaProtegida(req.path);
    if (!necesitaClave) return next();

    if (req.headers['x-api-token'] !== API_TOKEN) {
        return res.status(401).json({
            error: 'No autorizado. Esta acción requiere la clave del sistema.'
        });
    }
    next();
});

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
// SESIONES DE TRABAJO (tiempo activo)
// ==========================================
// Cada tramo en que un mecánico está ACTIVO se guarda como una sesión.
// Sumando esas sesiones sale cuántas horas estuvo disponible en el día,
// la semana, el mes o el año.

async function abrirSesion(mecanicoId) {
    // Una sola instrucción: consultar e insertar por separado dejaba una
    // rendija por la que dos peticiones seguidas podían abrir dos sesiones
    // al mismo mecánico y duplicarle las horas en el informe.
    await pool.query(
        `INSERT INTO sesiones_mecanico (mecanico_id, inicio)
         SELECT $1, CURRENT_TIMESTAMP
         WHERE NOT EXISTS (
             SELECT 1 FROM sesiones_mecanico
             WHERE mecanico_id = $1 AND fin IS NULL
         )`,
        [mecanicoId]
    );
}

async function cerrarSesion(mecanicoId) {
    await pool.query(
        `UPDATE sesiones_mecanico SET fin = CURRENT_TIMESTAMP
         WHERE mecanico_id = $1 AND fin IS NULL`,
        [mecanicoId]
    );
}

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
        await abrirSesion(r.rows[0].id);

        await registrar({
            accion: 'CREAR_MECANICO',
            detalle: `Se agregó a ${nombre} a la plantilla`,
            usuario: usuarioDe(req),
            mecanicoId: r.rows[0].id
        });

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
        const previo = await pool.query(
            'SELECT estado_asistencia, estado_trabajo, nombre FROM mecanicos WHERE id = $1', [id]
        );
        if (previo.rows.length === 0) {
            return res.status(404).json({ error: 'Mecánico no encontrado' });
        }
        const estadoAnterior = previo.rows[0].estado_asistencia;

        // Un mecánico que está atendiendo un carro NO puede pasar a Pausa o
        // Inactivo: el vehículo quedaría asignado a alguien que ya no está.
        // Primero hay que liberarlo o cancelar ese turno.
        if (previo.rows[0].estado_trabajo === 'OCUPADO' &&
            estado_asistencia && estado_asistencia !== 'ACTIVO') {
            return res.status(400).json({
                error: `${previo.rows[0].nombre} está atendiendo un vehículo. ` +
                       `Libéralo primero para poder cambiar su estado.`
            });
        }

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

        // Abrimos o cerramos su sesión de trabajo según el estado nuevo
        if (estado_asistencia && estado_asistencia !== estadoAnterior) {
            if (estado_asistencia === 'ACTIVO') {
                await abrirSesion(mecanico.id);
            } else {
                await cerrarSesion(mecanico.id);
            }
        }

        if (estado_asistencia && estado_asistencia !== estadoAnterior) {
            await registrar({
                accion: 'ESTADO_MECANICO',
                detalle: `${mecanico.nombre}: ${estadoAnterior} -> ${estado_asistencia}`,
                usuario: usuarioDe(req),
                mecanicoId: mecanico.id
            });
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

        await registrar({
            accion: 'ELIMINAR_MECANICO',
            detalle: `Se eliminó a ${mecanico.nombre} de la plantilla`,
            usuario: usuarioDe(req),
            mecanicoId: Number(id)
        });

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
                mecanico_preferido_id, nombre_mecanico_preferido,
                hora_llegada, clave_unica } = req.body;

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

        const placaLimpia = String(placa).toUpperCase().trim();

        // ---- PROTECCIÓN 1: misma clave = mismo registro ----
        // Si la tablet reintenta enviar algo que en realidad ya llegó
        // (pasa cuando el servidor tarda en responder), devolvemos el
        // vehículo que ya se creó en vez de crear otro.
        if (clave_unica) {
            const yaExiste = await pool.query(
                'SELECT * FROM turnos WHERE clave_unica = $1', [clave_unica]
            );
            if (yaExiste.rows.length > 0) {
                return res.json({
                    turno: yaExiste.rows[0],
                    duplicado_evitado: true,
                    asignado_de_inmediato: yaExiste.rows[0].estado_turno === 'EN_PROCESO',
                    asignaciones: []
                });
            }
        }

        // ---- PROTECCIÓN 2: un carro no puede estar dos veces en el taller ----
        const yaEnTaller = await pool.query(
            `SELECT id, estado_turno FROM turnos
             WHERE placa = $1 AND estado_turno IN ('EN_ESPERA', 'EN_PROCESO')
             LIMIT 1`,
            [placaLimpia]
        );
        if (yaEnTaller.rows.length > 0) {
            const estado = yaEnTaller.rows[0].estado_turno === 'EN_PROCESO'
                ? 'ya está siendo atendido'
                : 'ya está en la fila de espera';
            return res.status(409).json({
                error: `${placaLimpia} ${estado}. Si es otro vehículo, revisa la placa.`
            });
        }

        // Si la tablet estuvo sin internet, manda la hora REAL en que llegó
        // el carro, para que la fila respete el orden de llegada de verdad.
        // Se ignora una hora futura o de hace más de 12 horas (dato dudoso).
        let llegada = null;
        if (hora_llegada) {
            const f = new Date(hora_llegada);
            const ahora = Date.now();
            if (!isNaN(f) && f.getTime() <= ahora && (ahora - f.getTime()) < 12 * 3600 * 1000) {
                llegada = f.toISOString();
            }
        }

        const r = await pool.query(
            `INSERT INTO turnos (placa, tipo_servicios, es_vip, mecanico_preferido_id,
                                 nombre_mecanico_preferido, hora_llegada, clave_unica)
             VALUES ($1, $2::text[], $3, $4, $5,
                     COALESCE($6::timestamp, CURRENT_TIMESTAMP), $7)
             RETURNING *`,
            [placaLimpia, servicios, !!es_vip,
             es_vip ? mecanico_preferido_id : null,
             es_vip ? nombre_mecanico_preferido : null,
             llegada, clave_unica || null]
        );
        const turno = r.rows[0];

        await registrar({
            accion: 'INGRESO',
            detalle: `Ingresó ${placa} (${servicios.join(', ')})${es_vip ? ' — PREFERENCIAL' : ''}`,
            usuario: usuarioDe(req),
            placa,
            turnoId: turno.id,
            datos: { servicios, es_vip: !!es_vip, mecanico_preferido_id: mecanico_preferido_id || null }
        });

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

    // Un turno solo se puede entregar si de verdad se está atendiendo.
    // Sin esta validación se podía "finalizar" algo ya entregado o
    // cancelado, lo que ensuciaba las horas y los informes.
    const estado = actual.rows[0].estado_turno;
    if (estado !== 'EN_PROCESO') {
        const explicacion = estado === 'FINALIZADO' ? 'ya fue entregado'
                          : estado === 'CANCELADO'  ? 'fue cancelado'
                          : 'todavía no ha sido asignado a ningún mecánico';
        return { error: `Este vehículo ${explicacion}.` };
    }

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
        if (resultado.error) return res.status(400).json({ error: resultado.error });
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
        if (resultado.error) return res.status(400).json({ error: resultado.error });

        await registrar({
            accion: 'LIBERAR',
            detalle: `Se entregó ${resultado.turno.placa}`,
            usuario: usuarioDe(req),
            placa: resultado.turno.placa,
            mecanicoId: Number(req.params.id),
            turnoId: resultado.turno.id
        });

        res.json({ mensaje: 'Turno finalizado', ...resultado });
    } catch (err) { next(err); }
});


// ==========================================
// CORREGIR Y CANCELAR TURNOS
// ==========================================
// Si el turnero digita mal una placa, tiene que poder arreglarlo. Sin esto,
// el carro equivocado se queda en la fila para siempre.

// Corregir la placa o los servicios de un turno que aún no ha empezado
app.put('/turnos/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { placa, tipo_servicios } = req.body;

        const actual = await pool.query('SELECT * FROM turnos WHERE id = $1', [id]);
        if (actual.rows.length === 0) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }
        const turno = actual.rows[0];

        if (turno.estado_turno !== 'EN_ESPERA') {
            return res.status(400).json({
                error: 'Solo se pueden corregir vehículos que todavía están en espera.'
            });
        }

        let servicios = null;
        if (Array.isArray(tipo_servicios) && tipo_servicios.length > 0) {
            servicios = [...new Set(tipo_servicios.map(x => String(x).toLowerCase().trim()))];
            const VALIDOS = ['frenos', 'suspension', 'aceite', 'revision', 'alineacion'];
            const malos = servicios.filter(x => !VALIDOS.includes(x));
            if (malos.length > 0) {
                return res.status(400).json({ error: `Servicio no reconocido: ${malos.join(', ')}` });
            }
        }

        const r = await pool.query(
            `UPDATE turnos
             SET placa = COALESCE($1, placa),
                 tipo_servicios = COALESCE($2::text[], tipo_servicios)
             WHERE id = $3 RETURNING *`,
            [placa ? String(placa).toUpperCase().trim() : null, servicios, id]
        );

        await registrar({
            accion: 'CORREGIR',
            detalle: `Turno corregido: ${turno.placa} -> ${r.rows[0].placa}`,
            usuario: usuarioDe(req),
            placa: r.rows[0].placa,
            turnoId: turno.id,
            datos: { antes: { placa: turno.placa, servicios: turno.tipo_servicios },
                     despues: { placa: r.rows[0].placa, servicios: r.rows[0].tipo_servicios } }
        });

        // Los servicios pueden haber cambiado: quizá ahora sí hay quien lo atienda
        const asignaciones = await intentarAsignarDisponibles();
        asignaciones.forEach(avisarNuevaAsignacion);
        avisarCambio();

        res.json({ turno: r.rows[0] });
    } catch (err) { next(err); }
});

// Cancelar un turno. No se borra: queda marcado como CANCELADO para que
// el historial siga siendo confiable y se pueda auditar después.
app.put('/turnos/:id/cancelar', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { motivo } = req.body;

        const actual = await pool.query('SELECT * FROM turnos WHERE id = $1', [id]);
        if (actual.rows.length === 0) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }
        const turno = actual.rows[0];

        if (turno.estado_turno === 'FINALIZADO') {
            return res.status(400).json({ error: 'Este vehículo ya fue entregado, no se puede cancelar.' });
        }
        if (turno.estado_turno === 'CANCELADO') {
            return res.status(400).json({ error: 'Este vehículo ya estaba cancelado.' });
        }

        const r = await pool.query(
            `UPDATE turnos
             SET estado_turno = 'CANCELADO',
                 hora_cancelacion = CURRENT_TIMESTAMP,
                 motivo_cancelacion = $1
             WHERE id = $2 RETURNING *`,
            [motivo || 'Sin motivo registrado', id]
        );

        // Si ya lo estaba atendiendo alguien, ese mecánico queda libre
        let siguiente = { asignado: false };
        if (turno.mecanico_id && turno.estado_turno === 'EN_PROCESO') {
            await pool.query(
                `UPDATE mecanicos SET estado_trabajo = 'DISPONIBLE',
                                      disponible_desde = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [turno.mecanico_id]
            );
            siguiente = await asignarSiguienteTurno(turno.mecanico_id);
            avisarNuevaAsignacion(siguiente);
        }

        await registrar({
            accion: 'CANCELAR',
            detalle: `Turno cancelado. Motivo: ${motivo || 'no indicado'}`,
            usuario: usuarioDe(req),
            placa: turno.placa,
            mecanicoId: turno.mecanico_id,
            turnoId: turno.id
        });

        avisarCambio();
        res.json({ turno: r.rows[0], siguiente_turno: siguiente });
    } catch (err) { next(err); }
});

// Consultar el registro de acciones (para la gerencia)
app.get('/api/auditoria', async (req, res, next) => {
    try {
        const limite = Math.min(parseInt(req.query.limite) || 100, 500);
        const { placa, accion } = req.query;

        const condiciones = [];
        const valores = [];
        let i = 1;
        if (placa) { condiciones.push(`a.placa ILIKE $${i++}`); valores.push(`%${placa}%`); }
        if (accion) { condiciones.push(`a.accion = $${i++}`); valores.push(accion); }

        const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
        valores.push(limite);

        // Traemos también el nombre del mecánico, para no tener que mostrar
        // un número de identificación en pantalla.
        const r = await pool.query(
            `SELECT a.*, m.nombre AS mecanico_nombre
             FROM auditoria a
             LEFT JOIN mecanicos m ON m.id = a.mecanico_id
             ${where}
             ORDER BY a.fecha DESC LIMIT $${i}`,
            valores
        );
        res.json(r.rows);
    } catch (err) { next(err); }
});

// Lista de acciones existentes, para poblar el filtro en la app
app.get('/api/auditoria/acciones', async (req, res, next) => {
    try {
        const r = await pool.query(
            'SELECT DISTINCT accion FROM auditoria ORDER BY accion'
        );
        res.json(r.rows.map(f => f.accion));
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

        // Todas las fechas se comparan en HORA DE COLOMBIA, no en UTC.
        // Sin esta conversión, los carros que entran después de las 7 PM
        // aparecían contados en el día siguiente.
        const fechaLocal = `(hora_llegada AT TIME ZONE 'UTC' AT TIME ZONE '${ZONA}')`;
        const hoyLocal = `(CURRENT_TIMESTAMP AT TIME ZONE '${ZONA}')::date`;

        if (filtroTiempo === 'hoy') {
            query += ` AND ${fechaLocal}::date = ${hoyLocal}`;
        } else if (filtroTiempo === 'semana') {
            query += ` AND ${fechaLocal}::date >= date_trunc('week', ${hoyLocal})::date`;
        } else if (filtroTiempo === 'mes') {
            query += ` AND ${fechaLocal}::date >= date_trunc('month', ${hoyLocal})::date`;
        } else if (filtroTiempo === 'ano') {
            query += ` AND ${fechaLocal}::date >= date_trunc('year', ${hoyLocal})::date`;
        } else if (filtroTiempo === 'especifica' && fechaEspecifica) {
            query += ` AND ${fechaLocal}::date = $${i++}::date`;
            values.push(fechaEspecifica);
        }

        // Los turnos cancelados nunca cuentan en los informes
        query += ` AND estado_turno <> 'CANCELADO'`;

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


// Tiempo que cada mecánico estuvo ACTIVO en el periodo consultado.
// Suma solo la parte de cada sesión que cae dentro del rango: si alguien
// entró a las 10 PM y salió a las 6 AM, el informe de "hoy" cuenta solo
// las horas que corresponden a hoy, no la sesión completa.
app.get('/api/informes/tiempo-activo', async (req, res, next) => {
    try {
        const { filtroTiempo, fechaEspecifica } = req.query;

        // El rango se calcula en hora de Colombia y luego se lleva a UTC,
        // que es como la base guarda las fechas.
        let desde, hasta;
        const inicioDeHoy = `date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE '${ZONA}')`;

        if (filtroTiempo === 'hoy') {
            desde = inicioDeHoy;
            hasta = `(${inicioDeHoy} + interval '1 day')`;
        } else if (filtroTiempo === 'semana') {
            desde = `date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE '${ZONA}')`;
            hasta = `(${desde} + interval '1 week')`;
        } else if (filtroTiempo === 'mes') {
            desde = `date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE '${ZONA}')`;
            hasta = `(${desde} + interval '1 month')`;
        } else if (filtroTiempo === 'ano') {
            desde = `date_trunc('year', CURRENT_TIMESTAMP AT TIME ZONE '${ZONA}')`;
            hasta = `(${desde} + interval '1 year')`;
        } else if (filtroTiempo === 'especifica' && fechaEspecifica) {
            desde = `$1::date`;
            hasta = `($1::date + interval '1 day')`;
        } else {
            // 'siempre': desde el primer registro hasta ahora
            desde = `'1970-01-01'::timestamp`;
            hasta = `(CURRENT_TIMESTAMP AT TIME ZONE '${ZONA}')`;
        }

        // Pasamos el rango de hora local a UTC para comparar con la base
        const desdeUTC = `((${desde}) AT TIME ZONE '${ZONA}' AT TIME ZONE 'UTC')`;
        const hastaUTC = `((${hasta}) AT TIME ZONE '${ZONA}' AT TIME ZONE 'UTC')`;

        const valores = [];
        if (filtroTiempo === 'especifica' && fechaEspecifica) valores.push(fechaEspecifica);

        const r = await pool.query(`
            SELECT m.id,
                   m.nombre,
                   m.estado_asistencia,
                   COALESCE(SUM(
                       -- OJO: en PostgreSQL, GREATEST y LEAST IGNORAN los
                       -- valores nulos en vez de devolver nulo. Sin este
                       -- CASE, un mecánico sin sesiones registradas hacía
                       -- que se calculara desde 1970 hasta hoy (56 años).
                       CASE WHEN s.id IS NULL THEN 0
                            ELSE GREATEST(0, EXTRACT(EPOCH FROM (
                                     LEAST(COALESCE(s.fin, CURRENT_TIMESTAMP), ${hastaUTC})
                                   - GREATEST(s.inicio, ${desdeUTC})
                                 )))
                       END
                   ), 0) AS segundos_activo,
                   COUNT(s.id) FILTER (WHERE s.id IS NOT NULL) AS tramos
            FROM mecanicos m
            LEFT JOIN sesiones_mecanico s
                   ON s.mecanico_id = m.id
                  AND s.inicio < ${hastaUTC}
                  AND COALESCE(s.fin, CURRENT_TIMESTAMP) > ${desdeUTC}
            GROUP BY m.id, m.nombre, m.estado_asistencia
            ORDER BY segundos_activo DESC, m.nombre
        `, valores);

        const mecanicos = r.rows.map(f => {
            const seg = Math.max(0, Math.round(Number(f.segundos_activo)));
            return {
                id: f.id,
                nombre: f.nombre,
                estado_asistencia: f.estado_asistencia,
                segundos_activo: seg,
                horas: Math.floor(seg / 3600),
                minutos: Math.floor((seg % 3600) / 60),
                tramos: Number(f.tramos),
                en_turno_ahora: f.estado_asistencia === 'ACTIVO'
            };
        });

        const totalSegundos = mecanicos.reduce((a, m) => a + m.segundos_activo, 0);

        res.json({
            mecanicos,
            total_segundos: totalSegundos,
            total_horas: Math.floor(totalSegundos / 3600),
            total_minutos: Math.floor((totalSegundos % 3600) / 60)
        });
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

// Ruta no encontrada
app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// Manejo centralizado de errores.
// El detalle técnico se escribe en los logs de Render (donde solo tú lo ves),
// nunca se le devuelve al cliente: podría revelar nombres de tablas o parte
// de las consultas, que es información útil para alguien malintencionado.
app.use((err, req, res, next) => {
    console.error(`❌ Error en ${req.method} ${req.path}:`, err.stack);
    res.status(500).json({
        error: 'Ocurrió un error en el servidor. Intenta de nuevo en un momento.'
    });
});

// Render asigna el puerto por variable de entorno — si lo dejas fijo en 3000, no arranca
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Frenos Pala corriendo en el puerto ${PORT}`);
});
