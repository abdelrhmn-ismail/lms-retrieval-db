const path = require('path');
const fs = require('fs');
const envPath = path.resolve(__dirname, '.env');
require('dotenv').config({ path: envPath });

const IS_WINDOWS = process.platform === 'win32';
const LARAGON_MYSQL_DIR = 'C:\\laragon\\bin\\mysql\\mysql-8.0.30-winx64\\bin';

function stripQuotes(value) {
  return (value || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!IS_WINDOWS) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Looks a command name up in PATH (and common install dirs). Returns an absolute path or null. */
function findInPath(name) {
  const exts = IS_WINDOWS ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!IS_WINDOWS) {
    dirs.push('/usr/bin', '/usr/local/bin', '/usr/local/mysql/bin', '/opt/homebrew/bin', '/opt/lampp/bin', '/snap/bin');
  }
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolves a MySQL client binary for the current OS.
 * 1. Configured path, if it exists.
 * 2. If configured value is a bare command name (e.g. "mysql") or a Windows path on a
 *    non-Windows OS, search PATH for the configured basename, then the fallback names.
 * 3. On Windows, fall back to the default Laragon location.
 * Returns the configured value (or a sensible name) when nothing is found so error messages stay meaningful.
 */
function resolveBinary(configured, names) {
  const raw = stripQuotes(configured);
  if (raw && isExecutableFile(raw)) return raw;

  const candidates = [];
  if (raw) {
    // Take basename across both separator styles, drop .exe when not on Windows.
    let base = raw.split(/[\\/]/).pop();
    if (!IS_WINDOWS) base = base.replace(/\.exe$/i, '');
    if (base) candidates.push(base);
  }
  candidates.push(...names);

  for (const name of candidates) {
    const found = findInPath(name);
    if (found) return found;
  }

  if (IS_WINDOWS) {
    const laragon = path.win32.join(LARAGON_MYSQL_DIR, names[0] + '.exe');
    if (!raw || raw === laragon) return laragon;
  }
  return raw || names[0];
}

/**
 * Each system has its OWN production database server (they were split):
 *   LMS -> DBServer-LMS (64.225.66.108), central DB "alamlms"
 *   TMS -> DBServer-TMS (134.209.94.38), central DB "alamlms_tenancy"
 *   CMS -> DBServer-LMS (64.225.66.108, same server as LMS), central DB "alamlms_sites"
 * .env keys per system: <PREFIX>_DB_HOST, <PREFIX>_DB_PORT, <PREFIX>_DB_USERNAME, <PREFIX>_DB_PASSWORD,
 *                       <PREFIX>_CENTRAL_DB, <PREFIX>_PMA_URL, LOCAL_<PREFIX>_CENTRAL_DB,
 *                       LOCAL_<PREFIX>_APP_PORT (port of the local app, used for the "open locally" link)
 * `legacy` = the old single-server keys, still read as a fallback so an old .env keeps working.
 * No passwords here on purpose: they live only in .env (git-ignored).
 */
const SYSTEMS = {
  tms: {
    label: 'TMS Training',
    prefix: 'TMS',
    defaults: {
      host: '134.209.94.38',
      centralDb: 'alamlms_tenancy',
      pmaUrl: 'https://lms.alamlms.com/db_access',
      localCentralDb: 'alamlms_tenancy',
    },
    legacy: { centralDb: 'PROD_DB_TMS', localCentralDb: 'LOCAL_DB_TMS', pmaUrl: 'PMA_BASE_URL' },
  },
  lms: {
    label: 'LMS School',
    prefix: 'LMS',
    defaults: {
      host: '64.225.66.108',
      centralDb: 'alamlms',
      pmaUrl: 'https://phpmyadmin-lms.alamlms.com',
      localCentralDb: 'alamlms',
    },
    legacy: { centralDb: 'PROD_DB_LMS', localCentralDb: 'LOCAL_DB_LMS' },
  },
  cms: {
    label: 'CMS Sites',
    prefix: 'CMS',
    defaults: {
      host: '64.225.66.108',
      centralDb: 'alamlms_sites',
      pmaUrl: 'https://phpmyadmin-lms.alamlms.com',
      localCentralDb: 'alamlms_sites',
      localAppPort: '8080', // CMS docker-compose.yml maps 8080:80
    },
    legacy: {},
  },
};

const SYSTEM_KEYS = Object.keys(SYSTEMS);

/** First non-empty value among the given .env keys, else the default. */
function env(keys, fallback = '') {
  for (const k of [].concat(keys)) {
    if (!k) continue;
    const v = process.env[k];
    if (v !== undefined && stripQuotes(v) !== '') return stripQuotes(v);
  }
  return fallback;
}

function systemConfig(key) {
  const s = SYSTEMS[key];
  const p = s.prefix;
  return {
    key,
    label: s.label,
    host: env(`${p}_DB_HOST`, s.defaults.host),
    port: parseInt(env([`${p}_DB_PORT`, 'PROD_DB_PORT'], '3306'), 10),
    username: env([`${p}_DB_USERNAME`, 'PROD_DB_USERNAME'], 'admin'),
    password: env([`${p}_DB_PASSWORD`, 'PROD_DB_PASSWORD'], ''),
    centralDb: env([`${p}_CENTRAL_DB`, s.legacy.centralDb], s.defaults.centralDb),
    pmaUrl: env([`${p}_PMA_URL`, s.legacy.pmaUrl], s.defaults.pmaUrl),
    localCentralDb: env([`LOCAL_${p}_CENTRAL_DB`, s.legacy.localCentralDb], s.defaults.localCentralDb),
    localAppPort: env(`LOCAL_${p}_APP_PORT`, s.defaults.localAppPort || ''),
  };
}

/**
 * Validates a ?system= value. Unknown values are an error, never silently replaced by another
 * system (that would pull from the wrong server, e.g. a CMS request run against TMS).
 */
function normalizeSystem(value) {
  if (SYSTEM_KEYS.includes(value)) return value;
  throw new Error(`Unknown system "${value}". Known: ${SYSTEM_KEYS.join(', ')}. If you just updated the tool, restart it (npm start).`);
}

function getConfig() {
  const systems = {};
  for (const key of SYSTEM_KEYS) systems[key] = systemConfig(key);
  return {
    port: parseInt(env('PORT', '3000'), 10),
    // How many mysqldump processes pull table groups at the same time (1 = one at a time).
    dumpParallel: Math.min(8, Math.max(1, parseInt(env('DUMP_PARALLEL', '4'), 10) || 4)),
    systems,
    local: {
      host: env('LOCAL_DB_HOST', '127.0.0.1'),
      port: parseInt(env('LOCAL_DB_PORT', '3306'), 10),
      username: env('LOCAL_DB_USERNAME', 'root'),
      password: env('LOCAL_DB_PASSWORD', ''),
    },
    bins: {
      mysql: resolveBinary(process.env.MYSQL_BIN_PATH, ['mysql', 'mariadb']),
      mysqldump: resolveBinary(process.env.MYSQLDUMP_BIN_PATH, ['mysqldump', 'mariadb-dump']),
    }
  };
}

/**
 * Saves settings to .env. `newValues` shape:
 *   { port, local: {host, port, username, password}, systems: { lms: {host, port, username, password,
 *     centralDb, pmaUrl, localCentralDb}, ... }, mysqlBin, mysqldumpBin }
 * A production password that is undefined or '' keeps the current one.
 */
function updateConfig(newValues = {}) {
  const current = getConfig();
  const pick = (v, cur) => (v !== undefined && v !== null && v !== '' ? v : cur);
  const lines = [
    `PORT=${pick(newValues.port, current.port)}`,
    `DUMP_PARALLEL=${pick(newValues.dumpParallel, current.dumpParallel)}`,
    ''
  ];

  for (const key of SYSTEM_KEYS) {
    const p = SYSTEMS[key].prefix;
    const cur = current.systems[key];
    const nv = (newValues.systems || {})[key] || {};
    lines.push(
      `# ${SYSTEMS[key].label} production database`,
      `${p}_DB_HOST=${pick(nv.host, cur.host)}`,
      `${p}_DB_PORT=${pick(nv.port, cur.port)}`,
      `${p}_DB_USERNAME=${pick(nv.username, cur.username)}`,
      `${p}_DB_PASSWORD=${pick(nv.password, cur.password)}`,
      `${p}_CENTRAL_DB=${pick(nv.centralDb, cur.centralDb)}`,
      `${p}_PMA_URL=${pick(nv.pmaUrl, cur.pmaUrl)}`,
      `LOCAL_${p}_CENTRAL_DB=${pick(nv.localCentralDb, cur.localCentralDb)}`,
      // Port may be cleared on purpose (app on port 80), so '' is a valid new value here.
      `LOCAL_${p}_APP_PORT=${nv.localAppPort !== undefined ? nv.localAppPort : cur.localAppPort}`,
      ''
    );
  }

  const nl = newValues.local || {};
  lines.push(
    '# Local MySQL',
    `LOCAL_DB_HOST=${pick(nl.host, current.local.host)}`,
    `LOCAL_DB_PORT=${pick(nl.port, current.local.port)}`,
    `LOCAL_DB_USERNAME=${pick(nl.username, current.local.username)}`,
    `LOCAL_DB_PASSWORD=${nl.password !== undefined ? nl.password : current.local.password}`,
    '',
    '# MySQL client binaries',
    `MYSQL_BIN_PATH="${pick(newValues.mysqlBin, current.bins.mysql)}"`,
    `MYSQLDUMP_BIN_PATH="${pick(newValues.mysqldumpBin, current.bins.mysqldump)}"`,
    ''
  );

  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
  require('dotenv').config({ path: envPath, override: true });
  return getConfig();
}

module.exports = {
  SYSTEMS,
  SYSTEM_KEYS,
  normalizeSystem,
  getConfig,
  updateConfig,
  resolveBinary
};
