# Respaldo automático — Frenos Pala

Copia diaria de la base de datos que llega a tu correo. Se configura una vez y
funciona solo.

**Por qué hace falta:** el plan gratuito de Supabase **no hace respaldos**. Si
un día alguien borra algo por error o el proveedor tiene un problema, sin esto
se pierde todo el historial del taller. Esto es lo que evita pagar los 25
dólares mensuales del plan Pro.

Toda la configuración toma unos 15 minutos.

---

## PASO 1 — Cuenta para enviar correos (5 min)

Usamos **Resend**, que permite enviar correos de forma gratuita.

1. Entra a **https://resend.com** y crea una cuenta (con el correo donde
   quieres recibir los respaldos)
2. Confirma tu correo
3. En el menú, entra a **API Keys** → **Create API Key**
4. Ponle un nombre, por ejemplo `frenos-pala-respaldo`
5. **Copia la clave que aparece.** Empieza por `re_` y solo se muestra una
   vez — si la pierdes, hay que crear otra

⚠️ **Límite importante:** con la cuenta gratuita sin dominio propio, Resend
solo permite enviar correos **a la misma dirección con la que te registraste**.
Para este uso está bien, pero significa que el respaldo debe llegar a ESE
correo. Si quieres que llegue a otro (por ejemplo, el de tu jefa), habría que
verificar un dominio en Resend.

---

## PASO 2 — Configurar el servidor (3 min)

En **Render** → tu servicio → **Environment** → agrega estas tres variables:

| Nombre | Valor |
|---|---|
| `RESEND_API_KEY` | La clave que copiaste (empieza por `re_`) |
| `BACKUP_EMAIL` | Tu correo, el mismo con que te registraste en Resend |
| `BACKUP_TOKEN` | Una clave que tú inventes, larga. Ej: `respaldo-fp-2026-k9x2m7` |

`BACKUP_TOKEN` es para que nadie más pueda descargarse toda tu base de datos
conociendo la dirección del servidor. Invéntala larga y guárdala.

Render reinicia el servicio solo al guardar. Espera a que termine.

---

## PASO 3 — Probar que funciona (2 min)

Abre esta dirección en el navegador, cambiando la clave por la tuya:

```
https://frenos-pala-backend-ik8t.onrender.com/api/respaldo/enviar?token=TU_BACKUP_TOKEN
```

**Debe pasar esto:**
- El navegador muestra algo como `{"ok":true,"destino":"tu@correo.com",...}`
- **Te llega un correo** con el archivo adjunto

Si en cambio ves un error, dice exactamente qué falta (normalmente una
variable mal escrita en Render).

---

## PASO 4 — Programarlo todos los días (5 min)

1. Entra a **https://cron-job.org** y crea una cuenta gratuita
2. Clic en **Create cronjob**
3. Llena así:

| Campo | Valor |
|---|---|
| **Title** | Respaldo Frenos Pala |
| **URL** | `https://frenos-pala-backend-ik8t.onrender.com/api/respaldo/enviar?token=TU_BACKUP_TOKEN` |
| **Schedule** | Every day at `03:00` |

4. Busca la sección de **notificaciones** y activa que te avise **cuando el
   trabajo falle**
5. Guardar

Ese último punto es el que te avisa si el respaldo deja de funcionar. Si algo
sale mal, el servidor responde con error a propósito, cron-job.org lo detecta
y te manda un correo.

**Por qué a las 3 de la mañana:** es cuando menos carros hay, y además esa
llamada mantiene despierto el servidor de Render.

---

## Cómo saber que sigue funcionando

**Todos los días debe llegarte un correo** con el asunto:
```
Respaldo Frenos Pala — 2026-08-10 (1.247 vehículos)
```

El número de vehículos debe ir creciendo. Si un día no llega el correo, o el
número dejó de crecer, algo pasa.

**Recomendación:** crea una carpeta o etiqueta en tu correo para estos
respaldos, y revisa cada dos o tres meses que sigan llegando. Es un minuto y
te da la tranquilidad de saber que la red de seguridad está puesta.

---

## SI ALGÚN DÍA HAY QUE RECUPERAR LOS DATOS

Esto es lo importante: un respaldo que no sabes usar no sirve de nada.

1. Busca en tu correo el respaldo del día que quieres recuperar
2. Descarga el archivo adjunto (`frenos-pala-respaldo-FECHA.json.gz`)
3. Ponlo en la carpeta `frenos-pala-backend` de tu computador
4. Verifica que tu archivo `.env` tenga el `DATABASE_URL` correcto
5. Ejecuta:

```powershell
node restaurar.js frenos-pala-respaldo-2026-08-10.json.gz
```

El programa te muestra qué contiene el archivo y qué hay actualmente en la
base, y **pide que escribas `RESTAURAR`** antes de tocar nada.

Si algo falla a mitad de camino, **la base queda como estaba**: la
restauración es todo o nada, nunca a medias.

⚠️ **Restaurar reemplaza todo.** Lo que haya pasado entre la fecha del
respaldo y hoy se pierde. Por eso el respaldo es diario: como máximo pierdes
un día.

---

## Descargar una copia manualmente

Si quieres una copia en el momento, sin esperar al correo:

```
https://frenos-pala-backend-ik8t.onrender.com/api/respaldo/descargar?token=TU_BACKUP_TOKEN
```

Descarga el archivo sin comprimir. Útil antes de hacer un cambio grande.

---

## Qué se guarda

- **Mecánicos:** todos, con sus habilidades y estados
- **Turnos:** el historial completo de vehículos atendidos
- **Sesiones:** las horas de turno de cada mecánico
- **Auditoría:** los últimos 6 meses (se limita porque crece mucho y no es
  información crítica de operación)

Un año de operación pesa unos 20 MB en texto, que comprimidos quedan en 2 o 3.
Cabe de sobra en un correo.
