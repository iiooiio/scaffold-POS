const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Log a disco.
//
// POR QUÉ HACE FALTA: en la app empaquetada no hay consola. Los errores de
// sincronización iban a console.error y nadie los veía nunca, así que cuando algo no
// funcionaba no había forma de saber por qué -- ni para el usuario ni para diagnosticar
// a distancia.
//
// Se escribe en la carpeta de datos del usuario, con rotación simple por tamaño.

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB por archivo
const KEEP_LINES_IN_MEMORY = 200;  // para mostrarlas en el panel de Diagnóstico

const recent = [];
let logPath = null;

function ensureLogPath() {
  if (logPath) return logPath;
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, 'pos.log');
  return logPath;
}

function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, `${file}.1`); // se conserva solo la generación anterior
    }
  } catch { /* no existe todavía */ }
}

function write(level, args) {
  const message = args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');

  const line = `[${new Date().toISOString()}] [${level}] ${message}`;

  recent.push(line);
  if (recent.length > KEEP_LINES_IN_MEMORY) recent.shift();

  try {
    const file = ensureLogPath();
    rotateIfNeeded(file);
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    // Si ni siquiera se puede escribir el log, no hay nada más que hacer: no vale la
    // pena tumbar la app por eso.
  }
}

// Envuelve console.* para no tener que cambiar las ~40 llamadas que ya existen.
function install() {
  const original = { log: console.log, warn: console.warn, error: console.error };

  console.log = (...args) => { original.log(...args); write('INFO', args); };
  console.warn = (...args) => { original.warn(...args); write('WARN', args); };
  console.error = (...args) => { original.error(...args); write('ERROR', args); };

  process.on('uncaughtException', (err) => write('FATAL', [err]));
  process.on('unhandledRejection', (reason) => write('FATAL', ['unhandledRejection', reason]));

  write('INFO', [`--- POS iniciado, versión ${app.getVersion()} ---`]);
}

function getRecentLines(limit = 80) {
  return recent.slice(-limit);
}

function getLogPath() {
  return ensureLogPath();
}

function logDir() {
  return path.dirname(ensureLogPath());
}

module.exports = { install, getRecentLines, getLogPath, logDir };
