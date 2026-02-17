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
    this.slideData = {};
    this.slideOrder = [];
    this.activeSlideNum = null;
    this.elementSelections = {};
    this.sectionExpansion = {};
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
            excel_url: item.excel_url || '',
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
      
      // New response format: { slides: { "1": { graphs, tables, images, texts, url_image }, ... }, total_slides }
      // Also handle legacy flat format: { items: [...] }
      if (data.slides) {
        return this.parseSlideResponse(data);
      }
      
      // Legacy flat format fallback
      const items = data.items || [];
      console.log('[API] Fetched', items.length, 'chart/table items (legacy format)');
      return {
        format: 'legacy',
        items: items.map(item => ({
          ...item,
          type: item.type || 'graph'
        }))
      };
      
    } catch (error) {
      console.error('[API] Error fetching graph/table data:', error);
      throw error;
    }
  },
  
  parseSlideResponse(data) {
    const slides = data.slides || {};
    const slideData = {};
    const slideOrder = [];
    
    const slideNums = Object.keys(slides).map(Number).sort((a, b) => a - b);
    
    for (const num of slideNums) {
      const slide = slides[String(num)];
      const elements = [];
      
      (slide.graphs || []).forEach((g, i) => {
        elements.push({
          elementKey: `s${num}_chart_${g.chart_id || i}`,
          type: 'chart',
          title: g.title || `Chart ${g.chart_id || (i + 1)}`,
          chartType: g.chart_type || '',
          chartSubtype: g.chart_subtype || '',
          slideNumber: num,
          urlImage: g.url_image || '',
          assetKey: g.asset_key || '',
          position: g.position || {}
        });
      });
      
      (slide.tables || []).forEach((t, i) => {
        elements.push({
          elementKey: `s${num}_table_${t.table_id || i}`,
          type: 'table',
          title: t.title || `Table ${t.table_id || (i + 1)}`,
          shapeName: t.shape_name || '',
          dimensions: t.dimensions || {},
          slideNumber: num,
          urlImage: t.url_image || '',
          assetKey: t.asset_key || '',
          position: t.position || {}
        });
      });

      (slide.images || []).forEach((img, i) => {
        elements.push({
          elementKey: `s${num}_image_${img.image_id || i}`,
          type: 'image',
          title: img.description || img.shape_name || `Image ${img.image_id || (i + 1)}`,
          shapeName: img.shape_name || '',
          slideNumber: num,
          urlImage: img.url_image || '',
          assetKey: img.asset_key || '',
          position: img.position || {}
        });
      });
      
      (slide.texts || []).forEach((txt, i) => {
        elements.push({
          elementKey: `s${num}_text_${i}`,
          type: 'text',
          title: String(txt),
          slideNumber: num
        });
      });
      
      slideData[num] = {
        slideNumber: num,
        urlImage: slide.url_image || '',
        elements,
        chartsCount: (slide.graphs || []).length,
        tablesCount: (slide.tables || []).length,
        imagesCount: (slide.images || []).length,
        textsCount: (slide.texts || []).length
      };
      
      slideOrder.push(num);
    }
    
    console.log('[API] Parsed', slideOrder.length, 'slides with elements');
    return { format: 'slides', slideData, slideOrder, totalSlides: data.total_slides || slideOrder.length };
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

  createExcelButton(excelUrl, name) {
    if (!excelUrl) return null;
    
    const safeUrl = Utils.safeUrl(excelUrl);
    if (!safeUrl) return null;
    
    const button = document.createElement('button');
    button.className = 'wfuc-card-action-btn';
    button.title = `Download ${Utils.escapeHtml(name || 'file')}.xlsx`;
    button.onclick = (e) => {
      e.stopPropagation();
      this.downloadExcel(safeUrl, name);
    };
    
    // Excel icon
    const icon = document.createElement('span');
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="m10 13.5-2 2.5 2 2.5"/><path d="m14 13.5 2 2.5-2 2.5"/></svg>';
    icon.style.cssText = 'display: flex; align-items: center; flex-shrink: 0;';
    button.appendChild(icon);
    
    const label = document.createElement('span');
    label.className = 'wfuc-action-label';
    const fileName = Utils.escapeHtml(name || 'download');
    label.textContent = `${fileName}.xlsx`;
    button.appendChild(label);
    
    return button;
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
    
    content.appendChild(metaFile);
    content.appendChild(metaTime);
    
    // Card footer with status badge and Excel download
    const footer = document.createElement('div');
    footer.className = 'wfuc-card-footer';
    footer.style.marginTop = '12px';
    
    const statusBadge = this.getStatusBadge(uc.status);
    footer.appendChild(statusBadge);
    
    const excelButton = this.createExcelButton(uc.excel_url, uc.name);
    if (excelButton) {
      footer.appendChild(excelButton);
    }
    
    content.appendChild(footer);
    
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
      const result = await API.fetchGraphTableData(templateId);
      
      if (result.format === 'slides') {
        state.slideData = result.slideData;
        state.slideOrder = result.slideOrder;
        state.elementSelections = {};
        state.activeSlideNum = result.slideOrder[0] || null;
      } else {
        this.convertLegacyToSlideFormat(result.items);
      }
      
      const totalElements = this.getTotalElementCount();
      console.log('[DS Config] Loaded', state.slideOrder.length, 'slides with', totalElements, 'elements');
      
      if (totalElements === 0) {
        this.showEmptyState();
        setTimeout(() => Modal.closeAdd(), 3000);
        return;
      }
      
      this.renderSlideTabs();
      this.renderActiveSlide();
      this.updateProgress();
      this.updateConfirmButton();
      lucide.createIcons();
      
    } catch (error) {
      console.error('[DS Config] Load error:', error);
      this.showErrorState(error.message);
      Toast.error('Failed to load', error.message || 'Could not load presentation data. Please try again');
      setTimeout(() => Modal.closeAdd(), 3000);
    } finally {
      state.dsConfigLoading = false;
    }
  },
  
  convertLegacyToSlideFormat(items) {
    state.slideData = {};
    state.slideOrder = [];
    state.elementSelections = {};
    
    const bySlide = {};
    items.forEach((item, i) => {
      const sn = item.slide_number || 1;
      if (!bySlide[sn]) bySlide[sn] = { graphs: [], tables: [], texts: [] };
      if (item.type === 'table') {
        bySlide[sn].tables.push(item);
      } else {
        bySlide[sn].graphs.push(item);
      }
    });
    
    const slideNums = Object.keys(bySlide).map(Number).sort((a, b) => a - b);
    for (const num of slideNums) {
      const s = bySlide[num];
      const elements = [];
      s.graphs.forEach((g, i) => {
        elements.push({
          elementKey: `s${num}_chart_${i}`,
          type: 'chart',
          title: g.title || `Chart ${i + 1}`,
          slideNumber: num,
          urlImage: g.url_image || ''
        });
      });
      s.tables.forEach((t, i) => {
        elements.push({
          elementKey: `s${num}_table_${i}`,
          type: 'table',
          title: t.title || `Table ${i + 1}`,
          slideNumber: num,
          urlImage: t.url_image || ''
        });
      });
      state.slideData[num] = {
        slideNumber: num,
        urlImage: '',
        elements,
        chartsCount: s.graphs.length,
        tablesCount: s.tables.length,
        imagesCount: 0,
        textsCount: 0
      };
      state.slideOrder.push(num);
    }
    state.activeSlideNum = state.slideOrder[0] || null;
  },
  
  getTotalElementCount() {
    let total = 0;
    for (const num of state.slideOrder) {
      total += (state.slideData[num]?.elements || []).length;
    }
    return total;
  },
  
  getConfiguredCount() {
    let count = 0;
    for (const num of state.slideOrder) {
      const slide = state.slideData[num];
      if (!slide) continue;
      for (const el of slide.elements) {
        const sel = state.elementSelections[el.elementKey];
        if (!sel || !sel.source) continue;
        if (sel.source === 'generate' && !sel.reference) continue;
        count++;
      }
    }
    return count;
  },
  
  isSlideComplete(slideNum) {
    const slide = state.slideData[slideNum];
    if (!slide) return false;
    return slide.elements.every(el => {
      const sel = state.elementSelections[el.elementKey];
      if (!sel || !sel.source) return false;
      if (sel.source === 'generate' && !sel.reference) return false;
      return true;
    });
  },
  
  getSlideConfiguredCount(slideNum) {
    const slide = state.slideData[slideNum];
    if (!slide) return 0;
    return slide.elements.filter(el => {
      const sel = state.elementSelections[el.elementKey];
      if (!sel || !sel.source) return false;
      if (sel.source === 'generate' && !sel.reference) return false;
      return true;
    }).length;
  },
  
  showLoading() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 40px;color:#64748b">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:rgba(116,41,91,0.08);border-radius:50%;margin-bottom:20px">
            <span class="wfuc-processing-spinner-lg"></span>
          </div>
          <p style="margin:0;font-size:15px;font-weight:500;color:#0f172a">Loading your presentation</p>
          <p style="margin:8px 0 0;font-size:13px;color:#94a3b8">Extracting charts, tables, images, and text elements...</p>
        </div>
      `;
    }
    
    const slideArea = document.getElementById('wfuc-ds-slide-area');
    if (slideArea) slideArea.style.display = 'none';
    
    const tabs = document.getElementById('wfuc-ds-slide-tabs');
    if (tabs) tabs.innerHTML = '';
    
    const progress = document.getElementById('wfuc-ds-progress');
    if (progress) progress.style.display = 'none';
    
    const confirmBtn = document.getElementById('wfuc-ds-confirm');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Confirm Data Sources';
    }
  },
  
  showEmptyState() {
    const container = document.getElementById('wfuc-ds-item-container');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 40px;color:#64748b">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:rgba(148,163,184,0.08);border-radius:50%;margin-bottom:20px">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect width="4" height="7" x="7" y="10" rx="1"/><rect width="4" height="12" x="15" y="5" rx="1"/></svg>
          </div>
          <p style="margin:0;font-size:15px;font-weight:500;color:#0f172a">No configurable elements found</p>
          <p style="margin:8px 0 0;font-size:13px;color:#94a3b8">This presentation doesn't contain any charts, tables, images, or text elements to configure</p>
        </div>
      `;
    }
    Toast.info('No items found', 'No configurable elements were found in this presentation');
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
  
  renderSlideTabs() {
    const tabsContainer = document.getElementById('wfuc-ds-slide-tabs');
    if (!tabsContainer) return;
    tabsContainer.innerHTML = '';
    
    state.slideOrder.forEach(num => {
      const slide = state.slideData[num];
      const isActive = num === state.activeSlideNum;
      const isComplete = this.isSlideComplete(num);
      const remaining = slide.elements.length - this.getSlideConfiguredCount(num);
      
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'wfuc-ds-slide-tab';
      if (isActive) tab.classList.add('wfuc-tab-active');
      if (isComplete) tab.classList.add('wfuc-tab-complete');
      
      if (slide.urlImage) {
        const img = document.createElement('img');
        img.src = slide.urlImage;
        img.alt = `Slide ${num}`;
        img.onerror = function() { this.style.display = 'none'; };
        tab.appendChild(img);
      }
      
      const label = document.createElement('span');
      label.className = 'wfuc-ds-tab-label';
      label.textContent = `Slide ${num}`;
      tab.appendChild(label);
      
      if (isComplete) {
        const check = document.createElement('span');
        check.className = 'wfuc-ds-tab-check';
        check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        tab.appendChild(check);
      } else if (remaining > 0 && remaining < slide.elements.length) {
        const count = document.createElement('span');
        count.className = 'wfuc-ds-tab-count';
        count.textContent = remaining;
        tab.appendChild(count);
      }
      
      tab.onclick = () => {
        state.activeSlideNum = num;
        this.renderSlideTabs();
        this.renderActiveSlide();
      };
      
      tabsContainer.appendChild(tab);
    });
  },
  
  renderActiveSlide() {
    const slideArea = document.getElementById('wfuc-ds-slide-area');
    const itemContainer = document.getElementById('wfuc-ds-item-container');
    const progress = document.getElementById('wfuc-ds-progress');
    
    if (!slideArea || !state.activeSlideNum) return;
    
    if (itemContainer) itemContainer.innerHTML = '';
    slideArea.style.display = '';
    if (progress) progress.style.display = '';
    
    const slide = state.slideData[state.activeSlideNum];
    if (!slide) return;
    
    this.renderSlidePreview(slide);
    this.renderElementSections(slide);
    this.updateProgress();
  },
  
  renderSlidePreview(slide) {
    const wrap = document.getElementById('wfuc-ds-slide-preview-wrap');
    if (!wrap) return;
    
    wrap.innerHTML = '';
    
    if (slide.urlImage) {
      const img = document.createElement('img');
      img.src = slide.urlImage;
      img.alt = `Slide ${slide.slideNumber}`;
      img.onerror = function() { this.style.display = 'none'; };
      wrap.appendChild(img);
    }
    
    const info = document.createElement('div');
    info.className = 'wfuc-ds-slide-info';
    const parts = [];
    parts.push(`Slide ${slide.slideNumber}`);
    if (slide.chartsCount) parts.push(`${slide.chartsCount} chart${slide.chartsCount > 1 ? 's' : ''}`);
    if (slide.tablesCount) parts.push(`${slide.tablesCount} table${slide.tablesCount > 1 ? 's' : ''}`);
    if (slide.imagesCount) parts.push(`${slide.imagesCount} image${slide.imagesCount > 1 ? 's' : ''}`);
    if (slide.textsCount) parts.push(`${slide.textsCount} text${slide.textsCount > 1 ? 's' : ''}`);
    info.textContent = parts.join(' \u00b7 ');
    wrap.appendChild(info);
  },
  
  renderElementSections(slide) {
    const container = document.getElementById('wfuc-ds-elements');
    if (!container) return;
    
    // Preserve scroll position
    const scrollTop = container.scrollTop;
    
    container.innerHTML = '';
    
    const charts = slide.elements.filter(e => e.type === 'chart');
    const tables = slide.elements.filter(e => e.type === 'table');
    const images = slide.elements.filter(e => e.type === 'image');
    const texts = slide.elements.filter(e => e.type === 'text');
    
    const chartsTablesAndImages = [...charts, ...tables, ...images];
    
    if (chartsTablesAndImages.length > 0) {
      container.appendChild(this.buildSection(
        'Charts, Tables & Images',
        chartsTablesAndImages,
        slide,
        false
      ));
    }
    
    if (texts.length > 0) {
      container.appendChild(this.buildSection(
        'Texts',
        texts,
        slide,
        texts.length > 8
      ));
    }
    
    // Restore scroll position
    if (scrollTop > 0) {
      requestAnimationFrame(() => {
        container.scrollTop = scrollTop;
      });
    }
  },
  
  buildSection(title, elements, slide, defaultCollapsed) {
    const sectionKey = `s${slide.slideNumber}_${title}`;
    const section = document.createElement('div');
    section.className = 'wfuc-ds-section';
    
    // Check state, fall back to default
    const isExpanded = state.sectionExpansion[sectionKey] !== undefined 
      ? state.sectionExpansion[sectionKey] 
      : !defaultCollapsed;
      
    if (!isExpanded) section.classList.add('wfuc-collapsed');
    
    const configuredInSection = elements.filter(el => {
      const sel = state.elementSelections[el.elementKey];
      return sel && sel.source && (sel.source !== 'generate' || sel.reference);
    }).length;
    
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'wfuc-ds-section-header';
    header.innerHTML = `
      <div class="wfuc-ds-section-title">
        <span>${Utils.escapeHtml(title)}</span>
        <span class="wfuc-ds-section-count">${configuredInSection}/${elements.length}</span>
      </div>
      <div class="wfuc-ds-section-toggle">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    `;
    header.onclick = () => {
      const wasExpanded = !section.classList.contains('wfuc-collapsed');
      section.classList.toggle('wfuc-collapsed');
      state.sectionExpansion[sectionKey] = !wasExpanded;
    };
    
    const body = document.createElement('div');
    body.className = 'wfuc-ds-section-body';
    
    elements.forEach(el => {
      body.appendChild(this.buildElementRow(el, slide));
      
      const sel = state.elementSelections[el.elementKey];
      if (sel && sel.source === 'generate') {
        body.appendChild(this.buildReferenceRow(el, slide));
      }
    });
    
    section.appendChild(header);
    section.appendChild(body);
    return section;
  },
  
  buildElementRow(el, slide) {
    const row = document.createElement('div');
    row.className = 'wfuc-ds-row';
    row.dataset.elementKey = el.elementKey;
    
    const iconClass = el.type === 'chart' ? 'wfuc-icon-chart' : 
              el.type === 'table' ? 'wfuc-icon-table' :
              el.type === 'image' ? 'wfuc-icon-image' : 'wfuc-icon-text';
    const iconLabel = el.type === 'chart' ? '\u25e2' : el.type === 'table' ? '\u25a6' : el.type === 'image' ? '\u{1f5bc}' : 'T';
    
    const icon = document.createElement('div');
    icon.className = `wfuc-ds-row-icon ${iconClass}`;
    icon.textContent = iconLabel;
    
    const name = document.createElement('div');
    name.className = 'wfuc-ds-row-name';
    name.textContent = el.title;
    name.title = el.title;
    
    const controls = document.createElement('div');
    controls.className = 'wfuc-ds-row-controls';
    
    const select = document.createElement('select');
    select.className = 'wfuc-ds-select';
    const sel = state.elementSelections[el.elementKey];
    if (sel && sel.source) select.classList.add('wfuc-configured');
    
    const currentValue = sel?.source || '';
    
    const options = [
      { value: '', label: 'Select source...' },
      { value: 'excel', label: 'Excel' },
      { value: 'generate', label: 'Generate based on...' },
      { value: 'api', label: 'API' },
      { value: 'no_change', label: 'No change' }
    ];
    
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === currentValue) o.selected = true;
      select.appendChild(o);
    });
    
    select.onchange = () => {
      this.setElementSource(el.elementKey, select.value, slide);
    };
    
    controls.appendChild(select);
    
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(controls);
    
    return row;
  },
  
  buildReferenceRow(el, slide) {
    const wrap = document.createElement('div');
    wrap.className = 'wfuc-ds-ref-wrap';
    wrap.dataset.refFor = el.elementKey;
    
    const label = document.createElement('div');
    label.className = 'wfuc-ds-ref-label';
    label.innerHTML = '\u2514 Based on:';
    
    const select = document.createElement('select');
    select.className = 'wfuc-ds-ref-select';
    
    const sel = state.elementSelections[el.elementKey];
    const currentRef = sel?.reference || '';
    
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select element...';
    select.appendChild(defaultOpt);
    
    const sameSlideElements = slide.elements.filter(e => e.elementKey !== el.elementKey);
    
    const charts = sameSlideElements.filter(e => e.type === 'chart');
    const tables = sameSlideElements.filter(e => e.type === 'table');
    const images = sameSlideElements.filter(e => e.type === 'image');
    const texts = sameSlideElements.filter(e => e.type === 'text');
    
    if (charts.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Charts';
      charts.forEach(c => {
        const o = document.createElement('option');
        o.value = c.elementKey;
        o.textContent = `\u{1f4ca} ${c.title}`;
        if (c.elementKey === currentRef) o.selected = true;
        group.appendChild(o);
      });
      select.appendChild(group);
    }
    
    if (tables.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Tables';
      tables.forEach(t => {
        const o = document.createElement('option');
        o.value = t.elementKey;
        o.textContent = `\u{1f4cb} ${t.title}`;
        if (t.elementKey === currentRef) o.selected = true;
        group.appendChild(o);
      });
      select.appendChild(group);
    }

    if (images.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Images';
      images.forEach(img => {
        const o = document.createElement('option');
        o.value = img.elementKey;
        o.textContent = `\u{1f5bc} ${img.title}`;
        if (img.elementKey === currentRef) o.selected = true;
        group.appendChild(o);
      });
      select.appendChild(group);
    }
    
    if (texts.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Texts';
      texts.forEach(t => {
        const o = document.createElement('option');
        o.value = t.elementKey;
        const displayText = t.title.length > 40 ? t.title.substring(0, 40) + '...' : t.title;
        o.textContent = `T "${displayText}"`;
        if (t.elementKey === currentRef) o.selected = true;
        group.appendChild(o);
      });
      select.appendChild(group);
    }
    
    select.onchange = () => {
      if (!state.elementSelections[el.elementKey]) {
        state.elementSelections[el.elementKey] = { source: 'generate' };
      }
      state.elementSelections[el.elementKey].reference = select.value || null;
      this.onSelectionChanged();
    };
    
    wrap.appendChild(label);
    wrap.appendChild(select);
    return wrap;
  },
  
  setElementSource(elementKey, sourceValue, slide) {
    if (!sourceValue) {
      delete state.elementSelections[elementKey];
    } else {
      state.elementSelections[elementKey] = { 
        source: sourceValue,
        reference: sourceValue === 'generate' ? (state.elementSelections[elementKey]?.reference || null) : null
      };
    }
    
    this.renderElementSections(slide || state.slideData[state.activeSlideNum]);
    this.onSelectionChanged();
  },
  
  onSelectionChanged() {
    this.renderSlideTabs();
    this.updateProgress();
    this.updateConfirmButton();
  },
  
  quickApply(sourceType) {
    const slide = state.slideData[state.activeSlideNum];
    if (!slide) return;
    
    slide.elements.forEach(el => {
      state.elementSelections[el.elementKey] = { source: sourceType, reference: null };
    });
    
    this.renderElementSections(slide);
    this.onSelectionChanged();
  },
  
  updateProgress() {
    const total = this.getTotalElementCount();
    const configured = this.getConfiguredCount();
    const pct = total > 0 ? Math.round((configured / total) * 100) : 0;
    
    const fill = document.getElementById('wfuc-ds-progress-fill');
    if (fill) {
      fill.style.width = pct + '%';
      if (pct === 100) {
        fill.classList.add('wfuc-complete');
      } else {
        fill.classList.remove('wfuc-complete');
      }
    }
    
    const text = document.getElementById('wfuc-ds-progress-text');
    if (text) {
      text.textContent = `${configured} of ${total} configured`;
    }
  },
  
  updateConfirmButton() {
    const btn = document.getElementById('wfuc-ds-confirm');
    if (!btn) return;
    
    const total = this.getTotalElementCount();
    const configured = this.getConfiguredCount();
    btn.disabled = total === 0 || configured < total;
    
    if (configured === total && total > 0 && btn.disabled === false) {
      btn.style.animation = 'wfuc-pulse 0.5s ease-out';
      setTimeout(() => { btn.style.animation = ''; }, 500);
    }
  },
  
  async submit() {
    const btn = document.getElementById('wfuc-ds-confirm');
    if (!btn) return;
    
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="wfuc-spinner"></span> Saving configuration...';
    
    const dataSources = [];
    for (const num of state.slideOrder) {
      const slide = state.slideData[num];
      if (!slide) continue;
      slide.elements.forEach(el => {
        const sel = state.elementSelections[el.elementKey] || {};
        const entry = {
          slide_number: el.slideNumber,
          title: el.title,
          type: el.type,
          source_type: sel.source || 'no_change',
          element_key: el.elementKey
        };
        if (el.urlImage) entry.url_image = el.urlImage;
        if (el.assetKey) entry.asset_key = el.assetKey;
        if (sel.source === 'generate' && sel.reference) {
          entry.generate_reference = sel.reference;
        }
        dataSources.push(entry);
      });
    }
    
    const payload = {
      user_id: state.userId,
      template_id: state.pendingTemplateId,
      data_sources: dataSources
    };
    
    try {
      console.log('[DS Config] Submitting configuration:', JSON.stringify(payload, null, 2));
      const response = await API.submitDataSourceConfig(payload);
      console.log('[DS Config] Configuration saved successfully:', response);
      Toast.success('Configuration saved', 'Your data source preferences have been successfully saved');
      Modal.closeAdd();
      
      setTimeout(() => {
        API.fetchUseCases();
      }, 1000);
      
    } catch (error) {
      console.error('[DS Config] Failed to save configuration:', error);
      Toast.error('Save failed', error.message || 'Could not save data source configuration. Please try again');
      
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
};

// Backward compatibility wrappers for DataSourceConfig
async function openDataSourceConfig(userId, templateId) {
  return DataSourceConfig.open(userId, templateId);
}

function navigateItem(dir) {
  const slideOrder = state.slideOrder;
  const currentIdx = slideOrder.indexOf(state.activeSlideNum);
  const newIdx = currentIdx + dir;
  if (newIdx >= 0 && newIdx < slideOrder.length) {
    state.activeSlideNum = slideOrder[newIdx];
    DataSourceConfig.renderSlideTabs();
    DataSourceConfig.renderActiveSlide();
  }
}

function applyToAll(type) {
  DataSourceConfig.quickApply(type);
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
  const step3 = document.getElementById('wfuc-step-3');
  if (!modal || !modal.classList.contains('wfuc-open') || 
      !step3 || !step3.classList.contains('wfuc-active-step')) {
    return;
  }
  
  // Don't interfere with input fields
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
    return;
  }
  
  switch(e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      navigateItem(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      navigateItem(1);
      break;
    case 'Enter': {
      const confirmBtn = document.getElementById('wfuc-ds-confirm');
      if (confirmBtn && !confirmBtn.disabled) {
        e.preventDefault();
        DataSourceConfig.submit();
      }
      break;
    }
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
