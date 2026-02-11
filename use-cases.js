'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = Object.freeze({
  API: {
    FETCH_URL: 'https://nzm2t8rkfd.execute-api.eu-central-1.amazonaws.com/default/getAllUserUseCases',
    UPLOAD_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/branding-upload-supervisor',
    DELETE_URL: 'https://4tfgwxzmg2.execute-api.eu-central-1.amazonaws.com/default/delete_user_use_cases',
    GRAPH_TABLE_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/serve-ai-use-cases-graph-table',
    DATA_SOURCE_CONFIG_URL: 'https://eprid4tv0b.execute-api.eu-west-1.amazonaws.com/final/use-cases-data-sources'
  },
  POLL_INTERVAL: 10000,  // Increased from 5 seconds to 10 seconds to reduce aggressive polling
  POLL_MAX_INTERVAL: 60000,
  POLL_BACKOFF_MULTIPLIER: 2,  // More aggressive backoff to reduce requests on errors
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
  /**
   * Sanitize HTML to prevent XSS attacks
   */
  sanitizeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },
  
  /**
   * Escape HTML entities
   */
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
  
  /**
   * Debounce function to limit execution rate
   */
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
  
  /**
   * Throttle function to limit execution frequency
   */
  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },
  
  /**
   * Safe JSON parse
   */
  safeJsonParse(str, defaultValue = null) {
    try {
      return JSON.parse(str);
    } catch {
      return defaultValue;
    }
  },
  
  /**
   * Safe localStorage operations
   */
  storage: {
    get(key, defaultValue = null) {
      try {
        const item = localStorage.getItem(key);
        return item ? Utils.safeJsonParse(item, defaultValue) : defaultValue;
      } catch {
        return defaultValue;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    }
  },
  
  /**
   * Validate URL
   */
  safeUrl(value, allowed = ['http:', 'https:']) {
    try {
      const u = new URL(String(value), window.location.origin);
      return allowed.includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  },
  
  /**
   * Format file size
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  },
  
  /**
   * Validate file
   */
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
  
  /**
   * Get relative time
   */
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
  
  /**
   * Extract API-compatible template ID from DB format
   * DB format: template_mem_[userId]_req_[date]_[hash]
   * API format: req_[date]_[hash]
   */
  extractTemplateId(fullTemplateId) {
    if (!fullTemplateId) return null;
    
    // If it's already in the correct format (starts with req_), return as is
    if (fullTemplateId.startsWith('req_')) {
      return fullTemplateId;
    }
    
    // Extract req_* part from template_mem_[userId]_req_[date]_[hash]
    const match = fullTemplateId.match(/req_\d{8}_[a-f0-9]+/);
    if (match) {
      return match[0];
    }
    
    // If no match, return original (let API handle error)
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
  
  push(type, title, description) {
    const toast = this.getInstance();
    if (!toast) return null;
    const payload = description ? { description } : undefined;
    const fn = toast[type] || toast;
    return typeof fn === 'function' ? fn(title, payload) : toast(title, payload);
  },
  
  notify(type, title, description) {
    const toast = this.push(type, title, description);
    if (!toast && type === 'error') {
      alert(description ? `${title}\n${description}` : title);
    }
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
  if (window.dayjs_plugin_utc) {
    dayjs.extend(window.dayjs_plugin_utc);
  }
}
lucide.createIcons();

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
    this.isFetchingNow = false;  // Prevent concurrent requests
    this.lastDataHash = null;    // Track previous data to detect changes
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
    // Clean up all event listeners
    this.eventListeners.forEach(({ element, event, handler, options }) => {
      element.removeEventListener(event, handler, options);
    });
    this.eventListeners = [];
    
    // Clear poll timer
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
    
    API.fetchUseCases(); // Initial fetch
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
    // Implement exponential backoff for polling
    if (this.failedPollCount > 0) {
      this.pollInterval = Math.min(
        CONFIG.POLL_INTERVAL * Math.pow(CONFIG.POLL_BACKOFF_MULTIPLIER, this.failedPollCount),
        CONFIG.POLL_MAX_INTERVAL
      );
    } else {
      this.pollInterval = CONFIG.POLL_INTERVAL;
    }
    
    // Restart polling with new interval
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
        // Network error - retry
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
    
    // Prevent concurrent requests - race condition fix
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
    // Check if data has actually changed before re-rendering (fix aggressive re-rendering)
    const currentHash = this.hashData(data);
    const hasDataChanged = currentHash !== state.lastDataHash;
    
    if (!hasDataChanged) {
      console.debug('[API] Data unchanged, skipping re-render');
      return;  // Skip expensive DOM operations
    }
    
    state.lastDataHash = currentHash;
    state.setUseCases(data);
    
    // Only render if data actually changed
    UI.renderGrid();
    
    // Detect status transitions
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
    
    // Handle newly ready use cases
    if (newlyReady.length > 0) {
      this.handleNewlyReadyUseCases(newlyReady);
    }
    
    // Handle auto-selection of new uploads
    this.handleNewUploadSelection(data);
    
    // Stop polling if all done
    if (state.shouldStopPolling()) {
      console.log('[Polling] All use cases stable, stopping poll');
      state.stopPolling();
    }
  },
  
  handleNewlyReadyUseCases(newlyReady) {
    newlyReady.forEach(uc => {
      state.emitEvent('usecase-ready', { useCase: uc });
    });
    
    // Check for pending DS config
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
  
  hashData(data) {
    // Simple hash function to detect data changes
    // Uses JSON stringification with normalized order
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
      
      // Simple hash using string length and char codes
      let hash = 0;
      for (let i = 0; i < normalized.length; i++) {
        const char = normalized.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return hash.toString();
    } catch (e) {
      console.error('[API] Error hashing data:', e);
      return null;
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
  
  async uploadUseCase(file, name, description, dataSourcesEnabled = false) {
    if (!state.userId) {
      throw new Error('User not authenticated');
    }
    
    // Step 1: Get presigned URL
    const createResponse = await this.request(CONFIG.API.UPLOAD_URL, {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        user_id: state.userId,
        name,
        description,
        ai_template: true,
        data_sources: dataSourcesEnabled
      })
    });
    
    const data = await createResponse.json();
    const responseBody = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
    const uploadUrl = responseBody.presigned_put;
    
    if (!uploadUrl) {
      throw new Error('No upload URL received');
    }
    
    // Step 2: Upload to S3
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      }
    });
    
    if (!uploadResponse.ok) {
      throw new Error('Failed to upload file to storage');
    }
    
    return { success: true, fileName: file.name };
  },
  
  async fetchGraphTableData(templateId) {
    // Extract API-compatible template ID (req_date_hash) from DB format
    const apiTemplateId = Utils.extractTemplateId(templateId);
    
    console.log('[API] Fetching graph/table data for template:', apiTemplateId);
    
    try {
      const response = await this.request(CONFIG.API.GRAPH_TABLE_URL, {
        method: 'POST',
        body: JSON.stringify({
          user_id: state.userId,
          template_id: apiTemplateId
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = 'Failed to fetch charts and tables';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.message || errorData.error || errorMessage;
        } catch (e) {
          if (errorText) errorMessage = errorText;
        }
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      const items = data.items || [];
      
      console.log('[API] Fetched', items.length, 'chart/table items');
      
      // Ensure each item has a type field (default to 'graph' if missing)
      return items.map(item => ({
        ...item,
        type: item.type || 'graph'
      }));
      
    } catch (error) {
      console.error('[API] Error fetching graph/table data:', error);
      throw error;
    }
  },
  
  async submitDataSourceConfig(payload) {
    console.log('[API] Submitting data source configuration...');
    
    const response = await this.request(CONFIG.API.DATA_SOURCE_CONFIG_URL, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = 'Failed to save data source configuration';
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch (e) {
        if (errorText) errorMessage = errorText;
      }
      throw new Error(errorMessage);
    }
    
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
  
  createCardMenu(id, name, excelUrl) {
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

    const safeExcelUrl = Utils.safeUrl(excelUrl);
    if (safeExcelUrl) {
      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'wfuc-menu-item';
      downloadBtn.appendChild(this.createIcon('download', 14));
      downloadBtn.appendChild(document.createTextNode('Download Excel'));
      downloadBtn.onclick = (e) => {
        e.stopPropagation();
        this.downloadExcel(safeExcelUrl, name);
        this.closeAllMenus();
      };
      menu.appendChild(downloadBtn);
    }
    
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
    
    if (uc.template_id) {
      card.dataset.templateId = String(uc.template_id);
    }
    
    if (isReady) {
      card.style.cursor = 'pointer';
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
    header.appendChild(this.createCardMenu(id, uc.name, uc.excel_url));
    
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

  downloadExcel(url, name) {
    const safeUrl = Utils.safeUrl(url);
    if (!safeUrl) {
      Toast.error('Download failed', 'Invalid Excel link');
      return;
    }

    const link = document.createElement('a');
    link.href = safeUrl;
    link.download = '';
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
    
    lucide.createIcons();
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
    
    const buttons = root.querySelectorAll('.wfuc-menu-btn.wfuc-active');
    buttons.forEach(b => {
      if (b.id !== `wfuc-btn-${id}`) {
        b.classList.remove('wfuc-active');
      }
    });
    
    const menu = document.getElementById(`wfuc-menu-${id}`);
    const btn = document.getElementById(`wfuc-btn-${id}`);
    
    if (menu && btn) {
      menu.classList.toggle('wfuc-show');
      btn.classList.toggle('wfuc-active');
    }
  },
  
  closeAllMenus() {
    const root = document.getElementById('wf-use-cases');
    if (!root) return;
    
    root.querySelectorAll('.wfuc-dropdown-menu.wfuc-show').forEach(m => {
      m.classList.remove('wfuc-show');
    });
    root.querySelectorAll('.wfuc-menu-btn.wfuc-active').forEach(b => {
      b.classList.remove('wfuc-active');
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Modal Management
// ═══════════════════════════════════════════════════════════════════════════

const Modal = {
  open(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('wfuc-open');
    }
  },
  
  close(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('wfuc-open');
    }
  },
  
  openAdd() {
    this.open('wfuc-add-modal');
  },
  
  closeAdd() {
    this.close('wfuc-add-modal');
    Form.reset();
    state.resetModalState();
    this.showStep(1);
  },
  
  openDelete(id, name) {
    if (!id) return;
    state.deleteTargetId = id;
    const nameEl = document.getElementById('wfuc-delete-uc-name');
    if (nameEl) {
      nameEl.textContent = Utils.escapeHtml(name || 'this use case');
    }
    this.open('wfuc-delete-modal');
  },
  
  closeDelete() {
    this.close('wfuc-delete-modal');
    state.deleteTargetId = null;
  },
  
  showStep(step) {
    state.currentModalStep = step;
    const shell = document.getElementById('wfuc-modal-shell');
    
    document.querySelectorAll('#wfuc-add-modal .wfuc-modal-step').forEach(el => {
      el.classList.remove('wfuc-active-step');
    });
    
    const stepEl = document.getElementById(`wfuc-step-${step}`);
    if (stepEl) {
      stepEl.classList.add('wfuc-active-step');
    }
    
    if (shell) {
      if (step === 3) {
        shell.classList.add('wfuc-wide');
      } else {
        shell.classList.remove('wfuc-wide');
      }
    }
  },
  
  async confirmDelete() {
    if (!state.deleteTargetId || !state.userId) return;
    
    const btn = document.getElementById('wfuc-confirm-delete-btn');
    if (!btn) return;
    
    const originalText = btn.textContent;
    btn.textContent = 'Deleting...';
    btn.disabled = true;
    
    try {
      const idToDelete = state.deleteTargetId;
      
      // Optimistic update
      state.setUseCases(state.useCases.filter(uc => 
        (uc.id || uc.use_case_id) != idToDelete
      ));
      UI.renderGrid();
      this.closeDelete();
      
      await API.deleteUseCase(idToDelete);
      Toast.success('Use case deleted', 'Your use case was deleted successfully');
      
    } catch (error) {
      console.error('[Modal] Delete error:', error);
      Toast.error('Delete failed', 'Please try again');
      API.fetchUseCases(); // Re-sync
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Form Management
// ═══════════════════════════════════════════════════════════════════════════

const Form = {
  reset() {
    const form = document.getElementById('wfuc-add-use-case-form');
    if (form) form.reset();
    
    state.resetFileState();
    this.updateFilePreview();
    this.validateForm();
    
    const fields = document.getElementById('wfuc-fields-section');
    if (fields) fields.classList.remove('wfuc-visible');
    
    const uploadZone = document.getElementById('wfuc-upload-zone');
    if (uploadZone) uploadZone.style.display = '';
  },
  
  handleDragOver(e) {
    e.preventDefault();
    const area = document.getElementById('wfuc-upload-area');
    if (area) area.classList.add('wfuc-dragover');
  },
  
  handleDragLeave(e) {
    e.preventDefault();
    const area = document.getElementById('wfuc-upload-area');
    if (area) area.classList.remove('wfuc-dragover');
  },
  
  handleDrop(e) {
    e.preventDefault();
    const area = document.getElementById('wfuc-upload-area');
    if (area) area.classList.remove('wfuc-dragover');
    
    const files = e.dataTransfer?.files;
    if (files && files[0]) {
      this.selectFile(files[0]);
    }
  },
  
  handleFileInput(e) {
    const files = e.target?.files;
    if (files && files[0]) {
      this.selectFile(files[0]);
    }
  },
  
  selectFile(file) {
    const validation = Utils.validateFile(file);
    
    if (!validation.valid) {
      Toast.error('Invalid file', validation.error);
      return;
    }
    
    state.selectedFile = file;
    this.updateFilePreview();
    this.validateForm();
    
    // Auto-fill name
    const nameInput = document.getElementById('wfuc-use-case-name');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = file.name
        .replace(/\.pptx$/i, '')
        .replace(/[_-]/g, ' ');
      this.validateForm();
    }
    
    requestAnimationFrame(() => {
      const fields = document.getElementById('wfuc-fields-section');
      if (fields) fields.classList.add('wfuc-visible');
      
      setTimeout(() => {
        if (nameInput) nameInput.focus();
      }, 350);
    });
  },
  
  updateFilePreview() {
    const container = document.getElementById('wfuc-file-preview-container');
    const dropZone = document.getElementById('wfuc-upload-zone');
    
    if (!container) return;
    
    if (!state.selectedFile) {
      container.innerHTML = '';
      if (dropZone) dropZone.style.display = '';
      return;
    }
    
    if (dropZone) dropZone.style.display = 'none';
    
    const fileName = Utils.escapeHtml(state.selectedFile.name);
    const fileSize = Utils.formatFileSize(state.selectedFile.size);
    
    container.innerHTML = `
      <div class="wfuc-file-chip">
        <div class="wfuc-file-chip-icon">
          <i data-lucide="file-text"></i>
        </div>
        <div class="wfuc-file-chip-info">
          <div class="wfuc-file-chip-name">${fileName}</div>
          <div class="wfuc-file-chip-size">${fileSize}</div>
        </div>
        <button type="button" class="wfuc-file-chip-remove" onclick="Form.removeFile()" title="Remove file">
          <i data-lucide="x"></i>
        </button>
      </div>
    `;
    
    lucide.createIcons();
  },
  
  removeFile() {
    state.selectedFile = null;
    const fileInput = document.getElementById('wfuc-file-input');
    if (fileInput) fileInput.value = '';
    
    this.updateFilePreview();
    this.validateForm();
    
    const fields = document.getElementById('wfuc-fields-section');
    if (fields) fields.classList.remove('wfuc-visible');
  },
  
  validateForm() {
    const nameInput = document.getElementById('wfuc-use-case-name');
    const btn = document.getElementById('wfuc-submit-btn');
    
    if (!nameInput || !btn) return;
    
    const isValid = nameInput.value.trim() && state.selectedFile;
    btn.disabled = !isValid;
  },
  
  async submit(e) {
    e.preventDefault();
    
    if (!state.userId) {
      Toast.error('Not signed in', 'Please log in to create a use case');
      return;
    }
    
    const btn = document.getElementById('wfuc-submit-btn');
    if (!btn) return;
    
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Creating...';
    
    const nameInput = document.getElementById('wfuc-use-case-name');
    const descInput = document.getElementById('wfuc-use-case-desc');
    const externalDataToggle = document.getElementById('wfuc-external-data');
    
    const name = nameInput?.value || '';
    const description = descInput?.value || '';
    const externalDataEnabled = externalDataToggle?.checked || false;
    
    try {
      btn.textContent = 'Uploading...';
      Toast.info('Upload started', 'Your presentation is uploading');
      
      const result = await API.uploadUseCase(state.selectedFile, name, description, externalDataEnabled);
      
      // Mark upload for auto-selection
      Utils.storage.set(CONFIG.STORAGE_KEYS.NEW_UPLOAD, {
        file_name: result.fileName,
        createdAt: Date.now()
      });
      
      if (externalDataEnabled) {
        // Don't close modal, show processing step instead
        state.setPendingDsConfig({ name, file_name: result.fileName });
        Modal.showStep(2); // Stay in modal, go to processing step
        Toast.success('Upload complete', 'Processing your presentation...');
        state.startPolling();
        // Processing message will automatically transition to data source config when ready
      } else {
        Modal.closeAdd();
        Toast.success('Upload complete', 'Processing your use case');
        state.startPolling();
      }
      
    } catch (error) {
      console.error('[Form] Upload error:', error);
      Toast.error('Create failed', 'Failed to create use case. Please try again');
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
};

// Status Helpers (keep old function for backward compatibility)
function getStatusBadge(status) {
  return UI.getStatusBadge(status);
}

function handleCardClick(uc) {
  UI.handleCardClick(uc);
}

// Render
function renderGrid() {
  UI.renderGrid();
}

// API Functions (keep old for compatibility)
async function fetchUseCases() {
  return API.fetchUseCases();
}

function startPolling() {
  state.startPolling();
}

// Modal Logic (keep old for compatibility)
function openAddModal() {
  Modal.openAdd();
}

function closeAddModal() {
  Modal.closeAdd();
}

// Delete Modal Logic
function openDeleteModal(id, name) {
  Modal.openDelete(id, name);
}

function closeDeleteModal() {
  Modal.closeDelete();
}

async function confirmDeleteUseCase() {
  return Modal.confirmDelete();
}

function toggleMenu(e, id) {
  UI.toggleMenu(e, id);
}

function resetForm() {
  Form.reset();
}

// File Handling
function handleDragOver(e) {
  Form.handleDragOver(e);
}

function handleDragLeave(e) {
  Form.handleDragLeave(e);
}

function handleDrop(e) {
  Form.handleDrop(e);
}

function handleFileSelect(e) {
  Form.handleFileInput(e);
}

function validateAndSelectFile(file) {
  Form.selectFile(file);
}

function updateFilePreview() {
  Form.updateFilePreview();
}

function removeFile() {
  Form.removeFile();
}

function checkFormValidity() {
  Form.validateForm();
}

// Form Submission
async function handleCreateUseCase(e) {
  return Form.submit(e);
}

// ─── Multi-step Modal Functions ───
function showModalStep(step) {
  Modal.showStep(step);
}

// ═══════════════════════════════════════════════════════════════════════════
// Data Source Configuration
// ═══════════════════════════════════════════════════════════════════════════

const DataSourceConfig = {
  async open(userId, templateId) {
    if (state.dsConfigLoading) {
      console.log('[DS Config] Already loading, skipping duplicate request');
      return;
    }
    state.dsConfigLoading = true;
    state.pendingTemplateId = templateId;
    
    Modal.open('wfuc-add-modal');
    Modal.showStep(3);
    
    this.showLoading();
    
    try {
      console.log('[DS Config] Loading data for template:', templateId);
      const items = await API.fetchGraphTableData(templateId);
      console.log('[DS Config] Successfully loaded', items.length, 'items');
      
      // Validate that items have required fields
      const validItems = items.filter(item => 
        item.slide_number && item.title && item.url_image
      );
      
      if (validItems.length !== items.length) {
        console.warn('[DS Config] Some items missing required fields');
      }
      
      state.graphTableItems = validItems;
      state.currentItemIndex = 0;
      // Ensure there are no implicit pre-selections (explicit guard)
      state.itemSelections = {};
      // Clear any checked radio inputs from previous sessions
      try {
        document.querySelectorAll('input[name="wfuc-ds-source"]').forEach(i => i.checked = false);
      } catch (e) {
        // ignore - DOM may not be present yet
      }
      
      if (validItems.length === 0) {
        this.showEmptyState();
        setTimeout(() => Modal.closeAdd(), 3000);
        return;
      }
      
      this.renderCurrent();
      lucide.createIcons();
      
    } catch (error) {
      console.error('[DS Config] Load error:', error);
      this.showErrorState(error.message);
      Toast.error('Failed to load', error.message || 'Could not load charts and tables. Please try again');
      setTimeout(() => Modal.closeAdd(), 3000);
    } finally {
      state.dsConfigLoading = false;
    }
  },
  
  showLoading() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 40px;color:#64748b">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:rgba(124,58,237,0.08);border-radius:50%;margin-bottom:20px">
            <span class="wfuc-processing-spinner-lg"></span>
          </div>
          <p style="margin:0;font-size:15px;font-weight:500;color:#0f172a">Loading charts and tables</p>
          <p style="margin:8px 0 0;font-size:13px;color:#94a3b8">Please wait while we fetch your presentation data...</p>
        </div>
      `;
    }
    
    const confirmBtn = document.getElementById('wfuc-ds-confirm');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Confirm Data Sources';
    }
    
    ['wfuc-ds-dots', 'wfuc-ds-counter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    
    ['wfuc-ds-prev', 'wfuc-ds-next'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    
    lucide.createIcons();
  },
  
  showEmptyState() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 40px;color:#64748b">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:rgba(148,163,184,0.08);border-radius:50%;margin-bottom:20px">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect width="4" height="7" x="7" y="10" rx="1"/><rect width="4" height="12" x="15" y="5" rx="1"/></svg>
          </div>
          <p style="margin:0;font-size:15px;font-weight:500;color:#0f172a">No charts or tables found</p>
          <p style="margin:8px 0 0;font-size:13px;color:#94a3b8">This presentation doesn't contain any charts or tables to configure</p>
        </div>
      `;
    }
    Toast.info('No items found', 'No charts or tables were found in this presentation');
  },
  
  showErrorState(message) {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) {
      const safeMessage = Utils.escapeHtml(message || 'An error occurred while loading');
      container.innerHTML = `
        <div style="text-align:center;padding:60px 40px;color:#64748b">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:rgba(239,68,68,0.08);border-radius:50%;margin-bottom:20px">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <p style="margin:0;font-size:15px;font-weight:500;color:#0f172a">Failed to load data</p>
          <p style="margin:8px 0 0;font-size:13px;color:#94a3b8">${safeMessage}</p>
        </div>
      `;
    }
  },
  
  renderCurrent() {
    const item = state.graphTableItems[state.currentItemIndex];
    if (!item) return;
    
    const container = document.getElementById('wfuc-ds-item-container');
    if (!container) return;
    
    // Add fade out effect
    container.style.opacity = '0';
    container.style.transition = 'opacity 0.15s ease';
    
    setTimeout(() => {
      const selected = state.itemSelections[state.currentItemIndex] || '';
      const chk = (val) => selected === val ? 'checked' : '';
      
      const safeTitle = Utils.escapeHtml(item.title);
      const safeImageUrl = Utils.escapeHtml(item.url_image);
      const itemType = item.type === 'table' ? 'Table' : 'Chart';
      const typeColor = item.type === 'table' ? '#0ea5e9' : '#7c3aed';
      
      container.innerHTML = `
        <h3 class="wfuc-ds-item-title">${safeTitle}</h3>
        <div class="wfuc-ds-image-wrap">
          <span class="wfuc-ds-slide-badge">Slide ${item.slide_number}</span>
          <span class="wfuc-ds-slide-badge" style="background:${typeColor};right:12px;left:auto">${itemType}</span>
          <img src="${safeImageUrl}" alt="${safeTitle}" onerror="this.parentElement.style.minHeight='120px';this.style.display='none';">
        </div>
        <div class="wfuc-ds-options">
          <label class="wfuc-ds-option">
            <input type="radio" name="wfuc-ds-source" value="excel" ${chk('excel')} onchange="DataSourceConfig.selectSource('excel')">
            <div class="wfuc-ds-option-label">
              <div class="wfuc-ds-option-icon"><i data-lucide="table-2"></i></div>
              <span class="wfuc-ds-option-text">Excel <span style="opacity:0.5;font-size:10px;margin-left:4px">(1)</span></span>
            </div>
          </label>
          <label class="wfuc-ds-option">
            <input type="radio" name="wfuc-ds-source" value="api" ${chk('api')} onchange="DataSourceConfig.selectSource('api')">
            <div class="wfuc-ds-option-label">
              <div class="wfuc-ds-option-icon"><i data-lucide="plug"></i></div>
              <span class="wfuc-ds-option-text">API <span style="opacity:0.5;font-size:10px;margin-left:4px">(2)</span></span>
            </div>
          </label>
          <label class="wfuc-ds-option">
            <input type="radio" name="wfuc-ds-source" value="no_change" ${chk('no_change')} onchange="DataSourceConfig.selectSource('no_change')">
            <div class="wfuc-ds-option-label">
              <div class="wfuc-ds-option-icon"><i data-lucide="minus-circle"></i></div>
              <span class="wfuc-ds-option-text">No change <span style="opacity:0.5;font-size:10px;margin-left:4px">(3)</span></span>
            </div>
          </label>
        </div>
      `;
      
      this.updateUI();
      lucide.createIcons();
      
      // Fade in
      requestAnimationFrame(() => {
        container.style.opacity = '1';
      });
    }, 150);
  },
  
  updateUI() {
    const counter = document.getElementById('wfuc-ds-counter');
    if (counter) {
      const totalConfigured = Object.keys(state.itemSelections).length;
      const total = state.graphTableItems.length;
      counter.innerHTML = `
        <span style="font-weight:600;color:#0f172a">${state.currentItemIndex + 1}</span> 
        <span style="color:#94a3b8">of</span> 
        <span style="font-weight:600;color:#0f172a">${total}</span>
        <span style="color:#cbd5e1;margin:0 6px">•</span>
        <span style="color:${totalConfigured === total ? '#10b981' : '#94a3b8'};font-size:12px">
          ${totalConfigured} configured
        </span>
      `;
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
    
    // Visual feedback
    const options = document.querySelectorAll('.wfuc-ds-option-label');
    options.forEach(opt => {
      opt.style.transform = 'scale(1)';
    });
    
    const selectedOption = document.querySelector(`.wfuc-ds-option input[value="${type}"] + .wfuc-ds-option-label`);
    if (selectedOption) {
      selectedOption.style.transform = 'scale(1.02)';
      setTimeout(() => {
        selectedOption.style.transform = 'scale(1)';
      }, 200);
    }
    
    // Check if all items are configured
    const allConfigured = state.graphTableItems.every((_, i) => state.itemSelections[i]);
    if (allConfigured) {
      const confirmBtn = document.getElementById('wfuc-ds-confirm');
      if (confirmBtn && confirmBtn.disabled) {
        // Add a subtle pulse animation to the confirm button
        confirmBtn.style.animation = 'wfuc-pulse 0.5s ease-out';
        setTimeout(() => {
          confirmBtn.style.animation = '';
        }, 500);
      }
    }
    
    // Auto-advance to next unconfigured item if not on last item
    if (state.currentItemIndex < state.graphTableItems.length - 1) {
      const nextUnconfigured = state.graphTableItems.findIndex((_, i) => 
        i > state.currentItemIndex && !state.itemSelections[i]
      );
      
      if (nextUnconfigured !== -1) {
        setTimeout(() => {
          state.currentItemIndex = nextUnconfigured;
          this.renderCurrent();
        }, 300);
      }
    }
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
  },
  
  async submit() {
    const btn = document.getElementById('wfuc-ds-confirm');
    if (!btn) return;
    
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="wfuc-spinner"></span> Saving configuration...';
    
    // Disable navigation while submitting
    const prevBtn = document.getElementById('wfuc-ds-prev');
    const nextBtn = document.getElementById('wfuc-ds-next');
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    
    const payload = {
      user_id: state.userId,
      template_id: state.pendingTemplateId,
      data_sources: state.graphTableItems.map((item, i) => ({
        slide_number: item.slide_number,
        title: item.title,
        url_image: item.url_image,
        source_type: state.itemSelections[i] || 'no_change',
        type: item.type || 'graph' // Include type field (graph or table)
      }))
    };
    
    try {
      console.log('[DS Config] Submitting configuration:', JSON.stringify(payload, null, 2));
      const response = await API.submitDataSourceConfig(payload);
      console.log('[DS Config] Configuration saved successfully:', response);
      Toast.success('Configuration saved', 'Your data source preferences have been successfully saved');
      Modal.closeAdd();
      
      // Refresh the use cases list to show updated status
      setTimeout(() => {
        API.fetchUseCases();
      }, 1000);
      
    } catch (error) {
      console.error('[DS Config] Failed to save configuration:', error);
      Toast.error('Save failed', error.message || 'Could not save data source configuration. Please try again');
      
      // Re-enable buttons on error
      btn.disabled = false;
      btn.textContent = originalText;
      if (prevBtn) prevBtn.disabled = state.currentItemIndex === 0;
      if (nextBtn) nextBtn.disabled = state.currentItemIndex === state.graphTableItems.length - 1;
    }
  }
};

// Backward compatibility wrappers for DataSourceConfig
async function openDataSourceConfig(userId, templateId) {
  return DataSourceConfig.open(userId, templateId);
}

function renderCurrentItem() {
  DataSourceConfig.renderCurrent();
}

function renderDots() {
  DataSourceConfig.renderDots();
}

function navigateItem(dir) {
  DataSourceConfig.navigate(dir);
}

function selectSource(type) {
  DataSourceConfig.selectSource(type);
}

function applyToAll(type) {
  DataSourceConfig.applyToAll(type);
}

function updateConfirmButton() {
  DataSourceConfig.updateConfirmButton();
}

async function submitDataSourceConfig() {
  return DataSourceConfig.submit();
}

// ═══════════════════════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════════════════════

// Close menus when clicking outside
state.addEventListenerTracked(document, 'click', (e) => {
  if (!e.target.closest('.wfuc-menu-btn')) {
    UI.closeAllMenus();
  }
});

// Listen for selection changes
state.addEventListenerTracked(document, 'wfuc:selection-change', () => {
  UI.renderGrid();
});

// Keyboard navigation for data source configuration
state.addEventListenerTracked(document, 'keydown', (e) => {
  // Only handle keyboard events when the data source config modal is open
  const modal = document.getElementById('wfuc-add-modal');
  const step3 = document.getElementById('wfuc-modal-step-3');
  if (!modal || !modal.classList.contains('wfuc-open') || 
      !step3 || !step3.classList.contains('wfuc-active-step')) {
    return;
  }
  
  // Don't interfere with input fields
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    return;
  }
  
  switch(e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      DataSourceConfig.navigate(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      DataSourceConfig.navigate(1);
      break;
    case '1':
      e.preventDefault();
      DataSourceConfig.selectSource('excel');
      break;
    case '2':
      e.preventDefault();
      DataSourceConfig.selectSource('api');
      break;
    case '3':
      e.preventDefault();
      DataSourceConfig.selectSource('no_change');
      break;
    case 'Enter':
      const confirmBtn = document.getElementById('wfuc-ds-confirm');
      if (confirmBtn && !confirmBtn.disabled) {
        e.preventDefault();
        DataSourceConfig.submit();
      }
      break;
  }
});

// Form validation listeners with debouncing
const debouncedValidation = Utils.debounce(() => Form.validateForm(), CONFIG.DEBOUNCE_DELAY);

const nameInput = document.getElementById('wfuc-use-case-name');
const descInput = document.getElementById('wfuc-use-case-desc');

if (nameInput) {
  state.addEventListenerTracked(nameInput, 'input', debouncedValidation);
}
if (descInput) {
  state.addEventListenerTracked(descInput, 'input', debouncedValidation);
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  state.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════

console.log('[UseCases] Initializing...');
UI.renderGrid();
state.startPolling();
console.log('[UseCases] Ready');
