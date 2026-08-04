// ==========================================
// APP DEL TURNERO — Frenos Pala
// ==========================================
// Todo el estado vive en el backend (Postgres). Esta app pide datos frescos
// antes de pintar cada pantalla y le pide a la API que haga los cambios —
// ya no guarda su propia copia en un array de JavaScript.
//
// El timbre + la voz suenan en la TV (tv.js), no aquí.

// Mismo host/puerto desde el que se cargó esta página. Así, sin tocar nada,
// funciona igual si la abres como http://localhost:3000/mobile.html,
// desde la IP del taller en la red local, o desde el dominio ya publicado.
const API_URL = window.location.origin;
const socket = io(API_URL);

const NOMBRE_SERVICIO = { frenos: 'Frenos', suspension: 'Suspensión', revision: 'Revisión', alineacion: 'Alineación' };
const COLOR_SERVICIO = { frenos: '#ef4444', suspension: '#3b82f6', revision: '#f59e0b', alineacion: '#10b981' };

const state = { mecanicos: [] };
let selectedService = 'frenos';
let selectedMechanicForLiberar = null;

// ================= CONTROL DE ROLES (LOGIN) =================
// Nota: esto es solo una conveniencia visual (oculta botones administrativos
// para el turnero). El PIN vive en el navegador, así que no es seguridad de
// verdad — cualquiera que use las rutas de la API directamente podría editar
// mecánicos igual. Si algún día publicas esto fuera de la red del taller,
// conviene mover esta validación al servidor.
let userRole = null;
const PIN_ADMIN = '1234';

document.getElementById('btnRoleTornero').addEventListener('click', () => iniciarApp('tornero'));
document.getElementById('btnRoleAdmin').addEventListener('click', () => {
    const pin = document.getElementById('adminPin').value;
    if (pin === PIN_ADMIN) {
        iniciarApp('admin');
    } else {
        document.getElementById('loginError').style.display = 'block';
        setTimeout(() => document.getElementById('loginError').style.display = 'none', 3000);
    }
});

function iniciarApp(rol) {
    userRole = rol;
    document.getElementById('loginScreen').style.display = 'none';

    document.getElementById('navInformesBtn').style.display = rol === 'admin' ? 'flex' : 'none';
    document.getElementById('btnAñadirMecanico').style.display = rol === 'admin' ? 'block' : 'none';

    cargarMecanicos();
}

// ================= CARGA DE DATOS =================
async function cargarMecanicos() {
    try {
        const res = await fetch(`${API_URL}/mecanicos/todos`);
        state.mecanicos = await res.json();
        renderVipSelect();
        renderMechOcupados();
        renderRoster();
    } catch (err) {
        console.error('No se pudo cargar la lista de mecánicos:', err);
    }
}

socket.on('actualizar_tv', () => { if (userRole) cargarMecanicos(); });

// ================= PESTAÑA 1: REGISTRAR INGRESO =================
document.querySelectorAll('#serviceChips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('#serviceChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        selectedService = chip.dataset.service;
    });
});

document.getElementById('plateInput').addEventListener('input', function () {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

const checkPreferencial = document.getElementById('checkPreferencial');
const selectMecanicoPreferido = document.getElementById('selectMecanicoPreferido');

checkPreferencial.addEventListener('change', (e) => {
    if (e.target.checked) {
        selectMecanicoPreferido.classList.remove('hidden');
        renderVipSelect();
    } else {
        selectMecanicoPreferido.classList.add('hidden');
    }
});

function renderVipSelect() {
    if (checkPreferencial.checked) {
        selectMecanicoPreferido.innerHTML = state.mecanicos
            .filter(m => m.estado_asistencia !== 'INACTIVO')
            .map(m => `<option value="${m.id}">${m.nombre}</option>`)
            .join('');
    }
}

document.getElementById('btnRegistrar').addEventListener('click', async () => {
    const plateInput = document.getElementById('plateInput');
    const placa = plateInput.value.trim();
    const toast = document.getElementById('toastRegistro');

    if (placa.length !== 6) {
        alert('⚠️ La placa debe tener exactamente 6 caracteres (solo letras y números).');
        return;
    }

    let mecanicoPreferidoId = null;
    let nombreMecanicoPreferido = null;

    if (checkPreferencial.checked && selectMecanicoPreferido.value) {
        mecanicoPreferidoId = Number(selectMecanicoPreferido.value);
        nombreMecanicoPreferido = selectMecanicoPreferido.options[selectMecanicoPreferido.selectedIndex].text;

        const mecanicoElegido = state.mecanicos.find(m => m.id === mecanicoPreferidoId);
        const sabeElServicio = mecanicoElegido && mecanicoElegido[`sabe_${selectedService}`];
        if (mecanicoElegido && !sabeElServicio) {
            alert(`⚠️ ${nombreMecanicoPreferido} no realiza el servicio de "${NOMBRE_SERVICIO[selectedService]}". Verifica el servicio o cambia de mecánico.`);
            return;
        }
    }

    const body = {
        placa,
        tipo_servicio: selectedService,
        es_vip: checkPreferencial.checked,
        mecanico_preferido_id: mecanicoPreferidoId,
        nombre_mecanico_preferido: nombreMecanicoPreferido
    };

    try {
        const res = await fetch(`${API_URL}/turnos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        if (!res.ok) {
            mostrarToast(toast, data.error || 'No se pudo registrar el ingreso.', false);
            return;
        }

        mostrarToast(toast, data.asignado_de_inmediato
            ? `${placa} registrado y asignado de inmediato.`
            : `${placa} registrado, entra a la fila de espera.`, true);

        plateInput.value = '';
        checkPreferencial.checked = false;
        selectMecanicoPreferido.classList.add('hidden');
        cargarMecanicos();
    } catch (err) {
        mostrarToast(toast, 'No se pudo conectar con el servidor.', false);
        console.error(err);
    }
});

function mostrarToast(toast, mensaje, ok) {
    toast.textContent = mensaje;
    toast.style.borderColor = ok ? 'var(--green)' : 'var(--red)';
    toast.style.color = ok ? '#bfe8bf' : '#f0b3b3';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ================= PESTAÑA 2: FIN DE TRABAJO =================
function renderMechOcupados() {
    const list = document.getElementById('mechOcupadosList');
    const ocupados = state.mecanicos
        .filter(m => m.estado_trabajo === 'OCUPADO')
        .sort((a, b) => new Date(b.hora_inicio) - new Date(a.hora_inicio));

    if (ocupados.length === 0) {
        list.innerHTML = '<div class="empty-state">Sin mecánicos ocupados.</div>';
        return;
    }

    list.innerHTML = ocupados.map(m => `
        <div class="mech-card ${selectedMechanicForLiberar === m.id ? 'selected' : ''}" data-id="${m.id}">
            <div>
                <div class="mech-name">${m.nombre}</div>
                <div class="mech-plate">${m.placa_actual || ''}</div>
            </div>
            <div class="mech-time">${formatElapsed(m.hora_inicio)}</div>
        </div>
    `).join('');

    list.querySelectorAll('.mech-card').forEach(card => {
        card.addEventListener('click', () => {
            selectedMechanicForLiberar = Number(card.dataset.id);
            document.getElementById('btnLiberar').disabled = false;
            renderMechOcupados();
        });
    });
}

function formatElapsed(start) {
    if (!start) return '--:--';
    const s = Math.floor((Date.now() - new Date(start).getTime()) / 1000);
    if (s < 0) return '00:00';
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
}

document.getElementById('btnLiberar').addEventListener('click', async () => {
    if (!selectedMechanicForLiberar) return;
    const toast = document.getElementById('toastLiberar');

    try {
        const res = await fetch(`${API_URL}/mecanicos/${selectedMechanicForLiberar}/liberar`, { method: 'PUT' });
        const data = await res.json();

        if (!res.ok) {
            mostrarToast(toast, data.error || 'No se pudo liberar al mecánico.', false);
            return;
        }

        mostrarToast(toast, data.siguiente_turno && data.siguiente_turno.asignado
            ? 'Mecánico liberado y asignado al siguiente vehículo.'
            : 'Mecánico liberado, sin vehículos pendientes para su perfil.', true);

        selectedMechanicForLiberar = null;
        document.getElementById('btnLiberar').disabled = true;
        cargarMecanicos();
    } catch (err) {
        mostrarToast(toast, 'No se pudo conectar con el servidor.', false);
        console.error(err);
    }
});

// ================= PESTAÑA 3: PLANTILLA Y CRUD =================
function renderRoster() {
    const list = document.getElementById('rosterList');

    list.innerHTML = state.mecanicos.map(m => {
        const skills = [];
        if (m.sabe_frenos) skills.push('Frenos');
        if (m.sabe_suspension) skills.push('Suspensión');
        if (m.sabe_revision) skills.push('Revisión');
        if (m.sabe_alineacion) skills.push('Alineación');

        const acciones = userRole === 'admin' ? `
            <div class="roster-actions">
                <button class="icon-btn" onclick="abrirModal(${m.id})">✏️</button>
                <button class="icon-btn icon-delete" onclick="eliminarMecanico(${m.id})">🗑️</button>
            </div>` : '';

        return `
        <div class="roster-card">
            <div class="roster-top">
                <div>
                    <div class="mech-name" style="display:flex; justify-content:space-between;">
                        ${m.nombre}
                        ${acciones}
                    </div>
                    <div class="roster-skills">${skills.join(' · ') || 'Sin habilidades asignadas'}</div>
                </div>
            </div>
            <div class="seg" style="margin-top:10px;">
                <button class="on-activo ${m.estado_asistencia === 'ACTIVO' ? 'sel' : ''}" data-id="${m.id}" data-st="ACTIVO">Activo</button>
                <button class="on-pausa ${m.estado_asistencia === 'PAUSA' ? 'sel' : ''}" data-id="${m.id}" data-st="PAUSA">Pausa</button>
                <button class="on-inactivo ${m.estado_asistencia === 'INACTIVO' ? 'sel' : ''}" data-id="${m.id}" data-st="INACTIVO">Inactivo</button>
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.seg button').forEach(btn => {
        btn.addEventListener('click', async () => {
            const mecanico = state.mecanicos.find(m => m.id == btn.dataset.id);
            if (mecanico.estado_trabajo === 'OCUPADO') return;

            await fetch(`${API_URL}/mecanicos/${mecanico.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ estado_asistencia: btn.dataset.st })
            });
            cargarMecanicos();
        });
    });
}

const modal = document.getElementById('modalMecanico');
document.getElementById('btnAñadirMecanico').addEventListener('click', () => abrirModal());
document.getElementById('btnCancelarModal').addEventListener('click', () => modal.classList.add('hidden'));

window.abrirModal = function (id = null) {
    document.getElementById('modalTitle').innerText = id ? 'Editar Mecánico' : 'Añadir Mecánico';
    document.getElementById('modalId').value = id || '';
    document.getElementById('modalName').value = '';
    document.querySelectorAll('.skill-cb').forEach(cb => cb.checked = false);

    if (id) {
        const m = state.mecanicos.find(x => x.id === id);
        document.getElementById('modalName').value = m.nombre;
        ['frenos', 'suspension', 'revision', 'alineacion'].forEach(s => {
            if (m[`sabe_${s}`]) document.querySelector(`.skill-cb[value="${s}"]`).checked = true;
        });
    }
    modal.classList.remove('hidden');
};

document.getElementById('btnGuardarModal').addEventListener('click', async () => {
    const id = document.getElementById('modalId').value;
    const nombre = document.getElementById('modalName').value.trim();
    const skills = Array.from(document.querySelectorAll('.skill-cb:checked')).map(cb => cb.value);

    if (!nombre || skills.length === 0) {
        alert('Ingresa nombre y al menos una habilidad');
        return;
    }

    const body = {
        nombre,
        sabe_frenos: skills.includes('frenos'),
        sabe_suspension: skills.includes('suspension'),
        sabe_revision: skills.includes('revision'),
        sabe_alineacion: skills.includes('alineacion')
    };

    try {
        if (id) {
            await fetch(`${API_URL}/mecanicos/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } else {
            await fetch(`${API_URL}/mecanicos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        }
        modal.classList.add('hidden');
        cargarMecanicos();
    } catch (err) {
        alert('No se pudo guardar el mecánico.');
        console.error(err);
    }
});

window.eliminarMecanico = async function (id) {
    if (!confirm('¿Eliminar a este mecánico?')) return;
    try {
        const res = await fetch(`${API_URL}/mecanicos/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.eliminado === false) alert(data.mensaje);
        cargarMecanicos();
    } catch (err) {
        alert('No se pudo eliminar el mecánico.');
        console.error(err);
    }
};

// ================= PESTAÑA 4: INFORMES =================
let miGrafico = null;
let vistaInformeActual = 'general';

document.getElementById('btnInformeGeneral').addEventListener('click', (e) => cambiarVistaInforme('general', e.target));
document.getElementById('btnInformeMecanicos').addEventListener('click', (e) => cambiarVistaInforme('mecanicos', e.target));
document.getElementById('selectMecanicoInforme').addEventListener('change', renderizarGrafico);

const selectFiltroTiempo = document.getElementById('selectFiltroTiempo');
const inputFechaEspecifica = document.getElementById('inputFechaEspecifica');

selectFiltroTiempo.addEventListener('change', (e) => {
    if (e.target.value === 'especifica') {
        inputFechaEspecifica.classList.remove('hidden');
    } else {
        inputFechaEspecifica.classList.add('hidden');
        renderizarGrafico();
    }
});
inputFechaEspecifica.addEventListener('change', renderizarGrafico);

function cambiarVistaInforme(vista, btn) {
    vistaInformeActual = vista;
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const select = document.getElementById('selectMecanicoInforme');
    if (vista === 'mecanicos') {
        select.classList.remove('hidden');
        select.innerHTML = state.mecanicos.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
    } else {
        select.classList.add('hidden');
    }
    renderizarGrafico();
}

async function renderizarGrafico() {
    if (miGrafico) miGrafico.destroy();
    const ctx = document.getElementById('informeChart').getContext('2d');
    const leyenda = document.getElementById('leyendaInformes');
    const centerText = document.getElementById('chartCenterText');

    const filtroTiempo = selectFiltroTiempo.value;
    const fechaEspecifica = inputFechaEspecifica.value;
    const mecanicoElegido = vistaInformeActual === 'general' ? 'general' : document.getElementById('selectMecanicoInforme').value;

    try {
        const url = `${API_URL}/api/informes?filtroTiempo=${filtroTiempo}&fechaEspecifica=${fechaEspecifica}&mecanicoId=${mecanicoElegido}`;
        const res = await fetch(url);
        const datos = await res.json();

        const total = Object.values(datos).reduce((a, b) => a + b, 0);
        centerText.innerText = total > 0 ? total : '0';

        miGrafico = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: Object.keys(datos).map(k => NOMBRE_SERVICIO[k] || k),
                datasets: [{ data: Object.values(datos), backgroundColor: Object.keys(datos).map(k => COLOR_SERVICIO[k]), borderWidth: 0 }]
            },
            options: { cutout: '75%', plugins: { legend: { display: false } } }
        });

        leyenda.innerHTML = Object.keys(datos).map(k => `
            <div class="legend-item">
                <div class="legend-label"><div class="legend-color" style="background: ${COLOR_SERVICIO[k]}"></div>${NOMBRE_SERVICIO[k] || k}</div>
                <div class="legend-value">${datos[k]}</div>
            </div>`).join('');
    } catch (error) {
        console.error('Error consultando informes:', error);
    }
}

// ================= NAVEGACIÓN =================
document.querySelectorAll('.navbtn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.navbtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
        if (btn.dataset.tab === 'informes') renderizarGrafico();
    });
});

// ================= INSTALAR COMO APP (PWA) =================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* no es crítico si falla */ });
    });
}

// ================= ARRANQUE =================
setInterval(renderMechOcupados, 1000); // solo refresca los cronómetros, sin golpear la API
