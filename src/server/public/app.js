(function () {
  const API = '/';
  const DEMO = '/demo';

  function api(path, opts = {}) {
    const url = path.startsWith('http') ? path : API.replace(/\/$/, '') + path;
    return fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } }).then(async (r) => {
      const ct = r.headers.get('Content-Type') || '';
      const isJson = ct.includes('application/json');
      const text = await r.text();
      if (!r.ok) {
        let err = r.statusText;
        if (isJson) try { err = JSON.parse(text).error || err; } catch (_) {}
        else if (text.startsWith('<')) err = 'Server returned HTML (check URL and routes)';
        else err = text.slice(0, 100) || err;
        return Promise.reject(new Error(err));
      }
      if (!isJson) return Promise.reject(new Error('Expected JSON, got ' + (text.startsWith('<') ? 'HTML' : ct || 'other')));
      try { return JSON.parse(text); } catch (e) {
        return Promise.reject(new Error('Invalid JSON: ' + text.slice(0, 80)));
      }
    });
  }

  function getUserId() {
    return document.getElementById('userId').value.trim() || 'ada@the-real-insight.com';
  }

  function getUser() {
    return {
      email: getUserId(),
      firstName: document.getElementById('userFirstName').value.trim() || undefined,
      lastName: document.getElementById('userLastName').value.trim() || undefined,
    };
  }

  let uuid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Aggregated roles from all processes we've started (synthetic roleAssignments for testing)
  let aggregatedRoles = new Map(); // roleId -> { roleId, roleName }

  function addRolesFromDeploy(roles) {
    if (!Array.isArray(roles)) return;
    for (const r of roles) {
      if (r && r.roleId) aggregatedRoles.set(r.roleId, { roleId: r.roleId, roleName: r.roleName || r.roleId });
    }
    renderRoles();
  }

  function renderRoles() {
    const listEl = document.getElementById('rolesList');
    const emptyEl = document.getElementById('rolesEmpty');
    const roles = Array.from(aggregatedRoles.values());
    if (roles.length === 0) {
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      listEl.innerHTML = roles.map((r) =>
        '<li><code>' + escapeHtml(r.roleId) + '</code>' +
        (r.roleName && r.roleName !== r.roleId ? ' (' + escapeHtml(r.roleName) + ')' : '') + '</li>'
      ).join('');
    }
  }

  // --- Models & Start ---
  const modelSelect = document.getElementById('modelSelect');
  const startBtn = document.getElementById('startBtn');
  const startStatus = document.getElementById('startStatus');

  function getModelSource() {
    const r = document.querySelector('input[name="modelSource"]:checked');
    return (r && r.value) || 'insight';
  }

  function getProviderFilter() {
    return document.getElementById('providerFilter').value.trim();
  }

  async function loadModels() {
    const source = getModelSource();
    let url = DEMO + '/models?source=' + encodeURIComponent(source) + '&_=' + Date.now();
    if (source === 'insight') {
      const provider = getProviderFilter() || 'S8QW-G8R2-9QLC';
      url += '&provider=' + encodeURIComponent(provider);
    }
    const { models } = await api(url);
    modelSelect.innerHTML = models.length === 0
      ? '<option value="">No models</option>'
      : models.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('');
  }

  let startPendingFiles = [];

  async function uploadFiles(files) {
    if (files.length === 0) return [];
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    const res = await fetch(DEMO + '/upload', { method: 'POST', body: fd });
    const ct = res.headers.get('Content-Type') || '';
    const text = await res.text();
    if (!res.ok) throw new Error(text.startsWith('{') ? (JSON.parse(text).error || res.statusText) : res.statusText);
    const json = ct.includes('application/json') ? JSON.parse(text) : {};
    return json.documents || [];
  }

  async function startProcess() {
    const modelId = modelSelect.value;
    if (!modelId) {
      startStatus.textContent = 'Select a model first.';
      startStatus.className = 'status error';
      return;
    }
    startStatus.textContent = 'Starting...';
    startStatus.className = 'status';
    try {
      const deployRes = await api(DEMO + '/deploy', {
        method: 'POST',
        body: JSON.stringify({ modelId, source: getModelSource() }),
      });
      const { definitionId, roles } = deployRes;
      addRolesFromDeploy(roles);
      const contextDocuments = await uploadFiles(startPendingFiles);
      const { instanceId } = await api(DEMO + '/start', {
        method: 'POST',
        body: JSON.stringify({
          definitionId,
          user: getUser(),
          contextDocuments,
        }),
      });
      startStatus.textContent = 'Started: ' + instanceId;
      startStatus.className = 'status success';
      startPendingFiles = [];
      renderStartFileList();
      refreshWorklist();
      refreshInstances();
    } catch (e) {
      startStatus.textContent = 'Error: ' + e.message;
      startStatus.className = 'status error';
    }
  }

  function renderStartFileList() {
    const el = document.getElementById('startFileList');
    if (startPendingFiles.length === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = startPendingFiles.map((f, i) =>
      '<span>' + escapeHtml(f.name) + ' <span class="remove-file" data-i="' + i + '">×</span></span>'
    ).join('');
    el.querySelectorAll('.remove-file').forEach((b) => {
      b.onclick = () => {
        startPendingFiles.splice(parseInt(b.dataset.i, 10), 1);
        renderStartFileList();
      };
    });
  }

  const startUploadArea = document.getElementById('startUploadArea');
  const startFileInput = document.getElementById('startFileInput');
  startUploadArea.onclick = () => startFileInput.click();
  startUploadArea.ondragover = (e) => { e.preventDefault(); startUploadArea.classList.add('drag-over'); };
  startUploadArea.ondragleave = () => startUploadArea.classList.remove('drag-over');
  startUploadArea.ondrop = (e) => {
    e.preventDefault();
    startUploadArea.classList.remove('drag-over');
    startPendingFiles.push(...Array.from(e.dataTransfer.files));
    renderStartFileList();
  };
  startFileInput.onchange = () => {
    startPendingFiles.push(...Array.from(startFileInput.files));
    startFileInput.value = '';
    renderStartFileList();
  };

  // --- Worklist ---
  const worklistEl = document.getElementById('worklist');
  const refreshWorklistBtn = document.getElementById('refreshWorklistBtn');
  const claimForm = document.getElementById('claimForm');
  const claimTaskName = document.getElementById('claimTaskName');
  const claimResponse = document.getElementById('claimResponse');
  const submitClaimBtn = document.getElementById('submitClaimBtn');
  const cancelClaimBtn = document.getElementById('cancelClaimBtn');
  const autoModeCheck = document.getElementById('autoMode');

  let currentClaim = null;
  let autoInterval = null;

  async function listTasks(instanceId) {
    const q = new URLSearchParams({ status: 'OPEN', sortOrder: 'asc' });
    if (instanceId) q.set('instanceId', instanceId);
    const roleIds = Array.from(aggregatedRoles.keys());
    if (roleIds.length > 0) {
      q.set('userId', getUserId());
      q.set('roleIds', roleIds.join(','));
    }
    const { items } = await api('/v1/tasks?' + q);
    return items;
  }

  async function refreshWorklist() {
    try {
      const items = await listTasks();
      worklistEl.innerHTML = items.length === 0
        ? '<p class="status">No open tasks</p>'
        : items.map((t) => `
          <div class="work-item" data-task-id="${t._id}" data-instance-id="${t.instanceId}">
            <div class="info">
              <span class="name">${escapeHtml(t.name)}</span>
              <div class="meta">${t.instanceId} • ${t._id}</div>
            </div>
            <button class="claim-btn">Claim</button>
          </div>
        `).join('');

      worklistEl.querySelectorAll('.claim-btn').forEach((btn) => {
        btn.onclick = () => claimTask(btn.closest('.work-item'));
      });
    } catch (e) {
      worklistEl.innerHTML = '<p class="status error">' + escapeHtml(e.message) + '</p>';
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  let claimPendingFiles = [];

  async function claimTask(row) {
    const taskId = row.dataset.taskId;
    const instanceId = row.dataset.instanceId;
    try {
      await api(`/v1/tasks/${taskId}/activate`, {
        method: 'POST',
        body: JSON.stringify({ commandId: uuid(), userId: getUserId() }),
      });
      currentClaim = { taskId, instanceId, name: row.querySelector('.name').textContent };
      claimTaskName.textContent = currentClaim.name;
      claimResponse.value = 'ok';
      claimPendingFiles = [];
      renderClaimFileList();
      claimForm.classList.remove('hidden');
      loadClaimContextDocs();
    } catch (e) {
      alert(e.message);
    }
  }

  async function loadClaimContextDocs() {
    if (!currentClaim) return;
    const instance = await api('/v1/instances/' + currentClaim.instanceId);
    const convId = instance.conversationId;
    const el = document.getElementById('claimContextDocs');
    if (!convId) {
      el.innerHTML = '';
      return;
    }
    try {
      const conv = await api(DEMO + '/conversations/' + convId);
      const docs = conv.contextDocuments || [];
      el.innerHTML = docs.length === 0 ? '' : '<strong>Context documents:</strong><ul>' +
        docs.map((d) => {
          const href = d.path ? (DEMO + '/documents/' + encodeURIComponent(d.path)) : null;
          return '<li>' + (href ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(d.filename) + '</a>' : escapeHtml(d.filename)) + '</li>';
        }).join('') + '</ul>';
    } catch {
      el.innerHTML = '';
    }
  }

  function renderClaimFileList() {
    const el = document.getElementById('claimFileList');
    if (claimPendingFiles.length === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = claimPendingFiles.map((f, i) =>
      '<span>' + escapeHtml(f.name) + ' <span class="remove-file" data-i="' + i + '">×</span></span>'
    ).join('');
    el.querySelectorAll('.remove-file').forEach((b) => {
      b.onclick = () => {
        claimPendingFiles.splice(parseInt(b.dataset.i, 10), 1);
        renderClaimFileList();
      };
    });
  }

  async function submitClaim() {
    if (!currentClaim) return;
    const { taskId } = currentClaim;
    const result = { value: claimResponse.value.trim() };
    const contextDocuments = await uploadFiles(claimPendingFiles);
    try {
      await api(DEMO + '/tasks/' + taskId + '/complete', {
        method: 'POST',
        body: JSON.stringify({
          commandId: uuid(),
          userId: getUserId(),
          user: getUser(),
          result,
          contextDocuments,
        }),
      });
      currentClaim = null;
      claimForm.classList.add('hidden');
      startStatus.textContent = 'Task completed.';
      setTimeout(refreshWorklist, 600);
      refreshInstances();
    } catch (e) {
      alert(e.message);
    }
  }

  function cancelClaim() {
    currentClaim = null;
    claimForm.classList.add('hidden');
    claimPendingFiles = [];
    refreshWorklist();
  }

  const claimUploadArea = document.getElementById('claimUploadArea');
  const claimFileInput = document.getElementById('claimFileInput');
  claimUploadArea.onclick = () => claimFileInput.click();
  claimUploadArea.ondragover = (e) => { e.preventDefault(); claimUploadArea.classList.add('drag-over'); };
  claimUploadArea.ondragleave = () => claimUploadArea.classList.remove('drag-over');
  claimUploadArea.ondrop = (e) => {
    e.preventDefault();
    claimUploadArea.classList.remove('drag-over');
    claimPendingFiles.push(...Array.from(e.dataTransfer.files));
    renderClaimFileList();
  };
  claimFileInput.onchange = () => {
    claimPendingFiles.push(...Array.from(claimFileInput.files));
    claimFileInput.value = '';
    renderClaimFileList();
  };

  function runAutoMode() {
    if (!autoModeCheck.checked || currentClaim) return;
    (async () => {
      const items = await listTasks();
      if (items.length === 0) return;
      const row = worklistEl.querySelector('.work-item');
      if (!row) return;
      const taskId = row.dataset.taskId;
      const instanceId = row.dataset.instanceId;
      const name = row.querySelector('.name').textContent;
      try {
        await api(`/v1/tasks/${taskId}/activate`, {
          method: 'POST',
          body: JSON.stringify({ commandId: uuid(), userId: getUserId() }),
        });
        currentClaim = { taskId, instanceId, name };
        claimTaskName.textContent = name;
        claimResponse.value = 'auto';
        claimForm.classList.remove('hidden');
        setTimeout(submitClaim, 800);
      } catch (e) {
        console.warn('Auto claim failed:', e);
      }
    })();
  }

  // --- Process History ---
  const instanceSelect = document.getElementById('instanceSelect');
  const historyTable = document.getElementById('historyTable');
  const refreshInstancesBtn = document.getElementById('refreshInstancesBtn');

  async function refreshInstances() {
    try {
      const { items } = await api('/v1/instances?limit=100');
      const current = instanceSelect.value;
      instanceSelect.innerHTML = '<option value="">-- Select process --</option>' +
        items.map((i) => `<option value="${i._id}" data-conv="${i.conversationId || ''}">${i._id} (${i.status}) - ${new Date(i.createdAt).toLocaleString()}</option>`).join('');
      if (current) instanceSelect.value = current;
      if (instanceSelect.value) loadHistory(instanceSelect.value);
      viewDiagramBtn.disabled = !instanceSelect.value;
      updateViewConversationBtn();
    } catch (e) {
      instanceSelect.innerHTML = '<option value="">Error loading</option>';
    }
  }

  const viewDiagramBtn = document.getElementById('viewDiagramBtn');
  viewDiagramBtn.onclick = () => {
    const id = instanceSelect.value;
    if (id) window.open('/diagram.html?instanceId=' + encodeURIComponent(id), '_blank');
  };

  async function loadHistory(instanceId) {
    try {
      const entries = await api(`/v1/instances/${instanceId}/history`);
      if (entries.length === 0) {
        historyTable.innerHTML = '<p class="status">No history</p>';
        return;
      }
      const cols = ['seq', 'eventType', 'at', 'nodeName', 'nodeType', 'completedBy', 'result'];
      historyTable.innerHTML = `
        <table>
          <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>
            ${entries.map((e) => `
              <tr>
                <td>${e.seq}</td>
                <td>${escapeHtml(e.eventType || '')}</td>
                <td>${e.at ? new Date(e.at).toISOString().slice(0, 19) : ''}</td>
                <td>${escapeHtml(e.nodeName || e.nodeId || '')}</td>
                <td>${escapeHtml(e.nodeType || '')}</td>
                <td>${escapeHtml(e.completedBy || e.startedBy || '')}</td>
                <td>${e.result != null ? escapeHtml(JSON.stringify(e.result).slice(0, 40)) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (e) {
      historyTable.innerHTML = '<p class="status error">' + escapeHtml(e.message) + '</p>';
    }
  }

  function updateViewConversationBtn() {
    const opt = instanceSelect.options[instanceSelect.selectedIndex];
    const convId = opt && opt.dataset.conv;
    viewConversationBtn.disabled = !instanceSelect.value || !convId;
  }

  instanceSelect.onchange = () => {
    if (instanceSelect.value) loadHistory(instanceSelect.value);
    else historyTable.innerHTML = '';
    viewDiagramBtn.disabled = !instanceSelect.value;
    updateViewConversationBtn();
  };

  const viewConversationBtn = document.getElementById('viewConversationBtn');
  const conversationModal = document.getElementById('conversationModal');
  const conversationMessages = document.getElementById('conversationMessages');
  const conversationDocs = document.getElementById('conversationDocs');
  const closeConversationBtn = document.getElementById('closeConversationBtn');

  viewConversationBtn.onclick = async () => {
    const opt = instanceSelect.options[instanceSelect.selectedIndex];
    const convId = opt && opt.dataset.conv;
    if (!convId) return;
    try {
      const conv = await api(DEMO + '/conversations/' + convId);
      const msgs = conv.messages || [];
      conversationMessages.innerHTML = msgs.length === 0
        ? '<p class="status">No messages</p>'
        : msgs.map((m) => {
          const role = m.type === 'botMessage' ? 'assistant' : (m.role || 'user');
          const content = escapeHtml(String(m.content || ''));
          const at = (m.date || m.at) ? new Date(m.date || m.at).toLocaleString() : '';
          const u = m.user || {};
          const author = m.type === 'botMessage'
            ? 'Assistant'
            : [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || m.email || 'User';
          return `<div class="conversation-message ${role}"><span class="role">${escapeHtml(author)}${at ? ' · ' + at : ''}</span><div>${content}</div></div>`;
        }).join('');
      const docs = conv.contextDocuments || [];
      conversationDocs.innerHTML = docs.length === 0
        ? ''
        : '<h4>Documents</h4><ul>' + docs.map((d) => {
          const href = d.path ? (DEMO + '/documents/' + encodeURIComponent(d.path)) : null;
          return '<li>' + (href ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(d.filename) + '</a>' : escapeHtml(d.filename)) + '</li>';
        }).join('') + '</ul>';
      conversationModal.classList.remove('hidden');
    } catch (e) {
      alert('Failed to load conversation: ' + e.message);
    }
  };

  closeConversationBtn.onclick = () => conversationModal.classList.add('hidden');
  conversationModal.querySelector('.modal-backdrop').onclick = () => conversationModal.classList.add('hidden');

  // --- Init ---
  api('/demo/config').then((cfg) => {
    const sourceSwitch = document.querySelector('.source-switch');
    if (!cfg.triTesting) {
      // Hide the Local / The Real Insight toggle and force local source
      sourceSwitch.classList.add('hidden');
      document.getElementById('providerFilterWrap').classList.add('hidden');
      const localRadio = document.querySelector('input[name="modelSource"][value="local"]');
      if (localRadio) localRadio.checked = true;
    } else {
      sourceSwitch.classList.remove('hidden');
      const insight = document.querySelector('input[name="modelSource"][value="insight"]').checked;
      document.getElementById('providerFilterWrap').classList.toggle('hidden', !insight);
    }
    loadModels();
  }).catch(() => {
    // Fallback: default to local if config endpoint unavailable
    document.querySelector('.source-switch').classList.add('hidden');
    document.getElementById('providerFilterWrap').classList.add('hidden');
    loadModels();
  });

  renderRoles();
  refreshWorklist();
  refreshInstances();

  document.querySelectorAll('input[name="modelSource"]').forEach((r) => {
    r.onchange = () => {
      const insight = document.querySelector('input[name="modelSource"][value="insight"]').checked;
      document.getElementById('providerFilterWrap').classList.toggle('hidden', !insight);
      loadModels();
    };
  });
  document.getElementById('providerFilter').onchange = () => loadModels();
  document.getElementById('providerFilter').onblur = () => loadModels();

  startBtn.onclick = startProcess;
  refreshWorklistBtn.onclick = refreshWorklist;
  refreshInstancesBtn.onclick = refreshInstances;
  submitClaimBtn.onclick = submitClaim;
  cancelClaimBtn.onclick = cancelClaim;

  document.getElementById('purgeBtn').onclick = async () => {
    if (!confirm('Delete all process instances, definitions, tasks and history? This cannot be undone.')) return;
    try {
      await api(window.location.origin + '/v1/purge', { method: 'POST', body: JSON.stringify({}) });
      currentClaim = null;
      claimForm.classList.add('hidden');
      aggregatedRoles.clear();
      renderRoles();
      loadModels();
      refreshWorklist();
      refreshInstances();
      startStatus.textContent = 'Database purged.';
      startStatus.className = 'status success';
    } catch (e) {
      const msg = e && e.message ? e.message : (e ? String(e) : 'Unknown error');
      alert('Purge failed: ' + (msg || 'No details'));
    }
  };

  autoModeCheck.onchange = () => {
    if (autoModeCheck.checked) {
      runAutoMode();
      autoInterval = setInterval(runAutoMode, 2000);
    } else {
      clearInterval(autoInterval);
      autoInterval = null;
    }
  };

  // ── Recurrence dialog (Outlook-style) ──────────────────────────────────────

  const recModal = document.getElementById('recurrenceModal');
  const recPreview = document.getElementById('recPreview');
  const recSummary = document.getElementById('recSummary');
  let activeFreq = 'DAILY';

  function pad2(n) { return String(n).padStart(2, '0'); }

  function initRecDefaults() {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 60 - (now.getMinutes() % 15)); // next rounded quarter-hour
    now.setSeconds(0, 0);
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    document.getElementById('recDtstart').value = local.toISOString().slice(0, 16);
    const endDate = new Date(now);
    endDate.setFullYear(endDate.getFullYear() + 1);
    const endLocal = new Date(endDate.getTime() - endDate.getTimezoneOffset() * 60000);
    document.getElementById('recEndDate').value = endLocal.toISOString().slice(0, 10);
  }

  function setActiveFreq(freq) {
    activeFreq = freq;
    document.querySelectorAll('.rec-tab').forEach(t => t.classList.toggle('active', t.dataset.freq === freq));
    document.querySelectorAll('.rec-freq-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'recPanel' + freq));
    updateRecPreview();
  }

  document.querySelectorAll('.rec-tab').forEach(t => {
    t.onclick = () => setActiveFreq(t.dataset.freq);
  });

  function buildRRule() {
    const dtstartInput = document.getElementById('recDtstart').value;
    if (!dtstartInput) return { rrule: '', summary: 'Set a start time' };

    const dt = new Date(dtstartInput);
    const dtStr = dt.getUTCFullYear().toString() +
      pad2(dt.getUTCMonth() + 1) + pad2(dt.getUTCDate()) + 'T' +
      pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + pad2(dt.getUTCSeconds()) + 'Z';

    const parts = ['FREQ=' + activeFreq];
    let summary = '';

    if (activeFreq === 'DAILY') {
      const interval = parseInt(document.getElementById('recDailyInterval').value) || 1;
      if (interval > 1) parts.push('INTERVAL=' + interval);
      summary = interval === 1 ? 'Every day' : `Every ${interval} days`;
    }

    if (activeFreq === 'WEEKLY') {
      const interval = parseInt(document.getElementById('recWeeklyInterval').value) || 1;
      if (interval > 1) parts.push('INTERVAL=' + interval);
      const days = Array.from(document.querySelectorAll('#recPanelWEEKLY .rec-days input:checked')).map(c => c.value);
      if (days.length > 0) parts.push('BYDAY=' + days.join(','));
      const dayNames = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
      const dayStr = days.map(d => dayNames[d] || d).join(', ');
      summary = (interval === 1 ? 'Every week' : `Every ${interval} weeks`) + ' on ' + (dayStr || 'no days selected');
    }

    if (activeFreq === 'MONTHLY') {
      const interval = parseInt(document.getElementById('recMonthlyInterval').value) || 1;
      if (interval > 1) parts.push('INTERVAL=' + interval);
      const mode = document.querySelector('input[name="monthlyMode"]:checked')?.value || 'day';
      if (mode === 'day') {
        const day = parseInt(document.getElementById('recMonthlyDay').value) || 1;
        parts.push('BYMONTHDAY=' + day);
        summary = (interval === 1 ? 'Every month' : `Every ${interval} months`) + ` on the ${ordinal(day)}`;
      } else {
        const pos = document.getElementById('recMonthlyPos').value;
        const weekday = document.getElementById('recMonthlyWeekday').value;
        parts.push('BYDAY=' + weekday);
        parts.push('BYSETPOS=' + pos);
        const posNames = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' };
        const wdOpt = document.getElementById('recMonthlyWeekday').selectedOptions[0];
        summary = (interval === 1 ? 'Every month' : `Every ${interval} months`) +
          ` on the ${posNames[pos] || pos} ${wdOpt.text}`;
      }
    }

    if (activeFreq === 'YEARLY') {
      const mode = document.querySelector('input[name="yearlyMode"]:checked')?.value || 'date';
      if (mode === 'date') {
        const month = document.getElementById('recYearlyMonth').value;
        const day = parseInt(document.getElementById('recYearlyDay').value) || 1;
        parts.push('BYMONTH=' + month);
        parts.push('BYMONTHDAY=' + day);
        const monthOpt = document.getElementById('recYearlyMonth').selectedOptions[0];
        summary = `Every year on ${monthOpt.text} ${ordinal(day)}`;
      } else {
        const pos = document.getElementById('recYearlyPos').value;
        const weekday = document.getElementById('recYearlyWeekday').value;
        const month = document.getElementById('recYearlyMonth2').value;
        parts.push('BYMONTH=' + month);
        parts.push('BYDAY=' + weekday);
        parts.push('BYSETPOS=' + pos);
        const posNames = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' };
        const wdOpt = document.getElementById('recYearlyWeekday').selectedOptions[0];
        const monthOpt = document.getElementById('recYearlyMonth2').selectedOptions[0];
        summary = `Every year on the ${posNames[pos] || pos} ${wdOpt.text} of ${monthOpt.text}`;
      }
    }

    // End condition
    const endMode = document.querySelector('input[name="recEnd"]:checked')?.value || 'never';
    if (endMode === 'count') {
      const count = parseInt(document.getElementById('recEndCount').value) || 10;
      parts.push('COUNT=' + count);
      summary += `, ${count} times`;
    } else if (endMode === 'until') {
      const untilDate = document.getElementById('recEndDate').value;
      if (untilDate) {
        const ud = new Date(untilDate + 'T23:59:59Z');
        const untilStr = ud.getUTCFullYear().toString() +
          pad2(ud.getUTCMonth() + 1) + pad2(ud.getUTCDate()) + 'T235959Z';
        parts.push('UNTIL=' + untilStr);
        summary += `, until ${untilDate}`;
      }
    }

    const timeStr = pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
    summary += ` at ${timeStr}`;

    const rrule = 'DTSTART:' + dtStr + '\nRRULE:' + parts.join(';');
    return { rrule, summary };
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function updateRecPreview() {
    const { rrule, summary } = buildRRule();
    recPreview.textContent = rrule || '(configure a schedule)';
    recSummary.textContent = summary || '';
  }

  // Bind all inputs to live-update the preview
  recModal.addEventListener('input', updateRecPreview);
  recModal.addEventListener('change', updateRecPreview);

  document.getElementById('scheduleBtn').onclick = () => {
    if (!modelSelect.value) {
      startStatus.textContent = 'Select a model first.';
      startStatus.className = 'status error';
      return;
    }
    initRecDefaults();
    updateRecPreview();
    recModal.classList.remove('hidden');
  };

  document.getElementById('closeRecurrenceBtn').onclick = () => recModal.classList.add('hidden');
  document.getElementById('recCancelBtn').onclick = () => recModal.classList.add('hidden');
  recModal.querySelector('.modal-backdrop').onclick = () => recModal.classList.add('hidden');

  document.getElementById('recApplyBtn').onclick = async () => {
    const { rrule } = buildRRule();
    if (!rrule) return;
    const modelId = modelSelect.value;
    if (!modelId) return;

    recModal.classList.add('hidden');
    startStatus.textContent = 'Deploying with schedule...';
    startStatus.className = 'status';

    try {
      const deployRes = await api(DEMO + '/deploy', {
        method: 'POST',
        body: JSON.stringify({ modelId, source: getModelSource(), timerCycle: rrule }),
      });
      const { definitionId, roles } = deployRes;
      addRolesFromDeploy(roles);

      // Fetch the created schedule
      const { items } = await api('/v1/timer-schedules?definitionId=' + encodeURIComponent(definitionId));
      if (items.length > 0) {
        const s = items[0];
        const nextFire = new Date(s.nextFireAt).toLocaleString();
        startStatus.textContent = `Scheduled (${s.kind}). Next fire: ${nextFire}`;
        startStatus.className = 'status success';
      } else {
        startStatus.textContent = 'Deployed with schedule. Definition: ' + definitionId;
        startStatus.className = 'status success';
      }
    } catch (e) {
      startStatus.textContent = 'Error: ' + e.message;
      startStatus.className = 'status error';
    }
  };
})();
