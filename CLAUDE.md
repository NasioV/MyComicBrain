# MyComicBrain — Especificación inicial

> Documento puente. Sirve para arrancar el desarrollo en Claude Code (otra sesión, sin
> memoria de la conversación donde se diseñó esto). Es un documento **vivo**: la visión
> está completa, pero solo se construye lo marcado como **v1**. Lo demás queda anotado
> para no perderlo.

---

## 1. Visión

App personal y privada para gestionar la lectura de cómics. Centraliza qué sale cada mes,
permite elegir qué leer y en qué formato, y construye un calendario de lectura ordenado por
fecha que se actualiza solo cuando una editorial cambia fechas.

- **Nombre provisional:** MyComicBrain
- **Usuarios:** privada. Solo yo, como mucho un amigo más. Se publica en web pero **nadie
  ajeno puede entrar ni ver nada**.
- **Fuente de datos:** League of Comic Geeks (LoCG), vía la librería Python `comicgeeks`
  (scraper no oficial). De ahí salen título, número, editorial, fecha **y portada**.
- **Sin Comic Vine** (descartado por retardo en las imágenes; LoCG cubre también las portadas).

---

## 2. Stack y arquitectura

| Capa | Tecnología |
|------|------------|
| Frontend | Angular, desplegado en **Vercel** |
| Backend + BBDD | **Supabase** (Postgres + RLS + Auth) |
| Worker de ingesta | Script **Python** con `comicgeeks`, en **GitHub Actions** (cron, 1×/semana) |
| Imágenes | URL de portada de LoCG (S3), guardada en BBDD |

Flujo:

```
LoCG  ──►  Worker Python (cron, GitHub Actions)  ──►  Supabase: `publishers` + `series` + `releases`
                                                              │  (refresca snapshot de pulls
                                                              │   en ventana)
          App Angular  ◄──────────────────────────────────────┘
          (lee pulls/series/releases · escribe pulls)
```

Principios clave:

- **`pulls` es autosuficiente y duradera.** Guarda su propia copia de fecha, número y
  portada, y referencia a `series` (que nunca se poda). Por eso puedo consultar cualquier mes
  de mi historial (p. ej. -20 meses) aunque ese número ya no esté en `releases`.
- **La fecha se actualiza sola mientras importa.** Mientras un número está dentro de la
  ventana ±3 meses, el worker refresca su fecha/portada en `pulls`, así que los retrasos
  entran solos. Cuando sale de la ventana, su fecha ya es definitiva y se congela.
- **El worker solo toca la copia de catálogo de `pulls`** (fecha, portada, número). Nunca
  toca `format` ni `status`: mis decisiones son intocables.
- **Seguridad:** el worker escribe con la `service_role` key (solo en GitHub secrets, nunca
  en el navegador). La app usa la anon key con **RLS** activado.

---

## 3. Modelo de datos (v1)

Tres tablas. Diseñado para **ampliarse en el futuro** (añadir columnas vía migraciones sin
romper nada).

### Tabla `publishers` (editoriales — desplegable + grupo)

La rellena el worker con cada editorial nueva que ve en LoCG; también admite altas manuales.
El **grupo vive aquí**, no en la serie.

| Campo | Tipo | Notas |
|-------|------|-------|
| `publisher_id` | bigint PK | id de LoCG cuando existe; sintético si es manual |
| `name` | text UNIQUE | "DC Comics", "Marvel Comics", "Image Comics"... |
| `publisher_group` | text | `DC` \| `MARVEL` \| `OTROS` (para los 3 botones) |

### Tabla `series` (esqueleto duradero — NO se poda)

La rellena el worker con cada serie que ve en LoCG; también se crean a mano desde el alta
manual.

| Campo | Tipo | Notas |
|-------|------|-------|
| `series_id` | bigint PK | id de LoCG cuando existe; sintético si es manual |
| `name` | text | nombre de la serie |
| `publisher_id` | bigint FK → publishers | el grupo se deriva de aquí |
| `source` | text | `locg` \| `manual` |

### Tabla `releases` (catálogo ±3 meses — el worker la reescribe y poda)

| Campo | Tipo | Notas |
|-------|------|-------|
| `issue_id` | bigint PK | id del número en LoCG |
| `series_id` | bigint FK → series | |
| `issue_number` | text | texto, no número ("1", "1A", "Annual 1") |
| `release_date` | date | |
| `cover_url` | text | portada (S3 de LoCG) |
| `price` | text | opcional |
| `description` | text | opcional |
| `synced_at` | timestamptz | |

### Tabla `pulls` (mi selección — autosuficiente, duradera)

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | para RLS |
| `series_id` | bigint FK → series | |
| `issue_id` | bigint NULL | id de LoCG si vino del catálogo; NULL si alta manual |
| `issue_number` | text | snapshot |
| `release_date` | date | snapshot duradero (sobrevive a la poda de `releases`) |
| `cover_url` | text | snapshot |
| `format` | text | `fisico` \| `digital` — **el worker no lo toca** |
| `status` | text | ver estados — **el worker no lo toca** |
| `reading_order` | int NULL | diferido (orden manual en eventos) |
| `created_at` / `updated_at` | timestamptz | |
| | | UNIQUE (`user_id`, `series_id`, `issue_number`) |

**Refresco del worker:** tras actualizar `releases`, para cada número en ventana que coincida
con un pull (por `issue_id`), actualiza la copia `release_date` / `cover_url` / `issue_number`
en `pulls`. Nunca toca `format` ni `status`. Los pulls manuales (`issue_id` NULL) no se
refrescan.

### Tabla `sync_log` (estado del sync)

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | uuid PK | |
| `ran_at` | timestamptz | |
| `status` | text | `ok` \| `error` |
| `message` | text | detalle del error si lo hay |
| `releases_upserted` | int | |

El worker inserta una fila por ejecución. La app lee la última para el aviso de estado.

### Estados y colores

| Estado | Color de fila | Significado |
|--------|---------------|-------------|
| Leído | Rojo | Ya leído |
| Listo | Verde | Listo para leer (descargado / recibido) |
| Pedido | Azul claro | Pedido en físico, esperando |
| Descargar | Amarillo | Ha salido en digital, toca descargarlo |
| No salido | Gris muy claro | Aún no ha salido |

**Estado inicial al añadir a la pull list:**
- formato **digital → No salido**
- formato **físico → Pedido**

**Única automatización en v1:** `No salido → Descargar` cuando llega la `release_date` **y** el
formato es `digital`. Todo lo demás se cambia a mano.

Flujos de estado:
- Digital: No salido → (auto) Descargar → Listo → Leído
- Físico: Pedido → Listo → Leído

---

## 4. Pantallas

### 4.1 Principal — Calendario de mis pulls (v1)

La home. Muestra mis pulls del mes. Lee de `pulls JOIN series JOIN publishers` (no depende de
`releases`).

- **3 botones arriba:** `DC` | `MARVEL` | `OTROS`. Por defecto **DC**. Al cambiar de botón se
  muestra el calendario de ese grupo. La apariencia de la pantalla cambia según el grupo.
- **Un mes a la vez**, ordenado por `release_date` **ascendente**. Navegación a mes anterior /
  siguiente. Se puede consultar **cualquier mes**, incluso muy antiguo.
- **Modo tabla** ("base de datos"): filas con nombre de serie, número, estado y formato.
  - En el grupo **OTROS** se muestra además una **columna "Editorial"** (de `publishers`).
    En DC y Marvel esa columna no aparece (es redundante).
  - El **estado se cambia desde la propia fila** (inline).
  - El **color de la fila depende del estado**.
- **Aviso de sync:** si el último sync falló o lleva >~10 días sin correr, banner en rojo
  arriba.
- **Próxima actualización:** indicador discreto abajo con **fecha y hora exactas**
  ("próxima actualización: lunes 23/06 a las 07:00"), en hora de Madrid, calculado desde el
  cron fijo del worker.
- Consulta: `pulls JOIN series JOIN publishers WHERE publisher_group = <grupo> AND release_date
  dentro del mes ORDER BY release_date ASC`.

### 4.2 New Releases (v1)

Lista bonita con portadas e info del número, de **todo lo que sale** (todas las editoriales),
según el mes/fecha elegido. Lee de `releases` (ventana ±3 meses).

- Consultar cualquier fecha dentro de la ventana del catálogo.
- **Filtro por editorial.**
- Acciones: **añadir a la pull list** (eligiendo formato → aplica el estado inicial por la
  regla de arriba) y **ver más detalles**.

### 4.3 New to Pull List — alta manual (v1)

Red de seguridad por si el scraper Python deja de funcionar, y para añadir títulos antiguos
que ya no están en `releases`. **No depende del scraper.**

- Eliges una serie del autocompletado (de `series`) o creas una nueva: nombre + **editorial
  desde un desplegable** (tabla `publishers`).
- Metes número, fecha y formato. Se crea un `pulls` autosuficiente (`issue_id` NULL).

### 4.4 Login (v1)

- Supabase Auth.
- **Registro público desactivado.** Las cuentas (1, máx. 2) se crean a mano.
- Con RLS, quien no esté autenticado no lee nada.

---

## 5. Qué entra en v1 y qué se difiere

### v1 — núcleo a construir primero
1. Worker Python que llena `publishers` + `series` + `releases` (con portadas de LoCG) y
   escribe `sync_log`. Configurado con `workflow_dispatch` para poder lanzarlo a mano desde
   GitHub sin esperar al cron.
2. Login privado (1-2 cuentas, sin registro público, RLS).
3. Pantalla principal en **modo tabla**: 3 botones de grupo, mes navegable, columna Editorial
   solo en OTROS, estados con colores, cambio de estado inline, aviso de sync en rojo,
   indicador de próxima actualización (fecha y hora exactas, hora de Madrid).
4. Automatismo `No salido → Descargar` (digital, en fecha).
5. New Releases: lista con portadas, selector de fecha, filtro por editorial, añadir a pull
   list.
6. New to Pull List: alta manual con series.

### v1.1 — muy cercano
- **Modo visual** (portadas) en la principal: mismo dato que el modo tabla, solo cambia cómo
  se pinta. (El usuario lo considera secundario.)

### Futuro — anotado, no se construye aún
- `reading_order` manual para orden de lectura en eventos.
- Portadas propias en Supabase Storage (no depender del S3 de LoCG).
- Segundo usuario (amigo).
- Más automatizaciones de estado.
- Edición/ampliación del esquema con más detalle por tabla.

---

## 6. Decisiones cerradas

- **DC/MARVEL/OTROS:** el grupo vive en la tabla `publishers`. OTROS agrupa el resto en un solo
  botón, pero su vista muestra una columna **Editorial** para saber de cuál es cada número
  (en DC y Marvel esa columna no se muestra).
- **Ejecución manual:** descartado el botón dentro de la app. En su lugar, el worker lleva
  `workflow_dispatch` y se lanza desde la pestaña Actions de GitHub cuando haga falta (p. ej.
  tras renovar la cookie). El cron 1×/semana es el ritmo automático.
- **Estado inicial:** digital → No salido; físico → Pedido.
- **Ventana del worker en `releases`:** -3 / +3 meses. El historial completo vive en `pulls`
  (duradera), no en `releases`.
- **Cron:** 1 vez por semana.
- **Estado del sync:** tabla `sync_log` + banner rojo en la app si falla o está obsoleto.

---

## 7. Avisos heredados de la conversación

- `comicgeeks` es un **scraper no oficial** de LoCG. Riesgo bajo para uso privado, pero sus
  Términos de Uso prohíben el scraping y la librería **se puede romper** si LoCG cambia su
  HTML. El alta manual existe justo por esto.
- **El `ci_session` caduca y NO se arregla solo.** Cuando falle (banner rojo), el flujo es:
  copiar una cookie fresca del navegador → pegarla en el secret de GitHub → lanzar el worker a
  mano desde Actions (`workflow_dispatch`), sin esperar al cron. Trámite de un par de minutos,
  cada varias semanas.
- A veces el listado semanal trae menos detalle que la ficha individual; si falta algún dato,
  se rellena con una llamada por número (a costa de más peticiones).
- Mantener el worker **desacoplado** de la app: si el scraper falla, la app sigue viva.

---

## 8. Setup necesario antes de empezar

- VS Code + Claude Code
- Cuenta GitHub
- Cuenta Vercel
- Cuenta Supabase
- Node.js (Angular) y Python (worker) instalados en local
