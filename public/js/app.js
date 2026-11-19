document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const pullForm = document.getElementById('pullForm');
  const domainInput = document.getElementById('domainInput');
  const pasteBtn = document.getElementById('pasteBtn');
  const submitBtn = document.getElementById('submitBtn');
  const loadDomainsBtn = document.getElementById('loadDomainsBtn');
  const domainsSuggestions = document.getElementById('domainsSuggestions');
  const dropIfExistsSwitch = document.getElementById('dropIfExistsSwitch');
  const addLocalDomainSwitch = document.getElementById('addLocalDomainSwitch');

  // Progress Elements
  const progressSection = document.getElementById('progressSection');
  const progressBar = document.getElementById('progressBar');
  const percentBadge = document.getElementById('percentBadge');
  const progressTitle = document.getElementById('progressTitle');
  const currentActionText = document.getElementById('currentActionText');

  // Result Elements
  const resultCard = document.getElementById('resultCard');
  const resTenantId = document.getElementById('resTenantId');
  const resDbName = document.getElementById('resDbName');
  const resTableCount = document.getElementById('resTableCount');
  const resDuration = document.getElementById('resDuration');
  const resLocalUrl = document.getElementById('resLocalUrl');
  const openLocalAppBtn = document.getElementById('openLocalAppBtn');
  const resetBtn = document.getElementById('resetBtn');

  // Terminal Log
  const terminalLog = document.getElementById('terminalLog');
  const clearLogBtn = document.getElementById('clearLogBtn');

  // Status & Settings
  const connStatusBadge = document.getElementById('connStatusBadge');
  const connStatusText = document.getElementById('connStatusText');
  const testConnBtn = document.getElementById('testConnBtn');
  const connTestResults = document.getElementById('connTestResults');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');

  let currentEventSource = null;

  // 1. Check connections on page load
  checkStatus();

  async function checkStatus() {
    try {
      const res = await fetch('/api/test-connection');
      const data = await res.json();

      const isLocalOk = data.local?.success;
      const systems = Object.values(data.systems || {});
      // A system is reachable if direct MySQL or its phpMyAdmin works.
      const reachable = systems.filter(s => s.direct?.success || s.pma?.success);
      const allDirect = systems.length > 0 && systems.every(s => s.direct?.success);

      const dot = connStatusBadge.querySelector('.status-dot');

      if (isLocalOk && systems.length > 0 && reachable.length === systems.length) {
        dot.className = 'status-dot online';
        connStatusText.textContent = allDirect ? 'All Servers (Direct) & Local Connected' : 'All Servers & Local Connected';
      } else if (isLocalOk) {
        dot.className = 'status-dot warning';
        const down = systems.filter(s => !(s.direct?.success || s.pma?.success)).map(s => s.label);
        connStatusText.textContent = down.length ? `Local Ready, unreachable: ${down.join(', ')}` : 'Local MySQL Ready';
      } else {
        dot.className = 'status-dot offline';
        connStatusText.textContent = 'Local MySQL Disconnected';
      }
    } catch {
      connStatusText.textContent = 'Server Offline';
    }
  }

  // 2. Paste Button
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        domainInput.value = text.trim();
        domainInput.focus();
      }
    } catch {
      domainInput.focus();
    }
  });

  // 3. Clear Log
  clearLogBtn.addEventListener('click', () => {
    terminalLog.innerHTML = '<div class="text-secondary">// Log cleared.</div>';
  });

  function appendLog(text, type = 'info', time = null) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `[${time || new Date().toLocaleTimeString()}]`;

    const textSpan = document.createElement('span');
    textSpan.className = `log-${type}`;
    textSpan.textContent = text;

    entry.appendChild(timeSpan);
    entry.appendChild(textSpan);
    terminalLog.appendChild(entry);
    terminalLog.scrollTop = terminalLog.scrollHeight;
  }

  // 4. Update Pipeline Visual Steps
  function updateSteps(step) {
    for (let i = 1; i <= 5; i++) {
      const stepElem = document.getElementById(`step${i}`);
      const lineElem = document.getElementById(`line${i}`);

      if (i < step) {
        stepElem.className = 'step-item completed';
        if (lineElem) lineElem.className = 'step-line completed';
      } else if (i === step) {
        stepElem.className = 'step-item active';
        if (lineElem) lineElem.className = 'step-line';
      } else {
        stepElem.className = 'step-item';
        if (lineElem) lineElem.className = 'step-line';
      }
    }
  }

  // 5. Submit Form -> Real-time Retrieval via SSE
  pullForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const domain = domainInput.value.trim();
    if (!domain) return;

    const system = document.querySelector('input[name="systemRadio"]:checked').value;
    const mode = document.querySelector('input[name="modeRadio"]:checked').value;
    const dropIfExists = dropIfExistsSwitch.checked;
    const addLocalDomain = addLocalDomainSwitch.checked;

    // Reset UI states
    if (currentEventSource) {
      currentEventSource.close();
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span> Processing...';
    
    resultCard.classList.add('d-none');
    progressSection.classList.remove('d-none');
    
    progressBar.style.width = '5%';
    percentBadge.textContent = '5%';
    progressTitle.textContent = `Pulling [${domain}]...`;
    currentActionText.textContent = 'Connecting to production...';
    updateSteps(1);

    appendLog(`--- New Pull Request: ${domain} (${system.toUpperCase()}) ---`, 'warning');

    // Build SSE URL
    const sseUrl = `/api/pull?system=${encodeURIComponent(system)}&domain=${encodeURIComponent(domain)}&mode=${encodeURIComponent(mode)}&dropIfExists=${dropIfExists}&addLocalDomain=${addLocalDomain}`;

    currentEventSource = new EventSource(sseUrl);

    currentEventSource.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      appendLog(data.text, data.type, data.time);
    });

    currentEventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      progressBar.style.width = `${data.percent}%`;
      percentBadge.textContent = `${data.percent}%`;
      currentActionText.textContent = data.message;
      updateSteps(data.step);
    });

    currentEventSource.addEventListener('done', (e) => {
      const data = JSON.parse(e.data);
      currentEventSource.close();

      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down fs-5"></i><span>Pull Tenant Database to Local</span>';

      updateSteps(6); // marks all completed
      progressBar.style.width = '100%';
      percentBadge.textContent = '100%';
      currentActionText.textContent = 'Complete!';

      // Populate Result Card
      resTenantId.textContent = data.tenantId;
      resDbName.textContent = data.dbName;
      resTableCount.textContent = `${data.tableCount} tables`;
      resDuration.textContent = `${data.durationSeconds}s (${data.fileSizeMb} MB)`;
      
      // localUrl includes the local app port when set (CMS: :8080).
      const localHostUrl = data.localUrl || (data.localDomain ? `http://${data.localDomain}` : 'http://localhost');
      resLocalUrl.textContent = localHostUrl.replace(/^https?:\/\//, '');
      openLocalAppBtn.href = localHostUrl;

      resultCard.classList.remove('d-none');
      resultCard.scrollIntoView({ behavior: 'smooth' });
    });

    currentEventSource.addEventListener('error', (e) => {
      if (e.data) {
        try {
          const data = JSON.parse(e.data);
          appendLog(`Fatal: ${data.message}`, 'error');
        } catch {
          appendLog('Connection to retrieval stream closed.', 'error');
        }
      }
      currentEventSource.close();
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down fs-5"></i><span>Pull Tenant Database to Local</span>';
      progressBar.classList.replace('bg-primary', 'bg-danger');
      currentActionText.textContent = 'Process halted due to an error.';
    });
  });

  // 6. Reset Button
  resetBtn.addEventListener('click', () => {
    resultCard.classList.add('d-none');
    progressSection.classList.add('d-none');
    domainInput.value = '';
    domainInput.focus();
    progressBar.classList.replace('bg-danger', 'bg-primary');
  });

  // 7. Browse Production Domains Button
  loadDomainsBtn.addEventListener('click', async () => {
    const system = document.querySelector('input[name="systemRadio"]:checked').value;
    loadDomainsBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Loading...';
    
    try {
      const res = await fetch(`/api/domains?system=${system}`);
      const data = await res.json();
      
      if (data.success && data.domains && data.domains.length > 0) {
        domainsSuggestions.innerHTML = '';
        data.domains.forEach(d => {
          const item = document.createElement('a');
          item.href = '#';
          item.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center bg-dark text-light border-secondary';
          item.innerHTML = `
            <div>
              <span class="fw-bold text-primary">${d.domain}</span>
              <small class="text-secondary ms-2">tenant: ${d.tenant_id}</small>
            </div>
            <i class="fa-solid fa-arrow-right fs-7 text-secondary"></i>
          `;
          item.addEventListener('click', (ev) => {
            ev.preventDefault();
            domainInput.value = d.domain;
            domainsSuggestions.classList.add('d-none');
            domainInput.focus();
          });
          domainsSuggestions.appendChild(item);
        });
        domainsSuggestions.classList.remove('d-none');
      } else {
        appendLog('No domains returned from production central DB.', 'warning');
      }
    } catch (err) {
      appendLog(`Failed to fetch domains: ${err.message}`, 'error');
    } finally {
      loadDomainsBtn.innerHTML = '<i class="fa-solid fa-rotate me-1"></i> Browse Production Domains';
    }
  });

  // Close suggestions on outside click
  document.addEventListener('click', (e) => {
    if (!domainInput.contains(e.target) && !domainsSuggestions.contains(e.target) && !loadDomainsBtn.contains(e.target)) {
      domainsSuggestions.classList.add('d-none');
    }
  });

  // 8. Settings Modal Configuration
  const settingsModal = document.getElementById('settingsModal');
  const systemsSettings = document.getElementById('systemsSettings');
  // Fields of each system block: [key in config, label, input type, column width]
  const SYSTEM_FIELDS = [
    ['host', 'Host / IP', 'text', 'col-md-8'],
    ['port', 'Port', 'number', 'col-md-4'],
    ['username', 'Username', 'text', 'col-md-6'],
    ['password', 'Password', 'password', 'col-md-6'],
    ['centralDb', 'Production Central DB', 'text', 'col-md-6'],
    ['localCentralDb', 'Local Central DB', 'text', 'col-md-6'],
    ['pmaUrl', 'phpMyAdmin URL (fallback when port 3306 is closed)', 'text', 'col-md-8'],
    ['localAppPort', 'Local App Port (empty = 80)', 'text', 'col-md-4'],
  ];
  let loadedSystemKeys = [];

  function renderSystemsSettings(systems) {
    loadedSystemKeys = Object.keys(systems);
    systemsSettings.innerHTML = '';
    for (const key of loadedSystemKeys) {
      const sys = systems[key];
      const block = document.createElement('div');
      block.className = 'mb-4';
      const title = document.createElement('h6');
      title.className = 'fw-bold text-primary mb-3';
      title.innerHTML = '<i class="fa-solid fa-cloud me-2"></i>';
      title.append(`${sys.label}: Production Server`);
      const row = document.createElement('div');
      row.className = 'row g-3';
      for (const [field, label, type, col] of SYSTEM_FIELDS) {
        const wrap = document.createElement('div');
        wrap.className = col;
        const lbl = document.createElement('label');
        lbl.className = 'form-label fs-7';
        lbl.textContent = label;
        const input = document.createElement('input');
        input.type = type;
        input.className = 'form-control font-monospace';
        input.id = `cfg_${key}_${field}`;
        if (field === 'password') {
          input.placeholder = sys.hasPassword ? '(set, leave empty to keep current)' : '(not set)';
        } else {
          input.value = sys[field] ?? '';
        }
        wrap.append(lbl, input);
        row.appendChild(wrap);
      }
      block.append(title, row);
      systemsSettings.appendChild(block);
    }
  }

  settingsModal.addEventListener('show.bs.modal', async () => {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();

      renderSystemsSettings(cfg.systems || {});

      document.getElementById('cfgLocalHost').value = cfg.local.host;
      document.getElementById('cfgLocalPort').value = cfg.local.port;
      document.getElementById('cfgLocalUsername').value = cfg.local.username;
      document.getElementById('cfgLocalPassword').placeholder = cfg.local.hasPassword ? '(set, leave empty to keep current)' : '(empty by default)';

      document.getElementById('cfgMysqlBin').value = cfg.mysqlBin;
      document.getElementById('cfgMysqldumpBin').value = cfg.mysqldumpBin;
    } catch (err) {
      console.error(err);
    }
  });

  // Test Connections inside modal
  testConnBtn.addEventListener('click', async () => {
    testConnBtn.disabled = true;
    testConnBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Testing...';
    connTestResults.innerHTML = '<div class="text-secondary">Pinging services...</div>';

    try {
      const res = await fetch('/api/test-connection');
      const data = await res.json();

      // Built with textContent: messages contain server errors and must not be parsed as HTML.
      connTestResults.innerHTML = '';
      const addLine = (ok, okClass, failClass, failIcon, label, message) => {
        const div = document.createElement('div');
        div.className = `${ok ? okClass : failClass} mb-1`;
        div.innerHTML = `<i class="fa-solid ${ok ? 'fa-check' : failIcon} me-1"></i>`;
        const strong = document.createElement('strong');
        strong.textContent = `${label}: `;
        div.append(strong, message || '');
        connTestResults.appendChild(div);
      };

      addLine(data.local?.success, 'text-success', 'text-danger', 'fa-xmark', 'Local MySQL', data.local?.message);
      for (const sys of Object.values(data.systems || {})) {
        addLine(sys.direct?.success, 'text-success', 'text-warning', 'fa-triangle-exclamation', `${sys.label} Direct (3306)`, sys.direct?.message);
        addLine(sys.pma?.success, 'text-success', 'text-danger', 'fa-xmark', `${sys.label} phpMyAdmin`, sys.pma?.message);
      }
      checkStatus();
    } catch (err) {
      connTestResults.innerHTML = `<div class="text-danger">Test failed: ${err.message}</div>`;
    } finally {
      testConnBtn.disabled = false;
      testConnBtn.innerHTML = '<i class="fa-solid fa-bolt me-1"></i> Test All Connections Now';
    }
  });

  // Save Settings
  saveSettingsBtn.addEventListener('click', async () => {
    const systems = {};
    for (const key of loadedSystemKeys) {
      systems[key] = {};
      for (const [field] of SYSTEM_FIELDS) {
        const raw = document.getElementById(`cfg_${key}_${field}`).value;
        const value = field === 'password' ? raw : raw.trim();
        if (field === 'password' && value === '') continue; // empty = keep current password
        systems[key][field] = field === 'port' ? parseInt(value, 10) : value;
      }
    }

    const payload = {
      systems,
      local: {
        host: document.getElementById('cfgLocalHost').value.trim(),
        port: parseInt(document.getElementById('cfgLocalPort').value.trim(), 10),
        username: document.getElementById('cfgLocalUsername').value.trim(),
      },
      mysqlBin: document.getElementById('cfgMysqlBin').value.trim(),
      mysqldumpBin: document.getElementById('cfgMysqldumpBin').value.trim(),
    };

    const newLocalPass = document.getElementById('cfgLocalPassword').value;
    if (newLocalPass !== '') {
      payload.local.password = newLocalPass;
    }

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        appendLog('Configuration settings updated successfully!', 'success');
        bootstrap.Modal.getInstance(settingsModal).hide();
        checkStatus();
      }
    } catch (err) {
      alert(`Failed to save settings: ${err.message}`);
    }
  });
});
