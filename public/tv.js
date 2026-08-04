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
    revision: 'Revisión',
    alineacion: 'Alineación'
};

// ================= AUDIO: TIMBRE Y VOZ =================
function playChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [880, 1320].forEach((f, i) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = f;
            o.connect(g);
            g.connect(ctx.destination);
            g.gain.setValueAtTime(0.001, ctx.currentTime + i * 0.15);
            g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.15 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3);
            o.start(ctx.currentTime + i * 0.15);
            o.stop(ctx.currentTime + i * 0.15 + 0.32);
        });
    } catch (e) {
        // Los navegadores bloquean el audio hasta que alguien haga clic
        // en la pantalla al menos una vez. Ver el aviso de abajo.
    }
}

function announce(nombreMecanico, placa) {
    playChime();
    setTimeout(() => {
        try {
            const texto = `Mecánico ${nombreMecanico}, iniciar trabajo en placa ${placa.split('').join(' ')}`;
            const u = new SpeechSynthesisUtterance(texto);
            u.lang = 'es-CO';
            u.rate = 0.95;
            window.speechSynthesis.speak(u);
        } catch (e) { /* este navegador no soporta voz */ }
    }, 900);
}

// ================= TIEMPO REAL =================
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

        // Primero los ocupados (que es lo que interesa ver), luego los libres
        mecanicos.sort((a, b) => {
            const aOcupado = a.estado_trabajo === 'OCUPADO' ? 0 : 1;
            const bOcupado = b.estado_trabajo === 'OCUPADO' ? 0 : 1;
            return aOcupado - bOcupado;
        });

        lista.innerHTML = '';

        mecanicos.forEach(m => {
            const ocupado = m.estado_trabajo === 'OCUPADO';
            const li = document.createElement('li');
            li.className = `item-card ${ocupado ? 'ocupado' : 'disponible'}`;

            let infoDetalle = '';
            let derechaHtml = '';

            if (ocupado && m.placa_actual) {
                const servicio = NOMBRE_SERVICIO[m.tipo_servicio] || m.tipo_servicio || 'General';
                infoDetalle = `<div class="vehiculo-asignado">🚗 <strong>${m.placa_actual}</strong> (${servicio})</div>`;
                derechaHtml = `
                    <div style="text-align:right; font-family:monospace;">
                        <span class="badge-estado badge-ocupado" style="display:inline-block; margin-bottom:4px;">Ocupado</span><br>
                        <span style="font-size:1.1rem; font-weight:bold; color:#eab308;">⏱️ ${formatearCronometro(m.hora_inicio)}</span>
                    </div>`;
            } else {
                infoDetalle = `<div class="item-sub" style="color:#4ade80; margin-top:4px;">Listo para asignar</div>`;
                derechaHtml = `<span class="badge-estado badge-libre">DISPONIBLE</span>`;
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
        const turnosFosa = turnos.filter(t => t.tipo_servicio === 'revision' || t.tipo_servicio === 'alineacion');
        const turnosGenerales = turnos.filter(t => t.tipo_servicio === 'frenos' || t.tipo_servicio === 'suspension');

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

    const servicio = NOMBRE_SERVICIO[t.tipo_servicio] || t.tipo_servicio;
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
setInterval(actualizarPantalla, 3000);

// Los navegadores no dejan reproducir sonido hasta que el usuario interactúe
// con la página. Este aviso se quita con el primer clic y desbloquea el audio.
document.addEventListener('click', function desbloquear() {
    playChime();
    document.removeEventListener('click', desbloquear);
}, { once: true });