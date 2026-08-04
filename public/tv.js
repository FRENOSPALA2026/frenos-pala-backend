const API_URL = window.location.origin;
const socket = io(API_URL);

// 🔥 NUEVO: Manejo automático de reconexión y encendido
socket.on('connect', () => {
    console.log('🟢 ¡Conectado/Reconectado al servidor!');
    actualizarPantalla();
});

socket.on('actualizar_tv', () => {
    actualizarPantalla();
});

function formatearCronometro(timestamp) {
    if (!timestamp) return '00:00';
    const inicio = new Date(timestamp);
    const ahora = new Date();
    let segundosTotales = Math.floor((ahora - inicio) / 1000);
    if (segundosTotales < 0) segundosTotales = 0;
    const minutos = Math.floor(segundosTotales / 60);
    const segundos = segundosTotales % 60;
    return `${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`;
}

async function cargarMecanicos() {
    try {
        const res = await fetch(`${API_URL}/mecanicos`);
        let mecanicos = await res.json();
        const lista = document.getElementById('lista-mecanicos');
        lista.innerHTML = '';

        mecanicos = mecanicos.filter(m => m.status === 'disponible' || m.status === 'ocupado');

        if (mecanicos.length === 0) {
            lista.innerHTML = '<li style="justify-content:center; color:#94a3b8;">No hay mecánicos en turno</li>';
            return;
        }

        // ==========================================
        // 🔥 ORDENAMIENTO DINÁMICO CORREGIDO Y EXACTO
        // ==========================================
        mecanicos.sort((a, b) => {
            const aEsLibre = a.status === 'disponible' ? 0 : 1;
            const bEsLibre = b.status === 'disponible' ? 0 : 1;
            
            // 1. Los disponibles siempre van primero que los ocupados
            if (aEsLibre !== bEsLibre) {
                return aEsLibre - bEsLibre;
            }
            
            // 2. Si ambos están libres, el que lleva más tiempo esperando va arriba
            if (a.status === 'disponible' && b.status === 'disponible') {
                return (a.activeSince || 0) - (b.activeSince || 0);
            }
            
            // 3. Si ambos están ocupados: El que se acaba de ocupar (más reciente) va arriba,
            //    y el que lleva más tiempo trabajando (más antiguo) va al final de la lista.
            if (a.status === 'ocupado' && b.status === 'ocupado') {
                const tiempoA = a.startTime ? new Date(a.startTime).getTime() : 0;
                const tiempoB = b.startTime ? new Date(b.startTime).getTime() : 0;
                return tiempoB - tiempoA; 
            }
            
            return 0;
        });

        mecanicos.forEach(m => {
            const esLibre = m.status === 'disponible';
            const li = document.createElement('li');
            li.className = `item-card ${esLibre ? 'disponible' : 'ocupado'}`;
            
            let infoDetalle = ''; let derechaHtml = '';

            if (!esLibre && m.plate) {
                const tiempoCronometro = formatearCronometro(m.startTime);
                infoDetalle = `<div class="vehiculo-asignado">🚗 <strong>${m.plate}</strong> (${m.currentService || 'General'})</div>`;
                derechaHtml = `
                    <div style="text-align: right; font-family: monospace;">
                        <span class="badge-estado badge-ocupado" style="display: inline-block; margin-bottom: 4px;">Ocupado</span><br>
                        <span style="font-size: 1.1rem; font-weight: bold; color: #eab308;">⏱️ ${tiempoCronometro}</span>
                    </div>`;
            } else {
                const tiempoDisponible = formatearCronometro(m.activeSince);
                infoDetalle = `<div class="item-sub" style="color: #4ade80; margin-top: 4px;">Listo para asignar</div>`;
                derechaHtml = `
                    <div style="text-align: right; font-family: monospace;">
                        <span class="badge-estado badge-libre" style="display: inline-block; margin-bottom: 4px;">DISPONIBLE</span><br>
                        <span style="font-size: 1.1rem; font-weight: bold; color: #4ade80;">⏱️ ${tiempoDisponible}</span>
                    </div>`;
            }

            li.innerHTML = `<div><div class="item-titulo">${m.name}</div>${infoDetalle}</div>${derechaHtml}`;
            lista.appendChild(li);
        });
    } catch (err) { console.error(err); }
}

async function cargarEnEspera() {
    try {
        const res = await fetch(`${API_URL}/turnos/en-espera`);
        const turnos = await res.json();
        
        const listaEspera = document.getElementById('lista-espera');
        const listaFosa = document.getElementById('lista-proceso'); // Tu cuadro independiente para revisión/alineación
        listaEspera.innerHTML = ''; listaFosa.innerHTML = '';

        // 🔥 AQUÍ SE ARREGLA EL ERROR: Separamos estrictamente qué va para cada lista
        const turnosGenerales = turnos.filter(t => t.service === 'frenos' || t.service === 'suspension');
        const turnosFosa = turnos.filter(t => t.service === 'revision' || t.service === 'alineacion');

        if (turnosGenerales.length === 0) listaEspera.innerHTML = '<li style="justify-content:center; color:#94a3b8;">Sin carros en espera general</li>';
        if (turnosFosa.length === 0) listaFosa.innerHTML = '<li style="justify-content:center; color:#94a3b8;">Sin carros en Revisión / Alineación</li>';

        // CARROS EN COLA GENERAL (Frenos / Suspensión)
        turnosGenerales.forEach(t => {
            const li = document.createElement('li'); 
            li.className = 'item-card';
            
            let textoPreferencial = t.preferidoNombre ? `<span style="color: #fbbf24; font-weight: 600; margin-left: 6px;">(⭐ Con ${t.preferidoNombre})</span>` : '';

            li.innerHTML = `
                <div>
                    <div class="item-titulo">${t.plate}</div>
                    <div class="item-sub">Servicio: ${t.service} ${textoPreferencial}</div>
                </div>
                <div style="font-size:0.9rem; color:#38bdf8; text-align:right; font-family:monospace;">
                    Cola <br><span style="font-size: 1.1rem; font-weight: bold;">⏱️ ${formatearCronometro(t.ts)}</span>
                </div>`;
            listaEspera.appendChild(li);
        });

        // CARROS EN LISTA INDEPENDIENTE (Revisión / Alineación)
        turnosFosa.forEach(t => {
            const li = document.createElement('li'); 
            // Le dejamos la clase ocupado que tenías para que se vea diferente (naranja)
            li.className = 'item-card ocupado'; 
            
            let textoPreferencial = t.preferidoNombre ? `<span style="color: #fbbf24; font-weight: 600; margin-left: 6px;">(⭐ Con ${t.preferidoNombre})</span>` : '';

            li.innerHTML = `
                <div>
                    <div class="item-titulo">${t.plate}</div>
                    <div class="item-sub">Servicio: ${t.service} ${textoPreferencial}</div>
                </div>
                <div style="font-size:0.9rem; color:#eab308; text-align:right; font-family:monospace;">
                    Fosa / Rev <br><span style="font-size: 1.1rem; font-weight: bold;">⏱️ ${formatearCronometro(t.ts)}</span>
                </div>`;
            listaFosa.appendChild(li);
        });
    } catch (err) { console.error(err); }
}

function actualizarPantalla() {
    cargarMecanicos();
    cargarEnEspera();
}

actualizarPantalla();
setInterval(actualizarPantalla, 1000);