const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getConfig, updateConfig, normalizeSystem, SYSTEM_KEYS } = require('./config');
const localDb = require('./lib/localDb');
const mysqlDirect = require('./lib/mysqlDirect');
const { PmaSession, testPmaConnection } = require('./lib/pmaBridge');

const app = express();
const PORT = getConfig().port || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure temp/dumps folder exists
const dumpsDir = path.join(__dirname, 'dumps');
if (!fs.existsSync(dumpsDir)) {
  fs.mkdirSync(dumpsDir, { recursive: true });
}

// 1. Get current configuration
// Passwords are never sent to the browser, only whether one is set.
app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  const systems = {};
  for (const key of SYSTEM_KEYS) {
    const { password, ...rest } = cfg.systems[key];
    systems[key] = { ...rest, hasPassword: !!password };
  }
  res.json({
    port: cfg.port,
    systems,
    local: {
      host: cfg.local.host,
      port: cfg.local.port,
      username: cfg.local.username,
      hasPassword: !!cfg.local.password,
    },
    mysqlBin: cfg.bins.mysql,
    mysqldumpBin: cfg.bins.mysqldump
  });
});

// 2. Update configuration
app.post('/api/config', (req, res) => {
  try {
    updateConfig(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Test connections
// Result shape: { local: {success, message}, systems: { lms: {label, host, direct: {...}, pma: {...}}, ... } }
app.get('/api/test-connection', async (req, res) => {
  const cfg = getConfig();
  const localRes = await localDb.testLocalConnection();
  const results = {
    local: localRes.success
      ? { success: true, message: `Connected (v${localRes.version})` }
      : { success: false, message: localRes.error },
    systems: {}
  };

  // Each system has its own server: test them in parallel.
  await Promise.all(SYSTEM_KEYS.map(async (key) => {
    const sys = cfg.systems[key];
    const [directRes, pmaRes] = await Promise.all([
      mysqlDirect.testProdConnection(key),
      testPmaConnection(key)
    ]);
    results.systems[key] = {
      label: sys.label,
      host: sys.host,
      direct: directRes.success
        ? { success: true, message: `Connected to ${sys.host} (v${directRes.version})` }
        : { success: false, message: `Direct ${sys.host}:${sys.port} unreachable: ${directRes.error}` },
      pma: pmaRes.success
        ? { success: true, message: `Authenticated (${sys.pmaUrl})` }
        : { success: false, message: `${sys.pmaUrl}: ${pmaRes.error}` }
    };
  }));

  res.json(results);
});

// 4. Domains autocomplete list
app.get('/api/domains', async (req, res) => {
  let system;
  try {
    system = normalizeSystem(req.query.system);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  const query = req.query.q || '';
  const centralDb = getConfig().systems[system].centralDb;

  try {
    // Try direct MySQL first
    try {
      const rows = await mysqlDirect.getDomainsListDirect(system, query, 60);
      return res.json({ success: true, domains: rows });
    } catch {
      // Fallback to PMA session
      const pma = new PmaSession(system);
      await pma.login();
      const rows = await pma.getDomainsList(centralDb, query, 60);
      return res.json({ success: true, domains: rows });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Real-time Database Pull via SSE
app.get('/api/pull', async (req, res) => {
  // Setup Server-Sent Events headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const log = (text, type = 'info') => {
    sendEvent('log', { text, type, time: new Date().toLocaleTimeString() });
  };

  const progress = (step, percent, message) => {
    sendEvent('progress', { step, percent, message });
  };

  const startTime = Date.now();
  const cfg = getConfig();
  let system;
  try {
    system = normalizeSystem(req.query.system);
  } catch (err) {
    sendEvent('error', { message: err.message });
    return res.end();
  }
  const sys = cfg.systems[system];
  const domainInput = (req.query.domain || '').trim();
  const mode = req.query.mode || 'auto'; // 'auto', 'direct', 'pma'
  const dropIfExists = req.query.dropIfExists === 'true';
  const addLocalDomain = req.query.addLocalDomain !== 'false';

  const prodCentralDb = sys.centralDb;
  const localCentralDb = sys.localCentralDb;

  if (!domainInput) {
    sendEvent('error', { message: 'Domain name is required.' });
    return res.end();
  }

  log(`🚀 Starting Database Retrieval for [${domainInput}] in [${system.toUpperCase()}]...`);
  log(`Production server: ${sys.host}:${sys.port} | Central DB: ${prodCentralDb} | Local Central DB: ${localCentralDb}`);

  try {
    // ----------------------------------------------------
    // STEP 1: Determine Connection Method & Connect
    // ----------------------------------------------------
    progress(1, 15, 'Connecting to Production Central Database...');
    let chosenMethod = mode;

    if (mode === 'auto') {
      log('Detecting optimal connection method...');
      const directTest = await mysqlDirect.testProdConnection(system);
      if (directTest.success) {
        chosenMethod = 'direct';
        log('⚡ Direct MySQL connection is available! Using native mysqldump.', 'success');
      } else {
        chosenMethod = 'pma';
        log(`🔒 Port 3306 is not directly accessible. Using authenticated phpMyAdmin HTTPS tunnel.`, 'warning');
      }
    } else {
      log(`Using requested mode: ${chosenMethod.toUpperCase()}`);
    }

    // ----------------------------------------------------
    // STEP 2: Lookup Tenant & Database in Production
    // ----------------------------------------------------
    progress(2, 35, `Looking up tenant for "${domainInput}"...`);
    let tenantInfo = null;
    let pmaSession = null;

    if (chosenMethod === 'direct') {
      tenantInfo = await mysqlDirect.lookupTenantDirect(system, domainInput);
    } else {
      pmaSession = new PmaSession(system);
      await pmaSession.login();
      tenantInfo = await pmaSession.lookupTenant(prodCentralDb, domainInput);
    }

    if (!tenantInfo) {
      throw new Error(`No tenant found matching domain "${domainInput}" in production database ${prodCentralDb}.`);
    }

    const { domain, tenantId, tenantData, databaseName } = tenantInfo;
    log(`✅ Tenant Identified: [${tenantId}]`, 'success');
    log(`🔗 Production Domain: ${domain}`);
    log(`💾 Production Database: [${databaseName}]`, 'success');

    // ----------------------------------------------------
    // STEP 3: Export Database from Production (Gzipped)
    // ----------------------------------------------------
    progress(3, 55, `Exporting database "${databaseName}" from production (gzipped)...`);
    const dumpFileName = `${databaseName}_${Date.now()}.sql.gz`;
    const dumpFilePath = path.join(dumpsDir, dumpFileName);

    let exportResult = null;
    if (chosenMethod === 'direct') {
      exportResult = await mysqlDirect.dumpDatabaseDirect(system, databaseName, dumpFilePath, (msg) => log(msg));
    } else {
      exportResult = await pmaSession.exportDatabase(databaseName, dumpFilePath, (msg) => log(msg));
    }

    const fileSizeMb = (fs.statSync(dumpFilePath).size / (1024 * 1024)).toFixed(2);
    log(`📥 Successfully downloaded gzipped dump: ${dumpFileName} (${fileSizeMb} MB compressed)`, 'success');

    // ----------------------------------------------------
    // STEP 4: Prepare & Import into Local MySQL
    // ----------------------------------------------------
    progress(4, 75, `Creating and restoring local database "${databaseName}"...`);
    log(`Preparing local database [${databaseName}] (dropIfExists: ${dropIfExists})...`);
    const { skipBinlog } = await localDb.prepareLocalDatabase(databaseName, dropIfExists);

    log(`Streaming & decompressing schema and data into local MySQL${skipBinlog ? ' (binary log off for this import)' : ''}...`);
    await localDb.importSqlDump(databaseName, dumpFilePath, (msg) => log(msg), { skipBinlog });

    const dbStats = await localDb.getLocalDatabaseStats(databaseName);
    log(`✅ Local database restored! Total tables: ${dbStats.tableCount}`, 'success');

    // ----------------------------------------------------
    // STEP 5: Register Tenant & Domain in Local Central DB
    // ----------------------------------------------------
    progress(5, 95, `Registering tenant and domain in local central DB "${localCentralDb}"...`);
    const regResult = await localDb.registerInLocalCentralDb({
      centralDb: localCentralDb,
      tenantId,
      domain,
      tenantData,
      dbName: databaseName,
      addLocalDomain
    });

    log(`Registered domain: ${domain} -> ${tenantId} in local ${localCentralDb}`, 'success');
    // Link to open the tenant in the local app (CMS runs on :8080 via docker-compose).
    const localUrl = regResult.localDomain
      ? `http://${regResult.localDomain}${sys.localAppPort ? `:${sys.localAppPort}` : ''}`
      : null;
    if (localUrl) {
      log(`🌐 Registered local test domain: [${localUrl}]`, 'success');
    }

    // Clean up dump file after successful import
    try {
      if (fs.existsSync(dumpFilePath)) {
        fs.unlinkSync(dumpFilePath);
        log(`Cleaned up temporary dump file (${dumpFileName}).`);
      }
    } catch {
      // ignore
    }

    const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    progress(5, 100, 'Database retrieval completed successfully!');
    log(`🎉 ALL DONE in ${durationSeconds} seconds!`, 'success');

    sendEvent('done', {
      success: true,
      system: system.toUpperCase(),
      tenantId,
      domain,
      localDomain: regResult.localDomain,
      localUrl,
      dbName: databaseName,
      tableCount: dbStats.tableCount,
      fileSizeMb,
      durationSeconds
    });

  } catch (err) {
    log(`❌ Error: ${err.message}`, 'error');
    sendEvent('error', { message: err.message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n====================================================`);
  console.log(`🚀 LMS/TMS/CMS Database Retrieval Tool is running!`);
  console.log(`👉 Open http://localhost:${PORT} in your web browser`);
  console.log(`====================================================\n`);
});
