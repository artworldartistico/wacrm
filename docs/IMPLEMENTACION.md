# WACRM — Implementación, containerización y despliegue

Documentación técnica del proceso de puesta en funcionamiento de WACRM, un CRM
autoalojable para WhatsApp construido sobre Next.js y Supabase, desde el repositorio
clonado hasta un entorno productivo con despliegue continuo.

> **Nota de autoría.** El proyecto parte de WACRM, una solución open source de
> terceros. Lo documentado aquí es su implementación, adaptación, configuración,
> containerización, integración, resolución de incidencias, pruebas y despliegue.

**Dossier técnico (versión de lectura):** _(añade aquí el enlace publicado)_

---

## Contenido

1. [Arquitectura](#1-arquitectura)
2. [Requisitos](#2-requisitos)
3. [Entorno local con Docker](#3-entorno-local-con-docker)
4. [Containerización](#4-containerización)
5. [Variables de entorno](#5-variables-de-entorno)
6. [Base de datos y migraciones](#6-base-de-datos-y-migraciones)
7. [Despliegue continuo](#7-despliegue-continuo)
8. [Sincronizar con el repositorio original](#8-sincronizar-con-el-repositorio-original)
9. [WhatsApp y agentes de IA](#9-whatsapp-y-agentes-de-ia)
10. [Incidencias frecuentes](#10-incidencias-frecuentes)
11. [Checklist de validación](#11-checklist-de-validación)
12. [Referencia de comandos](#12-referencia-de-comandos)

---

## 1. Arquitectura

Dos entornos, una sola base de código. El mismo `Dockerfile` produce la imagen de
producción; `docker-compose.yml` sobrescribe el comando para desarrollo.

```
  ENTORNO LOCAL                 REPOSITORIO              PRODUCCIÓN
  Docker Compose                GitHub                   Railway
  npm run dev                   fork + upstream          build por Dockerfile
  localhost:8085     ──push──▶  main            ──auto──▶  dominio público
       │                                                     │
       └──────────────┬──────────────────────────────────────┘
                      ▼
        Supabase  ·  PostgreSQL + Auth + Storage
                      ▼
        WhatsApp Cloud API (Meta)  ·  LLM: OpenAI / Anthropic / Gemini
```

**Stack:** Docker · Docker Compose · Next.js 16 (App Router) · TypeScript · Supabase ·
PostgreSQL · Supabase CLI · Railway · Git/GitHub · WhatsApp Cloud API · Zod · next-intl

---

## 2. Requisitos

| Herramienta | Uso |
|---|---|
| Docker Desktop | Ejecución de la aplicación en contenedor |
| Git | Control de versiones y sincronización con el upstream |
| Supabase CLI | Aplicación de migraciones al proyecto remoto |
| Cuenta de Supabase | PostgreSQL, autenticación y almacenamiento |
| Cuenta de Railway | Build y despliegue de producción |
| App de Meta Business | WhatsApp Cloud API |

No se requiere Node.js instalado en la máquina: todo se ejecuta dentro del contenedor.

---

## 3. Entorno local con Docker

### 3.1 Clonar y verificar el remoto

Con varias cuentas de GitHub configuradas, conviene confirmar el destino de los push
antes del primer commit. Docker no interviene aquí: lo determina el remoto de Git y la
clave SSH en uso.

```bash
git clone <url-del-fork> wacrm
cd wacrm
git remote -v
```

### 3.2 Crear el archivo de entorno

```bash
cp .env.local.example .env
```

Completa los valores siguiendo la [sección 5](#5-variables-de-entorno). En local,
`NEXT_PUBLIC_SITE_URL` debe ser `http://localhost:8085` **con esquema incluido**.

### 3.3 Levantar el contenedor

```bash
docker compose up -d --build
docker compose logs -f wacrm
```

Aplicación disponible en `http://localhost:8085`. El puerto se puede cambiar sin tocar
el Compose: `HOST_PORT=8086 docker compose up -d`.

> El contenedor mapea `8085:3000` porque Next.js escucha internamente en el 3000.
> Un proyecto Next.js no puede servirse con una imagen `nginx:alpine` de sitio
> estático: necesita runtime Node, dependencias y variables de entorno.

---

## 4. Containerización

### 4.1 Dockerfile multi-stage

Tres etapas: dependencias cacheadas, compilación y runtime mínimo con la salida
*standalone* de Next.js ejecutada por un usuario sin privilegios.

```dockerfile
# Etapa 1 — dependencias (caché hasta que cambie package-lock.json)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Etapa 2 — build
# Las NEXT_PUBLIC_* se inlinean en el bundle del cliente: deben entrar
# como build args. Los secretos NO se hornean en la imagen.
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Etapa 3 — runtime mínimo
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S nextjs && adduser -S nextjs -G nextjs
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

**Decisiones:**

- `npm ci` en lugar de `npm install`: instalación reproducible desde el lockfile.
- Salida *standalone*: la imagen final no arrastra `node_modules` completo.
- Usuario `nextjs` sin privilegios en el runtime.
- Solo variables públicas como `ARG`; ningún secreto queda en una capa de la imagen.

### 4.2 Docker Compose (desarrollo)

Compose sobrescribe el `CMD` de producción, monta el código como volumen para hot
reload y preserva `node_modules` del contenedor con un volumen anónimo.

```yaml
services:
  wacrm:
    build:
      context: .
      args:
        NEXT_PUBLIC_SUPABASE_URL: ${NEXT_PUBLIC_SUPABASE_URL}
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ${NEXT_PUBLIC_SUPABASE_ANON_KEY}
        NEXT_PUBLIC_SITE_URL: ${NEXT_PUBLIC_SITE_URL:-}
        NEXT_PUBLIC_APP_LOCALE: ${NEXT_PUBLIC_APP_LOCALE:-en}
    container_name: wacrm
    working_dir: /app
    env_file:
      - .env                      # secretos solo en runtime
    volumes:
      - .:/app
      - /app/node_modules
    environment:
      NODE_ENV: development
      PORT: 3000
    ports:
      - '${HOST_PORT:-8085}:3000'
    command: npm run dev
    restart: unless-stopped
    stdin_open: true
    tty: true
    healthcheck:
      test: ['CMD','node','-e',"fetch('http://localhost:3000').then((r)=>process.exit(r.ok||r.status<500?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

El healthcheck consulta la app desde dentro del contenedor y acepta cualquier
respuesta por debajo de 500, de modo que un 404 de ruta no marque el servicio como
caído.

### 4.3 Exclusiones

`.dockerignore` mantiene el contexto de build limpio (`.git`, `node_modules`, `.next`,
`docs`, `.env*`, ficheros de Docker). `.gitignore` excluye todo `.env*` conservando los
ejemplos, de forma que las credenciales locales nunca lleguen al repositorio.

---

## 5. Variables de entorno

| Variable | Naturaleza | Momento |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Pública | Build + runtime |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Pública | Build + runtime |
| `NEXT_PUBLIC_SITE_URL` | Pública | Build + runtime |
| `NEXT_PUBLIC_APP_LOCALE` | Pública | Build + runtime |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secreta** | Solo runtime |
| `ENCRYPTION_KEY` | **Secreta** | Solo runtime |
| `META_APP_SECRET` | **Secreta** | Solo runtime |

El prefijo `NEXT_PUBLIC_` no es cosmético: Next.js incrusta esas variables en el
JavaScript que descarga el navegador. Por eso pueden pasarse como `ARG` sin riesgo, y
por eso **una clave privilegiada nunca debe llevar ese prefijo**.

`NEXT_PUBLIC_SITE_URL` cambia por entorno: `http://localhost:8085` en local y el
dominio real en producción. Apuntar al dominio remoto desde local provoca el bucle de
redirección descrito en la [sección 10](#10-incidencias-frecuentes).

---

## 6. Base de datos y migraciones

Las migraciones del directorio `supabase/migrations/` se aplican al proyecto remoto con
la CLI, sin pegar scripts a mano en el editor SQL.

```bash
supabase --version                              # verificar instalación
npm install -g supabase                         # si no está instalada

supabase login
npx supabase link --project-ref <project-ref>   # pide la contraseña de la BD
npx supabase db push
```

Cadena de conexión con *session pooler* (alternativa a la conexión directa):

```
postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres
```

**Verificación:** panel de Supabase → *Table Editor*, comprobando las tablas del dominio
(contactos, conversaciones, mensajes, pipelines, automatizaciones, configuración de IA).

---

## 7. Despliegue continuo

### 7.1 Flujo de trabajo

```
cambio en local → docker compose up -d → prueba en :8085
       ↓
git add . && git commit -m "..." && git push origin main
       ↓
Railway detecta el commit → build por Dockerfile → deploy → dominio público
```

### 7.2 Configuración del servicio

1. Conectar el servicio al repositorio de GitHub, concediendo acceso solo a los
   repositorios seleccionados.
2. Cargar las 7 variables en el panel del servicio (admite pegado masivo tipo `.env`).
   `NEXT_PUBLIC_SITE_URL` debe ser el dominio de producción, nunca `localhost`.
3. No configurar mapeo de puertos: la plataforma inyecta su propio `PORT` y gestiona
   dominio y TLS. El `8085` es exclusivo del entorno local.

**Aislamiento:** producción se reconstruye desde el repositorio con sus propias
variables y no lee nada de la máquina local. Un contenedor local roto no afecta al
servicio desplegado, y como `.env` está en `.gitignore`, las credenciales locales nunca
viajan en un push.

---

## 8. Sincronizar con el repositorio original

```bash
git remote add upstream <url-del-repositorio-original>
git fetch upstream
git log --oneline HEAD..upstream/main      # ver qué llega antes de integrar
git merge upstream/main --no-edit
```

Los conflictos aparecen típicamente en `Dockerfile`, `docker-compose.yml` y
`.dockerignore`. La resolución no consiste en elegir un lado, sino en combinar:

- **Del upstream:** Dockerfile multi-stage con salida standalone y healthcheck.
- **Propio:** puerto 8085, modo desarrollo con volúmenes, `env_file` local.

```bash
git add .dockerignore Dockerfile docker-compose.yml
git commit --no-edit -m "chore: merge upstream/main - resolve Docker config conflicts"
docker compose up -d --build     # validar local antes de publicar
git push origin main
```

Tras un merge conviene limpiar la caché de desarrollo (ver
[sección 10](#10-incidencias-frecuentes)).

---

## 9. WhatsApp y agentes de IA

### 9.1 Canal de WhatsApp

Integración con la API oficial de WhatsApp Cloud de Meta. Endpoints expuestos:

| Endpoint | Función |
|---|---|
| `/api/whatsapp/webhook` | Recepción de mensajes y eventos de estado |
| `/api/whatsapp/send` | Envío de mensajes salientes |
| `/api/whatsapp/config` | Configuración y verificación del registro del número |
| `/api/whatsapp/templates` | Sincronización y envío de plantillas |
| `/api/whatsapp/broadcast` | Envíos masivos sobre segmentos |
| `/api/v1/webhooks` | Webhooks salientes hacia sistemas externos |

La firma de los webhooks entrantes se valida con `META_APP_SECRET`; las credenciales
del canal se almacenan cifradas con `ENCRYPTION_KEY`. Ambas son secretos de runtime.
El webhook debe apuntar al dominio público de producción, no a `localhost`.

### 9.2 Añadir un proveedor LLM

Incorporar Google Gemini junto a OpenAI y Anthropic requiere tocar cuatro capas:

1. **UI** — nueva opción en el selector de proveedor de la configuración del agente.
2. **Capa de proveedor** — SDK de Google en `src/lib/ai/providers/` y actualización de
   los identificadores de modelo por defecto.
3. **Validación** — esquema Zod de `POST /api/ai/config` y tipo TypeScript inferido:

   ```ts
   provider: z.enum(['openai', 'anthropic', 'google'])
   ```

4. **Base de datos** — ampliar el check constraint de la columna `provider`:

   ```sql
   ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
   ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_provider_check
     CHECK (provider IN ('openai', 'anthropic', 'google'));
   ```

Omitir el paso 4 produce un fallo al guardar aunque la API valide correctamente: el
rechazo ocurre en la base de datos.

**Verificación:** `/agents` → seleccionar proveedor y modelo → *Test key* → *Save* →
probar en el *Playground*. Los identificadores de modelo de Gemini cambian con
frecuencia; un 404 del proveedor suele significar modelo retirado, no clave inválida.

---

## 10. Incidencias frecuentes

### El build falla al pre-renderizar `/forgot-password`

```
Error: @supabase/ssr: Your project's URL and API key are required to create a Supabase client!
Export encountered an error on /(auth)/forgot-password/page
```

Next.js genera estáticamente las rutas que considera estáticas durante `next build`. Esa
página instancia el cliente de Supabase, que exige URL y anon key en tiempo de
compilación. **Solución:** pasar las variables públicas al build (`ARG` + `ENV`) y forzar
renderizado dinámico donde dependa del contexto de petición:

```ts
export const dynamic = 'force-dynamic';
```

### Las variables existen en el panel pero llegan vacías al build

Comprobarlo antes de cambiar nada, instrumentando el Dockerfile:

```dockerfile
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && echo "SUPABASE_URL: OK" || echo "SUPABASE_URL: MISSING"
```

Si el log dice `MISSING`, el problema no es el valor sino el ciclo de vida de Docker: las
variables de servicio se inyectan en runtime, mientras que `RUN npm run build` ocurre en
build time y solo ve lo declarado como `ARG`. **Solución:** declararlas como `ARG` y
elevarlas a `ENV` antes del paso de compilación. Retirar la sonda una vez confirmado.

### Bucle 307 → 404 en local

`localhost:8085` redirige a `/login` y esa ruta devuelve 404, mientras producción
funciona. Causa habitual: `NEXT_PUBLIC_SITE_URL` apuntando al dominio remoto o sin
esquema `https://`. **Solución:**

```bash
# corregir .env → NEXT_PUBLIC_SITE_URL=http://localhost:8085
docker compose down && docker compose up -d
```

Un `docker compose restart` reutiliza el contenedor y no reinyecta las variables. Probar
en ventana de incógnito para evitar la redirección cacheada por el navegador.

### `MISSING_MESSAGE` en traducciones tras un merge

El servidor de desarrollo sirve la caché previa de `.next` mientras los archivos de
traducción ya cambiaron. Producción no lo sufre porque compila desde cero.

```powershell
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue; docker compose restart
```

### `42P01: relation "..." does not exist`

El nombre real de la tabla no coincide con el supuesto. Consultar el esquema antes de
alterarlo:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE '%ai%';
```

---

## 11. Checklist de validación

- [ ] `docker ps` muestra el contenedor *Up* y *healthy*
- [ ] `http://localhost:8085` responde 200 y el hot reload funciona al guardar
- [ ] `npm run build` completa sin errores de TypeScript ni de prerender
- [ ] Login, registro y recuperación de contraseña operativos
- [ ] Migraciones aplicadas y tablas visibles en el *Table Editor* de Supabase
- [ ] El push a `main` dispara un deploy con estado correcto
- [ ] Contactos, conversaciones, pipelines y automatizaciones accesibles
- [ ] Webhook de WhatsApp alcanzable desde el dominio público
- [ ] El agente de IA guarda configuración y responde en el playground

---

## 12. Referencia de comandos

```bash
# Ciclo de vida del contenedor
docker compose up -d                  # levantar
docker compose up -d --build          # reconstruir imagen y levantar
docker compose down                   # detener y eliminar
docker compose restart                # reiniciar (no reinyecta variables)
docker compose logs -f wacrm          # seguir logs
docker exec -it wacrm sh              # shell dentro del contenedor
docker ps                             # contenedores activos

# Puerto alternativo
HOST_PORT=8086 docker compose up -d

# Diagnóstico de puertos (PowerShell)
netstat -ano | Select-String 8085

# Base de datos
npx supabase link --project-ref <project-ref>
npx supabase db push

# Sincronización y despliegue
git fetch upstream && git merge upstream/main --no-edit
git add . && git commit -m "mensaje" && git push origin main
```
