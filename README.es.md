# Ecohotel Pure — Agente de WhatsApp con IA

Un chatbot de WhatsApp para el **Ecohotel Pure** (San Carlos, Antioquia) que responde preguntas de los clientes, proporciona información sobre alojamientos y precios, y notifica automáticamente al equipo del hotel por correo cuando un huésped está listo para hacer una reserva.

---

## Cómo funciona

```
Huésped (WhatsApp)
      │
      ▼
Meta Cloud API  ──webhook──►  Servidor Express (server.js)
                                      │
                              ┌───────┴────────┐
                              │                │
                         Supabase          Gemini 2.5 Flash
                    (historial de chat)   (respuesta IA + llamadas a herramientas)
                                                │
                                    herramienta escalate_to_human
                                                │
                                           Resend API
                                     (correo al equipo del hotel)
```

1. Un huésped envía un mensaje de WhatsApp.
2. Meta lo entrega al endpoint `/webhook` mediante un POST firmado con HMAC.
3. El servidor deduplica el mensaje contra Supabase (necesario por la naturaleza multi-instancia de Vercel) y verifica los límites de tasa.
4. Los últimos 10 mensajes de la conversación se obtienen y se envían a Gemini como contexto.
5. Gemini responde como el asistente virtual del hotel. Si el huésped proporciona su nombre, fechas de llegada/salida y número de personas, Gemini llama a la función `escalate_to_human`.
6. El servidor intercepta la llamada a la función, envía un correo formateado al equipo del hotel mediante Resend, y devuelve el resultado a Gemini para que genere un mensaje de confirmación natural.
7. La respuesta se envía de vuelta al huésped por WhatsApp.

---

## Funcionalidades

- Conversación natural en español impulsada por Gemini 2.5 Flash
- Conocimiento completo de alojamientos, precios, menú, cómo llegar y normas del hotel
- Escalación automática de reservas — recopila los datos del huésped y notifica al equipo por correo
- Historial de conversación (últimos 10 mensajes) para respuestas contextuales
- Verificación de firma del webhook (HMAC-SHA256) para rechazar solicitudes no autorizadas
- Deduplicación de mensajes mediante Supabase (seguro para entornos serverless/Vercel)
- Límite de tasa por número de teléfono (10 mensajes/minuto)
- Interruptor del bot mediante la variable `BOT_ACTIVE` — desactiva el bot sin detener el servidor
- Desplegable en Vercel sin cambios de configuración adicionales

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| IA | Google Gemini 2.5 Flash (`@google/generative-ai`) |
| Base de datos | Supabase (PostgreSQL) |
| Mensajería | Meta WhatsApp Cloud API v21.0 |
| Correo | Resend |
| Despliegue | Vercel (serverless) |

---

## Requisitos previos

- Una cuenta de [Meta Developer](https://developers.facebook.com/) con una app de WhatsApp Business
- Una cuenta de [Google AI Studio](https://aistudio.google.com/) para la API key de Gemini
- Un proyecto en [Supabase](https://supabase.com/)
- Una cuenta en [Resend](https://resend.com/) (tier gratuito: 3.000 correos/mes)
- Node.js 18 o superior
- [ngrok](https://ngrok.com/) (solo para desarrollo local)

---

## Configuración

### 1. Clonar e instalar dependencias

```bash
git clone <repo-url>
cd wppdemocc
npm install
```

### 2. Configurar las variables de entorno

Crea un archivo `.env` en la raíz del proyecto:

```env
# Meta / WhatsApp
WHATSAPP_ACCESS_TOKEN=<token permanente o temporal del Meta App Dashboard>
WHATSAPP_PHONE_NUMBER_ID=<Phone Number ID del Meta App Dashboard>
WHATSAPP_VERIFY_TOKEN=<cualquier cadena secreta que elijas — se usa una vez para verificar el webhook>
WHATSAPP_APP_SECRET=<App Secret del Meta App Dashboard → Basic Settings>

# Google Gemini
GEMINI_API_KEY=<API key de Google AI Studio>

# Supabase
SUPABASE_URL=<URL del proyecto en el dashboard de Supabase>
SUPABASE_SERVICE_ROLE_KEY=<Service role key — NO la anon key>

# Resend (notificaciones por correo)
RESEND_API_KEY=<API key de resend.com>
ESCALATION_EMAIL=<correo que recibirá las alertas de reserva>

# Opcional
BOT_ACTIVE=true   # cambia a "false" para silenciar el bot sin detener el servidor
PORT=3000
```

### 3. Ejecutar la migración de base de datos

Abre tu proyecto de Supabase, ve al **SQL Editor**, pega el contenido de `supabase/schema.sql` y ejecútalo. Esto crea tres tablas:

| Tabla | Propósito |
|---|---|
| `conversations` | Un registro por número de teléfono único |
| `messages` | Cada mensaje (usuario y asistente) con marcas de tiempo |
| `processed_messages` | Log de deduplicación — las entradas con más de 10 min se eliminan automáticamente |

### 4. Iniciar el servidor localmente

```bash
npm run dev    # reinicio automático al guardar cambios (Node 18+ --watch)
# o
npm start      # modo producción
```

El servidor arranca en `http://localhost:3000`.

### 5. Exponer el servidor con ngrok

```bash
ngrok http 3000
```

Copia la URL HTTPS que te da ngrok (ej. `https://abc123.ngrok-free.app`).

### 6. Registrar el webhook en Meta

1. Ve a tu Meta App Dashboard → WhatsApp → Configuration.
2. Establece el **Callback URL** como `https://abc123.ngrok-free.app/webhook`.
3. Establece el **Verify Token** con el valor que usaste en `WHATSAPP_VERIFY_TOKEN`.
4. Haz clic en **Verify and Save**.
5. En **Webhook fields**, suscríbete a **messages**.

El bot ya está activo. Envía un mensaje de WhatsApp a tu número de prueba.

---

## Despliegue en Vercel

```bash
npm install -g vercel
vercel
```

Agrega todas las variables de entorno de tu archivo `.env` en **Vercel Dashboard → Project → Settings → Environment Variables**.

El archivo `vercel.json` en la raíz del proyecto ya maneja el enrutamiento — no se necesita configuración adicional.

> **Nota:** Vercel congela las funciones serverless inmediatamente después de enviar la respuesta. El servidor está diseñado para esto: espera todo el procesamiento (Gemini + correo) antes de devolver `200` a Meta. Gemini suele responder en 2–5 segundos, muy por debajo del timeout de 20 segundos de Meta.

---

## Flujo de escalación de reservas

Cuando un huésped expresa interés en reservar, el agente recopila cuatro datos (en cualquier orden a lo largo de la conversación):

1. Nombre completo
2. Fecha de llegada
3. Fecha de salida
4. Número de personas

Una vez que tiene los cuatro, Gemini llama a la función `escalate_to_human`. El servidor envía un correo al equipo del hotel con:

- Nombre del huésped
- Número de WhatsApp
- Fechas de llegada y salida
- Número de personas
- Tipo de alojamiento (si fue mencionado)
- Solicitudes especiales (si las hay)

El agente luego le confirma al huésped que el equipo fue notificado y que pronto se pondrán en contacto.

---

## Cambiar el correo de escalación

El correo que recibe las alertas de reserva se controla mediante la variable de entorno `ESCALATION_EMAIL`. Es obligatoria — el servidor se negará a iniciar sin ella.

**Localmente (archivo `.env`):**
```env
ESCALATION_EMAIL=reservas@ecohotelpure.com
```

**En Vercel:**
Ve a **Project → Settings → Environment Variables**, agrega `ESCALATION_EMAIL` con la dirección destino y vuelve a desplegar.

También puedes enviar a varias direcciones configurando una lista de distribución o alias de grupo en tu proveedor de correo y apuntando `ESCALATION_EMAIL` a ese alias.

---

## Referencia de variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Sí | Token de acceso de Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | Sí | ID del número de teléfono de Meta |
| `WHATSAPP_VERIFY_TOKEN` | Sí | Secreto de verificación del webhook |
| `WHATSAPP_APP_SECRET` | Sí | Usado para verificar las firmas del webhook |
| `GEMINI_API_KEY` | Sí | API key de Google AI Studio |
| `SUPABASE_URL` | Sí | URL del proyecto de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí | Service role key de Supabase |
| `RESEND_API_KEY` | Sí | API key de Resend |
| `ESCALATION_EMAIL` | Sí | Destinatario de los correos de reserva — ver [Cambiar el correo de escalación](#cambiar-el-correo-de-escalación) |
| `BOT_ACTIVE` | No | Cambiar a `"false"` para silenciar el bot (por defecto `true`) |
| `PORT` | No | Puerto del servidor (por defecto `3000`) |

---

## Estructura del proyecto

```
wppdemocc/
├── server.js          # Servidor Express principal — enrutamiento, IA y lógica de correo
├── agent_prompt.md    # Prompt de sistema de Gemini — info del hotel, reglas y comportamiento del agente
├── supabase/
│   └── schema.sql     # Esquema de base de datos y triggers
├── vercel.json        # Configuración de despliegue en Vercel
└── package.json
```
