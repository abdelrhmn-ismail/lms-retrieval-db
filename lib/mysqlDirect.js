const mysql = require('mysql2/promise');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getConfig } = require('../config');
const { createDefaultsFile } = require('./mysqlCredentials');

/**
 * Creates a direct connection to the production MySQL server of one system (lms / tms / cms).
 */
async function getProdConnection(system, database = null, timeoutMs = 4000) {
  const cfg = getConfig().systems[system];
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
 * Tests the direct MySQL connection to one system's production server.
 */
async function testProdConnection(system) {
  try {
    const conn = await getProdConnection(system, null, 3500);
    const [rows] = await conn.query('SELECT VERSION() as version, CURRENT_USER() as user;');
    await conn.end();
    return { success: true, version: rows[0].version, user: rows[0].user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * "https://www.Site.com:8080/page?x" -> "www.site.com"
 */
function cleanDomainInput(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
}

/**
 * Looks up a domain (or tenant id) in the system's production central database.
 *
 * EXACT matches only (the domain as typed, with or without "www.", or the tenant id).
 * Before, it fell back to "LIKE %text%" and silently took the first hit: typing "kyanalam"
 * could pick en.kyanalam.com and then drop/replace the wrong local database.
 * Now, with no exact match, it throws an error that lists the similar domains to choose from.
 *
 * Returns null only when nothing at all is similar.
 */
async function lookupTenantDirect(system, domainInput) {
  const conn = await getProdConnection(system, getConfig().systems[system].centralDb, 8000);
  try {
    const clean = cleanDomainInput(domainInput);
    if (!clean) return null;
    const bare = clean.replace(/^www\./, '');
    const variants = [...new Set([clean, bare, `www.${bare}`])];

    const [rows] = await conn.query(`
      SELECT d.id AS domain_id, d.domain, d.tenant_id, t.data AS tenant_data
      FROM \`domains\` d
      JOIN \`tenants\` t ON d.tenant_id = t.id
      WHERE d.domain IN (?) OR d.tenant_id = ?
      ORDER BY (d.domain = ?) DESC, d.id ASC
      LIMIT 1;
    `, [variants, clean, clean]);

    if (!rows || rows.length === 0) {
      const like = `%${bare.replace(/[\\%_]/g, '\\$&')}%`;
      const [similar] = await conn.query(
        'SELECT domain, tenant_id FROM `domains` WHERE domain LIKE ? OR tenant_id LIKE ? ORDER BY domain LIMIT 10;',
        [like, like]
      );
      if (similar.length > 0) {
        const list = similar.map(r => `${r.domain} (tenant: ${r.tenant_id})`).join(' | ');
        throw new Error(`No exact match for "${clean}". Did you mean one of: ${list}`);
      }
      return null;
    }

    const row = rows[0];
    let parsedData = {};
    try {
      parsedData = typeof row.tenant_data === 'string' ? JSON.parse(row.tenant_data) : (row.tenant_data || {});
    } catch {
      parsedData = {};
    }

    // Every tenant in all three systems has tenancy_db_name (checked in production).
    // Never guess the database name: a guess could pull or overwrite the wrong database.
    const dbName = parsedData.tenancy_db_name;
    if (!dbName) {
      throw new Error(`Tenant "${row.tenant_id}" has no tenancy_db_name in ${getConfig().systems[system].centralDb}.tenants; cannot tell which database to pull.`);
    }
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

/** Splits tables into `count` groups of similar total size (largest first, into the lightest group). */
function splitIntoGroups(tables, count) {
  const groups = Array.from({ length: Math.min(count, tables.length) }, () => ({ size: 0, names: [] }));
  for (const t of [...tables].sort((a, b) => b.size - a.size)) {
    const lightest = groups.reduce((min, g) => (g.size < min.size ? g : min), groups[0]);
    lightest.names.push(t.name);
    lightest.size += t.size;
  }
  return groups.filter(g => g.names.length > 0);
}

/**
 * Runs one mysqldump process and writes its output to a gzip file.
 * Resolves only when mysqldump has exited AND the file is fully written.
 */
function runMysqldumpToGzip(bin, args, outPath, onBytes, registerProc) {
  return new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(outPath);
    const gzip = zlib.createGzip({ level: 6 });
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    registerProc(proc);

    let stderr = '';
    let exitCode = null;
    let fileWritten = false;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(err);
    };
    const tryFinish = () => {
      if (settled || exitCode === null || !fileWritten) return;
      settled = true;
      if (exitCode === 0) return resolve();
      const filteredError = stderr
        .split('\n')
        .filter(l => l.trim() && !/column statistics not supported/i.test(l))
        .join('\n')
        .trim();
      reject(new Error(filteredError || `mysqldump exited with code ${exitCode}`));
    };

    proc.stdout.on('data', (chunk) => onBytes(chunk.length));
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => fail(new Error(`Failed to start mysqldump: ${err.message}`)));
    proc.on('close', (code) => { exitCode = code; tryFinish(); });

    gzip.on('error', (err) => fail(new Error(`Gzip compression error: ${err.message}`)));
    outStream.on('error', (err) => fail(new Error(`Failed to write dump file: ${err.message}`)));
    outStream.on('finish', () => { fileWritten = true; tryFinish(); });

    proc.stdout.pipe(gzip).pipe(outStream);
  });
}

/** Appends `files` (in order) to `outPath`. Concatenated gzip files are one valid gzip stream. */
async function concatFiles(files, outPath) {
  const out = fs.createWriteStream(outPath);
  for (const f of files) {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(f);
      input.on('error', reject);
      input.on('end', resolve);
      input.pipe(out, { end: false });
    });
  }
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });
}

/**
 * Dumps a database from the system's production server into one .sql.gz file.
 *
 * SPEED: mysqldump sends ~15-18 small queries per table, one after another. Over the
 * ~65ms link to the Amsterdam servers that alone was ~58s for a 50-table CMS site, even with
 * almost no data. So tables are split into `dumpParallel` groups dumped at the same time
 * (DUMP_PARALLEL in .env, default 4; 1 = old behaviour). Views and routines go last, because
 * views depend on tables. Each group is its own consistent snapshot; fine for a local
 * debugging copy, use DUMP_PARALLEL=1 for one single snapshot of the whole database.
 *
 * The output file must end with .gz.
 */
async function dumpDatabaseDirect(system, dbName, outputSqlPath, onLog = () => {}) {
  const cfg = getConfig();
  const prod = cfg.systems[system];
  const mysqldumpBin = cfg.bins.mysqldump;

  if (!fs.existsSync(mysqldumpBin)) {
    throw new Error(`mysqldump binary not found (${mysqldumpBin}). Install the MySQL/MariaDB client (e.g. "sudo apt install mysql-client") or set the mysqldump path in Settings.`);
  }

  // 1. List tables and views (with size, to balance the groups).
  const conn = await getProdConnection(system, null, 8000);
  let objects;
  try {
    [objects] = await conn.query(`
      SELECT TABLE_NAME AS name, TABLE_TYPE AS type, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS size
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?;
    `, [dbName]);
  } finally {
    await conn.end();
  }
  const tables = objects.filter(o => o.type === 'BASE TABLE').map(o => ({ name: o.name, size: Number(o.size) }));
  const views = objects.filter(o => o.type === 'VIEW').map(o => o.name);
  if (tables.length === 0 && views.length === 0) {
    throw new Error(`Database "${dbName}" has no tables on ${prod.host} (does it exist?).`);
  }

  const groups = splitIntoGroups(tables, cfg.dumpParallel);
  onLog(`Found ${tables.length} tables${views.length ? ` and ${views.length} views` : ''}. Dumping in ${groups.length} parallel group(s)...`);

  // 2. Build the jobs. Order of the jobs = order inside the final file.
  const common = ['--single-transaction', '--quick', '--default-character-set=utf8mb4', '--no-tablespaces', '--skip-dump-date'];
  const jobs = groups.map((g, i) => ({
    label: `group ${i + 1}/${groups.length} (${g.names.length} tables)`,
    args: [...common, '--triggers', '--skip-routines', dbName, ...g.names],
  }));
  jobs.push(views.length > 0
    ? { label: `views (${views.length}) + routines`, args: [...common, '--skip-triggers', '--routines', dbName, ...views] }
    : { label: 'routines', args: [...common, '--skip-triggers', '--routines', '--no-create-info', '--no-data', dbName] });

  // 3. Run them: table groups in parallel, then the views/routines job.
  const creds = createDefaultsFile(prod);
  const partFiles = jobs.map((_, i) => `${outputSqlPath}.part${i}`);
  const procs = [];
  let totalBytes = 0;
  let lastLoggedMb = 0;
  const onBytes = (n) => {
    totalBytes += n;
    const mb = Math.floor(totalBytes / (1024 * 1024));
    if (mb >= lastLoggedMb + 5) {
      lastLoggedMb = mb;
      onLog(`Dump progress: ${mb} MB (uncompressed) received...`);
    }
  };
  const runJob = async (job, i) => {
    await runMysqldumpToGzip(mysqldumpBin, [creds.arg, ...job.args], partFiles[i], onBytes, (p) => procs.push(p));
    onLog(`✔ Dumped ${job.label}`);
  };

  try {
    const tableJobs = jobs.slice(0, -1);
    await Promise.all(tableJobs.map((job, i) => runJob(job, i)));
    await runJob(jobs[jobs.length - 1], jobs.length - 1);
    await concatFiles(partFiles, outputSqlPath);
  } catch (err) {
    procs.forEach(p => { try { p.kill(); } catch { /* already exited */ } });
    throw err;
  } finally {
    creds.cleanup();
    partFiles.forEach(f => fs.rmSync(f, { force: true }));
  }

  onLog(`mysqldump complete: ${(totalBytes / 1024 / 1024).toFixed(2)} MB uncompressed, saved to ${path.basename(outputSqlPath)}`);
  return { bytes: totalBytes, path: outputSqlPath };
}

/**
 * Fetches recent domains from the system's production central DB for auto-complete.
 */
async function getDomainsListDirect(system, search = '', limit = 100) {
  const conn = await getProdConnection(system, getConfig().systems[system].centralDb, 4000);
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
  cleanDomainInput,
  lookupTenantDirect,
  dumpDatabaseDirect,
  getDomainsListDirect
};
