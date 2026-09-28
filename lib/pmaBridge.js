const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');
const { getConfig } = require('../config');

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
  constructor() {
    this.cookies = {};
    this.token = null;
    this.sessionToken = null;
  }

  async login() {
    const cfg = getConfig().prod;
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

    return true;
  }

  async query(db, sql) {
    const cfg = getConfig().prod;
    const baseUrl = cfg.pmaUrl.replace(/\/$/, '');

    const queryParams = new URLSearchParams({
      db: db,
      sql_query: sql,
      token: this.sessionToken,
      server: '1',
      ajax_request: '1',
      pftext: 'F'
    }).toString();

    const r = await requestPma(`${baseUrl}/import.php`, {
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

  async lookupTenant(centralDb, domainInput) {
    const cleanDomain = domainInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    
    // 1. Query domains table (try exact match first)
    let sqlDomain = `SELECT id, domain, tenant_id FROM \`domains\` WHERE domain = '${cleanDomain}' OR tenant_id = '${cleanDomain}' LIMIT 1;`;
    let htmlDomain = await this.query(centralDb, sqlDomain);
    
    if (!htmlDomain || htmlDomain.includes('MySQL returned an empty result') || !htmlDomain.includes('<tbody')) {
      sqlDomain = `SELECT id, domain, tenant_id FROM \`domains\` WHERE domain LIKE '%${cleanDomain}%' LIMIT 1;`;
      htmlDomain = await this.query(centralDb, sqlDomain);
    }

    const domainTbodyMatch = htmlDomain.match(/<tbody>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/i);
    if (!domainTbodyMatch) {
      return null;
    }

    const domainCells = [...domainTbodyMatch[1].matchAll(/<td[^>]*class="[^"]*(?:data|text)[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]*>/g, '').trim());

    const matchedDomain = domainCells.find(c => c.includes('.')) || cleanDomain;
    let tenantId = domainCells.find(c => c && !c.includes('.') && isNaN(c));

    if (!tenantId) {
      tenantId = cleanDomain.split('.')[0];
    }

    // 2. Query tenants table specifically for this tenant
    const sqlTenant = `SELECT id, JSON_UNQUOTE(JSON_EXTRACT(data, '$.tenancy_db_name')) as tenancy_db_name, TO_BASE64(data) as b64_data FROM \`tenants\` WHERE id = '${tenantId}' LIMIT 1;`;
    const htmlTenant = await this.query(centralDb, sqlTenant);

    const tenantTbodyMatch = htmlTenant.match(/<tbody>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/i);
    let extractedDbName = null;
    let tenantData = {};

    if (tenantTbodyMatch) {
      const tenantCells = [...tenantTbodyMatch[1].matchAll(/<td[^>]*class="[^"]*(?:data|text)[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(m => m[1].replace(/<[^>]*>/g, '').trim());

      extractedDbName = tenantCells[1] && tenantCells[1] !== 'NULL' ? tenantCells[1] : null;
      const b64Raw = tenantCells[2] ? tenantCells[2].replace(/\s+/g, '') : '';
      if (b64Raw) {
        try {
          tenantData = JSON.parse(Buffer.from(b64Raw, 'base64').toString('utf-8'));
        } catch (e) {
          // ignore
        }
      }
    }

    // 3. Determine database name
    let dbName = tenantData.tenancy_db_name || extractedDbName;
    if (!dbName) {
      // Fallback check SHOW DATABASES LIKE
      const dbsHtml = await this.query(centralDb, `SHOW DATABASES LIKE '%${tenantId}%';`);
      const matchedDbs = [...dbsHtml.matchAll(/class="data[^"]*">([^<]+)<\/td>/g)].map(m => m[1]);
      if (matchedDbs.length > 0) {
        dbName = matchedDbs[0];
      } else {
        dbName = `tenant${tenantId}`;
      }
    }

    tenantData.tenancy_db_name = dbName;
    tenantData.db_name = dbName; // Stancl Tenancy internal key

    return {
      domain: matchedDomain,
      tenantId: tenantId,
      tenantData: tenantData,
      databaseName: dbName
    };
  }

  async getDomainsList(centralDb, search = '', limit = 100) {
    let sql = `SELECT domain, tenant_id FROM \`domains\``;
    if (search) {
      const cleanSearch = search.replace(/'/g, '');
      sql += ` WHERE domain LIKE '%${cleanSearch}%' OR tenant_id LIKE '%${cleanSearch}%'`;
    }
    sql += ` ORDER BY id DESC LIMIT ${limit};`;

    const html = await this.query(centralDb, sql);
    const rows = [];
    const trMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const tr of trMatches) {
      const texts = [...tr[1].matchAll(/<td[^>]*class="[^"]*(?:data|text)[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
      if (texts.length >= 2) {
        const domain = texts.find(t => t.includes('.'));
        const tenant = texts.find(t => t && !t.includes('.') && isNaN(t));
        if (domain) {
          rows.push({ domain, tenant_id: tenant || '' });
        }
      }
    }
    return rows;
  }

  async exportDatabase(dbName, outputSqlPath, onLog = () => {}) {
    const cfg = getConfig().prod;
    const baseUrl = cfg.pmaUrl.replace(/\/$/, '');

    onLog(`Connecting to phpMyAdmin export engine for: ${dbName}...`);

    // Load db_export.php to get fresh token and table list
    const rExportPage = await requestPma(`${baseUrl}/db_export.php?db=${encodeURIComponent(dbName)}`, {
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
    postParams.append('compression', 'none');

    for (const t of tableMatches) {
      postParams.append('table_select[]', t);
      postParams.append('table_structure[]', t);
      postParams.append('table_data[]', t);
    }

    const postBody = postParams.toString();
    onLog(`Initiating download for ${dbName} tables and data...`);

    return new Promise(async (resolve, reject) => {
      try {
        const parsed = new URL(`${baseUrl}/export.php`);
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
            'Referer': `${baseUrl}/db_export.php?db=${encodeURIComponent(dbName)}`,
            'User-Agent': 'Mozilla/5.0'
          },
          timeout: 180000 // 3 minutes timeout for large exports
        }, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`PMA Export failed with HTTP status ${res.statusCode}`));
          }

          const fileStream = fs.createWriteStream(outputSqlPath);
          let bytesReceived = 0;
          let lastLoggedMb = 0;

          res.on('data', (chunk) => {
            bytesReceived += chunk.length;
            const currentMb = Math.floor(bytesReceived / (1024 * 1024));
            if (currentMb > lastLoggedMb) {
              lastLoggedMb = currentMb;
              onLog(`Download progress: ${(bytesReceived / 1024 / 1024).toFixed(2)} MB received...`);
            }
          });

          res.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            onLog(`Export complete! Saved ${(bytesReceived / 1024 / 1024).toFixed(2)} MB to ${outputSqlPath}`);
            resolve({ bytes: bytesReceived, path: outputSqlPath, tables: tableMatches.length });
          });

          fileStream.on('error', (err) => {
            reject(err);
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Export request timed out after 3 minutes'));
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
async function testPmaConnection() {
  try {
    const session = new PmaSession();
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
