// ==========================================
// RESPALDO AUTOMÁTICO — Frenos Pala
// ==========================================
// Saca una copia completa de la base de datos y la manda por correo.
//
// Existe porque el plan gratuito de Supabase NO hace respaldos. Si algún día
// se pierde la base —por un error humano, un borrado accidental o un problema
// del proveedor— sin esto se perdería todo el historial del taller.
//
// La copia se comprime antes de enviarla: un año de operación pesa unos
// 20 MB en texto plano, pero comprimido baja a 2 o 3 MB.

const zlib = require('zlib');
const { promisify } = require('util');
const pool = require('./db');

const comprimir = promisify(zlib.gzip);

/// Saca todas las tablas y las devuelve en un solo objeto
async function generarRespaldo() {
    const [mecanicos, turnos, sesiones, auditoria] = await Promise.all([
        pool.query('SELECT * FROM mecanicos ORDER BY id'),
        pool.query('SELECT * FROM turnos ORDER BY id'),
        pool.query('SELECT * FROM sesiones_mecanico ORDER BY id'),
        // La auditoría puede crecer mucho: guardamos los últimos 6 meses
        pool.query(`SELECT * FROM auditoria
                    WHERE fecha > CURRENT_TIMESTAMP - interval '6 months'
                    ORDER BY id`)
    ]);

    return {
        generado_en: new Date().toISOString(),
        version: 1,
        resumen: {
            mecanicos: mecanicos.rows.length,
            turnos: turnos.rows.length,
            sesiones: sesiones.rows.length,
            auditoria: auditoria.rows.length
        },
        datos: {
            mecanicos: mecanicos.rows,
            turnos: turnos.rows,
            sesiones_mecanico: sesiones.rows,
            auditoria: auditoria.rows
        }
    };
}

/// Envía el respaldo por correo usando Resend
async function enviarPorCorreo() {
    const CLAVE = process.env.RESEND_API_KEY;
    const DESTINO = process.env.BACKUP_EMAIL;

    if (!CLAVE || !DESTINO) {
        throw new Error(
            'Faltan las variables RESEND_API_KEY o BACKUP_EMAIL en Render'
        );
    }

    const respaldo = await generarRespaldo();
    const texto = JSON.stringify(respaldo);
    const comprimido = await comprimir(Buffer.from(texto, 'utf8'));

    const fecha = new Date().toISOString().slice(0, 10);
    const nombreArchivo = `frenos-pala-respaldo-${fecha}.json.gz`;

    const pesoMB = (comprimido.length / 1024 / 1024).toFixed(2);
    const r = respaldo.resumen;

    const cuerpo = `
        <div style="font-family: Arial, sans-serif; max-width: 520px;">
          <div style="background:#1C1D1F; padding:20px; border-bottom:4px solid #F2B705;">
            <h2 style="color:#EDEDE7; margin:0; font-size:20px;">
              FRENOS <span style="color:#F2B705;">PALA</span>
            </h2>
            <p style="color:#9A9992; margin:6px 0 0; font-size:13px;">
              Respaldo automático de la base de datos
            </p>
          </div>

          <div style="padding:20px; color:#1F2124;">
            <p>Copia del <strong>${fecha}</strong>, adjunta a este correo.</p>

            <table style="width:100%; border-collapse:collapse; font-size:14px; margin:16px 0;">
              <tr style="background:#F7F6F2;">
                <td style="padding:8px 10px;">Mecánicos</td>
                <td style="padding:8px 10px; text-align:right;"><strong>${r.mecanicos}</strong></td>
              </tr>
              <tr>
                <td style="padding:8px 10px;">Vehículos atendidos</td>
                <td style="padding:8px 10px; text-align:right;"><strong>${r.turnos}</strong></td>
              </tr>
              <tr style="background:#F7F6F2;">
                <td style="padding:8px 10px;">Sesiones de trabajo</td>
                <td style="padding:8px 10px; text-align:right;"><strong>${r.sesiones}</strong></td>
              </tr>
              <tr>
                <td style="padding:8px 10px;">Registros de auditoría</td>
                <td style="padding:8px 10px; text-align:right;"><strong>${r.auditoria}</strong></td>
              </tr>
              <tr style="background:#F7F6F2;">
                <td style="padding:8px 10px;">Tamaño del archivo</td>
                <td style="padding:8px 10px; text-align:right;"><strong>${pesoMB} MB</strong></td>
              </tr>
            </table>

            <p style="font-size:13px; color:#6B6D70; line-height:1.6;">
              Guarda este correo. Si algún día hay que recuperar la información,
              este archivo tiene todo lo necesario.
              <br><br>
              Para restaurarlo se usa el comando
              <code style="background:#F0EFEA; padding:2px 5px;">node restaurar.js archivo.json.gz</code>
              desde la carpeta del servidor.
            </p>
          </div>
        </div>
    `;

    const respuesta = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CLAVE}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: process.env.BACKUP_FROM || 'Frenos Pala <onboarding@resend.dev>',
            to: [DESTINO],
            subject: `Respaldo Frenos Pala — ${fecha} (${r.turnos} vehículos)`,
            html: cuerpo,
            attachments: [{
                filename: nombreArchivo,
                content: comprimido.toString('base64')
            }]
        })
    });

    if (!respuesta.ok) {
        const detalle = await respuesta.text();
        throw new Error(`El servicio de correo rechazó el envío: ${detalle}`);
    }

    return {
        enviado: true,
        destino: DESTINO,
        archivo: nombreArchivo,
        peso_mb: Number(pesoMB),
        resumen: r
    };
}

module.exports = { generarRespaldo, enviarPorCorreo };
