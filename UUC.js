'use strict';

// Webflow Use Cases - Application Logic
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = Object.freeze({
  API: {
    FETCH_URL: 'https://nzm2t8rkfd.execute-api.eu-central-1.amazonaws.com/default/getAllUserUseCases',
    UPLOAD_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/branding-upload-supervisor',
    DELETE_URL: 'https://4tfgwxzmg2.execute-api.eu-central-1.amazonaws.com/default/delete_user_use_cases',
    GRAPH_TABLE_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/serve-ai-use-cases-graph-table',
    DATA_SOURCE_CONFIG_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/use-cases-data-sources'
  },
  POLL_INTERVAL: 10000,
  POLL_MAX_INTERVAL: 60000,
  POLL_BACKOFF_MULTIPLIER: 2,
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  ALLOWED_FILE_TYPES: ['.pptx'],
  DEBOUNCE_DELAY: 300,
  MAX_RETRY_ATTEMPTS: 3,
  STORAGE_KEYS: {
    MEMBER: '_ms-mem',
    PENDING_CONFIG: 'wfuc_pending_ds_config',
    NEW_UPLOAD: 'wfuc_new_upload',
    NEW_USECASE_ID: 'wfuc_new_usecase_id',
    SELECTION: 'wfuc_selection'
  },
  STATUSES: {
    UPLOADED: 'uploaded',
    PROCESSING: 'processing',
    READY: 'ready',
    FAILED: 'failed',
    ERROR: 'error',
    DELETED: 'deleted'
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

const Utils = {
  sanitizeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },

  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return String(text || '').replace(/[&<>"']/g, m => map[m]);
  },

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  },

  safeJsonParse(str, defaultValue = null) {
    try {
      return JSON.parse(str);
    } catch {
      return defaultValue;
    }
  },

  storage: {
    get(key) {
      try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn('[Storage] Could not save:', key, e);
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        console.warn('[Storage] Could not remove:', key, e);
      }
    }
  },

  safeUrl(value, allowed = ['http:', 'https:']) {
    if (!value) return '';
    try {
      const url = new URL(value);
      return allowed.includes(url.protocol) ? value : '';
    } catch {
      return '';
    }
  },

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  },

  validateFile(file) {
    if (!file) return { valid: false, error: 'No file selected' };
    if (file.size > CONFIG.MAX_FILE_SIZE) {
      return { valid: false, error: `File too large. Max size: ${Utils.formatFileSize(CONFIG.MAX_FILE_SIZE)}` };
    }
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!CONFIG.ALLOWED_FILE_TYPES.includes(ext)) {
      return { valid: false, error: `File type ${ext} not allowed. Allowed: ${CONFIG.ALLOWED_FILE_TYPES.join(', ')}` };
    }
    return { valid: true };
  },

  getRelativeTime(dateStr) {
    if (!dateStr) return '';
    try {
      if (typeof dayjs === 'undefined') return new Date(dateStr).toLocaleDateString();
      if (dayjs.utc) {
        return dayjs.utc(dateStr).fromNow();
      }
      let d = String(dateStr).trim();
      if (!d.endsWith('Z') && !d.includes('+') && !d.includes('GMT')) {
        d = d.replace(' ', 'T') + 'Z';
      }
      return dayjs(d).fromNow();
    } catch (e) {
      return new Date(dateStr).toLocaleDateString();
    }
  },

  extractTemplateId(fullTemplateId) {
    if (!fullTemplateId) return null;
    if (fullTemplateId.startsWith('req_')) {
      return fullTemplateId;
    }
    const match = fullTemplateId.match(/req_\d{8}_[a-f0-9]+/);
    if (match) {
      return match[0];
    }
    console.warn('[Utils] Could not extract template ID from:', fullTemplateId);
    return fullTemplateId;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Toast Notifications
// ═══════════════════════════════════════════════════════════════════════════

const Toast = {
  getInstance() {
    const fn = typeof window !== 'undefined' ? window.sonnerJS : null;
    return typeof fn === 'function' ? fn : null;
  },

  notify(type, title, description) {
    const fn = this.getInstance();
    if (!fn) return;
    const payload = { description };
    if (type === 'success') return fn.success(title, payload);
    if (type === 'error') return fn.error(title, payload);
    if (type === 'info') return fn.info(title, payload);
    if (type === 'warning') return fn.warning(title, payload);
  },

  success(title, description) {
    this.notify('success', title, description);
  },

  error(title, description) {
    this.notify('error', title, description);
  },

  info(title, description) {
    this.notify('info', title, description);
  },

  warning(title, description) {
    this.notify('warning', title, description);
  }
};

// Initialize dayjs
if (typeof dayjs !== 'undefined') {
  dayjs.extend(window.dayjs_plugin_relativeTime);
  dayjs.extend(window.dayjs_plugin_utc);
}

if (typeof lucide !== 'undefined') {
  lucide.createIcons();
}

// ═══════════════════════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════════════════════

class UseCaseState {
  constructor() {
    this.useCases = [];
    this.selectedFile = null;
    this.pollTimer = null;
    this.pollInterval = CONFIG.POLL_INTERVAL;
    this.deleteTargetId = null;
    this.prevStatuses = new Map();
    this.currentModalStep = 1;
    this.graphTableItems = [];
    this.currentItemIndex = 0;
    this.itemSelections = {};
    this.pendingTemplateId = null;
    this.dsConfigLoading = false;
    this.isPolling = false;
    this.failedPollCount = 0;
    this.eventListeners = [];
    this.userId = this.getUserId();
    this.isFetchingNow = false;
    this.lastDataHash = null;
  }

  getUserId() {
    const mem = Utils.storage.get(CONFIG.STORAGE_KEYS.MEMBER);
    return mem?.id || mem?.member_id || null;
  }

  getPendingDsConfig() {
    return Utils.storage.get(CONFIG.STORAGE_KEYS.PENDING_CONFIG);
  }

  setPendingDsConfig(config) {
    if (config) {
      Utils.storage.set(CONFIG.STORAGE_KEYS.PENDING_CONFIG, config);
    } else {
      Utils.storage.remove(CONFIG.STORAGE_KEYS.PENDING_CONFIG);
    }
  }

  setUseCases(cases) {
    this.useCases = cases || [];
    this.emitEvent('list-updated', { useCases: this.useCases });
  }

  addEventListenerTracked(element, event, handler, options) {
    element.addEventListener(event, handler, options);
    this.eventListeners.push({ element, event, handler, options });
  }

  cleanup() {
    this.eventListeners.forEach(({ element, event, handler, options }) => {
      element.removeEventListener(event, handler, options);
    });
    this.eventListeners = [];

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  emitEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(`wfuc:${name}`, { detail }));
  }

  resetModalState() {
    this.currentModalStep = 1;
    this.graphTableItems = [];
    this.currentItemIndex = 0;
    this.itemSelections = {};
    this.pendingTemplateId = null;
    this.dsConfigLoading = false;
  }

  resetFileState() {
    this.selectedFile = null;
  }

  startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.pollInterval = CONFIG.POLL_INTERVAL;
    this.failedPollCount = 0;

    if (this.pollTimer) clearInterval(this.pollTimer);

    API.fetchUseCases();
    this.pollTimer = setInterval(() => API.fetchUseCases(), this.pollInterval);
  }

  stopPolling() {
    this.isPolling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  adjustPollingInterval() {
    if (this.failedPollCount > 0) {
      this.pollInterval = Math.min(
        CONFIG.POLL_INTERVAL * Math.pow(CONFIG.POLL_BACKOFF_MULTIPLIER, this.failedPollCount),
        CONFIG.POLL_MAX_INTERVAL
      );
    } else {
      this.pollInterval = CONFIG.POLL_INTERVAL;
    }

    if (this.isPolling) {
      this.stopPolling();
      this.startPolling();
    }
  }

  shouldStopPolling() {
    const hasPending = !!this.getPendingDsConfig();
    if (hasPending) return false;

    if (this.useCases.length === 0) return true;

    return this.useCases.every(uc => {
      const status = (uc.status || '').toLowerCase();
      return status === CONFIG.STATUSES.READY || 
             status === CONFIG.STATUSES.FAILED || 
             status === CONFIG.STATUSES.ERROR;
    });
  }
}

const state = new UseCaseState();

// ═══════════════════════════════════════════════════════════════════════════
// API Layer
// ═══════════════════════════════════════════════════════════════════════════

const API = {
  async request(url, options = {}, retries = CONFIG.MAX_RETRY_ATTEMPTS) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      if (retries > 0 && (error.name === 'TypeError' || error.message.includes('Failed to fetch'))) {
        console.warn(`Request failed, retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.request(url, options, retries - 1);
      }
      throw error;
    }
  },

  async fetchUseCases() {
    if (!state.userId) {
      console.warn('[API] No user ID found');
      return;
    }

    if (state.isFetchingNow) {
      console.debug('[API] Fetch already in progress, skipping...');
      return;
    }

    state.isFetchingNow = true;
    try {
      const url = `${CONFIG.API.FETCH_URL}?userId=${encodeURIComponent(state.userId)}`;
      const response = await this.request(url, { method: 'GET' });
      const data = await response.json();

      state.failedPollCount = 0;
      state.adjustPollingInterval();

      this.processUseCasesData(data);
    } catch (error) {
      console.error('[API] Failed to fetch use cases:', error);
      state.failedPollCount++;
      state.adjustPollingInterval();
    } finally {
      state.isFetchingNow = false;
    }
  },

  processUseCasesData(data) {
    const currentHash = this.hashData(data);
    const hasDataChanged = currentHash !== state.lastDataHash;

    if (!hasDataChanged) {
      console.debug('[API] Data unchanged, skipping re-render');
      return;
    }

    state.lastDataHash = currentHash;
    state.setUseCases(data);

    UI.renderGrid();

    const newlyReady = [];
    data.forEach(uc => {
      const id = uc.id || uc.use_case_id;
      const prevStatus = state.prevStatuses.get(id);
      const nowStatus = (uc.status || '').toLowerCase();

      if (nowStatus === CONFIG.STATUSES.READY && prevStatus !== CONFIG.STATUSES.READY) {
        newlyReady.push(uc);
      }

      state.prevStatuses.set(id, nowStatus);
    });

    if (newlyReady.length > 0) {
      this.handleNewlyReadyUseCases(newlyReady);
    }

    this.handleNewUploadSelection(data);

    if (state.shouldStopPolling()) {
      console.log('[Polling] All use cases stable, stopping poll');
      state.stopPolling();
    }
  },

  hashData(data) {
    try {
      const normalized = JSON.stringify(
        (Array.isArray(data) ? data : [])
          .map(item => ({
            id: item.id || item.use_case_id,
            status: (item.status || '').toLowerCase(),
            name: item.name,
            file_name: item.file_name,
            thumbnail_image: item.thumbnail_image,
            template_id: item.template_id,
            created_at: item.created_at
          }))
          .sort((a, b) => (a.id || '').toString().localeCompare((b.id || '').toString()))
      );

      let hash = 0;
      for (let i = 0; i < normalized.length; i++) {
        const char = normalized.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash.toString();
    } catch (e) {
      console.error('[API] Error hashing data:', e);
      return null;
    }
  },

  handleNewlyReadyUseCases(newlyReady) {
    newlyReady.forEach(uc => {
      state.emitEvent('usecase-ready', { useCase: uc });
      Toast.success('Use case ready', uc.name ? `"${Utils.escapeHtml(uc.name)}" is ready` : 'Your use case is ready');
    });

    const pending = state.getPendingDsConfig();
    if (pending && !state.dsConfigLoading) {
      const match = newlyReady.find(uc =>
        (pending.name && uc.name && uc.name === pending.name) ||
        (pending.file_name && uc.file_name && uc.file_name === pending.file_name)
      );

      if (match) {
        state.setPendingDsConfig(null);
        const templateId = match.template_id || match.name;
        console.log('[DS Config] Auto-opening for template:', templateId);
        DataSourceConfig.open(state.userId, templateId);
      }
    }
  },

  handleNewUploadSelection(data) {
    const recent = Utils.storage.get(CONFIG.STORAGE_KEYS.NEW_UPLOAD);
    if (recent) {
      const found = data.find(u => u.file_name === recent.file_name);
      if (found) {
        Utils.storage.set(CONFIG.STORAGE_KEYS.NEW_USECASE_ID, String(found.id || found.use_case_id));
      }
    }
  },

  async deleteUseCase(useCaseId) {
    if (!useCaseId || !state.userId) {
      throw new Error('Missing required parameters');
    }

    const response = await this.request(CONFIG.API.DELETE_URL, {
      method: 'POST',
      body: JSON.stringify({
        user_id: state.userId,
        use_case_id: useCaseId
      })
    });

    return response.json();
  },

  async uploadUseCase(file, name, description, configureDataSources = false) {
    if (!state.userId) {
      throw new Error('User not authenticated');
    }

    const createResponse = await this.request(CONFIG.API.UPLOAD_URL, {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        user_id: state.userId,
        name,
        description,
        ai_template: true,
        data_sources: configureDataSources
      })
    });

    const { signedUrl } = await createResponse.json();

    const uploadResponse = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload file to storage');
    }

    return { success: true, fileName: file.name };
  },

  async fetchGraphTableData(templateId) {
    const apiTemplateId = Utils.extractTemplateId(templateId);

    console.log('[API] Fetching graph/table data for template:', apiTemplateId);

    const response = await this.request(CONFIG.API.GRAPH_TABLE_URL, {
      method: 'POST',
      body: JSON.stringify({
        user_id: state.userId,
        template_id: apiTemplateId
      })
    });

    const data = await response.json();
    return data.items || [];
  },

  async submitDataSourceConfig(payload) {
    const apiTemplateId = Utils.extractTemplateId(payload.template_id);

    const formattedPayload = {
      user_id: payload.user_id,
      template_id: apiTemplateId,
      data_sources: (payload.data_sources || []).map(source => ({
        slide_number: source.slide_number,
        title: source.title,
        url_image: source.url_image,
        source_type: source.source_type || 'unknown',
        type: source.type || 'graph'
      }))
    };

    console.log('[API] Submitting data sources:', formattedPayload.data_sources.length, 'items');

    const response = await this.request(CONFIG.API.DATA_SOURCE_CONFIG_URL, {
      method: 'POST',
      body: JSON.stringify(formattedPayload)
    });

    return response.json();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// UI Rendering (see wfuc-app2.js for complete UI implementation)
// ═══════════════════════════════════════════════════════════════════════════

const UI = {
  getStatusBadge(status) {
    const s = (status || CONFIG.STATUSES.UPLOADED).toLowerCase();
    const config = {
      [CONFIG.STATUSES.PROCESSING]: { color: '#ea580c', bg: '#fff7ed', label: 'Processing', icon: true },
      [CONFIG.STATUSES.UPLOADED]: { color: '#ea580c', bg: '#fff7ed', label: 'Processing', icon: true },
      [CONFIG.STATUSES.READY]: { color: '#16a34a', bg: '#f0fdf4', label: 'Ready', icon: false },
      [CONFIG.STATUSES.FAILED]: { color: '#dc2626', bg: '#fef2f2', label: 'Failed', icon: false },
      [CONFIG.STATUSES.ERROR]: { color: '#dc2626', bg: '#fef2f2', label: 'Failed', icon: false }
    };

    const { color, bg, label, icon } = config[s] || config[CONFIG.STATUSES.UPLOADED];

    const badge = document.createElement('span');
    badge.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      color: ${color};
      background: ${bg};
    `;

    if (icon) {
      const spinner = document.createElement('span');
      spinner.className = 'wfuc-spinner';
      badge.appendChild(spinner);
    }

    const text = document.createElement('span');
    text.textContent = label;
    badge.appendChild(text);

    return badge;
  },

  createIcon(name, size = 14) {
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', name);
    icon.style.width = `${size}px`;
    icon.style.height = `${size}px`;
    return icon;
  },

  createCardPreview(uc) {
    const preview = document.createElement('div');
    preview.className = 'wfuc-preview';

    const thumbUrl = uc.thumbnail_image ? Utils.safeUrl(uc.thumbnail_image) : null;

    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = Utils.escapeHtml(uc.name || 'Thumbnail');
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
      img.onerror = () => {
        img.style.display = 'none';
        preview.appendChild(this.createIcon('presentation', 48));
      };
      preview.appendChild(img);
    } else {
      const iconWrap = document.createElement('div');
      iconWrap.className = 'wfuc-preview-icon';
      iconWrap.appendChild(this.createIcon('presentation', 48));
      preview.appendChild(iconWrap);
    }

    return preview;
  },

  createCardMenu(id, name) {
    const menuWrap = document.createElement('div');
    menuWrap.style.position = 'relative';

    const menuBtn = document.createElement('button');
    menuBtn.id = `wfuc-btn-${id}`;
    menuBtn.className = 'wfuc-menu-btn';
    menuBtn.appendChild(this.createIcon('more-horizontal', 18));
    menuBtn.onclick = (e) => this.toggleMenu(e, String(id));

    const menu = document.createElement('div');
    menu.id = `wfuc-menu-${id}`;
    menu.className = 'wfuc-dropdown-menu';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'wfuc-menu-item';
    deleteBtn.appendChild(this.createIcon('trash-2', 14));
    deleteBtn.appendChild(document.createTextNode('Delete'));
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      Modal.openDelete(String(id), name || '');
    };

    menu.appendChild(deleteBtn);
    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(menu);

    return menuWrap;
  },

  createCard(uc) {
    const id = uc.id || uc.use_case_id;
    const card = document.createElement('div');
    card.className = 'wfuc-card';
    card.id = `wfuc-card-${id}`;

    if (uc.clickableToHome) {
      card.cursor = 'pointer';
      card.onclick = () => this.handleCardClick(uc);
    } else {
      card.style.cursor = 'default';
    }

    const preview = this.createCardPreview(uc);

    const content = document.createElement('div');
    content.className = 'wfuc-content';

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 4px;';

    const title = document.createElement('h3');
    title.className = 'wfuc-title';
    title.style.cssText = 'margin: 0; flex: 1;';
    const safeName = Utils.escapeHtml(uc.name || 'Untitled');
    title.textContent = safeName;
    title.title = safeName;

    header.appendChild(title);
    header.appendChild(this.createCardMenu(id, uc.name));

    if (uc.description) {
      const description = document.createElement('div');
      description.className = 'wfuc-description';
      const safeDesc = Utils.escapeHtml(uc.description);
      description.textContent = safeDesc;
      description.title = safeDesc;
      content.appendChild(header);
      content.appendChild(description);
    } else {
      content.appendChild(header);
    }

    const metaFile = document.createElement('div');
    metaFile.className = 'wfuc-meta';
    metaFile.appendChild(this.createIcon('file', 14));
    const fileText = document.createElement('span');
    fileText.textContent = Utils.escapeHtml(uc.file_name || 'Unknown file');
    metaFile.appendChild(fileText);

    const metaTime = document.createElement('div');
    metaTime.className = 'wfuc-meta';
    metaTime.style.marginTop = '4px';
    metaTime.appendChild(this.createIcon('clock', 14));
    const timeText = document.createElement('span');
    timeText.textContent = Utils.getRelativeTime(uc.created_at);
    metaTime.appendChild(timeText);

    const statusWrap = document.createElement('div');
    statusWrap.style.marginTop = '12px';
    statusWrap.appendChild(this.getStatusBadge(uc.status));

    content.appendChild(metaFile);
    content.appendChild(metaTime);
    content.appendChild(statusWrap);

    card.appendChild(preview);
    card.appendChild(content);

    return card;
  },

  renderGrid() {
    const grid = document.getElementById('wfuc-use-cases-grid');
    if (!grid) return;

    const addCard = grid.querySelector('.wfuc-add-card');
    grid.innerHTML = '';

    if (addCard) {
      grid.appendChild(addCard);
    }

    if (state.useCases.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wfuc-empty';
      empty.textContent = 'No use cases yet. Create one to get started.';
      grid.appendChild(empty);
      return;
    }

    state.useCases.forEach(uc => {
      const card = this.createCard(uc);
      grid.appendChild(card);
    });

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  },

  handleCardClick(uc) {
    const homeTab = document.querySelector('.nav-links-set-01-2-home');
    if (homeTab) {
      homeTab.click();
    } else {
      console.warn('[UI] Home tab button not found');
    }

    const dropdown = document.getElementById('wfuc-dropdown');
    if (dropdown) {
      const id = uc.id || uc.use_case_id;
      if (id) {
        dropdown.dispatchEvent(new CustomEvent('wfuc:set-selection', {
          detail: { id, template_id: uc.template_id || null }
        }));
      } else {
        console.warn('[UI] Use case has no ID', uc);
      }
    }
  },

  toggleMenu(e, id) {
    e.stopPropagation();
    const root = document.getElementById('wf-use-cases');
    if (!root) return;

    const menus = root.querySelectorAll('.wfuc-dropdown-menu.wfuc-show');
    menus.forEach(m => {
      if (m.id !== `wfuc-menu-${id}`) {
        m.classList.remove('wfuc-show');
      }
    });

    const menu = document.getElementById(`wfuc-menu-${id}`);
    if (menu) {
      menu.classList.toggle('wfuc-show');
      const btn = document.getElementById(`wfuc-btn-${id}`);
      if (btn) {
        btn.classList.toggle('wfuc-active');
      }
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Modal Management
// ═══════════════════════════════════════════════════════════════════════════

const Modal = {
  open(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.classList.add('wfuc-open');
    }
  },

  close(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.classList.remove('wfuc-open');
    }
  },

  openAdd() {
    Modal.open('wfuc-add-modal');
  },

  closeAdd() {
    Modal.close('wfuc-add-modal');
    state.resetFileState();
    Form.resetForm();
  },

  openDelete(id, name) {
    state.deleteTargetId = id;
    const titleEl = document.getElementById('wfuc-delete-title');
    if (titleEl) {
      titleEl.textContent = `Delete "${Utils.escapeHtml(name)}"?`;
    }
    Modal.open('wfuc-delete-modal');
  },

  closeDelete() {
    Modal.close('wfuc-delete-modal');
    state.deleteTargetId = null;
  },

  showStep(step) {
    state.currentModalStep = step;
    const steps = document.querySelectorAll('.wfuc-modal-step');
    steps.forEach(s => s.classList.remove('wfuc-active-step'));
    const activeStep = document.querySelector(`.wfuc-modal-step[data-step="${step}"]`);
    if (activeStep) {
      activeStep.classList.add('wfuc-active-step');
    }
  }
};

// Backward compatibility
function closeAddModal() {
  Modal.closeAdd();
}

function closeDeleteModal() {
  Modal.closeDelete();
}

// Form Management
const Form = {
  validateForm() {
    const nameInput = document.getElementById('wfuc-use-case-name');
    const fileSelected = !!state.selectedFile;
    const nameValid = nameInput && nameInput.value.trim().length > 0;

    const submitBtn = document.getElementById('wfuc-submit');
    if (submitBtn) {
      submitBtn.disabled = !fileSelected || !nameValid;
    }
  },

  resetForm() {
    const inputs = document.querySelectorAll('#wfuc-use-case-name, #wfuc-use-case-desc');
    inputs.forEach(i => (i.value = ''));
    this.validateForm();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Data Source Configuration
// ═══════════════════════════════════════════════════════════════════════════

const DataSourceConfig = {
  currentStep: 'items',

  async open(userId, templateId) {
    if (state.dsConfigLoading) return;
    state.dsConfigLoading = true;
    state.pendingTemplateId = templateId;
    this.currentStep = 'items';

    Modal.open('wfuc-add-modal');
    Modal.showStep(3);

    this.showLoading();

    try {
      console.log('[DS Config] Loading data for template:', templateId);
      const items = await API.fetchGraphTableData(templateId);
      console.log('[DS Config] Loaded', items.length, 'items');

      if (items.length === 0) {
        Toast.info('No content found', 'No charts or tables were found in this template');
        Modal.closeAdd();
        return;
      }

      state.graphTableItems = items;
      state.currentItemIndex = 0;
      state.itemSelections = {};

      this.renderCurrent();
      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
    } catch (error) {
      console.error('[DS Config] Load error:', error);
      Toast.error('Failed to load', error.message || 'Could not load content. Please try again');
      Modal.closeAdd();
    } finally {
      state.dsConfigLoading = false;
    }
  },

  showLoading() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:#94a3b8">
          <span class="wfuc-spinner" style="width:24px;height:24px;border-width:2px;display:inline-block"></span>
          <p style="margin-top:16px;font-size:14px;font-weight:500">Loading charts and tables...</p>
        </div>
      `;
    }

    const confirmBtn = document.getElementById('wfuc-ds-confirm');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Loading...';
    }

    ['wfuc-ds-dots', 'wfuc-ds-counter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });

    ['wfuc-ds-prev', 'wfuc-ds-next'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
  },

  getItemTypeIcon(type) {
    if (type === 'table') {
      return '<i data-lucide="table-rows" style="width:16px;height:16px;color:#3b82f6"></i>';
    }
    return '<i data-lucide="bar-chart-3" style="width:16px;height:16px;color:#a855f7"></i>';
  },

  getItemTypeBadge(type) {
    const typeStr = (type || 'graph').toLowerCase();
    const config = {
      'table': { label: 'Table', color: '#eff6ff', textColor: '#1e40af' },
      'graph': { label: 'Chart', color: '#faf5ff', textColor: '#5b21b6' }
    };

    const { label, color, textColor } = config[typeStr] || config['graph'];

    return `
      <span style="
        display:inline-flex;align-items:center;gap:6px;
        padding:4px 10px;border-radius:6px;
        background:${color};color:${textColor};
        font-size:12px;font-weight:500;
      ">
        ${this.getItemTypeIcon(typeStr)}
        ${label}
      </span>
    `;
  },

  renderCurrent() {
    if (this.currentStep === 'summary') {
      this.renderSummary();
      return;
    }

    const item = state.graphTableItems[state.currentItemIndex];
    if (!item) return;

    const container = document.getElementById('wfuc-ds-item-container');
    if (!container) return;

    const selected = state.itemSelections[state.currentItemIndex] || '';
    const chk = (val) => selected === val ? 'checked' : '';

    const safeTitle = Utils.escapeHtml(item.title);
    const safeImageUrl = Utils.escapeHtml(item.url_image);

    container.innerHTML = `
      <h3 class="wfuc-ds-item-title" style="font-size:18px;font-weight:600;margin:0 0 10px;color:#0f172a;">${safeTitle}</h3>
      <div class="wfuc-ds-image-wrap">
        <span class="wfuc-ds-slide-badge">
          Slide ${item.slide_number}
          ${this.getItemTypeBadge(item.type)}
        </span>
        <img src="${safeImageUrl}" alt="${safeTitle}" onerror="this.parentElement.style.minHeight='120px'">
      </div>
      <p style="font-size:13px;color:#64748b;margin:12px 0">Select the data source type:</p>
      <div class="wfuc-ds-options">
        <label class="wfuc-ds-option">
          <input type="radio" name="wfuc-ds-source" value="excel" ${chk('excel')} onchange="DataSourceConfig.selectSource('excel')">
          <div class="wfuc-ds-option-label">
            <div class="wfuc-ds-option-icon"><i data-lucide="file-spreadsheet"></i></div>
            <span class="wfuc-ds-option-text">
              <strong>Excel</strong>
              <div style="font-size:11px;color:#94a3b8">Connected spreadsheet</div>
            </span>
          </div>
        </label>
        <label class="wfuc-ds-option">
          <input type="radio" name="wfuc-ds-source" value="api" ${chk('api')} onchange="DataSourceConfig.selectSource('api')">
          <div class="wfuc-ds-option-label">
            <div class="wfuc-ds-option-icon"><i data-lucide="plug-2"></i></div>
            <span class="wfuc-ds-option-text">
              <strong>API</strong>
              <div style="font-size:11px;color:#94a3b8">Live data integration</div>
            </span>
          </div>
        </label>
        <label class="wfuc-ds-option">
          <input type="radio" name="wfuc-ds-source" value="no_change" ${chk('no_change')} onchange="DataSourceConfig.selectSource('no_change')">
          <div class="wfuc-ds-option-label">
            <div class="wfuc-ds-option-icon"><i data-lucide="minus-circle"></i></div>
            <span class="wfuc-ds-option-text">
              <strong>No change</strong>
              <div style="font-size:11px;color:#94a3b8">Keep manual updates</div>
            </span>
          </div>
        </label>
      </div>
    `;

    this.updateUI();
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  },

  renderSummary() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (!container) return;

    const configs = state.graphTableItems
      .map((item, i) => ({
        ...item,
        source_type: state.itemSelections[i] || 'no_change'
      }))
      .map(item => `
        <div style="
          display:flex;gap:12px;padding:12px;
          border:1px solid #e2e8f0;border-radius:8px;
          background:#f8fafc;margin-bottom:8px;
        ">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              ${this.getItemTypeBadge(item.type)}
            </div>
            <div style="font-size:13px;font-weight:500;color:#0f172a;margin-bottom:2px">${Utils.escapeHtml(item.title)}</div>
            <div style="font-size:12px;color:#64748b">Slide ${item.slide_number}</div>
          </div>
          <div style="text-align:right;min-width:100px">
            <div style="font-size:12px;font-weight:500;color:#7c3aed">
              ${item.source_type === 'no_change' ? '⏸ No change' : 
                item.source_type === 'excel' ? '📊 Excel' : 
                '🔌 API'}
            </div>
          </div>
        </div>
      `).join('');

    const confirmBtn = document.getElementById('wfuc-ds-confirm');

    container.innerHTML = `
      <div style="padding:20px 0">
        <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#0f172a">
          <i data-lucide="check-circle-2" style="width:18px;height:18px;color:#16a34a;margin-right:6px;vertical-align:-2px"></i>
          Review Configuration
        </h4>
        <p style="font-size:13px;color:#64748b;margin:0 0 16px">
          ${state.graphTableItems.length} item${state.graphTableItems.length !== 1 ? 's' : ''} ready to configure
        </p>
        <div style="max-height:300px;overflow-y:auto">
          ${configs}
        </div>
      </div>
    `;

    if (confirmBtn) {
      confirmBtn.textContent = 'Complete Setup';
      confirmBtn.disabled = false;
    }

    ['wfuc-ds-dots', 'wfuc-ds-counter', 'wfuc-ds-nav'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  },

  updateUI() {
    const counter = document.getElementById('wfuc-ds-counter');
    if (counter) {
      counter.textContent = `${state.currentItemIndex + 1} of ${state.graphTableItems.length}`;
    }

    const prevBtn = document.getElementById('wfuc-ds-prev');
    if (prevBtn) prevBtn.disabled = state.currentItemIndex === 0;

    const nextBtn = document.getElementById('wfuc-ds-next');
    if (nextBtn) nextBtn.disabled = state.currentItemIndex === state.graphTableItems.length - 1;

    this.updateConfirmButton();
    this.renderDots();
  },

  renderDots() {
    const container = document.getElementById('wfuc-ds-dots');
    if (!container) return;

    container.innerHTML = '';
    state.graphTableItems.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'wfuc-ds-dot';

      if (i === state.currentItemIndex) {
        dot.classList.add('wfuc-dot-current');
      } else if (state.itemSelections[i]) {
        dot.classList.add('wfuc-dot-set');
      }

      dot.onclick = () => {
        state.currentItemIndex = i;
        this.renderCurrent();
      };

      container.appendChild(dot);
    });
  },

  navigate(direction) {
    const newIndex = state.currentItemIndex + direction;
    if (newIndex < 0 || newIndex >= state.graphTableItems.length) return;

    state.currentItemIndex = newIndex;
    this.renderCurrent();
  },

  selectSource(type) {
    state.itemSelections[state.currentItemIndex] = type;
    this.renderDots();
    this.updateConfirmButton();
  },

  applyToAll(type) {
    state.graphTableItems.forEach((_, i) => {
      state.itemSelections[i] = type;
    });
    this.renderCurrent();
  },

  updateConfirmButton() {
    const btn = document.getElementById('wfuc-ds-confirm');
    if (!btn) return;

    const allSelected = state.graphTableItems.length > 0 && 
      state.graphTableItems.every((_, i) => state.itemSelections[i]);

    btn.disabled = !allSelected;
    if (allSelected && this.currentStep === 'items') {
      btn.textContent = 'Review Setup';
    }
  },

  async submit() {
    const btn = document.getElementById('wfuc-ds-confirm');
    if (!btn) return;

    if (this.currentStep === 'summary') {
      await this.doSubmit(btn);
      return;
    }

    this.currentStep = 'summary';
    btn.textContent = 'Submitting...';
    btn.disabled = true;
    this.renderCurrent();

    setTimeout(async () => {
      await this.doSubmit(btn);
    }, 500);
  },

  async doSubmit(btn) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="wfuc-spinner"></span> Completing setup...';

    const payload = {
      user_id: state.userId,
      template_id: state.pendingTemplateId,
      data_sources: state.graphTableItems.map((item, i) => ({
        slide_number: item.slide_number,
        title: item.title,
        url_image: item.url_image,
        source_type: state.itemSelections[i] || 'no_change',
        type: item.type || 'graph'
      }))
    };

    try {
      console.log('[DS Config] Submitting payload with', payload.data_sources.length, 'items');
      const response = await API.submitDataSourceConfig(payload);
      console.log('[DS Config] Response:', response);

      Toast.success('Setup complete!', 'Data sources configured successfully');

      setTimeout(() => {
        Modal.closeAdd();
      }, 500);
    } catch (error) {
      console.error('[DS Config] Submit error:', error);
      Toast.error('Setup failed', error.message || 'Could not save configuration. Please try again');

      this.currentStep = 'items';
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
};

async function submitDataSourceConfig() {
  return DataSourceConfig.submit();
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════

console.log('[UseCases] Initializing...');

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    UI.renderGrid();
    state.startPolling();
    console.log('[UseCases] Ready');
  });
} else {
  UI.renderGrid();
  state.startPolling();
  console.log('[UseCases] Ready');
}

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  state.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

const Utils = {
  sanitizeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },

  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return String(text || '').replace(/[&<>"']/g, m => map[m]);
  },

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  },

  safeJsonParse(str, defaultValue = null) {
    try {
      return JSON.parse(str);
    } catch {
      return defaultValue;
    }
  },

  storage: {
    get(key) {
      try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn('[Storage] Could not save:', key, e);
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        console.warn('[Storage] Could not remove:', key, e);
      }
    }
  },

  safeUrl(value, allowed = ['http:', 'https:']) {
    if (!value) return '';
    try {
      const url = new URL(value);
      return allowed.includes(url.protocol) ? value : '';
    } catch {
      return '';
    }
  },

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  },

  validateFile(file) {
    if (!file) return { valid: false, error: 'No file selected' };
    if (file.size > CONFIG.MAX_FILE_SIZE) {
      return { valid: false, error: `File too large. Max size: ${Utils.formatFileSize(CONFIG.MAX_FILE_SIZE)}` };
    }
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!CONFIG.ALLOWED_FILE_TYPES.includes(ext)) {
      return { valid: false, error: `File type ${ext} not allowed. Allowed: ${CONFIG.ALLOWED_FILE_TYPES.join(', ')}` };
    }
    return { valid: true };
  },

  getRelativeTime(dateStr) {
    if (!dateStr) return '';
    try {
      if (typeof dayjs === 'undefined') return new Date(dateStr).toLocaleDateString();
      if (dayjs.utc) {
        return dayjs.utc(dateStr).fromNow();
      }
      let d = String(dateStr).trim();
      if (!d.endsWith('Z') && !d.includes('+') && !d.includes('GMT')) {
        d = d.replace(' ', 'T') + 'Z';
      }
      return dayjs(d).fromNow();
    } catch (e) {
      return new Date(dateStr).toLocaleDateString();
    }
  },

  extractTemplateId(fullTemplateId) {
    if (!fullTemplateId) return null;
    if (fullTemplateId.startsWith('req_')) {
      return fullTemplateId;
    }
    const match = fullTemplateId.match(/req_\d{8}_[a-f0-9]+/);
    if (match) {
      return match[0];
    }
    console.warn('[Utils] Could not extract template ID from:', fullTemplateId);
    return fullTemplateId;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Toast Notifications
// ═══════════════════════════════════════════════════════════════════════════

const Toast = {
  getInstance() {
    const fn = typeof window !== 'undefined' ? window.sonnerJS : null;
    return typeof fn === 'function' ? fn : null;
  },

  notify(type, title, description) {
    const fn = this.getInstance();
    if (!fn) return;
    const payload = { description };
    if (type === 'success') return fn.success(title, payload);
    if (type === 'error') return fn.error(title, payload);
    if (type === 'info') return fn.info(title, payload);
    if (type === 'warning') return fn.warning(title, payload);
  },

  success(title, description) {
    this.notify('success', title, description);
  },

  error(title, description) {
    this.notify('error', title, description);
  },

  info(title, description) {
    this.notify('info', title, description);
  },

  warning(title, description) {
    this.notify('warning', title, description);
  }
};

// Initialize dayjs
if (typeof dayjs !== 'undefined') {
  dayjs.extend(window.dayjs_plugin_relativeTime);
  dayjs.extend(window.dayjs_plugin_utc);
}

if (typeof lucide !== 'undefined') {
  lucide.createIcons();
}

// ═══════════════════════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════════════════════

class UseCaseState {
  constructor() {
    this.useCases = [];
    this.selectedFile = null;
    this.pollTimer = null;
    this.pollInterval = CONFIG.POLL_INTERVAL;
    this.deleteTargetId = null;
    this.prevStatuses = new Map();
    this.currentModalStep = 1;
    this.graphTableItems = [];
    this.currentItemIndex = 0;
    this.itemSelections = {};
    this.pendingTemplateId = null;
    this.dsConfigLoading = false;
    this.isPolling = false;
    this.failedPollCount = 0;
    this.eventListeners = [];
    this.userId = this.getUserId();
    this.isFetchingNow = false;
    this.lastDataHash = null;
  }

  getUserId() {
    const mem = Utils.storage.get(CONFIG.STORAGE_KEYS.MEMBER);
    return mem?.id || mem?.member_id || null;
  }

  getPendingDsConfig() {
    return Utils.storage.get(CONFIG.STORAGE_KEYS.PENDING_CONFIG);
  }

  setPendingDsConfig(config) {
    if (config) {
      Utils.storage.set(CONFIG.STORAGE_KEYS.PENDING_CONFIG, config);
    } else {
      Utils.storage.remove(CONFIG.STORAGE_KEYS.PENDING_CONFIG);
    }
  }

  setUseCases(cases) {
    this.useCases = cases || [];
    this.emitEvent('list-updated', { useCases: this.useCases });
  }

  addEventListenerTracked(element, event, handler, options) {
    element.addEventListener(event, handler, options);
    this.eventListeners.push({ element, event, handler, options });
  }

  cleanup() {
    this.eventListeners.forEach(({ element, event, handler, options }) => {
      element.removeEventListener(event, handler, options);
    });
    this.eventListeners = [];

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  emitEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(`wfuc:${name}`, { detail }));
  }

  resetModalState() {
    this.currentModalStep = 1;
    this.graphTableItems = [];
    this.currentItemIndex = 0;
    this.itemSelections = {};
    this.pendingTemplateId = null;
    this.dsConfigLoading = false;
  }

  resetFileState() {
    this.selectedFile = null;
  }

  startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.pollInterval = CONFIG.POLL_INTERVAL;
    this.failedPollCount = 0;

    if (this.pollTimer) clearInterval(this.pollTimer);

    API.fetchUseCases();
    this.pollTimer = setInterval(() => API.fetchUseCases(), this.pollInterval);
  }

  stopPolling() {
    this.isPolling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  adjustPollingInterval() {
    if (this.failedPollCount > 0) {
      this.pollInterval = Math.min(
        CONFIG.POLL_INTERVAL * Math.pow(CONFIG.POLL_BACKOFF_MULTIPLIER, this.failedPollCount),
        CONFIG.POLL_MAX_INTERVAL
      );
    } else {
      this.pollInterval = CONFIG.POLL_INTERVAL;
    }

    if (this.isPolling) {
      this.stopPolling();
      this.startPolling();
    }
  }

  shouldStopPolling() {
    const hasPending = !!this.getPendingDsConfig();
    if (hasPending) return false;

    if (this.useCases.length === 0) return true;

    return this.useCases.every(uc => {
      const status = (uc.status || '').toLowerCase();
      return status === CONFIG.STATUSES.READY || 
             status === CONFIG.STATUSES.FAILED || 
             status === CONFIG.STATUSES.ERROR;
    });
  }
}

const state = new UseCaseState();

// ═══════════════════════════════════════════════════════════════════════════
// API Layer
// ═══════════════════════════════════════════════════════════════════════════

const API = {
  async request(url, options = {}, retries = CONFIG.MAX_RETRY_ATTEMPTS) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      if (retries > 0 && (error.name === 'TypeError' || error.message.includes('Failed to fetch'))) {
        console.warn(`Request failed, retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.request(url, options, retries - 1);
      }
      throw error;
    }
  },

  async fetchUseCases() {
    if (!state.userId) {
      console.warn('[API] No user ID found');
      return;
    }

    if (state.isFetchingNow) {
      console.debug('[API] Fetch already in progress, skipping...');
      return;
    }

    state.isFetchingNow = true;
    try {
      const url = `${CONFIG.API.FETCH_URL}?userId=${encodeURIComponent(state.userId)}`;
      const response = await this.request(url, { method: 'GET' });
      const data = await response.json();

      state.failedPollCount = 0;
      state.adjustPollingInterval();

      this.processUseCasesData(data);
    } catch (error) {
      console.error('[API] Failed to fetch use cases:', error);
      state.failedPollCount++;
      state.adjustPollingInterval();
    } finally {
      state.isFetchingNow = false;
    }
  },

  processUseCasesData(data) {
    const currentHash = this.hashData(data);
    const hasDataChanged = currentHash !== state.lastDataHash;

    if (!hasDataChanged) {
      console.debug('[API] Data unchanged, skipping re-render');
      return;
    }

    state.lastDataHash = currentHash;
    state.setUseCases(data);

    UI.renderGrid();

    const newlyReady = [];
    data.forEach(uc => {
      const id = uc.id || uc.use_case_id;
      const prevStatus = state.prevStatuses.get(id);
      const nowStatus = (uc.status || '').toLowerCase();

      if (nowStatus === CONFIG.STATUSES.READY && prevStatus !== CONFIG.STATUSES.READY) {
        newlyReady.push(uc);
      }

      state.prevStatuses.set(id, nowStatus);
    });

    if (newlyReady.length > 0) {
      this.handleNewlyReadyUseCases(newlyReady);
    }

    this.handleNewUploadSelection(data);

    if (state.shouldStopPolling()) {
      console.log('[Polling] All use cases stable, stopping poll');
      state.stopPolling();
    }
  },

  hashData(data) {
    try {
      const normalized = JSON.stringify(
        (Array.isArray(data) ? data : [])
          .map(item => ({
            id: item.id || item.use_case_id,
            status: (item.status || '').toLowerCase(),
            name: item.name,
            file_name: item.file_name,
            thumbnail_image: item.thumbnail_image,
            template_id: item.template_id,
            created_at: item.created_at
          }))
          .sort((a, b) => (a.id || '').toString().localeCompare((b.id || '').toString()))
      );

      let hash = 0;
      for (let i = 0; i < normalized.length; i++) {
        const char = normalized.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash.toString();
    } catch (e) {
      console.error('[API] Error hashing data:', e);
      return null;
    }
  },

  handleNewlyReadyUseCases(newlyReady) {
    newlyReady.forEach(uc => {
      state.emitEvent('usecase-ready', { useCase: uc });
      Toast.success('Use case ready', uc.name ? `"${Utils.escapeHtml(uc.name)}" is ready` : 'Your use case is ready');
    });

    const pending = state.getPendingDsConfig();
    if (pending && !state.dsConfigLoading) {
      const match = newlyReady.find(uc =>
        (pending.name && uc.name && uc.name === pending.name) ||
        (pending.file_name && uc.file_name && uc.file_name === pending.file_name)
      );

      if (match) {
        state.setPendingDsConfig(null);
        const templateId = match.template_id || match.name;
        console.log('[DS Config] Auto-opening for template:', templateId);
        DataSourceConfig.open(state.userId, templateId);
      }
    }
  },

  handleNewUploadSelection(data) {
    const recent = Utils.storage.get(CONFIG.STORAGE_KEYS.NEW_UPLOAD);
    if (recent) {
      const found = data.find(u => u.file_name === recent.file_name);
      if (found) {
        Utils.storage.set(CONFIG.STORAGE_KEYS.NEW_USECASE_ID, String(found.id || found.use_case_id));
      }
    }
  },

  async deleteUseCase(useCaseId) {
    if (!useCaseId || !state.userId) {
      throw new Error('Missing required parameters');
    }

    const response = await this.request(CONFIG.API.DELETE_URL, {
      method: 'POST',
      body: JSON.stringify({
        user_id: state.userId,
        use_case_id: useCaseId
      })
    });

    return response.json();
  },

  async uploadUseCase(file, name, description) {
    if (!state.userId) {
      throw new Error('User not authenticated');
    }

    const createResponse = await this.request(CONFIG.API.UPLOAD_URL, {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        user_id: state.userId,
        name,
        description,
        ai_template: true
      })
    });

    const { signedUrl } = await createResponse.json();

    const uploadResponse = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload file to storage');
    }

    return { success: true, fileName: file.name };
  },

  async fetchGraphTableData(templateId) {
    const apiTemplateId = Utils.extractTemplateId(templateId);

    console.log('[API] Fetching graph/table data for template:', apiTemplateId);

    const response = await this.request(CONFIG.API.GRAPH_TABLE_URL, {
      method: 'POST',
      body: JSON.stringify({
        user_id: state.userId,
        template_id: apiTemplateId
      })
    });

    const data = await response.json();
    return data.items || [];
  },

  async submitDataSourceConfig(payload) {
    const apiTemplateId = Utils.extractTemplateId(payload.template_id);

    const formattedPayload = {
      user_id: payload.user_id,
      template_id: apiTemplateId,
      data_sources: (payload.data_sources || []).map(source => ({
        slide_number: source.slide_number,
        title: source.title,
        url_image: source.url_image,
        source_type: source.source_type || 'unknown',
        type: source.type || 'graph'
      }))
    };

    console.log('[API] Submitting data sources:', formattedPayload.data_sources.length, 'items');

    const response = await this.request(CONFIG.API.DATA_SOURCE_CONFIG_URL, {
      method: 'POST',
      body: JSON.stringify(formattedPayload)
    });

    return response.json();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// UI Rendering (see wfuc-app2.js for complete UI implementation)
// ═══════════════════════════════════════════════════════════════════════════

const UI = {
  getStatusBadge(status) {
    const s = (status || CONFIG.STATUSES.UPLOADED).toLowerCase();
    const config = {
      [CONFIG.STATUSES.PROCESSING]: { color: '#ea580c', bg: '#fff7ed', label: 'Processing', icon: true },
      [CONFIG.STATUSES.UPLOADED]: { color: '#ea580c', bg: '#fff7ed', label: 'Processing', icon: true },
      [CONFIG.STATUSES.READY]: { color: '#16a34a', bg: '#f0fdf4', label: 'Ready', icon: false },
      [CONFIG.STATUSES.FAILED]: { color: '#dc2626', bg: '#fef2f2', label: 'Failed', icon: false },
      [CONFIG.STATUSES.ERROR]: { color: '#dc2626', bg: '#fef2f2', label: 'Failed', icon: false }
    };

    const { color, bg, label, icon } = config[s] || config[CONFIG.STATUSES.UPLOADED];

    const badge = document.createElement('span');
    badge.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      color: ${color};
      background: ${bg};
    `;

    if (icon) {
      const spinner = document.createElement('span');
      spinner.className = 'wfuc-spinner';
      badge.appendChild(spinner);
    }

    const text = document.createElement('span');
    text.textContent = label;
    badge.appendChild(text);

    return badge;
  },

  createIcon(name, size = 14) {
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', name);
    icon.style.width = `${size}px`;
    icon.style.height = `${size}px`;
    return icon;
  },

  createCardPreview(uc) {
    const preview = document.createElement('div');
    preview.className = 'wfuc-preview';

    const thumbUrl = uc.thumbnail_image ? Utils.safeUrl(uc.thumbnail_image) : null;

    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = Utils.escapeHtml(uc.name || 'Thumbnail');
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
      img.onerror = () => {
        img.style.display = 'none';
        preview.appendChild(this.createIcon('presentation', 48));
      };
      preview.appendChild(img);
    } else {
      const iconWrap = document.createElement('div');
      iconWrap.className = 'wfuc-preview-icon';
      iconWrap.appendChild(this.createIcon('presentation', 48));
      preview.appendChild(iconWrap);
    }

    return preview;
  },

  createCardMenu(id, name) {
    const menuWrap = document.createElement('div');
    menuWrap.style.position = 'relative';

    const menuBtn = document.createElement('button');
    menuBtn.id = `wfuc-btn-${id}`;
    menuBtn.className = 'wfuc-menu-btn';
    menuBtn.appendChild(this.createIcon('more-horizontal', 18));
    menuBtn.onclick = (e) => this.toggleMenu(e, String(id));

    const menu = document.createElement('div');
    menu.id = `wfuc-menu-${id}`;
    menu.className = 'wfuc-dropdown-menu';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'wfuc-menu-item';
    deleteBtn.appendChild(this.createIcon('trash-2', 14));
    deleteBtn.appendChild(document.createTextNode('Delete'));
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      Modal.openDelete(String(id), name || '');
    };

    menu.appendChild(deleteBtn);
    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(menu);

    return menuWrap;
  },

  createCard(uc) {
    const id = uc.id || uc.use_case_id;
    const card = document.createElement('div');
    card.className = 'wfuc-card';
    card.id = `wfuc-card-${id}`;

    if (uc.clickableToHome) {
      card.cursor = 'pointer';
      card.onclick = () => this.handleCardClick(uc);
    } else {
      card.style.cursor = 'default';
    }

    const preview = this.createCardPreview(uc);

    const content = document.createElement('div');
    content.className = 'wfuc-content';

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 4px;';

    const title = document.createElement('h3');
    title.className = 'wfuc-title';
    title.style.cssText = 'margin: 0; flex: 1;';
    const safeName = Utils.escapeHtml(uc.name || 'Untitled');
    title.textContent = safeName;
    title.title = safeName;

    header.appendChild(title);
    header.appendChild(this.createCardMenu(id, uc.name));

    if (uc.description) {
      const description = document.createElement('div');
      description.className = 'wfuc-description';
      const safeDesc = Utils.escapeHtml(uc.description);
      description.textContent = safeDesc;
      description.title = safeDesc;
      content.appendChild(header);
      content.appendChild(description);
    } else {
      content.appendChild(header);
    }

    const metaFile = document.createElement('div');
    metaFile.className = 'wfuc-meta';
    metaFile.appendChild(this.createIcon('file', 14));
    const fileText = document.createElement('span');
    fileText.textContent = Utils.escapeHtml(uc.file_name || 'Unknown file');
    metaFile.appendChild(fileText);

    const metaTime = document.createElement('div');
    metaTime.className = 'wfuc-meta';
    metaTime.style.marginTop = '4px';
    metaTime.appendChild(this.createIcon('clock', 14));
    const timeText = document.createElement('span');
    timeText.textContent = Utils.getRelativeTime(uc.created_at);
    metaTime.appendChild(timeText);

    const statusWrap = document.createElement('div');
    statusWrap.style.marginTop = '12px';
    statusWrap.appendChild(this.getStatusBadge(uc.status));

    content.appendChild(metaFile);
    content.appendChild(metaTime);
    content.appendChild(statusWrap);

    card.appendChild(preview);
    card.appendChild(content);

    return card;
  },

  renderGrid() {
    const grid = document.getElementById('wfuc-use-cases-grid');
    if (!grid) return;

    const addCard = grid.querySelector('.wfuc-add-card');
    grid.innerHTML = '';

    if (addCard) {
      grid.appendChild(addCard);
    }

    if (state.useCases.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wfuc-empty';
      empty.textContent = 'No use cases yet. Create one to get started.';
      grid.appendChild(empty);
      return;
    }

    state.useCases.forEach(uc => {
      const card = this.createCard(uc);
      grid.appendChild(card);
    });

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  },

  handleCardClick(uc) {
    const homeTab = document.querySelector('.nav-links-set-01-2-home');
    if (homeTab) {
      homeTab.click();
    } else {
      console.warn('[UI] Home tab button not found');
    }

    const dropdown = document.getElementById('wfuc-dropdown');
    if (dropdown) {
      const id = uc.id || uc.use_case_id;
      if (id) {
        dropdown.dispatchEvent(new CustomEvent('wfuc:set-selection', {
          detail: { id, template_id: uc.template_id || null }
        }));
      } else {
        console.warn('[UI] Use case has no ID', uc);
      }
    }
  },

  toggleMenu(e, id) {
    e.stopPropagation();
    const root = document.getElementById('wf-use-cases');
    if (!root) return;

    const menus = root.querySelectorAll('.wfuc-dropdown-menu.wfuc-show');
    menus.forEach(m => {
      if (m.id !== `wfuc-menu-${id}`) {
        m.classList.remove('wfuc-show');
      }
    });

    const menu = document.getElementById(`wfuc-menu-${id}`);
    if (menu) {
      menu.classList.toggle('wfuc-show');
      const btn = document.getElementById(`wfuc-btn-${id}`);
      if (btn) {
        btn.classList.toggle('wfuc-active');
      }
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Modal Management
// ═══════════════════════════════════════════════════════════════════════════

const Modal = {
  open(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.classList.add('wfuc-open');
    }
  },

  close(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.classList.remove('wfuc-open');
    }
  },

  openAdd() {
    Modal.open('wfuc-add-modal');
  },

  closeAdd() {
    Modal.close('wfuc-add-modal');
    state.resetFileState();
    Form.resetForm();
  },

  openDelete(id, name) {
    state.deleteTargetId = id;
    const titleEl = document.getElementById('wfuc-delete-title');
    if (titleEl) {
      titleEl.textContent = `Delete "${Utils.escapeHtml(name)}"?`;
    }
    Modal.open('wfuc-delete-modal');
  },

  closeDelete() {
    Modal.close('wfuc-delete-modal');
    state.deleteTargetId = null;
  },

  showStep(step) {
    state.currentModalStep = step;
    const steps = document.querySelectorAll('.wfuc-modal-step');
    steps.forEach(s => s.classList.remove('wfuc-active-step'));
    const activeStep = document.querySelector(`.wfuc-modal-step[data-step="${step}"]`);
    if (activeStep) {
      activeStep.classList.add('wfuc-active-step');
    }
  }
};

// Backward compatibility
function closeAddModal() {
  Modal.closeAdd();
}

function closeDeleteModal() {
  Modal.closeDelete();
}

// Form Management
const Form = {
  validateForm() {
    const nameInput = document.getElementById('wfuc-use-case-name');
    const fileSelected = !!state.selectedFile;
    const nameValid = nameInput && nameInput.value.trim().length > 0;

    const submitBtn = document.getElementById('wfuc-submit');
    if (submitBtn) {
      submitBtn.disabled = !fileSelected || !nameValid;
    }
  },

  resetForm() {
    const inputs = document.querySelectorAll('#wfuc-use-case-name, #wfuc-use-case-desc');
    inputs.forEach(i => (i.value = ''));
    this.validateForm();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Data Source Configuration
// ═══════════════════════════════════════════════════════════════════════════

const DataSourceConfig = {
  currentStep: 'items',

  async open(userId, templateId) {
    if (state.dsConfigLoading) return;
    state.dsConfigLoading = true;
    state.pendingTemplateId = templateId;
    this.currentStep = 'items';

    Modal.open('wfuc-add-modal');
    Modal.showStep(3);

    this.showLoading();

    try {
      console.log('[DS Config] Loading data for template:', templateId);
      const items = await API.fetchGraphTableData(templateId);
      console.log('[DS Config] Loaded', items.length, 'items');

      if (items.length === 0) {
        Toast.info('No content found', 'No charts or tables were found in this template');
        Modal.closeAdd();
        return;
      }

      state.graphTableItems = items;
      state.currentItemIndex = 0;
      state.itemSelections = {};

      this.renderCurrent();
      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
    } catch (error) {
      console.error('[DS Config] Load error:', error);
      Toast.error('Failed to load', error.message || 'Could not load content. Please try again');
      Modal.closeAdd();
    } finally {
      state.dsConfigLoading = false;
    }
  },

  showLoading() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:#94a3b8">
          <span class="wfuc-spinner" style="width:24px;height:24px;border-width:2px;display:inline-block"></span>
          <p style="margin-top:16px;font-size:14px;font-weight:500">Loading charts and tables...</p>
        </div>
      `;
    }

    const confirmBtn = document.getElementById('wfuc-ds-confirm');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Loading...';
    }

    ['wfuc-ds-dots', 'wfuc-ds-counter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });

    ['wfuc-ds-prev', 'wfuc-ds-next'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
  },

  getItemTypeIcon(type) {
    if (type === 'table') {
      return '<i data-lucide="table-rows" style="width:16px;height:16px;color:#3b82f6"></i>';
    }
    return '<i data-lucide="bar-chart-3" style="width:16px;height:16px;color:#a855f7"></i>';
  },

  getItemTypeBadge(type) {
    const typeStr = (type || 'graph').toLowerCase();
    const config = {
      'table': { label: 'Table', color: '#eff6ff', textColor: '#1e40af' },
      'graph': { label: 'Chart', color: '#faf5ff', textColor: '#5b21b6' }
    };

    const { label, color, textColor } = config[typeStr] || config['graph'];

    return `
      <span style="
        display:inline-flex;align-items:center;gap:6px;
        padding:4px 10px;border-radius:6px;
        background:${color};color:${textColor};
        font-size:12px;font-weight:500;
      ">
        ${this.getItemTypeIcon(typeStr)}
        ${label}
      </span>
    `;
  },

  renderCurrent() {
    if (this.currentStep === 'summary') {
      this.renderSummary();
      return;
    }

    const item = state.graphTableItems[state.currentItemIndex];
    if (!item) return;

    const container = document.getElementById('wfuc-ds-item-container');
    if (!container) return;

    const selected = state.itemSelections[state.currentItemIndex] || '';
    const chk = (val) => selected === val ? 'checked' : '';

    const safeTitle = Utils.escapeHtml(item.title);
    const safeImageUrl = Utils.escapeHtml(item.url_image);

    container.innerHTML = `
      <div class="wfuc-ds-image-wrap">
        <span class="wfuc-ds-slide-badge">
          Slide ${item.slide_number}
          ${this.getItemTypeBadge(item.type)}
        </span>
        <img src="${safeImageUrl}" alt="${safeTitle}" onerror="this.parentElement.style.minHeight='120px'">
      </div>
      <h3 class="wfuc-ds-item-title">${safeTitle}</h3>
      <p style="font-size:13px;color:#64748b;margin:12px 0">Select the data source type:</p>
      <div class="wfuc-ds-options">
        <label class="wfuc-ds-option">
          <input type="radio" name="wfuc-ds-source" value="excel" ${chk('excel')} onchange="DataSourceConfig.selectSource('excel')">
          <div class="wfuc-ds-option-label">
            <div class="wfuc-ds-option-icon"><i data-lucide="file-spreadsheet"></i></div>
            <span class="wfuc-ds-option-text">
              <strong>Excel</strong>
              <div style="font-size:11px;color:#94a3b8">Connected spreadsheet</div>
            </span>
          </div>
        </label>
        <label class="wfuc-ds-option">
          <input type="radio" name="wfuc-ds-source" value="api" ${chk('api')} onchange="DataSourceConfig.selectSource('api')">
          <div class="wfuc-ds-option-label">
            <div class="wfuc-ds-option-icon"><i data-lucide="plug-2"></i></div>
            <span class="wfuc-ds-option-text">
              <strong>API</strong>
              <div style="font-size:11px;color:#94a3b8">Live data integration</div>
            </span>
          </div>
        </label>
        <label class="wfuc-ds-option">
          <input type="radio" name="wfuc-ds-source" value="no_change" ${chk('no_change')} onchange="DataSourceConfig.selectSource('no_change')">
          <div class="wfuc-ds-option-label">
            <div class="wfuc-ds-option-icon"><i data-lucide="minus-circle"></i></div>
            <span class="wfuc-ds-option-text">
              <strong>No change</strong>
              <div style="font-size:11px;color:#94a3b8">Keep manual updates</div>
            </span>
          </div>
        </label>
      </div>
    `;

    this.updateUI();
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  },

  renderSummary() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (!container) return;

    const configs = state.graphTableItems
      .map((item, i) => ({
        ...item,
        source_type: state.itemSelections[i] || 'no_change'
      }))
      .map(item => `
        <div style="
          display:flex;gap:12px;padding:12px;
          border:1px solid #e2e8f0;border-radius:8px;
          background:#f8fafc;margin-bottom:8px;
        ">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              ${this.getItemTypeBadge(item.type)}
            </div>
            <div style="font-size:13px;font-weight:500;color:#0f172a;margin-bottom:2px">${Utils.escapeHtml(item.title)}</div>
            <div style="font-size:12px;color:#64748b">Slide ${item.slide_number}</div>
          </div>
          <div style="text-align:right;min-width:100px">
            <div style="font-size:12px;font-weight:500;color:#7c3aed">
              ${item.source_type === 'no_change' ? '⏸ No change' : 
                item.source_type === 'excel' ? '📊 Excel' : 
                '🔌 API'}
            </div>
          </div>
        </div>
      `).join('');

    const confirmBtn = document.getElementById('wfuc-ds-confirm');

    container.innerHTML = `
      <div style="padding:20px 0">
        <h4 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#0f172a">
          <i data-lucide="check-circle-2" style="width:18px;height:18px;color:#16a34a;margin-right:6px;vertical-align:-2px"></i>
          Review Configuration
        </h4>
        <p style="font-size:13px;color:#64748b;margin:0 0 16px">
          ${state.graphTableItems.length} item${state.graphTableItems.length !== 1 ? 's' : ''} ready to configure
        </p>
        <div style="max-height:300px;overflow-y:auto">
          ${configs}
        </div>
      </div>
    `;

    if (confirmBtn) {
      confirmBtn.textContent = 'Complete Setup';
      confirmBtn.disabled = false;
    }

    ['wfuc-ds-dots', 'wfuc-ds-counter', 'wfuc-ds-nav'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  },

  updateUI() {
    const counter = document.getElementById('wfuc-ds-counter');
    if (counter) {
      counter.textContent = `${state.currentItemIndex + 1} of ${state.graphTableItems.length}`;
    }

    const prevBtn = document.getElementById('wfuc-ds-prev');
    if (prevBtn) prevBtn.disabled = state.currentItemIndex === 0;

    const nextBtn = document.getElementById('wfuc-ds-next');
    if (nextBtn) nextBtn.disabled = state.currentItemIndex === state.graphTableItems.length - 1;

    this.updateConfirmButton();
    this.renderDots();
  },

  renderDots() {
    const container = document.getElementById('wfuc-ds-dots');
    if (!container) return;

    container.innerHTML = '';
    state.graphTableItems.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'wfuc-ds-dot';

      if (i === state.currentItemIndex) {
        dot.classList.add('wfuc-dot-current');
      } else if (state.itemSelections[i]) {
        dot.classList.add('wfuc-dot-set');
      }

      dot.onclick = () => {
        state.currentItemIndex = i;
        this.renderCurrent();
      };

      container.appendChild(dot);
    });
  },

  navigate(direction) {
    const newIndex = state.currentItemIndex + direction;
    if (newIndex < 0 || newIndex >= state.graphTableItems.length) return;

    state.currentItemIndex = newIndex;
    this.renderCurrent();
  },

  selectSource(type) {
    state.itemSelections[state.currentItemIndex] = type;
    this.renderDots();
    this.updateConfirmButton();
  },

  applyToAll(type) {
    state.graphTableItems.forEach((_, i) => {
      state.itemSelections[i] = type;
    });
    this.renderCurrent();
  },

  updateConfirmButton() {
    const btn = document.getElementById('wfuc-ds-confirm');
    if (!btn) return;

    const allSelected = state.graphTableItems.length > 0 && 
      state.graphTableItems.every((_, i) => state.itemSelections[i]);

    btn.disabled = !allSelected;
    if (allSelected && this.currentStep === 'items') {
      btn.textContent = 'Review Setup';
    }
  },

  async submit() {
    const btn = document.getElementById('wfuc-ds-confirm');
    if (!btn) return;

    if (this.currentStep === 'summary') {
      await this.doSubmit(btn);
      return;
    }

    this.currentStep = 'summary';
    btn.textContent = 'Submitting...';
    btn.disabled = true;
    this.renderCurrent();

    setTimeout(async () => {
      await this.doSubmit(btn);
    }, 500);
  },

  async doSubmit(btn) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="wfuc-spinner"></span> Completing setup...';

    const payload = {
      user_id: state.userId,
      template_id: state.pendingTemplateId,
      data_sources: state.graphTableItems.map((item, i) => ({
        slide_number: item.slide_number,
        title: item.title,
        url_image: item.url_image,
        source_type: state.itemSelections[i] || 'no_change',
        type: item.type || 'graph'
      }))
    };

    try {
      console.log('[DS Config] Submitting payload with', payload.data_sources.length, 'items');
      const response = await API.submitDataSourceConfig(payload);
      console.log('[DS Config] Response:', response);

      Toast.success('Setup complete!', 'Data sources configured successfully');

      setTimeout(() => {
        Modal.closeAdd();
      }, 500);
    } catch (error) {
      console.error('[DS Config] Submit error:', error);
      Toast.error('Setup failed', error.message || 'Could not save configuration. Please try again');

      this.currentStep = 'items';
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
};

async function submitDataSourceConfig() {
  return DataSourceConfig.submit();
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════

console.log('[UseCases] Initializing...');

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    UI.renderGrid();
    state.startPolling();
    console.log('[UseCases] Ready');
  });
} else {
  UI.renderGrid();
  state.startPolling();
  console.log('[UseCases] Ready');
}

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  state.cleanup();
});
