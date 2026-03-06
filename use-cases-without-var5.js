'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = Object.freeze({
  API: {
    FETCH_URL: 'https://nzm2t8rkfd.execute-api.eu-central-1.amazonaws.com/default/getAllUserUseCases',
    UPLOAD_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/branding-upload-supervisor',
    DELETE_URL: 'https://4tfgwxzmg2.execute-api.eu-central-1.amazonaws.com/default/delete_user_use_cases',
    GRAPH_TABLE_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/serve-use-case-all-content',
    DATA_SOURCE_CONFIG_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/use-cases-data-sources'
  },
  POLL_INTERVAL: 10000,
  POLL_MAX_INTERVAL: 60000,
  POLL_BACKOFF_MULTIPLIER: 2,
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
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
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text || '').replace(/[&<>"']/g, m => map[m]);
  },
  
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => { clearTimeout(timeout); func(...args); };
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
        setTimeout(function() { inThrottle = false; }, limit);
      }
    };
  },
  
  safeJsonParse(str, defaultValue = null) {
    try { return JSON.parse(str); } catch { return defaultValue; }
  },
  
  storage: {
    get(key, defaultValue = null) {
      try {
        const item = localStorage.getItem(key);
        return item ? Utils.safeJsonParse(item, defaultValue) : defaultValue;
      } catch { return defaultValue; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); return true; } catch { return false; }
    }
  },
  
  safeUrl(value, allowed = ['http:', 'https:']) {
    try {
      const u = new URL(String(value), window.location.origin);
      return allowed.includes(u.protocol) ? u.href : null;
    } catch { return null; }
  },
  
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  },
  
  validateFile(file) {
    if (!file) return { valid: false, error: 'No file selected' };
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!CONFIG.ALLOWED_FILE_TYPES.includes(ext)) {
      return { valid: false, error: `Only ${CONFIG.ALLOWED_FILE_TYPES.join(', ')} files are supported` };
    }
    if (file.size > CONFIG.MAX_FILE_SIZE) {
      return { valid: false, error: `File size must be less than ${Utils.formatFileSize(CONFIG.MAX_FILE_SIZE)}` };
    }
    return { valid: true };
  },
  
  getRelativeTime(dateStr) {
    if (!dateStr) return '';
    try {
      if (typeof dayjs === 'undefined') return new Date(dateStr).toLocaleDateString();
      if (dayjs.utc) return dayjs.utc(dateStr).fromNow();
      let d = String(dateStr).trim();
      if (!d.endsWith('Z') && !d.includes('+') && !d.includes('GMT')) {
        d = d.replace(' ', 'T') + 'Z';
      }
      return dayjs(d).fromNow();
    } catch (e) { return new Date(dateStr).toLocaleDateString(); }
  },
  
  extractTemplateId(fullTemplateId) {
    if (!fullTemplateId) return null;
    if (fullTemplateId.startsWith('req_')) return fullTemplateId;
    const match = fullTemplateId.match(/req_\d{8}_[a-f0-9]+/);
    return match ? match[0] : fullTemplateId;
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
  push(type, title, description) {
    const toast = this.getInstance();
    if (!toast) return null;
    const payload = description ? { description } : undefined;
    const fn = toast[type] || toast;
    return typeof fn === 'function' ? fn(title, payload) : toast(title, payload);
  },
  notify(type, title, description) {
    const toast = this.push(type, title, description);
    if (!toast && type === 'error') alert(description ? `${title}\n${description}` : title);
  },
  success(title, description) { this.notify('success', title, description); },
  error(title, description) { this.notify('error', title, description); },
  info(title, description) { this.notify('info', title, description); },
  warning(title, description) { this.notify('warning', title, description); }
};

if (typeof dayjs !== 'undefined') {
  dayjs.extend(window.dayjs_plugin_relativeTime);
  if (window.dayjs_plugin_utc) dayjs.extend(window.dayjs_plugin_utc);
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
    this.slideData = {};
    this.slideOrder = [];
    this.activeSlideNum = null;
    this.elementSelections = {};
    this.sectionExpansion = {};
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
  
  getPendingDsConfig() { return Utils.storage.get(CONFIG.STORAGE_KEYS.PENDING_CONFIG); }
  
  setPendingDsConfig(config) {
    if (config) Utils.storage.set(CONFIG.STORAGE_KEYS.PENDING_CONFIG, config);
    else Utils.storage.remove(CONFIG.STORAGE_KEYS.PENDING_CONFIG);
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
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
  
  emitEvent(name, detail) { document.dispatchEvent(new CustomEvent(`wfuc:${name}`, { detail })); }
  
  resetModalState() {
    this.currentModalStep = 1;
    this.slideData = {};
    this.slideOrder = [];
    this.activeSlideNum = null;
    this.elementSelections = {};
    this.sectionExpansion = {};
    this.pendingTemplateId = null;
    this.dsConfigLoading = false;
  }
  
  resetFileState() { this.selectedFile = null; }
  
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
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
  
  adjustPollingInterval() {
    if (this.failedPollCount > 0) {
      this.pollInterval = Math.min(
        CONFIG.POLL_INTERVAL * Math.pow(CONFIG.POLL_BACKOFF_MULTIPLIER, this.failedPollCount),
        CONFIG.POLL_MAX_INTERVAL
      );
    } else { this.pollInterval = CONFIG.POLL_INTERVAL; }
    
    if (this.isPolling && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => API.fetchUseCases(), this.pollInterval);
    }
  }
  
  shouldStopPolling() {
    if (!!this.getPendingDsConfig()) return false;
    if (this.useCases.length === 0) return true;
    return this.useCases.every(uc => {
      const status = (uc.status || '').toLowerCase();
      return status === CONFIG.STATUSES.READY || status === CONFIG.STATUSES.FAILED || status === CONFIG.STATUSES.ERROR;
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
        headers: { 'Content-Type': 'application/json', ...options.headers }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      return response;
    } catch (error) {
      if (retries > 0 && (error.name === 'TypeError' || error.message.includes('Failed to fetch'))) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.request(url, options, retries - 1);
      }
      throw error;
    }
  },
  
  async fetchUseCases() {
    if (!state.userId) return;
    if (state.isFetchingNow) return;
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
    } finally { state.isFetchingNow = false; }
  },
  
  processUseCasesData(data) {
    const items = Array.isArray(data) ? data : [];
    const currentHash = this.hashData(items);
    if (currentHash === state.lastDataHash) return;
    
    state.lastDataHash = currentHash;
    state.setUseCases(items);
    UI.renderGrid();
    
    const newlyReady = [];
    items.forEach(uc => {
      const id = uc.id || uc.use_case_id;
      const prevStatus = state.prevStatuses.get(id);
      const nowStatus = (uc.status || '').toLowerCase();
      if (nowStatus === CONFIG.STATUSES.READY && prevStatus !== CONFIG.STATUSES.READY) {
        newlyReady.push(uc);
      }
      state.prevStatuses.set(id, nowStatus);
    });
    
    if (newlyReady.length > 0) this.handleNewlyReadyUseCases(newlyReady);
    this.handleNewUploadSelection(items);
    if (state.shouldStopPolling()) state.stopPolling();
  },
  
  handleNewlyReadyUseCases(newlyReady) {
    newlyReady.forEach(uc => state.emitEvent('usecase-ready', { useCase: uc }));
    const pending = state.getPendingDsConfig();
    if (pending && !state.dsConfigLoading) {
      const match = newlyReady.find(uc =>
        (pending.name && uc.name && uc.name === pending.name) ||
        (pending.file_name && uc.file_name && uc.file_name === pending.file_name)
      );
      if (match) {
        const templateId = match.template_id || match.name;
        state.setPendingDsConfig(null);
        DataSourceConfig.open(state.userId, templateId);
      }
    }
  },
  
  handleNewUploadSelection(data) {
    const recent = Utils.storage.get(CONFIG.STORAGE_KEYS.NEW_UPLOAD);
    if (recent) {
      const found = data.find(u => u.file_name === recent.file_name);
      if (found) Utils.storage.set(CONFIG.STORAGE_KEYS.NEW_USECASE_ID, String(found.id || found.use_case_id));
    }
  },
  
  hashData(data) {
    try {
      const normalized = JSON.stringify((data || []).map(item => ({
        id: item.id || item.use_case_id,
        status: (item.status || '').toLowerCase(),
        name: item.name, file_name: item.file_name,
        thumbnail_image: item.thumbnail_image, template_id: item.template_id,
        excel_url: item.excel_url || '', created_at: item.created_at
      })).sort((a, b) => (a.id || '').toString().localeCompare((b.id || '').toString())));
      let hash = 0;
      for (let i = 0; i < normalized.length; i++) {
        hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
        hash = hash & hash;
      }
      return hash.toString();
    } catch { return null; }
  },
  
  async deleteUseCase(useCaseId) {
    const response = await this.request(CONFIG.API.DELETE_URL, {
      method: 'POST',
      body: JSON.stringify({ user_id: state.userId, use_case_id: useCaseId })
    });
    return response.json();
  },
  
  async uploadUseCase(file, name, description, dataSourcesEnabled = false) {
    const createResponse = await this.request(CONFIG.API.UPLOAD_URL, {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name, user_id: state.userId,
        name, description, ai_template: true, data_sources: dataSourcesEnabled
      })
    });
    const data = await createResponse.json();
    const responseBody = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
    const uploadUrl = responseBody.presigned_put;
    if (!uploadUrl) throw new Error('No upload URL received');
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT', body: file,
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    });
    if (!uploadResponse.ok) throw new Error('Failed to upload file to storage');
    return { success: true, fileName: file.name };
  },
  
  async fetchGraphTableData(templateId) {
    const apiTemplateId = Utils.extractTemplateId(templateId);
    try {
      const response = await this.request(CONFIG.API.GRAPH_TABLE_URL, {
        method: 'POST',
        body: JSON.stringify({ user_id: state.userId, template_id: apiTemplateId })
      });
      const data = await response.json();
      if (data.slides) return this.parseSlideResponse(data);
      const legacyItems = data.items || [];
      return { format: 'legacy', items: legacyItems.map(item => ({ ...item, type: item.type || 'graph' })) };
    } catch (error) { throw error; }
  },
  
  parseSlideResponse(data) {
    const slides = data.slides || {};
    const slideData = {};
    const slideOrder = [];
    const slideNums = Object.keys(slides).map(Number).sort((a, b) => a - b);
    for (const num of slideNums) {
      const slide = slides[String(num)];
      const elements = [];
      (slide.graphs || []).forEach((g, i) => elements.push({
        elementKey: `s${num}_chart_${g.chart_id || i}`, type: 'chart',
        title: g.title || `Chart ${g.chart_id || (i + 1)}`,
        chartType: g.chart_type || '', chartSubtype: g.chart_subtype || '',
        slideNumber: num, urlImage: g.url_image || '', assetKey: g.asset_key || '', position: g.position || {}
      }));
      (slide.tables || []).forEach((t, i) => elements.push({
        elementKey: `s${num}_table_${t.table_id || i}`, type: 'table',
        title: t.title || `Table ${t.table_id || (i + 1)}`,
        shapeName: t.shape_name || '', dimensions: t.dimensions || {},
        slideNumber: num, urlImage: t.url_image || '', assetKey: t.asset_key || '', position: t.position || {}
      }));
      (slide.images || []).forEach((img, i) => elements.push({
        elementKey: `s${num}_image_${img.image_id || i}`, type: 'image',
        title: img.description || img.shape_name || `Image ${img.image_id || (i + 1)}`,
        shapeName: img.shape_name || '', slideNumber: num, urlImage: img.url_image || '',
        assetKey: img.asset_key || '', mediaPath: img.media_path || '', position: img.position || {}
      }));
      (slide.texts || []).forEach((txt, i) => elements.push({
        elementKey: `s${num}_text_${i}`, type: 'text', title: String(txt), slideNumber: num
      }));
      slideData[num] = {
        slideNumber: num, urlImage: slide.url_image || '', elements,
        chartsCount: (slide.graphs || []).length, tablesCount: (slide.tables || []).length,
        imagesCount: (slide.images || []).length, textsCount: (slide.texts || []).length
      };
      slideOrder.push(num);
    }
    return { format: 'slides', slideData, slideOrder, totalSlides: data.total_slides || slideOrder.length };
  },
  
  async submitDataSourceConfig(payload) {
    const response = await this.request(CONFIG.API.DATA_SOURCE_CONFIG_URL, {
      method: 'POST', body: JSON.stringify(payload)
    });
    return response.json();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// UI Rendering
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
    badge.style.cssText = `display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; color: ${color}; background: ${bg};`;
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
    const isReady = (uc.status || '').toLowerCase() === CONFIG.STATUSES.READY;
    let selectedId = null;
    try {
      const stored = Utils.storage.get(CONFIG.STORAGE_KEYS.SELECTION);
      selectedId = stored?.id;
    } catch(e) {}
    const isSelected = selectedId && String(id) === String(selectedId);
    const card = document.createElement('li');
    card.className = `wfuc-card ${isSelected ? 'wfuc-selected' : ''}`;
    card.dataset.useCaseId = String(id || '');
    if (uc.template_id) card.dataset.templateId = String(uc.template_id);
    if (isReady) {
      card.style.cursor = 'pointer';
      card.onclick = () => this.handleCardClick(uc);
    } else { card.style.cursor = 'default'; }
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
    } else { content.appendChild(header); }
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
    const footer = document.createElement('div');
    footer.className = 'wfuc-card-footer';
    footer.style.marginTop = 'auto';
    footer.appendChild(this.getStatusBadge(uc.status));
    const safeExcelUrl = Utils.safeUrl(uc.excel_url);
    if (safeExcelUrl) {
      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'wfuc-card-action-btn';
      const displayName = (uc.name || 'Data').replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'Data';
      downloadBtn.title = 'Download ' + displayName + '.xlsx';
      downloadBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
        + '<span class="wfuc-action-label">' + displayName + '.xlsx</span>';
      downloadBtn.onclick = (e) => { e.stopPropagation(); this.downloadExcel(safeExcelUrl, uc.name); };
      footer.appendChild(downloadBtn);
    }
    content.appendChild(metaFile);
    content.appendChild(metaTime);
    content.appendChild(footer);
    card.appendChild(preview);
    card.appendChild(content);
    return card;
  },

  downloadExcel(url, name) {
    const safeUrl = Utils.safeUrl(url);
    if (!safeUrl) { Toast.error('Download failed', 'Invalid Excel link'); return; }
    const link = document.createElement('a');
    link.href = safeUrl;
    link.download = ((name || 'data').replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'data') + '.xlsx';
    link.rel = 'noopener'; link.style.display = 'none';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  },
  
  renderGrid() {
    const grid = document.getElementById('wfuc-use-cases-grid');
    if (!grid) return;
    const addCard = grid.querySelector('.wfuc-add-card');
    grid.innerHTML = '';
    if (addCard) grid.appendChild(addCard);
    if (state.useCases.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wfuc-empty';
      empty.textContent = 'No use cases yet. Create one to get started.';
      grid.appendChild(empty);
      return;
    }
    state.useCases.forEach(uc => grid.appendChild(this.createCard(uc)));
    lucide.createIcons();
  },
  
  handleCardClick(uc) {
    const homeTab = document.querySelector('.nav-links-set-01-2-home');
    if (homeTab) homeTab.click();
    const dropdown = document.getElementById('wfuc-dropdown');
    if (dropdown) {
      const id = uc.id || uc.use_case_id;
      if (id) dropdown.dispatchEvent(new CustomEvent('wfuc:set-selection', { detail: { id, template_id: uc.template_id || null } }));
    }
  },
  
  toggleMenu(e, id) {
    e.stopPropagation();
    const root = document.getElementById('wf-use-cases');
    if (!root) return;
    root.querySelectorAll('.wfuc-dropdown-menu.wfuc-show').forEach(m => {
      if (m.id !== `wfuc-menu-${id}`) m.classList.remove('wfuc-show');
    });
    root.querySelectorAll('.wfuc-menu-btn.wfuc-active').forEach(b => {
      if (b.id !== `wfuc-btn-${id}`) b.classList.remove('wfuc-active');
    });
    const menu = document.getElementById(`wfuc-menu-${id}`);
    const btn = document.getElementById(`wfuc-btn-${id}`);
    if (menu && btn) { menu.classList.toggle('wfuc-show'); btn.classList.toggle('wfuc-active'); }
  },
  
  closeAllMenus() {
    const root = document.getElementById('wf-use-cases');
    if (!root) return;
    root.querySelectorAll('.wfuc-dropdown-menu.wfuc-show').forEach(m => m.classList.remove('wfuc-show'));
    root.querySelectorAll('.wfuc-menu-btn.wfuc-active').forEach(b => b.classList.remove('wfuc-active'));
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Modal Management
// ═══════════════════════════════════════════════════════════════════════════

const Modal = {
  open(modalId) { const modal = document.getElementById(modalId); if (modal) modal.classList.add('wfuc-open'); },
  close(modalId) { const modal = document.getElementById(modalId); if (modal) modal.classList.remove('wfuc-open'); },
  openAdd() { this.open('wfuc-add-modal'); },
  closeAdd() {
    this.close('wfuc-add-modal');
    Form.reset(); state.resetModalState(); this.showStep(1);
  },
  openDelete(id, name) {
    if (!id) return;
    state.deleteTargetId = id;
    const nameEl = document.getElementById('wfuc-delete-uc-name');
    if (nameEl) nameEl.textContent = Utils.escapeHtml(name || 'this use case');
    this.open('wfuc-delete-modal');
  },
  closeDelete() { this.close('wfuc-delete-modal'); state.deleteTargetId = null; },
  showStep(step) {
    state.currentModalStep = step;
    const shell = document.getElementById('wfuc-modal-shell');
    document.querySelectorAll('#wfuc-add-modal .wfuc-modal-step').forEach(el => el.classList.remove('wfuc-active-step'));
    const stepEl = document.getElementById(`wfuc-step-${step}`);
    if (stepEl) stepEl.classList.add('wfuc-active-step');
    if (shell) {
      if (step === 4) shell.classList.add('wfuc-wide');
      else shell.classList.remove('wfuc-wide');
    }
  },
  async confirmDelete() {
    if (!state.deleteTargetId || !state.userId) return;
    const btn = document.getElementById('wfuc-confirm-delete-btn');
    if (!btn) return;
    const originalText = btn.textContent;
    btn.textContent = 'Deleting...'; btn.disabled = true;
    try {
      const idToDelete = state.deleteTargetId;
      state.setUseCases(state.useCases.filter(uc => String(uc.id || uc.use_case_id) !== String(idToDelete)));
      UI.renderGrid(); this.closeDelete();
      await API.deleteUseCase(idToDelete);
      Toast.success('Use case deleted', 'Your use case was deleted successfully');
    } catch (error) {
      Toast.error('Delete failed', 'Please try again'); API.fetchUseCases();
    } finally { btn.textContent = originalText; btn.disabled = false; }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Form Management
// ═══════════════════════════════════════════════════════════════════════════

const Form = {
  reset() {
    const form = document.getElementById('wfuc-add-use-case-form');
    if (form) form.reset();
    state.resetFileState(); this.updateFilePreview(); this.validateForm();
    const fields = document.getElementById('wfuc-fields-section');
    if (fields) fields.classList.remove('wfuc-visible');
    const uploadZone = document.getElementById('wfuc-upload-zone');
    if (uploadZone) uploadZone.style.display = '';
  },
  handleDragOver(e) { e.preventDefault(); const area = document.getElementById('wfuc-upload-area'); if (area) area.classList.add('wfuc-dragover'); },
  handleDragLeave(e) { e.preventDefault(); const area = document.getElementById('wfuc-upload-area'); if (area) area.classList.remove('wfuc-dragover'); },
  handleDrop(e) {
    e.preventDefault(); const area = document.getElementById('wfuc-upload-area'); if (area) area.classList.remove('wfuc-dragover');
    const files = e.dataTransfer?.files; if (files && files[0]) this.selectFile(files[0]);
  },
  handleFileInput(e) { const files = e.target?.files; if (files && files[0]) this.selectFile(files[0]); },
  selectFile(file) {
    const validation = Utils.validateFile(file);
    if (!validation.valid) { Toast.error('Invalid file', validation.error); return; }
    state.selectedFile = file; this.updateFilePreview(); this.validateForm();
    const nameInput = document.getElementById('wfuc-use-case-name');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = file.name.replace(/\.pptx$/i, '').replace(/[_-]/g, ' ');
      this.validateForm();
    }
    requestAnimationFrame(() => {
      const fields = document.getElementById('wfuc-fields-section');
      if (fields) fields.classList.add('wfuc-visible');
      setTimeout(() => { if (nameInput) nameInput.focus(); }, 350);
    });
  },
  updateFilePreview() {
    const container = document.getElementById('wfuc-file-preview-container');
    const dropZone = document.getElementById('wfuc-upload-zone');
    if (!container) return;
    if (!state.selectedFile) { container.innerHTML = ''; if (dropZone) dropZone.style.display = ''; return; }
    if (dropZone) dropZone.style.display = 'none';
    const fileName = Utils.escapeHtml(state.selectedFile.name);
    const fileSize = Utils.formatFileSize(state.selectedFile.size);
    container.innerHTML = `<div class="wfuc-file-chip"><div class="wfuc-file-chip-icon"><i data-lucide="file-text"></i></div><div class="wfuc-file-chip-info"><div class="wfuc-file-chip-name">${fileName}</div><div class="wfuc-file-chip-size">${fileSize}</div></div><button type="button" class="wfuc-file-chip-remove" onclick="Form.removeFile()" title="Remove file"><i data-lucide="x"></i></button></div>`;
    lucide.createIcons();
  },
  removeFile() {
    state.selectedFile = null; const fileInput = document.getElementById('wfuc-file-input');
    if (fileInput) fileInput.value = ''; this.updateFilePreview(); this.validateForm();
    const fields = document.getElementById('wfuc-fields-section');
    if (fields) fields.classList.remove('wfuc-visible');
  },
  validateForm() {
    const nameInput = document.getElementById('wfuc-use-case-name');
    const btn = document.getElementById('wfuc-submit-btn');
    if (!nameInput || !btn) return;
    btn.disabled = !(nameInput.value.trim() && state.selectedFile);
  },
  async submit(e) {
    e.preventDefault(); if (!state.userId) { Toast.error('Not signed in', 'Please log in'); return; }
    const btn = document.getElementById('wfuc-submit-btn'); if (!btn) return;
    const originalText = btn.textContent; btn.disabled = true; btn.textContent = 'Creating...';
    const nameInput = document.getElementById('wfuc-use-case-name');
    const descInput = document.getElementById('wfuc-use-case-desc');
    const externalDataToggle = document.getElementById('wfuc-external-data');
    const name = nameInput?.value || ''; const description = descInput?.value || '';
    const externalDataEnabled = externalDataToggle?.checked || false;
    try {
      btn.textContent = 'Uploading...'; Toast.info('Upload started', 'Your presentation is uploading');
      const result = await API.uploadUseCase(state.selectedFile, name, description, externalDataEnabled);
      Utils.storage.set(CONFIG.STORAGE_KEYS.NEW_UPLOAD, { file_name: result.fileName, createdAt: Date.now() });
      if (externalDataEnabled) {
        state.setPendingDsConfig({ name, file_name: result.fileName });
        Modal.showStep(2); Toast.success('Upload complete', 'Processing...'); state.startPolling();
      } else { Modal.closeAdd(); Toast.success('Upload complete', 'Processing your use case'); state.startPolling(); }
    } catch (error) { Toast.error('Create failed', 'Please try again'); } finally { btn.textContent = originalText; btn.disabled = false; }
  }
};

function openAddModal() { Modal.openAdd(); }
function closeAddModal() { Modal.closeAdd(); }
function closeDeleteModal() { Modal.closeDelete(); }
async function confirmDeleteUseCase() { return Modal.confirmDelete(); }
function handleDragOver(e) { Form.handleDragOver(e); }
function handleDragLeave(e) { Form.handleDragLeave(e); }
function handleDrop(e) { Form.handleDrop(e); }
function handleFileSelect(e) { Form.handleFileInput(e); }
async function handleCreateUseCase(e) { return Form.submit(e); }
async function submitDataSourceConfig() { return DataSourceConfig.submit(); }

// ═══════════════════════════════════════════════════════════════════════════
// Data Source Config (Was Step 4)
// ═══════════════════════════════════════════════════════════════════════════

const DataSourceConfig = {
  async open(userId, templateId) {
    if (state.dsConfigLoading) return;
    state.dsConfigLoading = true; state.pendingTemplateId = templateId;
    Modal.open('wfuc-add-modal'); Modal.showStep(4);
    this.showLoading();
    try {
      const result = await API.fetchGraphTableData(templateId);
      if (result.format === 'slides') {
        state.slideData = result.slideData; state.slideOrder = result.slideOrder;
        state.elementSelections = {}; state.activeSlideNum = result.slideOrder[0] || null;
      } else { this.convertLegacyToSlideFormat(result.items); }
      if (this.getTotalElementCount() === 0) {
        this.showEmptyState(); setTimeout(() => Modal.closeAdd(), 3000); return;
      }
      this.renderSlideTabs(); this.renderActiveSlide(); this.updateProgress();
      this.updateConfirmButton(); lucide.createIcons();
    } catch (error) {
      this.showErrorState(error.message); Toast.error('Failed to load', error.message);
      setTimeout(() => Modal.closeAdd(), 3000);
    } finally { state.dsConfigLoading = false; }
  },
  
  convertLegacyToSlideFormat(items) {
    state.slideData = {}; state.slideOrder = []; state.elementSelections = {};
    const bySlide = {};
    items.forEach(item => {
      const sn = item.slide_number || 1;
      if (!bySlide[sn]) bySlide[sn] = { graphs: [], tables: [] };
      if (item.type === 'table') bySlide[sn].tables.push(item);
      else bySlide[sn].graphs.push(item);
    });
    const slideNums = Object.keys(bySlide).map(Number).sort((a, b) => a - b);
    for (const num of slideNums) {
      const s = bySlide[num]; const elements = [];
      s.graphs.forEach((g, i) => elements.push({
        elementKey: `s${num}_chart_${i}`, type: 'chart', title: g.title || `Chart ${i + 1}`, slideNumber: num, urlImage: g.url_image || ''
      }));
      s.tables.forEach((t, i) => elements.push({
        elementKey: `s${num}_table_${i}`, type: 'table', title: t.title || `Table ${i + 1}`, slideNumber: num, urlImage: t.url_image || ''
      }));
      state.slideData[num] = { slideNumber: num, urlImage: '', elements, chartsCount: s.graphs.length, tablesCount: s.tables.length, imagesCount: 0, textsCount: 0 };
      state.slideOrder.push(num);
    }
    state.activeSlideNum = state.slideOrder[0] || null;
  },
  
  getTotalElementCount() {
    let total = 0;
    for (const num of state.slideOrder) total += (state.slideData[num]?.elements || []).length;
    return total;
  },
  
  getConfiguredCount() {
    let count = 0;
    for (const num of state.slideOrder) {
      const slide = state.slideData[num]; if (!slide) continue;
      for (const el of slide.elements) {
        const sel = state.elementSelections[el.elementKey];
        if (sel && sel.source && this.isSourceConfigured(sel)) count++;
      }
    }
    return count;
  },
  
  isSourceConfigured(sel) {
    if (!sel || !sel.source) return false;
    if (sel.source === 'custom_prompt') return !!(sel.prompt || '').trim();
    if (sel.source === 'generate_based_on') return !!sel.reference;
    return true;
  },
  
  isSlideComplete(slideNum) {
    const slide = state.slideData[slideNum]; if (!slide) return false;
    return slide.elements.every(el => {
      const sel = state.elementSelections[el.elementKey];
      return sel && sel.source && this.isSourceConfigured(sel);
    });
  },
  
  getSlideConfiguredCount(slideNum) {
    const slide = state.slideData[slideNum]; if (!slide) return 0;
    return slide.elements.filter(el => {
      const sel = state.elementSelections[el.elementKey];
      return sel && sel.source && this.isSourceConfigured(sel);
    }).length;
  },
  
  showLoading() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) container.innerHTML = `<div style="text-align:center;padding:60px 40px;color:#64748b"><div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:rgba(var(--primary-rgb),0.08);border-radius:50%;margin-bottom:20px"><span class="wfuc-processing-spinner-lg"></span></div><p style="margin:0;font-size:15px;font-weight:500;color:#0f172a">Loading presentation</p></div>`;
    const slideArea = document.getElementById('wfuc-ds-slide-area'); if (slideArea) slideArea.style.display = 'none';
    const tabs = document.getElementById('wfuc-ds-slide-tabs'); if (tabs) tabs.innerHTML = '';
    const progress = document.getElementById('wfuc-ds-progress'); if (progress) progress.style.display = 'none';
    const confirmBtn = document.getElementById('wfuc-ds-confirm');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Confirm Data Sources'; }
  },
  
  showEmptyState() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) container.innerHTML = `<div style="text-align:center;padding:60px 40px;color:#64748b"><p style="margin:0;font-size:15px;font-weight:500;color:#0f172a">No configurable elements found</p></div>`;
  },
  
  showErrorState(message) {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) container.innerHTML = `<div style="text-align:center;padding:60px 40px;color:#64748b"><p style="margin:0;font-size:15px;font-weight:500;color:#0f172a">Failed to load data</p><p>${Utils.escapeHtml(message)}</p></div>`;
  },
  
  renderSlideTabs() {
    const tabsContainer = document.getElementById('wfuc-ds-slide-tabs'); if (!tabsContainer) return;
    tabsContainer.innerHTML = '';
    state.slideOrder.forEach(num => {
      const slide = state.slideData[num];
      const isActive = num === state.activeSlideNum;
      const isComplete = this.isSlideComplete(num);
      const remaining = slide.elements.length - this.getSlideConfiguredCount(num);
      const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'wfuc-ds-slide-tab';
      tab.dataset.slideNum = String(num);
      if (isActive) tab.classList.add('wfuc-tab-active');
      if (isComplete) tab.classList.add('wfuc-tab-complete');
      if (slide.urlImage) {
        const img = document.createElement('img'); img.src = slide.urlImage; img.onerror = function() { this.style.display = 'none'; }; tab.appendChild(img);
      }
      const label = document.createElement('span'); label.className = 'wfuc-ds-tab-label'; label.textContent = `Slide ${num}`; tab.appendChild(label);
      if (isComplete) {
        const check = document.createElement('span'); check.className = 'wfuc-ds-tab-check'; check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'; tab.appendChild(check);
      } else if (remaining > 0 && remaining < slide.elements.length) {
        const count = document.createElement('span'); count.className = 'wfuc-ds-tab-count'; count.textContent = remaining; tab.appendChild(count);
      }
      tab.onclick = () => { state.activeSlideNum = num; this.renderSlideTabs(); this.renderActiveSlide(); };
      tabsContainer.appendChild(tab);
    });
  },
  
  renderActiveSlide() {
    const slideArea = document.getElementById('wfuc-ds-slide-area');
    const itemContainer = document.getElementById('wfuc-ds-item-container');
    const progress = document.getElementById('wfuc-ds-progress');
    if (!slideArea || !state.activeSlideNum) return;
    if (itemContainer) itemContainer.innerHTML = ''; slideArea.style.display = ''; if (progress) progress.style.display = '';
    const slide = state.slideData[state.activeSlideNum]; if (!slide) return;
    this.renderAutoConfigure();
    this.renderSlidePreview(slide); this.renderElementSections(slide); this.updateProgress(); this.updateConfirmButton();
  },
  
  renderSlidePreview(slide) {
    const wrap = document.getElementById('wfuc-ds-slide-preview-wrap'); if (!wrap) return;
    wrap.innerHTML = '';
    if (slide.urlImage) {
      const img = document.createElement('img'); img.src = slide.urlImage; img.onerror = function() { this.style.display = 'none'; }; wrap.appendChild(img);
    }
    const info = document.createElement('div'); info.className = 'wfuc-ds-slide-info';
    const parts = [`Slide ${slide.slideNumber}`];
    if (slide.chartsCount) parts.push(`${slide.chartsCount} chart${slide.chartsCount > 1 ? 's' : ''}`);
    if (slide.tablesCount) parts.push(`${slide.tablesCount} table${slide.tablesCount > 1 ? 's' : ''}`);
    if (slide.imagesCount) parts.push(`${slide.imagesCount} image${slide.imagesCount > 1 ? 's' : ''}`);
    if (slide.textsCount) parts.push(`${slide.textsCount} text${slide.textsCount > 1 ? 's' : ''}`);
    info.textContent = parts.join(' \u00b7 '); wrap.appendChild(info);
  },
  
  renderElementSections(slide) {
    const container = document.getElementById('wfuc-ds-elements'); if (!container) return;
    const scrollTop = container.scrollTop; container.innerHTML = '';
    const charts = slide.elements.filter(e => e.type === 'chart');
    const tables = slide.elements.filter(e => e.type === 'table');
    const images = slide.elements.filter(e => e.type === 'image');
    const texts = slide.elements.filter(e => e.type === 'text');
    const cti = [...charts, ...tables, ...images];
    if (cti.length > 0) container.appendChild(this.buildSection('Charts, Tables & Images', cti, slide, false));
    if (texts.length > 0) container.appendChild(this.buildSection('Texts', texts, slide, texts.length > 8));
    if (scrollTop > 0) requestAnimationFrame(() => { container.scrollTop = scrollTop; });
  },
  
  buildSection(title, elements, slide, defaultCollapsed) {
    const sectionKey = `s${slide.slideNumber}_${title}`;
    const section = document.createElement('div'); section.className = 'wfuc-ds-section';
    const isExpanded = state.sectionExpansion[sectionKey] !== undefined ? state.sectionExpansion[sectionKey] : !defaultCollapsed;
    if (!isExpanded) section.classList.add('wfuc-collapsed');
    const configuredInSection = elements.filter(el => this.isSourceConfigured(state.elementSelections[el.elementKey])).length;
    const sectionIcons = {
      'Charts, Tables & Images': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.1 6.27a2 2 0 0 0 0 3.46l9.07 4.09a2 2 0 0 0 1.66 0l9.07-4.09a2 2 0 0 0 0-3.46Z"></path><path d="m2.1 14.27 9.07 4.09a2 2 0 0 0 1.66 0l9.07-4.09"></path><path d="m2.1 19.27 9.07 4.09a2 2 0 0 0 1.66 0l9.07-4.09"></path></svg>',
      'Texts': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="15" y1="12" x2="3" y2="12"></line><line x1="17" y1="18" x2="3" y2="18"></line></svg>'
    };
    const header = document.createElement('button'); header.type = 'button'; header.className = 'wfuc-ds-section-header';
    header.innerHTML = `<div class="wfuc-ds-section-title">${sectionIcons[title] || ''}<span>${Utils.escapeHtml(title)}</span><span class="wfuc-ds-section-count">${configuredInSection}/${elements.length}</span></div><div class="wfuc-ds-section-toggle"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></div>`;
    header.onclick = () => { const wasExpanded = !section.classList.contains('wfuc-collapsed'); section.classList.toggle('wfuc-collapsed'); state.sectionExpansion[sectionKey] = !wasExpanded; };
    const body = document.createElement('div'); body.className = 'wfuc-ds-section-body';
    elements.forEach(el => { body.appendChild(this.buildElementGroup(el, slide)); });
    section.appendChild(header); section.appendChild(body); return section;
  },
  
  buildElementGroup(el, slide) {
    const group = document.createElement('div');
    group.className = 'wfuc-ds-element-group';
    group.dataset.elementKey = el.elementKey;
    group.appendChild(this.buildElementRow(el, slide));
    const sel = state.elementSelections[el.elementKey];
    if (sel) {
      let panel = null;
      if (sel.source === 'generate_based_on') panel = this.buildReferenceSelect(el, slide);
      else if (sel.source === 'custom_prompt') panel = this.buildPromptTextarea(el);
      else if (sel.source === 'context_generate') panel = this.buildContextHint(el);
      if (panel) group.appendChild(panel);
    }
    return group;
  },

  buildElementRow(el, slide) {
    const row = document.createElement('div'); row.className = 'wfuc-ds-row'; row.dataset.elementKey = el.elementKey;
    const iconSvgs = {
      text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>',
      image: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L3 21"></path></svg>',
      chart: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>',
      table: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>'
    };
    const iconClass = el.type === 'chart' ? 'wfuc-icon-chart' : el.type === 'table' ? 'wfuc-icon-table' : el.type === 'image' ? 'wfuc-icon-image' : 'wfuc-icon-text';
    const icon = document.createElement('div'); icon.className = `wfuc-ds-row-icon ${iconClass}`; icon.innerHTML = iconSvgs[el.type] || iconSvgs.text;
    const name = document.createElement('div'); name.className = 'wfuc-ds-row-name'; name.textContent = el.title; name.title = el.title;
    const controls = document.createElement('div'); controls.className = 'wfuc-ds-row-controls';
    const defaultSource = el.type === 'chart' ? 'excel' : el.type === 'table' ? 'excel' : el.type === 'text' ? 'context_generate' : el.type === 'image' ? 'ai_generation' : '';
    if (!state.elementSelections[el.elementKey] && defaultSource) state.elementSelections[el.elementKey] = { source: defaultSource, isDefault: true };
    const select = document.createElement('select'); select.className = 'wfuc-ds-select';
    const sel = state.elementSelections[el.elementKey];
    if (sel && sel.source) select.classList.add(sel.isDefault ? 'wfuc-default' : 'wfuc-configured');
    let options;
    if (el.type === 'image') {
      options = [{ value: '', label: '⚡ Select source...' }, { value: 'serp', label: '🔍 SERP' }, { value: 'stock_images', label: '📸 Stock images' }, { value: 'ai_generation', label: '✨ AI Generation' }, { value: 'no_change', label: 'No change' }];
    } else {
      options = [{ value: '', label: '\u26a1 Select source...' }, { value: 'context_generate', label: '\u2728 Auto-generate (AI)' }, { value: 'custom_prompt', label: '\u270f\ufe0f Custom prompt' }, { value: 'excel', label: 'Excel' }, { value: 'api', label: 'API' }, { value: 'generate_based_on', label: 'Generate based on\u2026' }, { value: 'no_change', label: 'No change' }];
    }
    options.forEach(opt => {
      const o = document.createElement('option'); o.value = opt.value; o.textContent = opt.label; if (opt.value === (sel?.source || '')) o.selected = true; select.appendChild(o);
    });
    select.onchange = () => this.setElementSource(el.elementKey, select.value, slide);
    controls.appendChild(select); row.appendChild(icon); row.appendChild(name); row.appendChild(controls); return row;
  },
  
  buildReferenceSelect(el, slide) {
    const wrap = document.createElement('div'); wrap.className = 'wfuc-ds-gen-wrap';
    wrap.dataset.genFor = el.elementKey;
    const sel = state.elementSelections[el.elementKey] || {};
    const sameSlideElements = (slide || state.slideData[state.activeSlideNum]).elements.filter(e => e.elementKey !== el.elementKey);
    if (sameSlideElements.length === 0) {
      const msg = document.createElement('div'); msg.style.cssText = 'padding:12px 16px;color:#94a3b8;font-size:13px;font-style:italic;'; msg.textContent = 'No other elements to reference'; wrap.appendChild(msg); return wrap;
    }
    const refSelect = document.createElement('select'); refSelect.className = 'wfuc-ds-ref-select';
    const defaultOpt = document.createElement('option'); defaultOpt.value = ''; defaultOpt.textContent = 'Select reference element...'; refSelect.appendChild(defaultOpt);
    ['chart', 'table', 'image', 'text'].forEach(type => {
      const filtered = sameSlideElements.filter(e => e.type === type);
      if (filtered.length > 0) {
        const group = document.createElement('optgroup'); group.label = type.charAt(0).toUpperCase() + type.slice(1) + 's';
        filtered.forEach(e => {
          const o = document.createElement('option'); o.value = e.elementKey;
          o.textContent = (type === 'text' ? 'T "' + (e.title.length > 40 ? e.title.substring(0, 40) + '...' : e.title) + '"' : e.title);
          if (e.elementKey === (sel.reference || '')) o.selected = true; group.appendChild(o);
        });
        refSelect.appendChild(group);
      }
    });
    if (sel.reference) refSelect.classList.add('wfuc-configured');
    refSelect.onchange = () => { state.elementSelections[el.elementKey].reference = refSelect.value || null; this.onSelectionChanged(); };
    wrap.appendChild(refSelect); return wrap;
  },
  
  buildPromptTextarea(el) {
    const wrap = document.createElement('div'); wrap.className = 'wfuc-ds-gen-wrap';
    wrap.dataset.genFor = el.elementKey;
    const sel = state.elementSelections[el.elementKey] || {};
    const textarea = document.createElement('textarea'); textarea.className = 'wfuc-ds-gen-prompt'; textarea.placeholder = 'Describe what data to generate...'; textarea.rows = 3; textarea.value = sel.prompt || '';
    textarea.oninput = Utils.debounce(() => { state.elementSelections[el.elementKey].prompt = textarea.value; this.onSelectionChanged(); }, 400);
    wrap.appendChild(textarea); return wrap;
  },
  
  buildContextHint(el) {
    const wrap = document.createElement('div'); wrap.className = 'wfuc-ds-gen-wrap';
    wrap.dataset.genFor = el.elementKey;
    const hint = document.createElement('div'); hint.className = 'wfuc-ds-context-hint'; hint.textContent = 'AI will auto-generate content based on slide context';
    wrap.appendChild(hint); return wrap;
  },
  
  _updateSectionCounts(container) {
    container.querySelectorAll('.wfuc-ds-section').forEach(section => {
      const rows = section.querySelectorAll('.wfuc-ds-row');
      const total = rows.length;
      const configured = Array.from(rows).filter(row => {
        const key = row.dataset.elementKey;
        return key && this.isSourceConfigured(state.elementSelections[key]);
      }).length;
      const badge = section.querySelector('.wfuc-ds-section-count');
      if (badge) badge.textContent = `${configured}/${total}`;
    });
  },

  _updateTabBadge(slideNum) {
    const tab = document.querySelector(`#wfuc-ds-slide-tabs [data-slide-num="${slideNum}"]`);
    if (!tab) return;
    const isComplete = this.isSlideComplete(slideNum);
    tab.classList.toggle('wfuc-tab-complete', isComplete);
    const existing = tab.querySelector('.wfuc-ds-tab-check, .wfuc-ds-tab-count');
    if (existing) existing.remove();
    if (isComplete) {
      const check = document.createElement('span');
      check.className = 'wfuc-ds-tab-check';
      check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      tab.appendChild(check);
    } else {
      const slide = state.slideData[slideNum];
      const remaining = (slide?.elements.length || 0) - this.getSlideConfiguredCount(slideNum);
      if (remaining > 0 && remaining < (slide?.elements.length || 0)) {
        const count = document.createElement('span');
        count.className = 'wfuc-ds-tab-count';
        count.textContent = remaining;
        tab.appendChild(count);
      }
    }
  },

  renderAutoConfigure() {
    if (document.getElementById('wfuc-ds-autocfg')) return;
    const tabs = document.getElementById('wfuc-ds-slide-tabs');
    if (!tabs) return;
    const banner = document.createElement('div');
    banner.id = 'wfuc-ds-autocfg';
    banner.className = 'wfuc-ds-autocfg';
    const left = document.createElement('div');
    left.className = 'wfuc-ds-autocfg-left';
    const titleRow = document.createElement('div');
    titleRow.className = 'wfuc-ds-autocfg-title';
    titleRow.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="m2 17 10 5 10-5"></path><path d="m2 12 10 5 10-5"></path></svg><span>Auto-configure all slides</span>';
    const chips = document.createElement('div');
    chips.className = 'wfuc-ds-autocfg-chips';
    chips.innerHTML = '<span class="wfuc-ds-autocfg-chip wfuc-autocfg-excel">Charts &amp; Tables \u2192 Excel</span><span class="wfuc-ds-autocfg-chip wfuc-autocfg-ai">Texts \u2192 Auto-generate</span><span class="wfuc-ds-autocfg-chip wfuc-autocfg-image">Images \u2192 AI Generation</span>';
    left.appendChild(titleRow);
    left.appendChild(chips);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'wfuc-ds-autocfg-btn';
    btn.className = 'wfuc-ds-autocfg-btn';
    btn.textContent = 'Apply to all';
    btn.onclick = () => this.autoConfigureAll();
    banner.appendChild(left);
    banner.appendChild(btn);
    tabs.insertAdjacentElement('beforebegin', banner);
  },

  autoConfigureAll() {
    const defaults = { chart: 'excel', table: 'excel', text: 'context_generate', image: 'ai_generation' };
    for (const num of state.slideOrder) {
      const slide = state.slideData[num];
      if (!slide) continue;
      slide.elements.forEach(el => {
        const src = defaults[el.type];
        if (src) state.elementSelections[el.elementKey] = { source: src };
      });
    }
    const btn = document.getElementById('wfuc-ds-autocfg-btn');
    if (btn) {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Applied';
      btn.classList.add('wfuc-autocfg-done');
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = 'Apply to all';
        btn.classList.remove('wfuc-autocfg-done');
        btn.disabled = false;
      }, 2500);
    }
    const slide = state.slideData[state.activeSlideNum];
    if (slide) this.renderElementSections(slide);
    this.renderSlideTabs();
    this.updateProgress();
    this.updateConfirmButton();
  },

  setElementSource(elementKey, sourceValue, slide) {
    const existing = state.elementSelections[elementKey] || {};
    if (!sourceValue) {
      delete state.elementSelections[elementKey];
    } else {
      const newSel = { source: sourceValue };
      if (sourceValue === 'custom_prompt') newSel.prompt = existing.prompt || null;
      if (sourceValue === 'generate_based_on') newSel.reference = existing.reference || null;
      state.elementSelections[elementKey] = newSel;
    }

    const slideData = slide || state.slideData[state.activeSlideNum];
    const el = slideData?.elements?.find(e => e.elementKey === elementKey);
    const container = document.getElementById('wfuc-ds-elements');

    if (el && container) {
      const existingGroup = container.querySelector(`.wfuc-ds-element-group[data-element-key="${elementKey}"]`);
      if (existingGroup) {
        existingGroup.replaceWith(this.buildElementGroup(el, slideData));
      } else {
        this.renderElementSections(slideData);
      }
      this._updateSectionCounts(container);
    } else {
      this.renderElementSections(slideData);
    }

    this._updateTabBadge(state.activeSlideNum);
    this.updateProgress();
    this.updateConfirmButton();
  },
  
  onSelectionChanged() { this.updateProgress(); this.updateConfirmButton(); },
  
  quickApply(sourceType) {
    const slide = state.slideData[state.activeSlideNum]; if (!slide) return;
    slide.elements.forEach(el => { state.elementSelections[el.elementKey] = { source: sourceType }; });
    this.renderElementSections(slide); this.onSelectionChanged();
  },
  
  updateProgress() {
    const total = this.getTotalElementCount(), configured = this.getConfiguredCount();
    const pct = total > 0 ? Math.round((configured / total) * 100) : 0;
    const fill = document.getElementById('wfuc-ds-progress-fill');
    if (fill) { fill.style.width = pct + '%'; fill.classList.toggle('wfuc-complete', pct === 100); }
    const text = document.getElementById('wfuc-ds-progress-text');
    if (text) text.textContent = `${configured} of ${total} configured`;
  },
  
  updateConfirmButton() {
    if (this._isSubmitting) return;
    const btn = document.getElementById('wfuc-ds-confirm'); if (!btn) return;
    const total = this.getTotalElementCount(), configured = this.getConfiguredCount();
    const wasDisabled = btn.disabled;
    btn.textContent = 'Confirm Data Sources';
    btn.disabled = total === 0 || configured < total;
    if (!btn.disabled && wasDisabled && total > 0) {
      btn.style.animation = 'wfuc-pulse 0.5s ease-out';
      setTimeout(() => { btn.style.animation = ''; }, 500);
    }
  },
  
  async submit() {
    if (this._isSubmitting) return;
    const btn = document.getElementById('wfuc-ds-confirm'); if (!btn) return;
    this._isSubmitting = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="wfuc-spinner"></span> Saving...';
    try {
      const dataSources = [];
      for (const num of state.slideOrder) {
        const slide = state.slideData[num]; if (!slide) continue;
        slide.elements.forEach(el => {
          const sel = state.elementSelections[el.elementKey] || {};
          const entry = { slide_number: el.slideNumber, title: el.title, type: el.type, source_type: sel.source || 'no_change', element_key: el.elementKey };
          if (el.urlImage) entry.url_image = el.urlImage; if (el.assetKey) entry.asset_key = el.assetKey; if (el.mediaPath) entry.media_path = el.mediaPath;
          if (sel.source === 'custom_prompt' && sel.prompt) entry.prompt = sel.prompt;
          if (sel.source === 'generate_based_on' && sel.reference) entry.reference_element_key = sel.reference;
          dataSources.push(entry);
        });
      }
      const payload = { user_id: state.userId, template_id: state.pendingTemplateId, data_sources: dataSources };
      await API.submitDataSourceConfig(payload);
      Toast.success('Configuration saved', 'Saved successfully'); Modal.closeAdd();
      setTimeout(() => API.fetchUseCases(), 1000);
    } catch (error) {
      Toast.error('Save failed', error.message);
    } finally {
      this._isSubmitting = false;
      this.updateConfirmButton();
    }
  }
};

function navigateItem(dir) {
  const slideOrder = state.slideOrder, currentIdx = slideOrder.indexOf(state.activeSlideNum), newIdx = currentIdx + dir;
  if (newIdx >= 0 && newIdx < slideOrder.length) {
    state.activeSlideNum = slideOrder[newIdx]; DataSourceConfig.renderSlideTabs(); DataSourceConfig.renderActiveSlide();
  }
}

// Event Listeners
state.addEventListenerTracked(document, 'click', (e) => { if (!e.target.closest('.wfuc-menu-btn')) UI.closeAllMenus(); });
state.addEventListenerTracked(document, 'wfuc:selection-change', () => UI.renderGrid());
state.addEventListenerTracked(document, 'keydown', (e) => {
  const modal = document.getElementById('wfuc-add-modal'), step4 = document.getElementById('wfuc-step-4');
  if (!modal?.classList.contains('wfuc-open') || !step4?.classList.contains('wfuc-active-step')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navigateItem(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navigateItem(1); }
  else if (e.key === 'Enter') { const b = document.getElementById('wfuc-ds-confirm'); if (b && !b.disabled) { e.preventDefault(); DataSourceConfig.submit(); } }
});

const dv = Utils.debounce(() => Form.validateForm(), CONFIG.DEBOUNCE_DELAY);
const ni = document.getElementById('wfuc-use-case-name'), di = document.getElementById('wfuc-use-case-desc');
if (ni) state.addEventListenerTracked(ni, 'input', dv);
if (di) state.addEventListenerTracked(di, 'input', dv);
window.addEventListener('beforeunload', () => state.cleanup());

UI.renderGrid(); state.startPolling();
