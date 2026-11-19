const mysql = require('mysql2/promise');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getConfig } = require('../config');
const { createDefaultsFile } = require('./mysqlCredentials');

/**
 * Checks if a file is gzip compressed by inspecting its magic bytes (0x1f, 0x8b)
 */
function isGzipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(2);
    fs.readSync(fd, buffer, 0, 2, 0);
    fs.closeSync(fd);
    return buffer[0] === 0x1f && buffer[1] === 0x8b;
  } catch {
    return false;
  }
}

/**
 * Creates a connection to local MySQL server.
 */
async function getLocalConnection(database = null) {
  const cfg = getConfig().local;
  const connConfig = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    multipleStatements: true
  };
  if (database) {
    connConfig.database = database;
  }
  return await mysql.createConnection(connConfig);
}

/**
 * Tests local database connectivity.
 */
async function testLocalConnection() {
  try {
    const conn = await getLocalConnection();
    const [rows] = await conn.query('SELECT VERSION() as version, CURRENT_USER() as user;');
    await conn.end();
    return { success: true, version: rows[0].version, user: rows[0].user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Prepares the local tenant database (creates or re-creates it).
 */
/**
 * Creates (or re-creates) the local tenant database.
 * Returns { skipBinlog }: whether the local user may turn off binary logging for its own
 * session. Local MySQL on Ubuntu has log_bin=ON + sync_binlog=1, which made every statement
 * wait for the disk (measured: ~2.4s per CREATE TABLE, ~190ms per INSERT; about half with the
 * binlog off). A local debugging copy does not need to be in the binlog.
 */
async function prepareLocalDatabase(dbName, dropIfExists = false) {
  const conn = await getLocalConnection();
  let skipBinlog = false;
  try {
    try {
      await conn.query('SET SESSION sql_log_bin = 0;');
      skipBinlog = true;
    } catch {
      skipBinlog = false; // no privilege: import normally
    }
    if (dropIfExists) {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
    }
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  } finally {
    await conn.end();
  }
  return { skipBinlog };
}

/**
 * Imports a .sql or .sql.gz dump file into the local tenant database using mysql.exe.
 * Automatically decompresses gzipped dumps on-the-fly without needing intermediate uncompressed files.
 */
function importSqlDump(dbName, sqlFilePath, onLog = () => {}, { skipBinlog = false } = {}) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const mysqlBin = cfg.bins.mysql;

    if (!fs.existsSync(mysqlBin)) {
      return reject(new Error(`MySQL client binary not found (${mysqlBin}). Install the MySQL/MariaDB client (e.g. "sudo apt install mysql-client") or set the mysql path in Settings.`));
    }
    if (!fs.existsSync(sqlFilePath)) {
      return reject(new Error(`SQL dump file does not exist: ${sqlFilePath}`));
    }

    const isGzip = isGzipFile(sqlFilePath) || sqlFilePath.endsWith('.gz');

    // Credentials via a temporary option file, never "-pPASSWORD" (visible in the process
    // list and, before, printed in this log).
    const creds = createDefaultsFile(cfg.local);
    const args = [creds.arg, '--default-character-set=utf8mb4', dbName];

    onLog(`Importing ${path.basename(sqlFilePath)} into local ${cfg.local.host}:${cfg.local.port}/${dbName} as ${cfg.local.username}${isGzip ? ' (streaming gzip decompressor)' : ''}...`);

    const fileStream = fs.createReadStream(sqlFilePath);
    const proc = spawn(mysqlBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    proc.on('close', () => creds.cleanup());

    // Progress: share of the (compressed) dump file read so far, logged every 10%.
    const totalBytes = fs.statSync(sqlFilePath).size || 1;
    let readBytes = 0;
    let lastLoggedPercent = 0;
    fileStream.on('data', (chunk) => {
      readBytes += chunk.length;
      const percent = Math.floor((readBytes / totalBytes) * 100);
      if (percent >= lastLoggedPercent + 10 && percent < 100) {
        lastLoggedPercent = percent - (percent % 10);
        onLog(`Import progress: ${lastLoggedPercent}%...`);
      }
    });

    let stderr = '';
    let hasStreamError = false;

    fileStream.on('error', (err) => {
      hasStreamError = true;
      reject(new Error(`Failed to read dump file: ${err.message}`));
    });

    let inputStream;
    if (isGzip) {
      onLog('Decompressing gzipped SQL stream directly into local MySQL...');
      const gunzip = zlib.createGunzip();
      gunzip.on('error', (err) => {
        hasStreamError = true;
        reject(new Error(`Gzip decompression error during import: ${err.message}`));
      });
      fileStream.pipe(gunzip);
      inputStream = gunzip;
    } else {
      inputStream = fileStream;
    }

    // Session settings for a fast import: no FK/unique checks, no binlog (if allowed), and one
    // commit per table instead of one per INSERT statement (DDL and UNLOCK TABLES still commit).
    proc.stdin.write(`${skipBinlog ? 'SET SESSION sql_log_bin=0; ' : ''}SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0; SET autocommit=0;\n`);
    inputStream.pipe(proc.stdin, { end: false });
    inputStream.on('end', () => {
      proc.stdin.write('\nCOMMIT; SET autocommit=1; SET FOREIGN_KEY_CHECKS=1; SET UNIQUE_CHECKS=1;\n');
      proc.stdin.end();
    });

    proc.stdout.on('data', (data) => {
      onLog(`[mysql] ${data.toString()}`);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      creds.cleanup();
      reject(new Error(`Failed to spawn mysql process: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (hasStreamError) return;

      if (code === 0) {
        onLog(`Database ${dbName} imported successfully!`);
        resolve(true);
      } else {
        // Filter out benign password CLI warning
        const filteredError = stderr
          .split('\n')
          .filter(l => !l.includes('Using a password on the command line interface can be insecure'))
          .join('\n')
          .trim();

        if (!filteredError && code === 0) {
          resolve(true);
        } else {
          reject(new Error(filteredError || `MySQL import exited with code ${code}`));
        }
      }
    });
  });
}

/**
 * Registers or updates the tenant & domain in the local central database
 * (alamlms / alamlms_tenancy / alamlms_sites).
 */
async function registerInLocalCentralDb({ centralDb, tenantId, domain, tenantData, dbName, addLocalDomain = true }) {
  // Connect without a database: the central DB may not exist yet locally.
  const conn = await getLocalConnection();
  try {
    // 1. Ensure central database exists and has the tables we write to.
    //    Same columns as production; "IF NOT EXISTS" leaves an existing (fuller) schema untouched.
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${centralDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await conn.query(`USE \`${centralDb}\`;`);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`tenants\` (
        \`id\` VARCHAR(191) NOT NULL PRIMARY KEY,
        \`created_at\` TIMESTAMP NULL,
        \`updated_at\` TIMESTAMP NULL,
        \`data\` JSON NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`domains\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`domain\` VARCHAR(255) NOT NULL,
        \`tenant_id\` VARCHAR(191) NOT NULL,
        \`created_at\` TIMESTAMP NULL,
        \`updated_at\` TIMESTAMP NULL,
        UNIQUE KEY \`domains_domain_unique\` (\`domain\`),
        KEY \`domains_tenant_id_foreign\` (\`tenant_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

    // 2. Prepare full tenant data JSON
    let tenantDataObj = typeof tenantData === 'object' ? { ...tenantData } : {};
    if (typeof tenantData === 'string' && tenantData) {
      try {
        tenantDataObj = JSON.parse(tenantData);
      } catch {
        tenantDataObj = {};
      }
    }
    
    if (dbName) {
      tenantDataObj.tenancy_db_name = tenantDataObj.tenancy_db_name || dbName;
      tenantDataObj.db_name = tenantDataObj.tenancy_db_name || dbName;
    }

    const tenantDataStr = JSON.stringify(tenantDataObj);
    
    await conn.query(`
      INSERT INTO \`tenants\` (id, data, created_at, updated_at)
      VALUES (?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE 
        data = VALUES(data),
        updated_at = NOW();
    `, [tenantId, tenantDataStr]);

    // 3. Insert or update primary production domain
    if (domain) {
      await conn.query(`
        INSERT INTO \`domains\` (domain, tenant_id, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE 
          tenant_id = VALUES(tenant_id),
          updated_at = NOW();
      `, [domain, tenantId]);
    }

    // 4. Optionally register <tenantId>.localhost for convenient local browser debugging
    let localDomainName = null;
    if (addLocalDomain) {
      localDomainName = `${tenantId}.localhost`.toLowerCase();
      await conn.query(`
        INSERT INTO \`domains\` (domain, tenant_id, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE 
          tenant_id = VALUES(tenant_id),
          updated_at = NOW();
      `, [localDomainName, tenantId]);
    }

    return { success: true, localDomain: localDomainName };
  } finally {
    await conn.end();
  }
}

/**
 * Gets stats for a local database (table count, row count estimation).
 */
async function getLocalDatabaseStats(dbName) {
  const conn = await getLocalConnection();
  try {
    const [rows] = await conn.query(`
      SELECT 
        COUNT(*) as tableCount,
        COALESCE(SUM(data_length + index_length), 0) as totalBytes
      FROM information_schema.tables 
      WHERE table_schema = ?;
    `, [dbName]);

    return {
      tableCount: rows[0].tableCount || 0,
      totalBytes: rows[0].totalBytes || 0
    };
  } finally {
    await conn.end();
  }
}

module.exports = {
  getLocalConnection,
  testLocalConnection,
  prepareLocalDatabase,
  importSqlDump,
  registerInLocalCentralDb,
  getLocalDatabaseStats
};
