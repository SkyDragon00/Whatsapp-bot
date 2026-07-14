# Cloudflare Worker de citas

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
