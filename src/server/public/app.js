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
    return document.getElementById('userId').value.trim() || 'ui-user@example.com';
  }

  let uuid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

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
      const provider = getProviderFilter() || 'ZAW3-Y4D4-I2NY';
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
      const { definitionId } = await api(DEMO + '/deploy', {
        method: 'POST',
        body: JSON.stringify({ modelId, source: getModelSource() }),
      });
      const contextDocuments = await uploadFiles(startPendingFiles);
      const { instanceId } = await api(DEMO + '/start', {
        method: 'POST',
        body: JSON.stringify({
          definitionId,
          user: { email: getUserId() },
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
          const role = m.role || 'user';
          const content = escapeHtml(String(m.content || ''));
          const at = m.at ? new Date(m.at).toLocaleString() : '';
          return `<div class="conversation-message ${role}"><span class="role">${escapeHtml(role)}${at ? ' · ' + at : ''}</span><div>${content}</div></div>`;
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
  document.getElementById('providerFilterWrap').classList.toggle('hidden', !document.querySelector('input[name="modelSource"][value="insight"]').checked);
  loadModels();
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
})();
