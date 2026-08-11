# Cloudflare Worker de citas

## Webhook de WhatsApp

WhatsApp Cloud API usa `/whatsapp-webhook`; Telegram continúa usando `/telegram-webhook`.
Configura estos valores como secretos del Worker, nunca en `wrangler.jsonc`:

```powershell
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_ACCESS_TOKEN_NEW
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put META_APP_SECRET
```

En la configuración de Meta usa:

- **Callback URL:** `https://TU-WORKER.workers.dev/whatsapp-webhook`
- **Verify token:** exactamente el valor guardado en `WHATSAPP_VERIFY_TOKEN`

El Worker prioriza `WHATSAPP_ACCESS_TOKEN_NEW` y conserva
`WHATSAPP_ACCESS_TOKEN` como respaldo temporal para instalaciones anteriores.

Después de verificar el endpoint, suscribe el campo `messages`. `META_APP_SECRET`
permite validar la firma `X-Hub-Signature-256` de cada notificación.
`WHATSAPP_GRAPH_API_VERSION` es opcional para cambiar la versión de Graph API sin
modificar código.

El dashboard de `../public/index.html` se publica como Static Assets del mismo Worker. En producción, `/` sirve el calendario, `/health` conserva el diagnóstico, `/api/*` usa D1 y `/telegram-webhook` mantiene el bot.

## API administrativa

Las rutas `/api/appointments`, `/api/settings` y `/api/services` no usan CORS abierto. En desarrollo se aceptan solicitudes dirigidas a `localhost`, `127.0.0.1` o `::1` sin credenciales. El mismo origen del Worker también se acepta; otros orígenes deben aparecer en `ADMIN_ALLOWED_ORIGINS`.

Fuera de esos hosts, el Worker falla cerrado si no existe `ADMIN_API_TOKEN` y exige `Authorization: Bearer <token>` cuando el secreto está configurado. Los orígenes de navegador permitidos se definen como una lista separada por comas en `ADMIN_ALLOWED_ORIGINS`; los orígenes locales se aceptan para que el dashboard local pueda consumir un Worker publicado con autenticación.

`ADMIN_API_TOKEN` debe configurarse como secreto de Cloudflare, nunca en `wrangler.jsonc` ni en archivos versionados. El token Bearer es una protección transitoria para esta demo administrativa; antes de publicar el dashboard para uso general debe reemplazarse o complementarse con autenticación de usuarios, preferiblemente Cloudflare Access.

El dashboard lee una URL opcional definida antes de cargar su script principal:

```js
window.APPOINTMENTS_API_BASE_URL = 'https://worker.example';
```

Sin esa variable usa `http://127.0.0.1:8787` durante desarrollo y su propio origen cuando está publicado en `workers.dev`. No apunta al Express antiguo.

El token se solicita en el navegador y se guarda exclusivamente en `sessionStorage`. No se debe escribir un token real en HTML, JavaScript o configuración versionada. Este mecanismo es solo para la demo; producción debe usar Cloudflare Access o sesiones seguras.

Operaciones administrativas adicionales:

- `POST /api/appointments/:id/cancel` con cuerpo `{}`.
- `POST /api/appointments/:id/reschedule` con `start_at` y `service_id` opcional.

La reprogramación vuelve a validar horario, anticipación, horizonte futuro, servicio y conflictos. D1 conserva el trigger de solapamientos como protección final.

La migración `0004_business_profile_and_booking_policies.sql` agrega preferencias y reglas de reserva sin borrar datos. No debe aplicarse remotamente sin autorización explícita.
