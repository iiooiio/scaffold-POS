# POS Electron — Scaffold (catálogo solo desde WooCommerce)

**Estado: código sin ejecutar/sin probar en máquina real.** Es un scaffold funcional en
lógica, pero no se ha corrido `npm install`, no se ha probado contra un WooCommerce real,
ni contra una impresora física. Revisa cada punto marcado abajo antes de confiar en él
en producción.

## Instalación

```bash
cd pos-electron
npm install
npm run rebuild   # compila better-sqlite3 para el Electron instalado (módulo nativo)
cp .env.example .env
# edita .env con tus credenciales WC y el REGISTER_ID de esta caja
npm start
```

## Cómo obtener las credenciales de WooCommerce

WooCommerce → Ajustes → Avanzado → REST API → Agregar clave. Dale permisos de
**Lectura/Escritura** (necesita escribir para crear órdenes).

Importante: `consumer_key`/`consumer_secret` van por query string en este scaffold, lo
cual **solo es seguro sobre HTTPS**. Si tu sitio corre en HTTP plano, cambia
`woo-client.js` para usar Basic Auth por header en vez de query params.

## Impresora térmica USB

`PRINTER_INTERFACE` en `.env` necesita el identificador que tu sistema operativo le da a
la impresora. Esto varía:
- **Windows**: usualmente el nombre tal como aparece en "Impresoras y escáneres".
- **Mac/Linux**: puede ser una ruta de dispositivo o el nombre CUPS.

No pude verificar el valor exacto sin hardware — prueba con `printer:auto` primero: si no
detecta la impresora, busca el nombre exacto en tu SO y ponlo literal en `.env`.

## Build robusto vía GitHub Actions (recomendado)

Ya incluido: `.github/workflows/build-windows.yml`. Corre en un runner `windows-latest`
real, así que compila el módulo nativo (`better-sqlite3`) de verdad en Windows — sin
Wine, sin cross-compile, sin adivinar binarios prebuilt.

**Ajusta la ruta si hace falta**: el workflow asume que subes este proyecto tal cual,
con `pos-electron/` como subcarpeta del repo (por eso `working-directory: pos-electron`
en cada step). Si en cambio `pos-electron/` va a ser la raíz del repo, quita esa línea
de cada step en el `.yml`.

**Cómo usarlo:**
```bash
git init
git add .
git commit -m "scaffold POS"
git remote add origin <tu-repo-en-github>
git push -u origin main
git tag v0.1.0
git push origin v0.1.0   # dispara el build automáticamente
```
O sin tags: ve a la pestaña **Actions** de tu repo en GitHub → selecciona el workflow →
**Run workflow** (botón manual, gracias a `workflow_dispatch`).

Cuando termine, el `.exe` queda descargable en la pestaña **Actions** → la ejecución
correspondiente → sección **Artifacts** → `pos-windows-installer`.

No lo he podido ejecutar yo mismo (no tengo acceso a GitHub Actions desde aquí) — si el
workflow falla, pega el log del step que truena y lo ajustamos.

## Generar el .exe para Windows (manual, alternativas locales)

```bash
npm run dist:win
```

Esto genera un instalador NSIS (`POS Setup 0.1.0.exe`) en `dist/`.

**El punto crítico: `better-sqlite3` es un módulo nativo (compilado en C++).**
Para que el `.exe` funcione en máquinas Windows, el binario nativo dentro del paquete
tiene que estar compilado para Windows. Esto cambia dónde puedes correr `dist:win`:

- **Compilando DESDE Windows** → funciona directo, `electron-builder` compila el módulo
  nativo para el mismo SO donde corres el comando. Es la opción más confiable.
- **Compilando desde Mac/Linux hacia Windows** → electron-builder puede cross-compilar
  el `.exe`, pero el módulo nativo (`better-sqlite3`) necesita el binario prebuilt para
  Windows. Si tienes internet en la máquina de build, `electron-builder` normalmente lo
  descarga solo (usa `prebuild-install` internamente); si falla, hay que forzarlo con
  `npm_config_target_platform=win32 npm_config_target_arch=x64 npm install` antes del
  build. No lo he probado en este entorno — si te falla, dímelo y lo resolvemos con el
  error exacto en mano.
- **Más confiable a mediano plazo**: usar GitHub Actions con un runner `windows-latest`
  que corra `npm install && npm run dist:win` — ahí compila nativo de verdad en Windows,
  sin depender de cross-compile. Si quieres, te armo el workflow `.yml`.

El instalador resultante NO incluye tu `.env` (por seguridad, no debe ir en el repo/build).
Cada máquina donde lo instales necesita su propio `.env` junto al ejecutable, o hay que
adaptar `config.js` para leer la config desde otro lado (registro de Windows, archivo
externo fijo, etc.) — pendiente de decidir según cómo lo vayas a distribuir.

## Qué SÍ cubre este scaffold

- Catálogo de productos simples sincronizado desde WooCommerce a SQLite local
  (pull incremental por `modified_after`).
- Carrito y checkout que funcionan sin internet: la orden se guarda en una cola local
  y se imprime el ticket de inmediato.
- Sincronización automática de la cola de órdenes cada `SYNC_INTERVAL_MS` cuando hay
  conexión al sitio.
- Folio local por caja (`REGISTER_ID`) para no chocar números de ticket entre cajas
  mientras están offline.

## Qué NO cubre (pendiente, a propósito)

- **Productos variables/variaciones** — ✅ resuelto: hay tabla `product_variations`,
  sync de variaciones (con sus propias imágenes), y un selector modal en la UI que se
  abre al tocar un producto tipo `variable` en el catálogo. Los line items de la orden
  incluyen `variation_id` cuando aplica.
  **Caveat sin verificar**: el sync de variaciones se dispara solo para productos
  variables que WooCommerce reporta como "modificados" en el pull incremental
  (`modified_after`) del producto PADRE. No confirmé si WooCommerce actualiza la fecha
  de modificación del padre cuando solo cambia una variación (precio/stock) sin tocar el
  producto en sí. Si notas que el stock/precio de una variación no se actualiza solo,
  usa "Sincronizar catálogo ahora" — ahí sí vuelve a traer todo. Si el problema persiste,
  hay que forzar el resync completo de variables en cada pasada (más lento, pero seguro).
- **Buffer de stock entre cajas** — si dos cajas venden el mismo SKU offline al mismo
  tiempo, pueden sobrevender. No hay lógica de reserva/buffer todavía; es una decisión
  de negocio pendiente (ver conversación previa).
- **Manejo de errores de sync en UI** — ✅ resuelto: hay un panel en la UI mínima que
  lista órdenes en estado `error`, con botones "Reintentar" (vuelve a intentar el POST a
  WooCommerce) y "Marcar resuelto manual" (las saca de la cola sin crearlas en Woo, para
  cuando el cajero ya las resolvió por fuera — ej. las capturó a mano en wp-admin). El
  auto-sync de fondo YA NO reintenta órdenes en error solo; eso es a propósito, según la
  política de stock acordada (sin buffer, sobreventa se resuelve manual).
- **Clientes** — ✅ resuelto: tabla `customers`, sync completo (sin incremental, Woo no
  lo soporta en este endpoint) en un intervalo aparte y más espaciado
  (`CUSTOMERS_SYNC_INTERVAL_MS`, default 10 min), y selector con búsqueda en el carrito.
  La orden manda `customer_id` a Woo cuando hay cliente seleccionado.
  **No cubre**: crear clientes nuevos desde el POS (solo asocia existentes), ni borrar
  clientes que se eliminaron en Woo (quedan en la caché local hasta que alguien limpie
  la base a mano).
- **Multi-pago / cambio** — el checkout asume pago simple en efectivo, sin cálculo de
  cambio ni pagos mixtos.
- **Reintentos con backoff** — `flushPendingOrders` reintenta en cada tick del intervalo,
  sin backoff exponencial ni límite de reintentos.

## Siguiente paso sugerido

Definir la política de stock entre cajas (buffer de seguridad vs. aceptar sobreventa
ocasional) antes de conectar más de una caja a producción — es lo que más riesgo tiene
del diseño actual.
