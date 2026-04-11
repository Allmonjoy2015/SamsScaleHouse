// ============================================================
// scale-settings.js  —  Load after renderer.js
// Manages RS-232 scale settings UI and status display
// ============================================================

// ── Status Display ────────────────────────────────────────────

const STATUS_LABELS = {
    connected:    '✓ Scale connected',
    connecting:   'Connecting to scale...',
    disconnected: 'Scale disconnected — retrying',
    error:        'Scale error',
    unconfigured: 'Scale not configured'
};

function updateScaleStatusUI(status, message = '') {
    const dot  = document.getElementById('scaleDot');
    const text = document.getElementById('scaleStatusText');
    if (!dot || !text) return;

    dot.className  = `scale-dot ${status}`;
    text.className = `scale-status-text ${status}`;

    const label = STATUS_LABELS[status] || status;
    text.textContent = message
        ? (status === 'error' ? `⚠ ${message}` : `${label} — ${message}`)
        : label;
}

// Listen for status events from main process
if (window.electronAPI?.onScaleStatus) {
    window.electronAPI.onScaleStatus(({ status, message }) => {
        updateScaleStatusUI(status, message);
    });
}

// Init: get current status on load
async function initScaleStatus() {
    try {
        const s = await window.electronAPI.invoke('get-scale-status');
        updateScaleStatusUI(s.connected ? 'connected' : 'unconfigured');

        // If connected, show last weight immediately
        if (s.connected && s.lastWeight !== null) {
            const el = document.getElementById('liveWeight');
            if (el) el.innerText = parseFloat(s.lastWeight).toFixed(1);
        }
    } catch (_) {}
}

// ── Settings Panel Toggle ─────────────────────────────────────

function toggleScaleSettings() {
    const panel = document.getElementById('scaleSettingsPanel');
    const isOpen = panel.style.display !== 'none';

    if (!isOpen) {
        loadSettingsIntoForm();
        refreshPortList();
        panel.style.display = 'block';
    } else {
        panel.style.display = 'none';
    }
}

// ── Port List ─────────────────────────────────────────────────

async function refreshPortList() {
    const sel = document.getElementById('sCfgPort');
    const current = sel.value;

    sel.innerHTML = '<option value="">— Scanning... —</option>';

    try {
        const ports = await window.electronAPI.invoke('list-serial-ports');

        sel.innerHTML = '<option value="">— Select port —</option>';

        if (ports.length === 0) {
            sel.innerHTML += '<option value="" disabled>No ports found</option>';
        } else {
            ports.forEach(p => {
                const label = p.manufacturer
                    ? `${p.path}  (${p.manufacturer})`
                    : p.path;
                sel.innerHTML += `<option value="${p.path}" ${p.path === current ? 'selected' : ''}>${label}</option>`;
            });
        }
    } catch (err) {
        sel.innerHTML = '<option value="">Error listing ports</option>';
        console.error('Port list error:', err);
    }
}

// ── Load Saved Config Into Form ───────────────────────────────

async function loadSettingsIntoForm() {
    try {
        const cfg = await window.electronAPI.invoke('get-scale-config');

        document.getElementById('sCfgBaud').value  = cfg.baudRate   || 9600;
        document.getElementById('sCfgParity').value= cfg.parity     || 'none';
        document.getElementById('sCfgData').value  = cfg.dataBits   || 8;
        document.getElementById('sCfgStop').value  = cfg.stopBits   || 1;
        document.getElementById('sCfgDelim').value = cfg.delimiter   || '\n';
        document.getElementById('sCfgPoll').checked= !!cfg.pollMode;
        document.getElementById('sCfgPollMs').value= cfg.pollInterval || 500;

        // Port will be set after refreshPortList completes
        document.getElementById('sCfgPort')._pendingValue = cfg.portPath;
        document.getElementById('pollIntervalGroup').style.display = cfg.pollMode ? 'flex' : 'none';
    } catch (err) {
        console.error('Failed to load scale config:', err);
    }
}

// After refreshing port list, restore saved port selection
const _origRefresh = refreshPortList;
window.refreshPortList = async function() {
    await _origRefresh();
    const sel     = document.getElementById('sCfgPort');
    const pending = sel._pendingValue;
    if (pending) {
        // Try to select it; add as option if not in list (port currently unplugged)
        const exists = Array.from(sel.options).some(o => o.value === pending);
        if (!exists && pending) {
            sel.innerHTML += `<option value="${pending}">${pending} (last used, not found)</option>`;
        }
        sel.value = pending;
        sel._pendingValue = null;
    }
};

// ── Poll Mode Toggle ──────────────────────────────────────────

function onPollToggle() {
    const checked = document.getElementById('sCfgPoll').checked;
    document.getElementById('pollIntervalGroup').style.display = checked ? 'flex' : 'none';
}

// ── Presets ───────────────────────────────────────────────────

const SCALE_PRESETS = {
    toledo: {
        baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
        delimiter: '\n', pollMode: false,
        _note: 'Mettler Toledo IND/SIC series — continuous output 8N1'
    },
    fairbanks: {
        baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
        delimiter: '\n', pollMode: false,
        _note: 'Fairbanks Ultegra/SCB — continuous 8N1'
    },
    ricelake: {
        baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
        delimiter: '\r\n', pollMode: false,
        _note: 'Rice Lake 920i/820i — CR+LF terminated'
    },
    cardinal: {
        baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
        delimiter: '\r', pollMode: true, pollInterval: 500,
        _note: 'Cardinal/Detecto — demand output, CR poll'
    },
    generic: {
        baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
        delimiter: '\n', pollMode: false,
        _note: 'Generic 8N1 9600 baud — most common default'
    }
};

function applyPreset(name) {
    const preset = SCALE_PRESETS[name];
    if (!preset) return;

    document.getElementById('sCfgBaud').value   = preset.baudRate;
    document.getElementById('sCfgParity').value = preset.parity;
    document.getElementById('sCfgData').value   = preset.dataBits;
    document.getElementById('sCfgStop').value   = preset.stopBits;
    document.getElementById('sCfgDelim').value  = preset.delimiter;
    document.getElementById('sCfgPoll').checked = preset.pollMode;
    if (preset.pollInterval) document.getElementById('sCfgPollMs').value = preset.pollInterval;
    document.getElementById('pollIntervalGroup').style.display = preset.pollMode ? 'flex' : 'none';

    showPortTestResult(`Preset applied: ${preset._note}`, 'ok');
}

// ── Auto-Seek Scale ──────────────────────────────────────

async function autoSeekScale() {
    showPortTestResult('Scanning all COM ports for a scale... (this may take a moment)', 'ok');

    // Disable the button during scan
    const btn = document.querySelector('[onclick="autoSeekScale()"]');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Scanning...';
    }

    try {
        const result = await window.electronAPI.invoke('auto-seek-scale');

        if (result.success) {
            // Populate the form with the detected settings
            const sel = document.getElementById('sCfgPort');

            // Make sure the port is in the dropdown
            await refreshPortList();
            const exists = Array.from(sel.options).some(o => o.value === result.port);
            if (!exists) {
                sel.innerHTML += `<option value="${result.port}">${result.port} (auto-detected)</option>`;
            }
            sel.value = result.port;

            document.getElementById('sCfgBaud').value = result.baudRate;

            let msg = `Found scale on ${result.port} @ ${result.baudRate} baud`;
            if (result.manufacturer) msg += ` (${result.manufacturer})`;
            if (result.weight !== null) msg += ` — reading: ${result.weight} lbs`;
            else if (result.sample) msg += ` — raw: "${result.sample}"`;

            showPortTestResult(msg, 'ok');
        } else {
            let msg = result.message || 'No scale found.';
            if (result.portsScanned && result.portsScanned.length > 0) {
                msg += ' Checked: ' + result.portsScanned.join(', ');
            }
            showPortTestResult(msg, 'err');
        }
    } catch (err) {
        showPortTestResult('Auto-seek failed: ' + err.message, 'err');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🔍 Auto';
        }
    }
}

// ── Save Settings ─────────────────────────────────────────────

async function saveScaleSettings() {
    const port = document.getElementById('sCfgPort').value;
    if (!port) {
        showPortTestResult('Please select a serial port.', 'err');
        return;
    }

    const cfg = {
        portPath:     port,
        baudRate:     parseInt(document.getElementById('sCfgBaud').value),
        parity:       document.getElementById('sCfgParity').value,
        dataBits:     parseInt(document.getElementById('sCfgData').value),
        stopBits:     parseInt(document.getElementById('sCfgStop').value),
        delimiter:    document.getElementById('sCfgDelim').value,
        pollMode:     document.getElementById('sCfgPoll').checked,
        pollInterval: parseInt(document.getElementById('sCfgPollMs').value) || 500
    };

    try {
        await window.electronAPI.invoke('save-scale-config', cfg);
        showPortTestResult(`Connecting to ${port}...`, 'ok');
        updateScaleStatusUI('connecting');

        // Close panel after short delay
        setTimeout(() => {
            document.getElementById('scaleSettingsPanel').style.display = 'none';
        }, 1500);
    } catch (err) {
        showPortTestResult('Save failed: ' + err.message, 'err');
    }
}

// ── Manual Reconnect ──────────────────────────────────────────

async function manualReconnect() {
    try {
        updateScaleStatusUI('connecting');
        await window.electronAPI.invoke('reconnect-scale');
        showPortTestResult('Reconnecting...', 'ok');
    } catch (err) {
        showPortTestResult('Reconnect failed: ' + err.message, 'err');
    }
}

// ── Test Result Banner ────────────────────────────────────────

function showPortTestResult(msg, type) {
    const el = document.getElementById('portTestResult');
    el.textContent   = msg;
    el.className     = `port-test-result ${type}`;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Init ──────────────────────────────────────────────────────

if (window.electronAPI) {
    initScaleStatus();

    // Auto-seek on startup if no port is configured
    (async function autoSeekOnBoot() {
        try {
            const cfg = await window.electronAPI.invoke('get-scale-config');
            if (!cfg.portPath) {
                console.log('[Scale] No port configured — running auto-seek...');
                updateScaleStatusUI('connecting', 'Scanning for scale...');

                const result = await window.electronAPI.invoke('auto-seek-scale');
                if (result.success) {
                    const newCfg = {
                        portPath:     result.port,
                        baudRate:     result.baudRate,
                        parity:       'none',
                        dataBits:     8,
                        stopBits:     1,
                        delimiter:    '\n',
                        pollMode:     false,
                        pollInterval: 500
                    };
                    await window.electronAPI.invoke('save-scale-config', newCfg);
                    console.log('[Scale] Auto-detected: ' + result.port + ' @ ' + result.baudRate);
                } else {
                    console.log('[Scale] Auto-seek found nothing — configure manually via gear icon.');
                    updateScaleStatusUI('unconfigured');
                }
            }
        } catch (err) {
            console.warn('[Scale] Auto-seek boot error:', err.message);
        }
    })();
} else {
    updateScaleStatusUI('error', 'window.electronAPI bridge not found');
}
