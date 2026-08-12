# Asistente de citas y gestión de negocio

Asistente serverless desplegado en Cloudflare Workers. Recibe mensajes mediante la API oficial de WhatsApp Cloud de Meta y Telegram, usa Gemini para la conversación y administra citas, servicios, clientes, gastos, pagos y documentos de conocimiento.

El servidor local de calendario y su base `citas.db` se conservan para compatibilidad. Ya no existe ningún cliente local de WhatsApp, vinculación por QR ni puente basado en WhatsApp Web.

## Arquitectura

```text
WhatsApp Cloud API -> /whatsapp-webhook --+
Telegram Bot API  -> /telegram-webhook ---+-> Gemini + herramientas -> D1
                                             |                    +-> KV
                                             +-> flujos de gastos +-> R2

Navegador -> Static Assets -> public/index.html -> /api/* -> D1
```

- `cloudflare-worker/src/routes/whatsapp.js`: verificación y webhook oficial de Meta.
- `cloudflare-worker/src/integrations/whatsapp.js`: envío mediante Graph API.
- `cloudflare-worker/src/routes/telegram.js`: webhook de Telegram.
- `cloudflare-worker/src/ai/`: prompt, herramientas y ejecución de Gemini.
- `cloudflare-worker/src/repositories/`: acceso a D1.
- `cloudflare-worker/src/conversation/`: historial temporal en KV.
- `public/index.html`: dashboard administrativo servido como Static Asset.

## Desarrollo

```bash
cd cloudflare-worker
npm install
npm run dev
```

El dashboard se sirve en `/`, el diagnóstico en `GET /health` y las rutas administrativas bajo `/api/*`.

Para levantar el calendario local existente:

```bash
npm install
npm start
```

Este proceso abre `http://localhost:3000` y conserva sus datos en `citas.db`; no se conecta a WhatsApp. Las citas recibidas por la API oficial de Meta se persisten en D1 y se consultan desde el dashboard servido por el Worker.

## Configuración de WhatsApp Cloud API

Guarda los secretos con Wrangler:

```powershell
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_ACCESS_TOKEN_NEW
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put META_APP_SECRET
```

En Meta configura:

- Callback URL: `https://TU-WORKER.workers.dev/whatsapp-webhook`
- Verify token: el valor de `WHATSAPP_VERIFY_TOKEN`
- Campo suscrito: `messages`

`WHATSAPP_GRAPH_API_VERSION` permite cambiar opcionalmente la versión de Graph API. El Worker prioriza `WHATSAPP_ACCESS_TOKEN_NEW` y conserva `WHATSAPP_ACCESS_TOKEN` como compatibilidad temporal con instalaciones anteriores.

## Otros secretos y variables

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADMIN_API_TOKEN
```

Los bindings `DB` (D1), `CONVERSATIONS` (KV), `RECEIPTS` (R2) y `ASSETS` están declarados en `cloudflare-worker/wrangler.jsonc`. No guardes secretos en Git ni en ese archivo; para desarrollo usa `cloudflare-worker/.dev.vars`, que no se versiona.

## Migraciones, pruebas y despliegue

```bash
cd cloudflare-worker

# Base local
npx wrangler d1 migrations apply appointments-db --local

# Verificación
npm test

# Despliegue
npm run deploy
```

Aplicar migraciones o desplegar contra recursos remotos modifica producción y debe hacerse de forma intencional.

## Persistencia

- D1 es la fuente de verdad de citas, clientes, servicios, configuración, gastos, pagos y documentos.
- KV almacena historial temporal, deduplicación y estados pendientes.
- R2 almacena comprobantes.

La API administrativa usa sesiones y aislamiento por empresa. Consulta `cloudflare-worker/README.md` para detalles operativos del webhook y del dashboard.
