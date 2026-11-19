const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { getConfig } = require('../config');
const { cleanDomainInput } = require('./mysqlDirect');

/**
 * Helper to perform HTTP/HTTPS requests with cookies and redirects.
 */
function requestPma(urlStr, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(options.headers || {})
      },
      timeout: options.timeout || 30000
    };

    const req = client.request(reqOptions, (res) => {
      resolve(res);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`PMA request timed out: ${urlStr}`));
    });

    if (postBody) {
      req.write(postBody);
    }
    req.end();
  });
}

/**
 * Reads a response stream into a buffer or string.
 */
function readStream(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

function updateCookies(setCookieHeader, currentCookies = {}) {
  if (!setCookieHeader) return currentCookies;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of list) {
    const parts = c.split(';')[0].split('=');
    const name = parts[0].trim();
    const val = parts.slice(1).join('=');
    if (val === 'deleted' || !val) {
      delete currentCookies[name];
    } else {
      currentCookies[name] = val;
    }
  }
  return currentCookies;
}

function cookieString(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

class PmaSession {
  /** @param {string} system  'lms' / 'tms': which system's phpMyAdmin and credentials to use. */
  constructor(system) {
    if (!getConfig().systems[system]) throw new Error(`Unknown system: ${system}`);
    this.system = system;
    this.cookies = {};
    this.token = null;
    this.sessionToken = null;
  }

  async login() {
    const cfg = getConfig().systems[this.system];
    const baseUrl = cfg.pmaUrl.replace(/\/$/, '');

    // Step 1: Initial page load to fetch login token & session cookies
    const r1 = await requestPma(`${baseUrl}/index.php`);
    updateCookies(r1.headers['set-cookie'], this.cookies);
    const body1 = (await readStream(r1)).toString('utf-8');

    const tokenMatch = body1.match(/name="token"\s+value="([^"]+)"/) || body1.match(/token=([a-f0-9]+)/);
    if (!tokenMatch) {
      throw new Error('Unable to extract initial phpMyAdmin token from login page.');
    }
    this.token = tokenMatch[1];

    // Step 2: Post credentials
    const loginParams = new URLSearchParams({
      set_session: this.token,
      pma_username: cfg.username,
      pma_password: cfg.password,
      server: '1',
      target: 'index.php',
      token: this.token
    }).toString();

    const r2 = await requestPma(`${baseUrl}/index.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(loginParams),
        'Cookie': cookieString(this.cookies),
        'Referer': `${baseUrl}/index.php`
      }
    }, loginParams);

    updateCookies(r2.headers['set-cookie'], this.cookies);
    const body2 = (await readStream(r2)).toString('utf-8');

    // Follow redirect if given
    const r3 = await requestPma(`${baseUrl}/index.php`, {
      headers: {
        'Cookie': cookieString(this.cookies)
      }
    });
    updateCookies(r3.headers['set-cookie'], this.cookies);
    const body3 = (await readStream(r3)).toString('utf-8');

    // Extract valid post-login token
    const allTokens = [...body3.matchAll(/token[="': ]+([a-f0-9]{32})/gi)].map(m => m[1]);
    this.sessionToken = allTokens[0] || this.token;

    if (body3.includes('Access denied') || body3.includes('Cannot log in')) {
      throw new Error('phpMyAdmin login failed: Invalid username or password.');
    }

    // phpMyAdmin 5.1+ removed import.php / export.php / db_export.php; everything goes through
    // index.php?route=... (phpmyadmin-lms.alamlms.com is 5.2, the TMS one is older). Detect which.
    const probe = await requestPma(`${baseUrl}/import.php`, { headers: { 'Cookie': cookieString(this.cookies) } });
    const probeBody = (await readStream(probe)).toString('utf-8');
    this.routeMode = probe.statusCode === 404 || /File not found/i.test(probeBody);

    return true;
  }

  /** URL of a phpMyAdmin page for this server's version ("route" URLs on 5.1+, script files before). */
  pmaUrl(page, db = '') {
    const baseUrl = getConfig().systems[this.system].pmaUrl.replace(/\/$/, '');
    const dbParam = encodeURIComponent(db);
    if (this.routeMode) {
      return {
        import: `${baseUrl}/index.php?route=/import`,
        dbExport: `${baseUrl}/index.php?route=/database/export&db=${dbParam}`,
        export: `${baseUrl}/index.php?route=/export`,
      }[page];
    }
    return {
      import: `${baseUrl}/import.php`,
      dbExport: `${baseUrl}/db_export.php?db=${dbParam}`,
      export: `${baseUrl}/export.php`,
    }[page];
  }

  async query(db, sql) {
    const cfg = getConfig().systems[this.system];
    const baseUrl = cfg.pmaUrl.replace(/\/$/, '');

    const queryParams = new URLSearchParams({
      db: db,
      sql_query: sql,
      token: this.sessionToken,
      server: '1',
      ajax_request: '1',
      pftext: 'F'
    }).toString();

    const r = await requestPma(this.pmaUrl('import'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(queryParams),
        'Cookie': cookieString(this.cookies),
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${baseUrl}/index.php`
      }
    }, queryParams);

    const body = (await readStream(r)).toString('utf-8');
    try {
      const json = JSON.parse(body);
      if (json.error) {
        throw new Error(json.error.replace(/<[^>]*>/g, ' ').trim());
      }
      return json.message || '';
    } catch (e) {
      if (e.message.includes('Token mismatch')) {
        // Re-login and retry once
        await this.login();
        return this.query(db, sql);
      }
      throw e;
    }
  }

  /**
   * Same rules as lookupTenantDirect(): EXACT match only (domain with/without "www.", or tenant id),
   * otherwise an error listing similar domains. Never guesses the database name.
   * The SQL is sent as text through phpMyAdmin, so the input is limited to domain characters.
   */
  async lookupTenant(centralDb, domainInput) {
    const clean = cleanDomainInput(domainInput);
    if (!clean) return null;
    if (!/^[a-z0-9._-]+$/.test(clean)) {
      throw new Error(`"${clean}" is not a valid domain or tenant id (allowed: letters, digits, . _ -).`);
    }
    const bare = clean.replace(/^www\./, '');
    const variants = [...new Set([clean, bare, `www.${bare}`])].map(v => `'${v}'`).join(', ');

    // One value between markers: no guessing which HTML cell is which column.
    // TO_BASE64 keeps the JSON intact through phpMyAdmin's HTML; it adds line breaks, removed here.
    // Markers are split ('@@RO','W@@') because phpMyAdmin echoes the SQL text back in its page:
    // the whole marker must only ever appear in the real result rows.
    const sql = `SELECT CONCAT('@@RO', 'W@@', d.domain, '|', d.tenant_id, '|', REPLACE(REPLACE(TO_BASE64(t.data), CHAR(10), ''), CHAR(13), ''), '@@EN', 'D@@') AS r
      FROM \`domains\` d JOIN \`tenants\` t ON t.id = d.tenant_id
      WHERE d.domain IN (${variants}) OR d.tenant_id = '${clean}'
      ORDER BY (d.domain = '${clean}') DESC, d.id ASC LIMIT 1;`;
    const html = await this.query(centralDb, sql);
    const match = html.replace(/<[^>]*>/g, '').match(/@@ROW@@([^|@]*)\|([^|@]*)\|([A-Za-z0-9+/=\s]*)@@END@@/);

    if (!match) {
      const similar = await this.getDomainsList(centralDb, bare, 10);
      if (similar.length > 0) {
        const list = similar.map(r => `${r.domain} (tenant: ${r.tenant_id})`).join(' | ');
        throw new Error(`No exact match for "${clean}". Did you mean one of: ${list}`);
      }
      return null;
    }

    const [, domain, tenantId, b64] = match;
    let tenantData = {};
    try {
      tenantData = JSON.parse(Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf-8'));
    } catch {
      tenantData = {};
    }

    const dbName = tenantData.tenancy_db_name;
    if (!dbName) {
      throw new Error(`Tenant "${tenantId}" has no tenancy_db_name in ${centralDb}.tenants; cannot tell which database to pull.`);
    }
    tenantData.db_name = dbName; // Stancl Tenancy internal key

    return {
      domain: domain.trim(),
      tenantId: tenantId.trim(),
      tenantData,
      databaseName: dbName
    };
  }

  async getDomainsList(centralDb, search = '', limit = 100) {
    // Each row comes back as one value between markers (no guessing which cell is the domain:
    // domains like "eocean" or "test" have no dot).
    // Markers split in the SQL text: phpMyAdmin echoes the query back in its page.
    let sql = `SELECT CONCAT('@@RO', 'W@@', domain, '|', tenant_id, '@@EN', 'D@@') AS r FROM \`domains\``;
    if (search) {
      // Sent as SQL text through phpMyAdmin: keep only domain characters.
      const cleanSearch = String(search).toLowerCase().replace(/[^a-z0-9._-]/g, '');
      sql += ` WHERE domain LIKE '%${cleanSearch}%' OR tenant_id LIKE '%${cleanSearch}%'`;
    }
    sql += ` ORDER BY id DESC LIMIT ${parseInt(limit, 10) || 100};`;

    const text = (await this.query(centralDb, sql)).replace(/<[^>]*>/g, '');
    return [...text.matchAll(/@@ROW@@([^|@]*)\|([^|@]*)@@END@@/g)]
      .map(m => ({ domain: m[1].trim(), tenant_id: m[2].trim() }));
  }

  async exportDatabase(dbName, outputSqlPath, onLog = () => {}) {
    const cfg = getConfig().systems[this.system];
    const baseUrl = cfg.pmaUrl.replace(/\/$/, '');

    onLog(`Connecting to phpMyAdmin export engine for: ${dbName}...`);

    // Load the database export page to get a fresh token and the table list
    const rExportPage = await requestPma(this.pmaUrl('dbExport', dbName), {
      headers: {
        'Cookie': cookieString(this.cookies),
        'Referer': `${baseUrl}/index.php`
      }
    });
    updateCookies(rExportPage.headers['set-cookie'], this.cookies);
    const exportPageHtml = (await readStream(rExportPage)).toString('utf-8');

    const pageToken = (exportPageHtml.match(/name="token"\s+value="([^"]+)"/) || [])[1] || this.sessionToken;

    // Extract table checkboxes
    const tableMatches = [...exportPageHtml.matchAll(/name="table_select\[\]"[^>]*value="([^"]+)"/gi)].map(m => m[1]);
    onLog(`Discovered ${tableMatches.length} tables in ${dbName}.`);

    // Detect exact compression value from phpMyAdmin export form (usually 'gzip')
    let compressionVal = 'gzip';
    const compSelectMatch = exportPageHtml.match(/<select[^>]*name="compression"[^>]*>([\s\S]*?)<\/select>/i);
    if (compSelectMatch) {
      const gzipOptMatch = compSelectMatch[1].match(/<option[^>]*value="([^"]+)"[^>]*>[^<]*gzip/i);
      if (gzipOptMatch) {
        compressionVal = gzipOptMatch[1];
      }
    }

    const postParams = new URLSearchParams();
    postParams.append('db', dbName);
    postParams.append('token', pageToken);
    postParams.append('export_type', 'database');
    postParams.append('export_method', 'custom');
    postParams.append('quick_or_custom', 'custom');
    postParams.append('what', 'sql');
    postParams.append('sql_structure_or_data', 'structure_and_data');
    postParams.append('sql_create_table', 'something');
    postParams.append('sql_drop_table', 'something');
    postParams.append('sql_auto_increment', 'something');
    postParams.append('sql_create_view', 'something');
    postParams.append('sql_procedure_function', 'something');
    postParams.append('sql_create_trigger', 'something');
    postParams.append('sql_backquotes', 'something');
    postParams.append('sql_type', 'INSERT');
    postParams.append('sql_insert_syntax', 'both');
    postParams.append('output_format', 'sendit');
    postParams.append('filename_template', '@DATABASE@');
    postParams.append('charset_of_file', 'utf-8');
    postParams.append('compression', compressionVal);

    for (const t of tableMatches) {
      postParams.append('table_select[]', t);
      postParams.append('table_structure[]', t);
      postParams.append('table_data[]', t);
    }

    const postBody = postParams.toString();
    onLog(`Initiating download for ${dbName} tables and data (Compression: ${compressionVal})...`);

    return new Promise(async (resolve, reject) => {
      try {
        const parsed = new URL(this.pmaUrl('export'));
        const isHttps = parsed.protocol === 'https:';
        const client = isHttps ? https : http;

        const req = client.request({
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postBody),
            'Cookie': cookieString(this.cookies),
            'Referer': this.pmaUrl('dbExport', dbName),
            'User-Agent': 'Mozilla/5.0',
            'Accept-Encoding': 'gzip, deflate'
          },
          timeout: 600000 // 10 minutes timeout for large database exports
        }, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`PMA Export failed with HTTP status ${res.statusCode}`));
          }

          const fileStream = fs.createWriteStream(outputSqlPath);
          let bytesReceived = 0;
          let lastLoggedUnit = 0;

          res.on('data', (chunk) => {
            bytesReceived += chunk.length;
            const currentUnit = Math.floor(bytesReceived / (1024 * 512));
            if (currentUnit > lastLoggedUnit) {
              lastLoggedUnit = currentUnit;
              onLog(`Download progress: ${(bytesReceived / 1024 / 1024).toFixed(2)} MB received (gzipped)...`);
            }
          });

          res.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();

            if (bytesReceived === 0) {
              return reject(new Error('Export failed: received 0 bytes from phpMyAdmin.'));
            }

            // Verify if phpMyAdmin returned an HTML/JSON error rather than a gzipped file
            if (fs.existsSync(outputSqlPath)) {
              try {
                const fd = fs.openSync(outputSqlPath, 'r');
                const buf = Buffer.alloc(Math.min(bytesReceived, 512));
                fs.readSync(fd, buf, 0, buf.length, 0);
                fs.closeSync(fd);

                // If not gzip magic bytes (0x1f 0x8b), check for HTML error
                if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
                  const str = buf.toString('utf-8');
                  if (str.includes('<div class="error"') || str.includes('Fatal error') || str.includes('Token mismatch')) {
                    const cleanErr = str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
                    return reject(new Error(`PMA Export returned an error: ${cleanErr}`));
                  }
                }
              } catch {
                // ignore
              }
            }

            onLog(`Export complete! Saved ${(bytesReceived / 1024 / 1024).toFixed(2)} MB (gzipped) to ${path.basename(outputSqlPath)}`);
            resolve({ bytes: bytesReceived, path: outputSqlPath, tables: tableMatches.length, compression: compressionVal });
          });

          fileStream.on('error', (err) => {
            reject(err);
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Export request timed out after 10 minutes'));
        });

        req.write(postBody);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

/**
 * Tests connection via phpMyAdmin.
 */
async function testPmaConnection(system) {
  try {
    const session = new PmaSession(system);
    await session.login();
    return { success: true, message: 'Successfully authenticated with phpMyAdmin!' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  PmaSession,
  testPmaConnection
};
