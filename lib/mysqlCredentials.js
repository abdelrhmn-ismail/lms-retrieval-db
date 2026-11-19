const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Passes MySQL credentials to the mysql / mysqldump command-line tools through a temporary
 * option file instead of "-pPASSWORD" on the command line.
 * A password on the command line is visible to every user in the process list (ps / Task Manager)
 * and was also printed in the tool's log.
 *
 * The file is created with permissions 0600 (owner only) in a private temp folder and must be
 * removed with cleanup() when the command has finished.
 *
 * Returns { arg, cleanup }: `arg` must be the FIRST argument given to mysql / mysqldump.
 */
function createDefaultsFile({ host, port, username, password }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyan-db-puller-'));
  const file = path.join(dir, 'client.cnf');
  // Option-file values in double quotes: escape backslashes and quotes.
  const quote = (v) => `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = ['[client]', `host=${quote(host)}`, `port=${port}`, `user=${quote(username)}`];
  if (password) lines.push(`password=${quote(password)}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });

  let removed = false;
  return {
    arg: `--defaults-extra-file=${file}`,
    cleanup() {
      if (removed) return;
      removed = true;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore: temp folder, the OS cleans it eventually
      }
    }
  };
}

module.exports = { createDefaultsFile };
