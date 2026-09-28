const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getConfig, updateConfig } = require('./config');
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
app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    port: cfg.port,
    prodHost: cfg.prod.host,
    prodPort: cfg.prod.port,
    prodUsername: cfg.prod.username,
    prodPassword: cfg.prod.password ? '••••••••' : '',
    hasProdPassword: !!cfg.prod.password,
    prodLmsDb: cfg.prod.lmsDb,
    prodTmsDb: cfg.prod.tmsDb,
    pmaUrl: cfg.prod.pmaUrl,
    localHost: cfg.local.host,
    localPort: cfg.local.port,
    localUsername: cfg.local.username,
    localPassword: cfg.local.password ? '••••••••' : '',
    localLmsDb: cfg.local.lmsDb,
    localTmsDb: cfg.local.tmsDb,
    mysqlBin: cfg.bins.mysql,
    mysqldumpBin: cfg.bins.mysqldump
  });
});

// 2. Update configuration
app.post('/api/config', (req, res) => {
  try {
    const updated = updateConfig(req.body);
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Test connections
app.get('/api/test-connection', async (req, res) => {
  const results = {
    local: { name: 'Local Laragon MySQL', status: 'testing' },
    prodDirect: { name: 'Production MySQL (Direct 3306)', status: 'testing' },
    prodPma: { name: 'Production phpMyAdmin (HTTPS)', status: 'testing' }
  };

  // Local MySQL test
  const localRes = await localDb.testLocalConnection();
  results.local = localRes.success 
    ? { success: true, message: `Connected (v${localRes.version})` }
    : { success: false, message: localRes.error };

  // Production Direct test
  const prodDirectRes = await mysqlDirect.testProdConnection();
  results.prodDirect = prodDirectRes.success 
    ? { success: true, message: `Connected (v${prodDirectRes.version})` }
    : { success: false, message: `Direct port 3306 unreachable: ${prodDirectRes.error}` };

  // Production PMA test
  const prodPmaRes = await testPmaConnection();
  results.prodPma = prodPmaRes.success 
    ? { success: true, message: 'Authenticated successfully' }
    : { success: false, message: prodPmaRes.error };

  res.json(results);
});

// 4. Domains autocomplete list
app.get('/api/domains', async (req, res) => {
  const system = req.query.system === 'lms' ? 'lms' : 'tms';
  const query = req.query.q || '';
  const cfg = getConfig();
  const centralDb = system === 'lms' ? cfg.prod.lmsDb : cfg.prod.tmsDb;

  try {
    // Try direct MySQL first
    try {
      const rows = await mysqlDirect.getDomainsListDirect(centralDb, query, 60);
      return res.json({ success: true, domains: rows });
    } catch {
      // Fallback to PMA session
      const pma = new PmaSession();
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
  const system = req.query.system === 'lms' ? 'lms' : 'tms';
  const domainInput = (req.query.domain || '').trim();
  const mode = req.query.mode || 'auto'; // 'auto', 'direct', 'pma'
  const dropIfExists = req.query.dropIfExists === 'true';
  const addLocalDomain = req.query.addLocalDomain !== 'false';

  const prodCentralDb = system === 'lms' ? cfg.prod.lmsDb : cfg.prod.tmsDb;
  const localCentralDb = system === 'lms' ? cfg.local.lmsDb : cfg.local.tmsDb;

  if (!domainInput) {
    sendEvent('error', { message: 'Domain name is required.' });
    return res.end();
  }

  log(`🚀 Starting Database Retrieval for [${domainInput}] in [${system.toUpperCase()}]...`);
  log(`Production Central DB: ${prodCentralDb} | Local Central DB: ${localCentralDb}`);

  try {
    // ----------------------------------------------------
    // STEP 1: Determine Connection Method & Connect
    // ----------------------------------------------------
    progress(1, 15, 'Connecting to Production Central Database...');
    let chosenMethod = mode;

    if (mode === 'auto') {
      log('Detecting optimal connection method...');
      const directTest = await mysqlDirect.testProdConnection();
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
      tenantInfo = await mysqlDirect.lookupTenantDirect(prodCentralDb, domainInput);
    } else {
      pmaSession = new PmaSession();
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
      exportResult = await mysqlDirect.dumpDatabaseDirect(databaseName, dumpFilePath, (msg) => log(msg));
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
    await localDb.prepareLocalDatabase(databaseName, dropIfExists);

    log(`Streaming & decompressing schema and data into local MySQL...`);
    await localDb.importSqlDump(databaseName, dumpFilePath, (msg) => log(msg));

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
    if (regResult.localDomain) {
      log(`🌐 Registered local test domain: [http://${regResult.localDomain}]`, 'success');
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
  console.log(`🚀 LMS/TMS Database Retrieval Tool is running!`);
  console.log(`👉 Open http://localhost:${PORT} in your web browser`);
  console.log(`====================================================\n`);
});
