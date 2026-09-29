const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

// Impresión de etiquetas en ZPL.
//
// NO usa node-thermal-printer: las impresoras de etiquetas (Zebra, TSC, Godex, Qian y
// compatibles) no hablan ESC/POS. Hablan ZPL/TSPL, que es otro lenguaje.
//
// Dos transportes:
//   'tcp' (recomendado)  -> socket crudo al puerto 9100 de la impresora. Es el puerto
//                           RAW estándar, no depende del spooler de Windows ni de
//                           drivers, y no necesita dependencias nativas.
//   'windows-share'      -> para impresoras SOLO USB: se comparte la impresora en
//                           Windows y se le copia el archivo crudo. Requiere que
//                           compartas la impresora con un nombre en Windows.

// ---------- Generación del ZPL ----------

function mmToDots(mm, dpi) {
  return Math.round((mm / 25.4) * dpi);
}

// ^, ~ y \ son caracteres de control de ZPL. Si vienen en el nombre de un producto
// rompen la etiqueta, así que se sustituyen.
function sanitize(text) {
  return String(text || '').replace(/[\^~]/g, ' ').replace(/\\/g, '/');
}

function buildLabelZpl({ name, sku, price, copies = 1 }) {
  const dpi = config.labelDpi;
  const widthDots = mmToDots(config.labelWidthMm, dpi);
  const heightDots = mmToDots(config.labelHeightMm, dpi);

  const margin = mmToDots(1.5, dpi);
  const gap = Math.round(margin / 2);

  // El layout se calcula de abajo hacia arriba a partir del alto disponible. Antes se
  // fijaban alturas por porcentaje sueltas y el código de barras se salía de la
  // etiqueta (verificado: 204 dots en una etiqueta de 200).
  const nameFont = Math.max(14, Math.round(heightDots * 0.10));
  const priceFont = Math.max(18, Math.round(heightDots * 0.17));
  const hriFont = Math.max(10, Math.round(heightDots * 0.08)); // texto bajo el código

  const nameBlock = nameFont * 2; // el nombre puede ocupar dos renglones
  const available = heightDots - margin * 2;
  const barcodeHeight = Math.max(
    20,
    available - nameBlock - priceFont - hriFont - gap * 3
  );

  const yName = margin;
  const yPrice = yName + nameBlock + gap;
  const yBarcode = yPrice + priceFont + gap;

  const safeName = sanitize(name);
  const safeSku = sanitize(sku).trim();
  const priceText = `$${Number(price || 0).toFixed(2)}`;

  // ^CI28 = UTF-8. Sin esto los acentos de los nombres en español salen como basura.
  // ^FB envuelve el nombre en dos líneas en vez de cortarlo.
  // ^BCN,alto,Y = Code128 con el texto legible debajo.
  // ^PQ imprime N copias de una sola vez, en la impresora, sin reenviar el ZPL.
  return [
    '^XA',
    '^CI28',
    `^PW${widthDots}`,
    `^LL${heightDots}`,
    '^LH0,0',
    `^FO${margin},${yName}^A0N,${nameFont},${nameFont}^FB${widthDots - margin * 2},2,0,L,0^FD${safeName}^FS`,
    `^FO${margin},${yPrice}^A0N,${priceFont},${priceFont}^FD${priceText}^FS`,
    `^BY2,3,${barcodeHeight}`,
    `^FO${margin},${yBarcode}^BCN,${barcodeHeight},Y,N,N^FD${safeSku}^FS`,
    `^PQ${copies},0,1,Y`,
    '^XZ',
  ].join('\n');
}

// ---------- Transportes ----------

function sendTcp(zpl) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const done = (err) => {
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(config.labelTimeoutMs);
    socket.once('timeout', () => done(new Error(
      `La impresora de etiquetas no respondió en ${config.labelHost}:${config.labelPort}. ` +
      'Revisa que esté encendida, en la misma red y con esa IP.'
    )));
    socket.once('error', (err) => done(new Error(
      `No se pudo conectar a ${config.labelHost}:${config.labelPort} — ${err.message}`
    )));

    socket.connect(config.labelPort, config.labelHost, () => {
      socket.write(zpl, 'utf8', () => {
        // Pequeña espera antes de cerrar: si se cierra de inmediato, algunas
        // impresoras descartan el final del buffer.
        setTimeout(() => done(null), 300);
      });
    });
  });
}

// Para impresoras solo-USB en Windows: se copia el archivo crudo al recurso compartido.
// Requiere compartir la impresora en Windows con el nombre de LABEL_PRINTER_SHARE.
function sendWindowsShare(zpl) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error("El transporte 'windows-share' solo funciona en Windows"));
      return;
    }
    if (!config.labelShare) {
      reject(new Error('Falta LABEL_PRINTER_SHARE (nombre con el que compartiste la impresora en Windows)'));
      return;
    }

    const tmp = path.join(os.tmpdir(), `pos-label-${Date.now()}.zpl`);
    try {
      fs.writeFileSync(tmp, zpl, 'utf8');
    } catch (err) {
      reject(new Error(`No se pudo escribir el archivo temporal: ${err.message}`));
      return;
    }

    const target = `\\\\localhost\\${config.labelShare}`;
    execFile('cmd', ['/c', 'copy', '/b', tmp, target], (err, stdout, stderr) => {
      fs.unlink(tmp, () => {});
      if (err) {
        reject(new Error(
          `Falló el envío a "${target}": ${stderr || err.message}. ` +
          'Verifica que la impresora esté compartida en Windows con ese nombre exacto.'
        ));
        return;
      }
      resolve();
    });
  });
}

async function sendZpl(zpl) {
  if (config.labelTransport === 'windows-share') return sendWindowsShare(zpl);
  return sendTcp(zpl);
}

async function printLabels({ name, sku, price, copies = 1 }) {
  if (!sku || !String(sku).trim()) {
    throw new Error('Este producto no tiene SKU, así que no se puede generar el código de barras');
  }
  const zpl = buildLabelZpl({ name, sku, price, copies });
  await sendZpl(zpl);
  return { ok: true, copies };
}

// Devuelve el ZPL SIN imprimirlo, para poder pegarlo en labelary.com/viewer.html y ver
// cómo va a quedar la etiqueta antes de tener la impresora enfrente.
function previewLabelZpl(sample) {
  return buildLabelZpl({
    name: sample?.name || 'Producto de ejemplo con nombre largo',
    sku: sample?.sku || 'ABC-12345',
    price: sample?.price ?? 199.5,
    copies: 1,
  });
}

module.exports = { printLabels, buildLabelZpl, previewLabelZpl };
