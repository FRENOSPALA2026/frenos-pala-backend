// ==========================================
// DASHBOARD DE TV — Frenos Pala
// ==========================================
// Pantalla de solo lectura. Lee los datos de la API (que a su vez los saca
// de la base de datos) y se refresca al instante cuando el servidor avisa
// que algo cambió.
//
// El timbre y el anuncio de voz suenan AQUÍ, porque esta es la pantalla
// conectada a los parlantes del taller.

const API_URL = window.location.origin;
const socket = io(API_URL);

// Nombres bonitos para mostrar (la base de datos los guarda en minúscula)
const NOMBRE_SERVICIO = {
    frenos: 'Frenos',
    suspension: 'Suspensión',
    aceite: 'Cambio de aceite',
    revision: 'Revisión',
    alineacion: 'Alineación'
};

// Servicios que ocupan las plataformas (van a la columna de la fosa)
const SERVICIOS_FOSA = ['revision', 'alineacion'];

// Un turno puede necesitar varios servicios: los mostramos separados por " + "
function textoServicios(lista) {
    if (!Array.isArray(lista) || lista.length === 0) return 'General';
    return lista.map(s => NOMBRE_SERVICIO[s] || s).join(' + ');
}

// ================= AUDIO: TIMBRE Y VOZ =================
// Los navegadores BLOQUEAN todo sonido hasta que la persona interactúa
// con la página al menos una vez. Por eso mostramos un aviso grande que,
// al tocarlo, desbloquea el audio para el resto del día.

let audioListo = false;
let ctxAudio = null;
let vozEspanol = null;

// Chrome carga las voces de forma asíncrona: hay que esperarlas.
function buscarVoz() {
    const voces = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (!voces || voces.length === 0) return;
    // Preferimos una voz en español; si no hay, usamos la primera disponible.
    vozEspanol = voces.find(v => v.lang && v.lang.toLowerCase().startsWith('es'))
              || voces[0];
    console.log('🔊 Voz seleccionada:', vozEspanol ? vozEspanol.name : 'ninguna');
}
if (window.speechSynthesis) {
    buscarVoz();
    window.speechSynthesis.onvoiceschanged = buscarVoz;
}

function activarAudio() {
    if (audioListo) return;
    try {
        ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
        if (ctxAudio.state === 'suspended') ctxAudio.resume();

        // Un "enunciado vacío" desbloquea la síntesis de voz en Chrome
        if (window.speechSynthesis) {
            const vacio = new SpeechSynthesisUtterance(' ');
            vacio.volume = 0;
            window.speechSynthesis.speak(vacio);
        }

        audioListo = true;
        const aviso = document.getElementById('aviso-audio');
        if (aviso) aviso.style.display = 'none';
        playChime();
        console.log('🔊 Audio activado');
    } catch (e) {
        console.error('No se pudo activar el audio:', e);
    }
}

function playChime() {
    if (!ctxAudio) return;
    try {
        if (ctxAudio.state === 'suspended') ctxAudio.resume();
        [880, 1320].forEach((f, i) => {
            const o = ctxAudio.createOscillator();
            const g = ctxAudio.createGain();
            o.frequency.value = f;
            o.connect(g);
            g.connect(ctxAudio.destination);
            const t = ctxAudio.currentTime + i * 0.15;
            g.gain.setValueAtTime(0.001, t);
            g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
            o.start(t);
            o.stop(t + 0.37);
        });
    } catch (e) {
        console.error('Error con el timbre:', e);
    }
}

function announce(nombreMecanico, placa) {
    if (!audioListo) {
        console.warn('⚠️ Audio no activado: toca la pantalla para habilitarlo.');
        const aviso = document.getElementById('aviso-audio');
        if (aviso) aviso.style.display = 'flex';
        return;
    }

    playChime();

    setTimeout(() => {
        try {
            if (!window.speechSynthesis) return;
            if (!vozEspanol) buscarVoz();

            // Solo el primer nombre y apellido: los nombres completos son
            // muy largos y el anuncio se vuelve eterno con el ruido del taller.
            const partes = String(nombreMecanico).trim().split(/\s+/);
            const nombreCorto = partes.slice(0, 2).join(' ');

            // Deletreamos la placa para que se entienda entre el ruido
            const placaDeletreada = String(placa).split('').join(' ');

            const u = new SpeechSynthesisUtterance(
                `Mecánico ${nombreCorto}, iniciar trabajo en placa ${placaDeletreada}`
            );
            if (vozEspanol) u.voice = vozEspanol;
            u.lang = 'es-ES';
            u.rate = 0.9;
            u.volume = 1;

            u.onerror = (e) => console.error('Error de voz:', e.error);

            // Cancelamos cualquier anuncio pendiente para que no se encimen
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(u);
        } catch (e) {
            console.error('No se pudo anunciar por voz:', e);
        }
    }, 1000);
}

// Cualquier toque o tecla en la pantalla activa el audio
['click', 'touchstart', 'keydown'].forEach(evento => {
    document.addEventListener(evento, activarAudio, { once: false });
});

socket.on('connect', () => console.log('🟢 TV conectada al servidor'));
socket.on('disconnect', () => console.log('🔴 TV desconectada, reintentando...'));

// El servidor avisa cuándo hubo una asignación nueva (para sonar una sola vez)
socket.on('nueva_asignacion', (datos) => {
    if (datos && datos.mecanico_nombre && datos.placa) {
        announce(datos.mecanico_nombre, datos.placa);
    }
});

// El servidor avisa que algo cambió: refrescamos las listas
socket.on('actualizar_tv', () => actualizarPantalla());

// ================= UTILIDADES =================
function formatearCronometro(timestamp) {
    if (!timestamp) return '00:00';
    let segundos = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (segundos < 0 || isNaN(segundos)) segundos = 0;
    const minutos = Math.floor(segundos / 60);
    const resto = segundos % 60;
    return `${String(minutos).padStart(2, '0')}:${String(resto).padStart(2, '0')}`;
}

// ================= COLUMNA 1: MECÁNICOS =================
async function cargarMecanicos() {
    try {
        const res = await fetch(`${API_URL}/mecanicos`);
        const mecanicos = await res.json();
        const lista = document.getElementById('lista-mecanicos');

        if (!Array.isArray(mecanicos) || mecanicos.length === 0) {
            lista.innerHTML = '<li style="justify-content:center; color:#94a3b8;">No hay mecánicos activos en turno</li>';
            return;
        }

        // ORDEN DE LA COLUMNA:
        //   1º Los DISPONIBLES, del que lleva MÁS tiempo esperando al que
        //      lleva menos. Así el siguiente en recibir carro sale de primero
        //      y se ve de un vistazo quién lleva más rato sin trabajo.
        //   2º Los OCUPADOS, del que acaba de empezar al que lleva más rato.
        mecanicos.sort((a, b) => {
            const aLibre = a.estado_trabajo === 'DISPONIBLE';
            const bLibre = b.estado_trabajo === 'DISPONIBLE';

            if (aLibre !== bLibre) return aLibre ? -1 : 1; // libres arriba

            if (aLibre) {
                // Más tiempo esperando primero = fecha más antigua primero
                const ta = a.disponible_desde ? new Date(a.disponible_desde).getTime() : Infinity;
                const tb = b.disponible_desde ? new Date(b.disponible_desde).getTime() : Infinity;
                return ta - tb;
            }

            // Ocupados: menos tiempo trabajando primero = empezó hace poco
            const ia = a.hora_inicio ? new Date(a.hora_inicio).getTime() : 0;
            const ib = b.hora_inicio ? new Date(b.hora_inicio).getTime() : 0;
            return ib - ia;
        });

        lista.innerHTML = '';

        mecanicos.forEach(m => {
            const ocupado = m.estado_trabajo === 'OCUPADO';
            const li = document.createElement('li');
            li.className = `item-card ${ocupado ? 'ocupado' : 'disponible'}`;

            let infoDetalle = '';
            let derechaHtml = '';

            if (ocupado && m.placa_actual) {
                const servicio = textoServicios(m.tipo_servicios);
                infoDetalle = `<div class="vehiculo-asignado">🚗 <strong>${m.placa_actual}</strong> (${servicio})</div>`;
                derechaHtml = `
                    <div style="text-align:right; font-family:monospace;">
                        <span class="badge-estado badge-ocupado" style="display:inline-block; margin-bottom:4px;">Ocupado</span><br>
                        <span style="font-size:1.1rem; font-weight:bold; color:#eab308;">⏱️ ${formatearCronometro(m.hora_inicio)}</span>
                    </div>`;
            } else {
                // Cuánto lleva esperando sin carro
                const espera = m.disponible_desde
                    ? formatearCronometro(m.disponible_desde)
                    : '--:--';
                infoDetalle = `<div class="item-sub" style="color:#4ade80; margin-top:4px;">Listo para asignar</div>`;
                derechaHtml = `
                    <div style="text-align:right; font-family:monospace;">
                        <span class="badge-estado badge-libre" style="display:inline-block; margin-bottom:4px;">Disponible</span><br>
                        <span style="font-size:1.1rem; font-weight:bold; color:#4ade80;">⏳ ${espera}</span>
                    </div>`;
            }

            li.innerHTML = `<div><div class="item-titulo">${m.nombre}</div>${infoDetalle}</div>${derechaHtml}`;
            lista.appendChild(li);
        });
    } catch (err) {
        console.error('Error cargando mecánicos:', err);
    }
}

// ================= COLUMNAS 2 y 3: FILAS DE ESPERA =================
async function cargarEnEspera() {
    try {
        const res = await fetch(`${API_URL}/turnos/en-espera`);
        const turnos = await res.json();

        const listaEspera = document.getElementById('lista-espera');
        const listaFosa = document.getElementById('lista-proceso');

        if (!Array.isArray(turnos)) return;

        // Revisión y alineación van a la fosa; frenos y suspensión a la fila general
        // Si el carro necesita revisión o alineación, ocupa una plataforma:
        // va a la columna de la fosa aunque también necesite otros servicios.
        const usaFosa = t => Array.isArray(t.tipo_servicios)
            && t.tipo_servicios.some(s => SERVICIOS_FOSA.includes(s));

        const turnosFosa = turnos.filter(usaFosa);
        const turnosGenerales = turnos.filter(t => !usaFosa(t));

        listaEspera.innerHTML = turnosGenerales.length === 0
            ? '<li style="justify-content:center; color:#94a3b8;">Sin carros en espera</li>'
            : '';
        listaFosa.innerHTML = turnosFosa.length === 0
            ? '<li style="justify-content:center; color:#94a3b8;">Sin carros para la fosa</li>'
            : '';

        turnosGenerales.forEach(t => {
            listaEspera.appendChild(crearTarjetaTurno(t, 'Cola', '#38bdf8', ''));
        });

        turnosFosa.forEach(t => {
            listaFosa.appendChild(crearTarjetaTurno(t, 'Fosa / Rev', '#eab308', 'ocupado'));
        });
    } catch (err) {
        console.error('Error cargando la fila de espera:', err);
    }
}

function crearTarjetaTurno(t, etiqueta, color, claseExtra) {
    const li = document.createElement('li');
    li.className = `item-card ${claseExtra}`;

    const servicio = textoServicios(t.tipo_servicios);
    const textoVip = t.es_vip && t.nombre_mecanico_preferido
        ? `<span style="color:#fbbf24; font-weight:600; margin-left:6px;">(⭐ Con ${t.nombre_mecanico_preferido})</span>`
        : (t.es_vip ? '<span style="color:#fbbf24; font-weight:600; margin-left:6px;">⭐ VIP</span>' : '');

    li.innerHTML = `
        <div>
            <div class="item-titulo">${t.placa}</div>
            <div class="item-sub">Servicio: ${servicio} ${textoVip}</div>
        </div>
        <div style="font-size:0.9rem; color:${color}; text-align:right; font-family:monospace;">
            ${etiqueta} <br>
            <span style="font-size:1.1rem; font-weight:bold;">⏱️ ${formatearCronometro(t.hora_llegada)}</span>
        </div>`;
    return li;
}

// ================= ARRANQUE =================
function actualizarPantalla() {
    cargarMecanicos();
    cargarEnEspera();
}

actualizarPantalla();
// Refresco de respaldo cada 3 segundos, por si se cae la conexión de socket
setInterval(actualizarPantalla, 1000);
