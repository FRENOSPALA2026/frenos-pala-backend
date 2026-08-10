// ==========================================
// PRUEBAS DEL SISTEMA — Frenos Pala
// ==========================================
// Verifica que las reglas de negocio funcionen de verdad, no solo que el
// código compile. Se ejecuta contra el servidor ya desplegado:
//
//     node pruebas.js
//     node pruebas.js https://frenos-pala-backend-ik8t.onrender.com
//
// ⚠️ CREA DATOS DE PRUEBA (mecánicos y vehículos con placas ZZZ*) y los
//    limpia al terminar. No toca los datos reales del taller.

const BASE = process.argv[2] || process.env.API_URL || 'http://localhost:3000';

// Cada ejecución usa su propia clave. Si se reutilizara la misma, la
// ejecución de hoy encontraría la clave que dejó la de ayer y la prueba
// mediría algo distinto de lo que pretende.
const CLAVE_PRUEBA = `prueba_${Date.now()}`;
const TOKEN = process.env.API_TOKEN || '';

let pasadas = 0, falladas = 0;
const creados = { mecanicos: [], turnos: [] };

function cabeceras() {
    return {
        'Content-Type': 'application/json',
        'x-usuario': 'admin',
        ...(TOKEN ? { 'x-api-token': TOKEN } : {})
    };
}

async function pedir(metodo, ruta, cuerpo) {
    const res = await fetch(`${BASE}${ruta}`, {
        method: metodo,
        headers: cabeceras(),
        body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    let datos = null;
    try { datos = await res.json(); } catch (_) { /* respuesta sin cuerpo */ }
    return { estado: res.status, datos };
}

function verificar(descripcion, condicion, detalle = '') {
    if (condicion) {
        pasadas++;
        console.log(`  ✅ ${descripcion}`);
    } else {
        falladas++;
        console.log(`  ❌ ${descripcion}${detalle ? `\n     ${detalle}` : ''}`);
    }
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
async function pruebaServidorVivo() {
    console.log('\n▶ El servidor responde');
    const r = await pedir('GET', '/ping');
    verificar('Responde al ping', r.estado === 200, `Recibido: ${r.estado}`);
    if (r.estado !== 200) {
        console.log('\n⛔ El servidor no responde. Revisa la dirección y que esté encendido.');
        process.exit(1);
    }
}

async function pruebaZonaHoraria() {
    console.log('\n▶ Zona horaria');
    const r = await pedir('GET', '/api/informes?filtroTiempo=hoy');
    verificar('El informe de hoy responde sin error', r.estado === 200);
    verificar('Devuelve los 5 servicios',
        r.datos && ['frenos', 'suspension', 'aceite', 'revision', 'alineacion']
            .every(s => s in r.datos),
        `Recibido: ${JSON.stringify(r.datos)}`);
}

async function pruebaHabilidades() {
    console.log('\n▶ Asignación por habilidades');

    // Un mecánico que SOLO sabe frenos
    const soloFrenos = await pedir('POST', '/mecanicos', {
        nombre: 'ZZZ Prueba Solo Frenos',
        sabe_frenos: true, sabe_suspension: false,
        sabe_aceite: false, sabe_revision: false, sabe_alineacion: false
    });
    verificar('Se puede crear un mecánico', soloFrenos.estado === 200);
    if (soloFrenos.datos?.id) creados.mecanicos.push(soloFrenos.datos.id);

    // Un carro que necesita frenos Y suspensión: NO debería tomarlo
    const dobleServicio = await pedir('POST', '/turnos', {
        placa: 'ZZZ001',
        tipo_servicios: ['frenos', 'suspension']
    });
    verificar('Se puede registrar un vehículo con varios servicios',
        dobleServicio.estado === 200);
    if (dobleServicio.datos?.turno?.id) creados.turnos.push(dobleServicio.datos.turno.id);

    await esperar(600);
    const enEspera = await pedir('GET', '/turnos/en-espera');
    const sigueEsperando = (enEspera.datos || []).some(t => t.placa === 'ZZZ001');
    verificar('Un carro de frenos+suspensión NO lo toma quien solo sabe frenos',
        sigueEsperando,
        'El motor asignó un trabajo que el mecánico no puede terminar');
}

async function pruebaDuplicados() {
    console.log('\n▶ Protección contra duplicados');

    const primero = await pedir('POST', '/turnos', {
        placa: 'ZZZ002', tipo_servicios: ['frenos'], clave_unica: CLAVE_PRUEBA
    });
    if (primero.datos?.turno?.id) creados.turnos.push(primero.datos.turno.id);
    verificar('Se registra el primer vehículo', primero.estado === 200);

    // Misma clave: debe devolver el mismo, no crear otro
    const repetido = await pedir('POST', '/turnos', {
        placa: 'ZZZ002', tipo_servicios: ['frenos'], clave_unica: CLAVE_PRUEBA
    });
    verificar('La misma clave devuelve el vehículo ya creado, no uno nuevo',
        repetido.estado === 200 && repetido.datos?.duplicado_evitado === true &&
        repetido.datos?.turno?.id === primero.datos?.turno?.id,
        `Recibido: ${JSON.stringify(repetido.datos).slice(0, 160)}`);

    // Misma placa sin clave: debe rechazarse
    const mismaPlaca = await pedir('POST', '/turnos', {
        placa: 'ZZZ002', tipo_servicios: ['aceite']
    });
    // Si por alguna razón sí se creó, hay que recogerlo también
    if (mismaPlaca.datos?.turno?.id) creados.turnos.push(mismaPlaca.datos.turno.id);
    verificar('Una placa que ya está en el taller se rechaza',
        mismaPlaca.estado === 409,
        `Esperado 409, recibido ${mismaPlaca.estado}`);
}

async function pruebaValidaciones() {
    console.log('\n▶ Validaciones de entrada');

    const sinServicio = await pedir('POST', '/turnos', { placa: 'ZZZ003' });
    verificar('Rechaza un vehículo sin servicios', sinServicio.estado === 400);

    const servicioInvalido = await pedir('POST', '/turnos', {
        placa: 'ZZZ004', tipo_servicios: ['pintura']
    });
    verificar('Rechaza un servicio que no existe', servicioInvalido.estado === 400);

    const vipSinMecanico = await pedir('POST', '/turnos', {
        placa: 'ZZZ005', tipo_servicios: ['frenos'], es_vip: true
    });
    verificar('Rechaza un turno preferencial sin mecánico de confianza',
        vipSinMecanico.estado === 400);

    const sinNombre = await pedir('POST', '/mecanicos', { sabe_frenos: true });
    verificar('Rechaza un mecánico sin nombre', sinNombre.estado === 400);
}

async function pruebaCancelacion() {
    console.log('\n▶ Corregir y cancelar');

    const turno = await pedir('POST', '/turnos', {
        placa: 'ZZZ006', tipo_servicios: ['revision']
    });
    const id = turno.datos?.turno?.id;
    if (id) creados.turnos.push(id);
    verificar('Se registra un vehículo para la fosa', turno.estado === 200);

    if (id) {
        // La placa se corrige esté en espera o ya siendo atendida. Esta
        // prueba no puede depender de si había un mecánico libre en ese
        // momento, porque eso cambia según cómo esté el taller.
        const corregido = await pedir('PUT', `/turnos/${id}`, { placa: 'ZZZ007' });
        verificar('Se puede corregir la placa (esté en espera o en atención)',
            corregido.estado === 200 && corregido.datos?.turno?.placa === 'ZZZ007',
            `Recibido: ${JSON.stringify(corregido.datos).slice(0, 180)}`);

        // Una placa que ya está adentro no se puede poner por error
        const otro = await pedir('POST', '/turnos', {
            placa: 'ZZZ009', tipo_servicios: ['frenos']
        });
        if (otro.datos?.turno?.id) {
            creados.turnos.push(otro.datos.turno.id);
            const choque = await pedir('PUT', `/turnos/${otro.datos.turno.id}`,
                { placa: 'ZZZ007' });
            verificar('Corregir a una placa que ya está en el taller se rechaza',
                choque.estado === 409,
                `Esperado 409, recibido ${choque.estado}`);
        }

        const cancelado = await pedir('PUT', `/turnos/${id}/cancelar`, {
            motivo: 'Prueba automatizada'
        });
        verificar('Se puede cancelar un vehículo', cancelado.estado === 200);

        const otraVez = await pedir('PUT', `/turnos/${id}/cancelar`, { motivo: 'x' });
        verificar('No se puede cancelar dos veces el mismo vehículo',
            otraVez.estado === 400);

        const finalizarCancelado = await pedir('PUT', `/turnos/${id}/finalizar`);
        verificar('No se puede entregar un vehículo cancelado',
            finalizarCancelado.estado === 400,
            `Esperado 400, recibido ${finalizarCancelado.estado}`);
    }
}

async function pruebaMecanicoOcupado() {
    console.log('\n▶ Reglas del personal');

    // Barremos los vehículos de prueba que dejaron las secciones anteriores:
    // si quedan carros esperando, el motor se los asigna a nuestro mecánico
    // en cuanto lo liberemos y la prueba mediría otra cosa.
    await limpiarRastrosTurnos();

    const m = await pedir('POST', '/mecanicos', {
        nombre: 'ZZZ Prueba Ocupado', sabe_frenos: true
    });
    const id = m.datos?.id;
    if (id) creados.mecanicos.push(id);

    const t = await pedir('POST', '/turnos', {
        placa: 'ZZZ008', tipo_servicios: ['frenos']
    });
    if (t.datos?.turno?.id) creados.turnos.push(t.datos.turno.id);

    await esperar(600);

    const todos = await pedir('GET', '/mecanicos/todos');
    const nuestro = (todos.datos || []).find(x => x.id === id);

    if (nuestro?.estado_trabajo === 'OCUPADO') {
        const pausar = await pedir('PUT', `/mecanicos/${id}`, {
            estado_asistencia: 'PAUSA'
        });
        verificar('No se puede pausar a un mecánico que está atendiendo',
            pausar.estado === 400,
            `Esperado 400, recibido ${pausar.estado}`);

        const liberar = await pedir('PUT', `/mecanicos/${id}/liberar`);
        verificar('Se puede liberar al mecánico', liberar.estado === 200);

        // Al liberarlo, el motor puede asignarle DE INMEDIATO otro carro que
        // estuviera esperando — eso es lo correcto, no un error. Así que
        // primero lo dejamos sin trabajo, y solo entonces comprobamos que
        // liberar a alguien desocupado sí se rechaza.
        let intentos = 0;
        let ultimoEstado = 200;
        while (ultimoEstado === 200 && intentos < 6) {
            await esperar(400);
            const otro = await pedir('PUT', `/mecanicos/${id}/liberar`);
            ultimoEstado = otro.estado;
            intentos++;
        }

        verificar('Liberar a un mecánico que no está atendiendo se rechaza',
            ultimoEstado === 400,
            `Después de ${intentos} intentos seguía devolviendo ${ultimoEstado}`);
    } else {
        console.log('  ⏭️  Se omite: el vehículo de prueba no llegó a asignarse');
    }
}

async function pruebaTiempoActivo() {
    console.log('\n▶ Informe de horas en turno');

    const r = await pedir('GET', '/api/informes/tiempo-activo?filtroTiempo=hoy');
    verificar('El informe responde', r.estado === 200);

    const mecanicos = r.datos?.mecanicos || [];
    const unDia = 24 * 3600;
    const absurdos = mecanicos.filter(m => m.segundos_activo > unDia);
    verificar('Ningún mecánico supera 24 horas en un solo día',
        absurdos.length === 0,
        absurdos.length > 0
            ? `Cifra imposible en: ${absurdos.map(m => m.nombre).join(', ')}`
            : '');

    verificar('Ningún tiempo es negativo',
        mecanicos.every(m => m.segundos_activo >= 0));
}

// Borra TODO lo que tenga pinta de dato de prueba (placas y nombres que
// empiezan por ZZZ), sin depender de los identificadores que fuimos
// guardando. Así, aunque una prueba falle a mitad de camino, no queda
// basura en la base de datos del taller.
// Cancela solo los VEHÍCULOS de prueba, dejando los mecánicos en pie
async function limpiarRastrosTurnos() {
    const espera = await pedir('GET', '/turnos/en-espera');
    const proceso = await pedir('GET', '/turnos/en-proceso');

    const dePrueba = [...(espera.datos || []), ...(proceso.datos || [])]
        .filter(t => String(t.placa || '').startsWith('ZZZ'));

    for (const t of dePrueba) {
        await pedir('PUT', `/turnos/${t.id}/cancelar`,
            { motivo: 'Limpieza entre pruebas' });
    }
}

async function limpiarRastros(silencioso = false) {
    let turnosBorrados = 0, mecanicosBorrados = 0;

    // Dos pasadas: al eliminar un mecánico ocupado, su vehículo vuelve
    // a la fila, así que hay que volver a recogerlo.
    for (let pasada = 0; pasada < 2; pasada++) {
        const espera = await pedir('GET', '/turnos/en-espera');
        const proceso = await pedir('GET', '/turnos/en-proceso');

        const dePrueba = [...(espera.datos || []), ...(proceso.datos || [])]
            .filter(t => String(t.placa || '').startsWith('ZZZ'));

        for (const t of dePrueba) {
            const r = await pedir('PUT', `/turnos/${t.id}/cancelar`,
                { motivo: 'Limpieza de pruebas automatizadas' });
            if (r.estado === 200) turnosBorrados++;
        }

        if (pasada === 0) {
            const mecanicos = await pedir('GET', '/mecanicos/todos');
            const prueba = (mecanicos.datos || [])
                .filter(m => String(m.nombre || '').startsWith('ZZZ'));

            for (const m of prueba) {
                const r = await pedir('DELETE', `/mecanicos/${m.id}`);
                if (r.estado === 200) mecanicosBorrados++;
            }
        }
    }

    if (!silencioso) {
        console.log(`  🧹 ${turnosBorrados} vehículos y ${mecanicosBorrados} mecánicos de prueba`);
    }
    return { turnosBorrados, mecanicosBorrados };
}

async function limpiar() {
    console.log('\n▶ Limpiando datos de prueba');
    await limpiarRastros();
}

// ==========================================
(async () => {
    console.log('═'.repeat(58));
    console.log('  PRUEBAS DEL SISTEMA — Frenos Pala');
    console.log(`  Servidor: ${BASE}`);
    console.log('═'.repeat(58));

    try {
        await pruebaServidorVivo();

        // Antes de nada, barremos lo que haya quedado de corridas anteriores.
        // Sin esto, un residuo hace fallar pruebas que en realidad están bien.
        const previo = await limpiarRastros(true);
        if (previo.turnosBorrados > 0 || previo.mecanicosBorrados > 0) {
            console.log(`\n  ℹ️  Se limpiaron residuos de una corrida anterior: ` +
                `${previo.turnosBorrados} vehículos, ${previo.mecanicosBorrados} mecánicos`);
        }

        await pruebaZonaHoraria();
        await pruebaHabilidades();
        await pruebaDuplicados();
        await pruebaValidaciones();
        await pruebaCancelacion();
        await pruebaMecanicoOcupado();
        await pruebaTiempoActivo();
    } catch (err) {
        console.error('\n⛔ Las pruebas se interrumpieron:', err.message);
        falladas++;
    } finally {
        try { await limpiar(); } catch (e) {
            console.error('  ⚠️ No se pudo limpiar todo:', e.message);
        }
    }

    console.log('\n' + '═'.repeat(58));
    console.log(`  ${pasadas} correctas · ${falladas} con problemas`);
    console.log('═'.repeat(58));

    if (falladas > 0) {
        console.log('\n⚠️  Revisa lo marcado con ❌ antes de entregar.\n');
        process.exit(1);
    }
    console.log('\n✅ Todo funciona como se espera.\n');
})();
