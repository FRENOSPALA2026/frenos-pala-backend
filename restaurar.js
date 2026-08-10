// ==========================================
// RESTAURAR UN RESPALDO — Frenos Pala
// ==========================================
// Recupera la base de datos desde uno de los archivos que llegan por correo.
//
//     node restaurar.js frenos-pala-respaldo-2026-08-10.json.gz
//     node restaurar.js respaldo.json           (también acepta sin comprimir)
//
// ⚠️ BORRA TODO lo que haya en la base y lo reemplaza por el contenido del
//    archivo. Pide confirmación escrita antes de hacer nada.
//
// Antes de usarlo, revisa que DATABASE_URL en tu archivo .env apunte a la
// base correcta. Restaurar sobre la base equivocada sería peor que el
// problema que intentas resolver.

process.env.TZ = 'UTC';
require('dotenv').config();

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const pool = require('./db');

const archivo = process.argv[2];

if (!archivo) {
    console.log('\nUso: node restaurar.js <archivo-de-respaldo>\n');
    console.log('Ejemplo:');
    console.log('  node restaurar.js frenos-pala-respaldo-2026-08-10.json.gz\n');
    process.exit(1);
}

if (!fs.existsSync(archivo)) {
    console.log(`\n⛔ No se encuentra el archivo: ${archivo}\n`);
    process.exit(1);
}

function preguntar(texto) {
    const rl = readline.createInterface({
        input: process.stdin, output: process.stdout
    });
    return new Promise(resolver => {
        rl.question(texto, respuesta => { rl.close(); resolver(respuesta); });
    });
}

function leerRespaldo(ruta) {
    const contenido = fs.readFileSync(ruta);
    // Los archivos comprimidos empiezan con estos dos bytes
    const estaComprimido = contenido[0] === 0x1f && contenido[1] === 0x8b;
    const texto = estaComprimido
        ? zlib.gunzipSync(contenido).toString('utf8')
        : contenido.toString('utf8');
    return JSON.parse(texto);
}

/// Arma un INSERT a partir de las columnas que traiga cada fila
async function insertarFilas(client, tabla, filas) {
    if (!filas || filas.length === 0) return 0;

    const columnas = Object.keys(filas[0]);
    const listaColumnas = columnas.map(c => `"${c}"`).join(', ');

    for (const fila of filas) {
        const marcadores = columnas.map((_, i) => `$${i + 1}`).join(', ');
        const valores = columnas.map(c => fila[c]);
        await client.query(
            `INSERT INTO ${tabla} (${listaColumnas}) VALUES (${marcadores})`,
            valores
        );
    }

    // Los identificadores vienen en el respaldo, así que hay que mover el
    // contador de la tabla para que los próximos registros no choquen.
    await client.query(
        `SELECT setval(pg_get_serial_sequence('${tabla}', 'id'),
                COALESCE((SELECT MAX(id) FROM ${tabla}), 1))`
    );

    return filas.length;
}

(async () => {
    console.log('\n' + '═'.repeat(58));
    console.log('  RESTAURAR RESPALDO — Frenos Pala');
    console.log('═'.repeat(58));

    let respaldo;
    try {
        respaldo = leerRespaldo(archivo);
    } catch (err) {
        console.log(`\n⛔ El archivo no se pudo leer: ${err.message}`);
        console.log('   ¿Es el archivo correcto y está completo?\n');
        process.exit(1);
    }

    const r = respaldo.resumen || {};
    console.log(`\n  Archivo:  ${archivo}`);
    console.log(`  Generado: ${respaldo.generado_en || 'desconocido'}`);
    console.log('\n  Contiene:');
    console.log(`    ${r.mecanicos ?? '?'} mecánicos`);
    console.log(`    ${r.turnos ?? '?'} vehículos atendidos`);
    console.log(`    ${r.sesiones ?? '?'} sesiones de trabajo`);
    console.log(`    ${r.auditoria ?? '?'} registros de auditoría`);

    // Le mostramos qué hay AHORA en la base, para que no restaure encima
    // de datos buenos por equivocación.
    try {
        const actual = await pool.query(`
            SELECT (SELECT COUNT(*) FROM mecanicos) AS mecanicos,
                   (SELECT COUNT(*) FROM turnos) AS turnos
        `);
        console.log('\n  ⚠️  En la base de datos actual hay:');
        console.log(`    ${actual.rows[0].mecanicos} mecánicos`);
        console.log(`    ${actual.rows[0].turnos} vehículos`);
        console.log('\n  TODO ESO SE VA A BORRAR y será reemplazado por el archivo.');
    } catch (err) {
        console.log(`\n⛔ No se pudo conectar a la base de datos: ${err.message}`);
        console.log('   Revisa DATABASE_URL en tu archivo .env\n');
        process.exit(1);
    }

    const respuesta = await preguntar('\n  Escribe RESTAURAR para continuar: ');
    if (respuesta.trim() !== 'RESTAURAR') {
        console.log('\n  Cancelado. No se tocó nada.\n');
        process.exit(0);
    }

    const client = await pool.connect();
    try {
        console.log('\n▶ Restaurando...');
        await client.query('BEGIN');

        // El orden importa: primero lo que depende de otras tablas
        await client.query('DELETE FROM auditoria');
        await client.query('DELETE FROM sesiones_mecanico');
        await client.query('DELETE FROM turnos');
        await client.query('DELETE FROM mecanicos');
        console.log('  Base vaciada');

        const d = respaldo.datos || {};
        // Los mecánicos van primero: los turnos los referencian
        console.log(`  Mecánicos:  ${await insertarFilas(client, 'mecanicos', d.mecanicos)}`);
        console.log(`  Turnos:     ${await insertarFilas(client, 'turnos', d.turnos)}`);
        console.log(`  Sesiones:   ${await insertarFilas(client, 'sesiones_mecanico', d.sesiones_mecanico)}`);
        console.log(`  Auditoría:  ${await insertarFilas(client, 'auditoria', d.auditoria)}`);

        await client.query('COMMIT');

        console.log('\n' + '═'.repeat(58));
        console.log('  ✅ Restauración completada');
        console.log('═'.repeat(58));
        console.log('\n  Abre la TV y la app para confirmar que todo esté bien.\n');
    } catch (err) {
        await client.query('ROLLBACK');
        console.log('\n' + '═'.repeat(58));
        console.log(`  ⛔ Falló la restauración: ${err.message}`);
        console.log('═'.repeat(58));
        console.log('\n  La base quedó COMO ESTABA ANTES (no se guardó nada a medias).\n');
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
})();
