const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getDb } = require('./init');

const BACKUP_DIR = () => path.join(app.getPath('userData'), 'backups');
const KEEP_BACKUPS = 10;

function ensureBackupDir() {
  const dir = BACKUP_DIR();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Usa db.backup() de better-sqlite3, NO una copia de archivo. Copiar el .db a mano
// mientras la app escribe puede producir un respaldo corrupto (y con WAL activo, además
// deja fuera lo que todavía está en el -wal). db.backup() hace un respaldo consistente
// con la base en uso.
async function createBackup(label = 'auto') {
  const dir = ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `pos-${label}-${stamp}.db`);

  await getDb().backup(filePath);
  pruneOldBackups();

  const { size } = fs.statSync(filePath);
  return { path: filePath, size, createdAt: new Date().toISOString() };
}

function listBackups() {
  const dir = BACKUP_DIR();
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

// Conserva los más recientes y borra el resto. Sin esto, la carpeta crece sin límite.
function pruneOldBackups() {
  const backups = listBackups();
  for (const old of backups.slice(KEEP_BACKUPS)) {
    try {
      fs.unlinkSync(old.path);
    } catch (err) {
      console.error('[respaldo] no se pudo borrar el respaldo viejo:', err.message);
    }
  }
}

function backupDir() {
  return ensureBackupDir();
}

module.exports = { createBackup, listBackups, backupDir };
