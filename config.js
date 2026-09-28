const path = require('path');
const fs = require('fs');
require('dotenv').config();

const envPath = path.resolve(__dirname, '.env');

function getConfig() {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    prod: {
      host: process.env.PROD_DB_HOST || '188.166.133.78',
      port: parseInt(process.env.PROD_DB_PORT || '3306', 10),
      username: process.env.PROD_DB_USERNAME || 'admin',
      password: process.env.PROD_DB_PASSWORD || '5WhXFwQ5gB6Y7cdZw',
      lmsDb: process.env.PROD_DB_LMS || 'alamlms',
      tmsDb: process.env.PROD_DB_TMS || 'alamlms_tenancy',
      pmaUrl: process.env.PMA_BASE_URL || 'https://lms.alamlms.com/db_access',
    },
    local: {
      host: process.env.LOCAL_DB_HOST || '127.0.0.1',
      port: parseInt(process.env.LOCAL_DB_PORT || '3306', 10),
      username: process.env.LOCAL_DB_USERNAME || 'root',
      password: process.env.LOCAL_DB_PASSWORD || '',
      lmsDb: process.env.LOCAL_DB_LMS || 'alamlms',
      tmsDb: process.env.LOCAL_DB_TMS || 'alamlms_tenancy',
    },
    bins: {
      mysql: process.env.MYSQL_BIN_PATH ? process.env.MYSQL_BIN_PATH.replace(/^"(.*)"$/, '$1') : 'C:\\laragon\\bin\\mysql\\mysql-8.0.30-winx64\\bin\\mysql.exe',
      mysqldump: process.env.MYSQLDUMP_BIN_PATH ? process.env.MYSQLDUMP_BIN_PATH.replace(/^"(.*)"$/, '$1') : 'C:\\laragon\\bin\\mysql\\mysql-8.0.30-winx64\\bin\\mysqldump.exe',
    }
  };
}

function updateConfig(newValues) {
  const current = getConfig();
  const merged = {
    PORT: newValues.port || current.port,
    PROD_DB_HOST: newValues.prodHost || current.prod.host,
    PROD_DB_PORT: newValues.prodPort || current.prod.port,
    PROD_DB_USERNAME: newValues.prodUsername || current.prod.username,
    PROD_DB_PASSWORD: newValues.prodPassword !== undefined ? newValues.prodPassword : current.prod.password,
    PROD_DB_LMS: newValues.prodLmsDb || current.prod.lmsDb,
    PROD_DB_TMS: newValues.prodTmsDb || current.prod.tmsDb,
    PMA_BASE_URL: newValues.pmaUrl || current.prod.pmaUrl,
    LOCAL_DB_HOST: newValues.localHost || current.local.host,
    LOCAL_DB_PORT: newValues.localPort || current.local.port,
    LOCAL_DB_USERNAME: newValues.localUsername || current.local.username,
    LOCAL_DB_PASSWORD: newValues.localPassword !== undefined ? newValues.localPassword : current.local.password,
    LOCAL_DB_LMS: newValues.localLmsDb || current.local.lmsDb,
    LOCAL_DB_TMS: newValues.localTmsDb || current.local.tmsDb,
    MYSQL_BIN_PATH: `"${newValues.mysqlBin || current.bins.mysql}"`,
    MYSQLDUMP_BIN_PATH: `"${newValues.mysqldumpBin || current.bins.mysqldump}"`,
  };

  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
  require('dotenv').config({ override: true });
  return getConfig();
}

module.exports = {
  getConfig,
  updateConfig
};
