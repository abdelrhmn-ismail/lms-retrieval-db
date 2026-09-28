const mysql = require('mysql2/promise');
const { spawn } = require('child_process');
const fs = require('fs');
const { getConfig } = require('../config');

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
async function prepareLocalDatabase(dbName, dropIfExists = false) {
  const conn = await getLocalConnection();
  try {
    if (dropIfExists) {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
    }
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  } finally {
    await conn.end();
  }
}

/**
 * Imports a .sql dump file into the local tenant database using mysql.exe.
 */
function importSqlDump(dbName, sqlFilePath, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const mysqlBin = cfg.bins.mysql;

    if (!fs.existsSync(mysqlBin)) {
      return reject(new Error(`MySQL binary not found at: ${mysqlBin}. Please check your Laragon path.`));
    }
    if (!fs.existsSync(sqlFilePath)) {
      return reject(new Error(`SQL dump file does not exist: ${sqlFilePath}`));
    }

    const args = [
      `-h${cfg.local.host}`,
      `-P${cfg.local.port}`,
      `-u${cfg.local.username}`,
      '--default-character-set=utf8mb4',
      dbName
    ];

    if (cfg.local.password) {
      args.splice(3, 0, `-p${cfg.local.password}`);
    }

    onLog(`Executing: ${mysqlBin} ${args.join(' ')} < ${sqlFilePath}`);

    const fileStream = fs.createReadStream(sqlFilePath);
    const proc = spawn(mysqlBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stderr = '';

    proc.stdin.write('SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0;\n');
    fileStream.pipe(proc.stdin, { end: false });
    fileStream.on('end', () => {
      proc.stdin.write('\nSET FOREIGN_KEY_CHECKS=1; SET UNIQUE_CHECKS=1;\n');
      proc.stdin.end();
    });

    proc.stdout.on('data', (data) => {
      onLog(`[mysql] ${data.toString()}`);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn mysql process: ${err.message}`));
    });

    proc.on('close', (code) => {
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
 * Registers or updates the tenant & domain in the local central database (alamlms or alamlms_tenancy).
 */
async function registerInLocalCentralDb({ centralDb, tenantId, domain, tenantData, dbName, addLocalDomain = true }) {
  const conn = await getLocalConnection(centralDb);
  try {
    // 1. Ensure central database exists and has required tables
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${centralDb}\`;`);
    await conn.query(`USE \`${centralDb}\`;`);

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
