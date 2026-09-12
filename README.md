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

## Configuración: ya no necesitas copiar .env a cada caja

La app ahora guarda su configuración en `config.json` dentro de la carpeta de datos de
usuario de cada máquina, y se edita desde el botón **Ajustes** en la app. Flujo normal
de instalación en una caja nueva:

1. Instalas el `.exe`.
2. Abres la app. Como no hay configuración, se abre sola la pantalla de Ajustes.
3. Capturas URL del sitio, consumer key/secret, identificador de caja, impresora y
   (opcional) URL del logo.
4. Guardas y reinicias la app.

El `.env` sigue funcionando para desarrollo (`npm start`) y tiene MENOR prioridad que
`config.json`. Si faltan datos, la app ya NO se cae con un diálogo de error como antes:
arranca igual y te pide la configuración.

## Auto-update

La app empaquetada busca actualizaciones al arrancar y cada 4 horas, usando releases de
GitHub. Para publicar una versión nueva:

1. Sube la versión en `package.json` (ej. `0.1.0` → `0.2.0`).
2. Commit y push.
3. `git tag v0.2.0 && git push origin v0.2.0`

El workflow compila en Windows y publica el release automáticamente; las cajas
instaladas la detectan y la instalan. Una corrida manual desde la pestaña Actions solo
compila, sin publicar.

**Ajusta `owner` y `repo`** en la sección `build.publish` de `package.json` si tu
repositorio no es `iiooiio/scaffold-POS`.

**Caveats sin verificar** (no pude probar el ciclo completo de actualización):
- El instalador no está firmado digitalmente. Windows SmartScreen puede advertir al
  instalar. El auto-update de NSIS funciona sin firma, pero no lo confirmé en máquina.
- Si el repositorio es privado, el auto-update necesita un token para descargar los
  releases; con repositorio público no hace falta.

## Lector de código de barras

Funciona con lectores USB que emulan teclado (la mayoría). No hay que configurar nada ni
hacer click en el buscador: la app detecta el escaneo por la velocidad del tecleo
(teclas a menos de 40ms una de otra, terminadas en Enter) y busca por **SKU exacto**.

- Producto simple → se agrega al carrito directo.
- Variación con SKU propio → se agrega esa variación.
- SKU de un producto variable (el padre) → abre el selector de variación, porque no se
  puede vender sin elegir una.
- SKU desconocido → aviso en pantalla, no agrega nada.

Requisito: los SKU en WooCommerce tienen que coincidir con lo que imprime el código de
barras. Si usas los códigos de barras del fabricante (EAN/UPC), ponlos como SKU.

**Caveat sin verificar**: el umbral de 40ms entre teclas está tomado del
comportamiento típico de estos lectores, pero no lo probé con hardware. Si tu lector es
más lento y los escaneos no se detectan, sube `SCAN_MAX_GAP_MS` en
`src/renderer/renderer.js`.

## Cancelaciones

Desde el panel **Ventas** puedes cancelar una venta. Qué pasa depende de si ya llegó a
WooCommerce:

- **Aún no sincronizada** → se marca cancelada localmente y nunca se envía a Woo.
- **Ya sincronizada** → se marca `cancel_pending` y el ciclo de sincronización le cambia
  el estado a `cancelled` en WooCommerce. Woo devuelve el stock automáticamente al
  cancelar, así que no hay que reponer inventario a mano.

Funciona sin conexión: la cancelación local es inmediata y válida para el corte aunque
Woo no responda todavía.

**Restricción a propósito: solo se cancelan ventas del turno ABIERTO.** Cancelar una de
un turno ya cerrado cambiaría retroactivamente un corte ya firmado, y además el efectivo
devuelto saldría del cajón de hoy y no del de ese día. Para devoluciones de días
anteriores, registra un **retiro** en el panel de Caja con el motivo.

Se imprime un comprobante de cancelación con monto devuelto, motivo y espacio de firma.

**No cubre**: cancelaciones parciales (devolver solo algunos artículos de un ticket).
Es todo o nada.

## Ajuste global de precios (%)

En **Ajustes** hay un campo de porcentaje que modifica todos los precios que vienen de
WooCommerce. Positivo sube (ej. `10` = +10%), negativo baja (ej. `-5` = -5%), `0` deja
los precios tal cual.

Se aplica en un solo punto del código (`adjustPrice` en `main.js`), así que catálogo,
selector de variaciones, escaneo de código de barras y carrito siempre usan el mismo
precio — no hay forma de que el ticket y la orden difieran por este motivo.

**Importante**: al enviar la orden se mandan `subtotal` y `total` explícitos por línea.
Sin eso WooCommerce recalcularía con SU precio de catálogo e ignoraría el ajuste, dejando
el ticket impreso y la orden en Woo con montos distintos.

Cuando el ajuste está activo, el riel izquierdo muestra un aviso permanente con el
porcentaje. Es a propósito: un recargo o descuento global invisible es una forma fácil de
cobrar mal sin que nadie se dé cuenta.

El cambio de porcentaje aplica al guardar (recarga el catálogo), sin reiniciar.

**Caveat sin verificar**: no probé cómo interactúa el ajuste con la configuración de
impuestos de WooCommerce. Si manejas precios con IVA incluido, verifica con una venta
real que el total de la orden en Woo coincida con el ticket impreso.

## Productos y servicios temporales

Botón **+ Producto temporal** en el panel del carrito: descripción, precio unitario y
cantidad. Sirve para cobrar algo que no está en el catálogo (un servicio, un flete, una
pieza suelta) sin crear el producto en WooCommerce.

No toca el catálogo ni la base local: vive solo en el carrito de esa venta. En el ticket
sale como cualquier otra línea; en el carrito aparece marcado como "temporal".

**Cómo llega a WooCommerce**: como `fee_lines`, no como `line_items`. Woo exige
`product_id` en los line_items, así que un producto inexistente no puede ir ahí. Los
`fee_lines` aceptan nombre y monto libres, y funcionan offline igual porque no dependen
de que exista nada en Woo. Si la cantidad es mayor a 1, el nombre incluye `(xN)` porque
los fee_lines no tienen campo de cantidad.

Se envían con `tax_status: 'none'` a propósito, para que el monto cobrado sea exactamente
el del ticket. Si necesitas que Woo les calcule impuesto, cámbialo a `'taxable'` en
`src/sync/order-sync.js`.

**No cubre**: guardar los temporales para reutilizarlos después, ni descontar inventario
(por definición no tienen existencias).

## Origen de la orden (atribución) — y el bug que causó

Las órdenes del POS se marcan con `_wc_order_attribution_source_type`. El valor se
configura con `ORDER_ATTRIBUTION` y por default es `mobile_app`.

**Historia del bug**: antes se mandaba `source_type: 'utm'` junto con `utm_source` y
`utm_medium`. Con `source_type='utm'`, WooCommerce intenta renderizar además
`utm_campaign`, `device_type` y `session_page_views` en los metaboxes "Order attribution"
y "Customer history" del detalle de la orden. Al no existir esos metas, el sitio truena
con error crítico justo en esas dos vistas. Por eso ahora se manda SOLO `source_type`,
con un valor del enum que no arrastra campos acompañantes.

Valores útiles para `ORDER_ATTRIBUTION`:
- `mobile_app` (default) — el que usa la propia app móvil de WooCommerce.
- `admin` — alternativa válida, se lee como "creada desde el panel".
- `none` — no manda nada de atribución. Úsalo si algo sigue rompiéndose; Woo mostrará
  el origen como desconocido, que es exactamente lo que pasa con órdenes anteriores a
  que existiera la función, y lo maneja sin problema.

### Limpiar las órdenes que ya quedaron dañadas

Las órdenes creadas ANTES de este arreglo ya tienen el meta malo guardado, así que su
detalle va a seguir tronando aunque actualices el POS. Hay que borrarles ese meta.
**Respalda la base antes.** Con HPOS activo los metas viven en `wp_wc_orders_meta`; sin
HPOS, en `wp_postmeta`. Ejecuta las dos por si acaso, ajustando el prefijo de tablas:

```sql
DELETE FROM wp_wc_orders_meta WHERE meta_key LIKE '_wc_order_attribution%';
DELETE FROM wp_postmeta      WHERE meta_key LIKE '_wc_order_attribution%';
```

Eso borra la atribución de TODAS las órdenes, incluidas las de la tienda en línea. Si
quieres conservar esas, limita por id de orden:

```sql
DELETE FROM wp_wc_orders_meta WHERE order_id = 123 AND meta_key LIKE '_wc_order_attribution%';
DELETE FROM wp_postmeta       WHERE post_id  = 123 AND meta_key LIKE '_wc_order_attribution%';
```

### Confirmar el diagnóstico

Para verificar que esto era la causa y no algo más: **WooCommerce → Estado → Logs**, y en
el selector busca "Fatal Errors". El stack trace dirá exactamente qué archivo y línea
tronaron. Si el error NO menciona order attribution, hay otra causa y conviene revisarla
con ese log en mano.

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
  Desde el buscador de clientes hay un botón **+ Cliente nuevo**. Solo se pide nombre; el
  WhatsApp es opcional. No se captura teléfono aparte: el WhatsApp se manda también como
  teléfono de facturación en Woo, para que el cliente no quede allá sin número de contacto.

  **Correo generado automáticamente**: WooCommerce exige un email único por cliente, pero
  en mostrador nadie lo pide, así que se genera desde el nombre
  (`juan-perez@pos.com`, con acentos normalizados y sufijo `-2`, `-3`... si ya existe).
  El dominio se configura con `POS_EMAIL_DOMAIN` (default `pos.com`).

  **Vale la pena cambiarlo**: `pos.com` es un dominio real de un tercero. Nunca se le
  envía correo desde aquí, pero si algún día conectas cualquier automatización de email
  en WooCommerce, esos mensajes saldrían hacia un dominio ajeno. Lo más seguro es usar un
  subdominio propio (`pos.tu-sitio.com`) o `pos.invalid`, que por estándar nunca resuelve.

  **WhatsApp**: se guarda local, se manda a Woo como meta del cliente (`_pos_whatsapp`)
  —listo para la integración con WAHA— y además como `billing.phone`. También es buscable
  desde el buscador de clientes.

## Atajos de teclado

- **Esc** — cierra el modal abierto. Si hay varios encimados, cierra solo el de arriba.
- **F11** — entra/sale de pantalla completa (no hay barra de menú que lo ofrezca).
- Cualquier código escaneado con lector se procesa sin necesidad de enfocar el buscador,
  siempre que no haya un modal abierto.

  **Cómo funciona sin conexión**: si hay red, el cliente se crea en Woo de inmediato y se
  guarda con su id real. Si no hay red, se guarda con un id LOCAL negativo marcado como
  pendiente, para no bloquear la venta; el ciclo de sincronización lo crea en Woo después.
  El id local nunca cambia, y el `customer_id` de Woo se resuelve **al momento de enviar
  la orden**, no al guardarla — si se resolviera antes, una venta hecha offline apuntaría
  a un cliente que todavía no existe allá.
  Los clientes pendientes se suben ANTES que las órdenes en cada ciclo, por la misma razón.
  Si Woo rechaza el cliente (correo duplicado o inválido), la venta que lo referencia queda
  en estado `error` con el motivo, visible en el panel de errores.

  **No cubre**: editar clientes existentes, ni borrar de la caché local los que se
  eliminaron en Woo (quedan hasta que alguien limpie la base a mano).
- **Multi-pago / cambio** — el checkout asume pago simple en efectivo, sin cálculo de
  cambio ni pagos mixtos.
- **Reintentos con backoff** — `flushPendingOrders` reintenta en cada tick del intervalo,
  sin backoff exponencial ni límite de reintentos.

## Siguiente paso sugerido

Definir la política de stock entre cajas (buffer de seguridad vs. aceptar sobreventa
ocasional) antes de conectar más de una caja a producción — es lo que más riesgo tiene
del diseño actual.
