const mysql = require('mysql2/promise');
const { spawn } = require('child_process');
const fs = require('fs');
const { getConfig } = require('../config');

/**
 * Creates a direct connection to production MySQL.
 */
async function getProdConnection(database = null, timeoutMs = 4000) {
  const cfg = getConfig().prod;
  return await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    database: database || undefined,
    connectTimeout: timeoutMs
  });
}

/**
 * Tests direct MySQL connection to production.
 */
async function testProdConnection() {
  try {
    const conn = await getProdConnection(null, 3500);
    const [rows] = await conn.query('SELECT VERSION() as version, CURRENT_USER() as user;');
    await conn.end();
    return { success: true, version: rows[0].version, user: rows[0].user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Looks up a domain and its tenant details in the production central database.
 */
async function lookupTenantDirect(centralDb, domainInput) {
  const conn = await getProdConnection(centralDb, 4000);
  try {
    const cleanDomain = domainInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    
    // 1. Try exact match first
    let [rows] = await conn.query(`
      SELECT d.id as domain_id, d.domain, d.tenant_id, t.data as tenant_data
      FROM \`domains\` d
      LEFT JOIN \`tenants\` t ON d.tenant_id = t.id
      WHERE d.domain = ? OR d.tenant_id = ?
      LIMIT 1;
    `, [cleanDomain, cleanDomain]);

    if (!rows || rows.length === 0) {
      [rows] = await conn.query(`
        SELECT d.id as domain_id, d.domain, d.tenant_id, t.data as tenant_data
        FROM \`domains\` d
        LEFT JOIN \`tenants\` t ON d.tenant_id = t.id
        WHERE d.domain LIKE ?
        LIMIT 1;
      `, [`%${cleanDomain}%`]);
    }

    if (!rows || rows.length === 0) {
      return null;
    }

    const row = rows[0];
    let parsedData = {};
    try {
      parsedData = typeof row.tenant_data === 'string' ? JSON.parse(row.tenant_data) : (row.tenant_data || {});
    } catch {
      parsedData = {};
    }

    // Determine target database name
    let dbName = parsedData.tenancy_db_name;
    if (!dbName) {
      const [dbRows] = await conn.query(`SHOW DATABASES LIKE ?;`, [`%${row.tenant_id}%`]);
      if (dbRows && dbRows.length > 0) {
        dbName = Object.values(dbRows[0])[0];
      } else {
        dbName = `tenant${row.tenant_id}`;
      }
    }

    parsedData.tenancy_db_name = dbName;
    parsedData.db_name = dbName; // Stancl Tenancy internal key

    return {
      domainId: row.domain_id,
      domain: row.domain,
      tenantId: row.tenant_id,
      tenantData: parsedData,
      databaseName: dbName
    };
  } finally {
    await conn.end();
  }
}

/**
 * Dumps a database from production using mysqldump.exe.
 */
function dumpDatabaseDirect(dbName, outputSqlPath, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const mysqldumpBin = cfg.bins.mysqldump;

    if (!fs.existsSync(mysqldumpBin)) {
      return reject(new Error(`mysqldump binary not found at: ${mysqldumpBin}`));
    }

    const args = [
      `-h${cfg.prod.host}`,
      `-P${cfg.prod.port}`,
      `-u${cfg.prod.username}`,
      `-p${cfg.prod.password}`,
      '--single-transaction',
      '--quick',
      '--default-character-set=utf8mb4',
      '--routines',
      '--triggers',
      dbName
    ];

    onLog(`Running mysqldump for ${dbName}...`);

    const outStream = fs.createWriteStream(outputSqlPath);
    const proc = spawn(mysqldumpBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stderr = '';
    let bytesDumped = 0;

    proc.stdout.on('data', (chunk) => {
      bytesDumped += chunk.length;
      if (bytesDumped % (1024 * 512) === 0) {
        onLog(`Dump progress: ${(bytesDumped / 1024 / 1024).toFixed(2)} MB received...`);
      }
    });

    proc.stdout.pipe(outStream);

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn mysqldump: ${err.message}`));
    });

    proc.on('close', (code) => {
      outStream.close();
      const filteredError = stderr
        .split('\n')
        .filter(l => !l.includes('Using a password on the command line interface can be insecure'))
        .join('\n')
        .trim();

      if (code === 0) {
        onLog(`mysqldump complete! Total size: ${(bytesDumped / 1024 / 1024).toFixed(2)} MB`);
        resolve({ bytes: bytesDumped, path: outputSqlPath });
      } else {
        reject(new Error(filteredError || `mysqldump exited with code ${code}`));
      }
    });
  });
}

/**
 * Fetches recent domains from production central DB for auto-complete.
 */
async function getDomainsListDirect(centralDb, search = '', limit = 100) {
  const conn = await getProdConnection(centralDb, 4000);
  try {
    let sql = `SELECT id, domain, tenant_id FROM \`domains\``;
    const params = [];
    if (search) {
      sql += ` WHERE domain LIKE ? OR tenant_id LIKE ?`;
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += ` ORDER BY id DESC LIMIT ?;`;
    params.push(limit);

    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

module.exports = {
  getProdConnection,
  testProdConnection,
  lookupTenantDirect,
  dumpDatabaseDirect,
  getDomainsListDirect
};
