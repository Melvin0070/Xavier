const CONFIG = {
    API_ENDPOINT: 'https://rjttx5p195.execute-api.eu-central-1.amazonaws.com/default/multiStep_form_Orchestrator',
    FINAL_SUBMISSION_ENDPOINT: 'https://gdi9c82r4j.execute-api.eu-west-1.amazonaws.com/moderate-test',
    POLLING_ENDPOINT: 'https://gdi9c82r4j.execute-api.eu-west-1.amazonaws.com/getitemstatus',
    DEFAULT_PROCESS: 'strategic plan',
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    UPLOAD_TIMEOUT: 30000,
    POLL_INTERVAL: 5000,
    MAX_POLL_ATTEMPTS: 100,
    LOTTIE_ANIMATION_URL: 'https://cdn.prod.website-files.com/63f0b2aeb50e55c7b0e56df1/6470a2088f24096486eac123_Comp%201.json'
};


class APIError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.name = 'APIError';
        this.statusCode = statusCode;
    }
}

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}


class MultiStepFormV4 {
    constructor() {
        console.log('[MultiStepFormV4] Initializing...');
        
    this.userId = this.generateUserId();
    this.sessionId = null; 
    this.process = CONFIG.DEFAULT_PROCESS;
        
        this.sector = null;
        this.company = null;
    this.formId = null; 
        
        this.currentStep = null; // Backend will set this
        this.isLoading = false;
        this.currentQuestionData = null;
        this.selectedFile = null;
        this.uploadProgress = 0;
        this.isSubmitting = false;
    this.allAnswers = []; // Store all answers for final submission fallback
    this.finalHistory = []; // Persisted history fetched from backend
        this.pollingIntervalId = null;
        this.pollAttempts = 0;
        this.lastJobId = null;
        
        // DOM elements
    this.elements = {};
    this.lottieInstance = null;
    this.loadingMode = 'default';
    this.defaultLoadingMessage = 'Preparing the next step...';
    this.submissionLoadingMessage = 'Generating your presentation...';
    this.isFinalizing = false;
        
        console.log('[MultiStepFormV4] User ID:', this.userId);
    console.log('[MultiStepFormV4] Process:', this.process);
        
        // Initialize
        this.initializeElements();
        this.defaultLoadingMessage = this.elements.loadingMessage?.textContent?.trim() || this.defaultLoadingMessage;
        this.initializeLottieAnimation();
        this.attachEventListeners();
        this.showInitialQuestion();
        
        console.log('[MultiStepFormV4] Initialization complete');
    }

    /**
     * Generate unique user ID
     */
     generateUserId() {
        try {
            const memberData = JSON.parse(localStorage.getItem("_ms-mem"));
            if (memberData && memberData.id) {
                return memberData.id;
            }
        } catch (error) {
            console.error("Error retrieving user_id from localStorage:", error);
        }
        return null;
    }
    /**
     * Generate unique session ID
     */
    generateSessionId(){
        try {
            if (window?.crypto?.randomUUID) {
                return `session-${window.crypto.randomUUID()}`;
            }

            if (window?.crypto?.getRandomValues) {
                const buffer = new Uint32Array(4);
                window.crypto.getRandomValues(buffer);
                const token = Array.from(buffer)
                    .map(num => num.toString(16).padStart(8, '0'))
                    .join('');
                return `session-${token}`;
            }
        } catch (error) {
            console.error("Error generating session_id:", error);
        }

        const timestamp = Date.now().toString(36);
        const randomPart = Math.random().toString(36).slice(2, 11);
        return `session-${timestamp}-${randomPart}`;
    }

    /**
     * Initialize DOM element references
     */
    initializeElements() {
        this.elements = {
            // Initial question elements
            initialQuestion: document.getElementById('msf-v4-initialQuestion'),
            sectorInput: document.getElementById('msf-v4-sectorInput'),
            companyInput: document.getElementById('msf-v4-companyInput'),
            initialSubmitBtn: document.getElementById('msf-v4-initialSubmitBtn'),
            initialRedirectBtn: document.getElementById('msf-v4-initialRedirectBtn'),
            
            // Main form elements
            mainForm: document.getElementById('msf-v4-mainForm'),
            stepNumber: document.getElementById('msf-v4-stepNumber'),
            totalSteps: document.getElementById('msf-v4-totalSteps'),
            questionText: document.getElementById('msf-v4-questionText'),
            questionContent: document.getElementById('msf-v4-questionContent'),
            submitBtn: document.getElementById('msf-v4-submitBtn'),
            loadingOverlay: document.getElementById('msf-v4-loadingOverlay'),
            loadingMessage: document.getElementById('msf-v4-loadingMessage'),
            lottieContainer: document.getElementById('msf-v4-lottieContainer'),
            defaultLoader: document.getElementById('msf-v4-defaultLoader'),
            successMessage: document.getElementById('msf-v4-successMessage'),
            formNavigation: document.querySelector('.msf-v4-form-navigation')
        };

        // Validate required elements
        const optionalElements = new Set(['submitBtn', 'initialRedirectBtn']);
        const missingElements = Object.entries(this.elements)
            .filter(([key, element]) => !element && !optionalElements.has(key))
            .map(([key]) => key);

        if (missingElements.length > 0) {
            console.error('Missing required DOM elements:', missingElements);
            alert('Form initialization failed. Missing elements: ' + missingElements.join(', '));
        }
    }

    /**
     * Initialize Lottie animation for submission loading state
     */
    initializeLottieAnimation() {
        const container = this.elements.lottieContainer;

        if (!container) {
            console.warn('Lottie container not found. Falling back to default loader.');
            return;
        }

        if (typeof lottie === 'undefined') {
            console.warn('Lottie library not available. Default loader will be used.');
            return;
        }

        try {
            this.lottieInstance = lottie.loadAnimation({
                container,
                renderer: 'svg',
                loop: false,
                autoplay: false,
                path: CONFIG.LOTTIE_ANIMATION_URL
            });

            if (typeof this.lottieInstance.setSpeed === 'function') {
                this.lottieInstance.setSpeed(0.25);
            }

            if (this.loadingMode === 'lottie') {
                this.setLoaderMode(true);
            }
        } catch (error) {
            console.error('Failed to initialize Lottie animation:', error);
        }
    }

    /**
     * Toggle loader mode between default and Lottie animation
     */
    setLoaderMode(useLottie) {
    const shouldUseLottie = Boolean(useLottie);
    this.loadingMode = shouldUseLottie ? 'lottie' : 'default';

        if (this.lottieInstance) {
            if (shouldUseLottie) {
                this.lottieInstance.goToAndPlay(0, true);
            } else {
                this.lottieInstance.stop();
            }
        }

        const overlay = this.elements.loadingOverlay;
        if (!overlay) {
            return;
        }

        const canUseLottie = shouldUseLottie && Boolean(this.lottieInstance);
        overlay.classList.toggle('msf-v4-show-lottie', canUseLottie);

        if (this.elements.lottieContainer) {
            this.elements.lottieContainer.setAttribute('aria-hidden', canUseLottie ? 'false' : 'true');
        }

        if (this.elements.defaultLoader) {
            this.elements.defaultLoader.setAttribute('aria-hidden', canUseLottie ? 'true' : 'false');
        }
    }

    /**
     * Attach event listeners
     */
    attachEventListeners() {
        // Initial submit button
        if (this.elements.initialSubmitBtn) {
            this.elements.initialSubmitBtn.addEventListener('click', () => this.handleInitialQuestionSubmit());
        }

        if (this.elements.initialRedirectBtn) {
            this.elements.initialRedirectBtn.addEventListener('click', () => {
                window.location.href = '/models/ai-strategic-plan';
            });
        }
        
        // Initial question inputs - Enter key listener (optional fallback)
        if (this.elements.sectorInput) {
            this.elements.sectorInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.elements.companyInput.focus();
                }
            });
        }
        
        if (this.elements.companyInput) {
            this.elements.companyInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.handleInitialQuestionSubmit();
                }
            });
        }
        
        // Submit button (only for file uploads)
        if (this.elements.submitBtn) {
            this.elements.submitBtn.addEventListener('click', () => this.handleSubmit());
        }
    }

    /**
     * Show initial question (sector & company)
     */
    showInitialQuestion() {
        console.log('[showInitialQuestion] Showing initial question screen');
        
        // Hide loading overlay
        this.hideLoading();
        
        // Show initial question, hide main form
        if (this.elements.initialQuestion) {
            this.elements.initialQuestion.style.display = 'flex';
            console.log('[showInitialQuestion] Initial question display set to flex');
        } else {
            console.error('[showInitialQuestion] Initial question element not found!');
        }
        
        if (this.elements.mainForm) {
            this.elements.mainForm.style.display = 'none';
        }
        
        // Focus on sector input
        setTimeout(() => {
            if (this.elements.sectorInput) {
                this.elements.sectorInput.focus();
                console.log('[showInitialQuestion] Sector input focused');
            } else {
                console.error('[showInitialQuestion] Sector input not found!');
            }
        }, 100);
    }

    /**
     * Handle initial question submission
     */
    async handleInitialQuestionSubmit() {
        const sector = this.elements.sectorInput.value.trim();
        const company = this.elements.companyInput.value.trim();

        if (!sector) {
            this.showError('Please enter a sector.');
            return;
        }

        // Store values
        this.sector = sector;
        this.company = company || null;
        
        // Generate session ID now
        this.sessionId = this.generateSessionId();

        // Hide initial question and show main form
        this.elements.initialQuestion.style.display = 'none';
        this.elements.mainForm.style.display = 'flex';

        // Start the actual form
        await this.startForm();
    }

    /**
     * Start the form by loading the first question
     */
    async startForm() {
        try {
            await this.makeAPICall();
        } catch (error) {
            console.error('Failed to start form:', error);
            this.showError('Failed to load the form. Please refresh the page.');
        }
    }

    /**
     * Make API call to backend - simplified for forward-only flow
     */
    async makeAPICall(answer = null) {
        const usingFinalizingLoader = this.isFinalizing;

        if (usingFinalizingLoader) {
            if (!this.isLoading) {
                this.showLoading(this.submissionLoadingMessage, { useLottie: true });
            }
        } else {
            this.showLoading();
        }
        
        try {
            const requestData = {
                userId: this.userId,
                sessionId: this.sessionId,
                process: this.process,
                sector: this.sector,
                company: this.company
            };

            // Add answer if provided
            if (answer) {
                requestData.answer = answer;
                const recordedStep = this.currentStep ?? (this.allAnswers.length + 1);
                // Store summarized answer for potential fallback usage
                this.allAnswers.push({
                    step: recordedStep,
                    question: answer.question,
                    answer: answer.payload
                });
            }

            console.log('Making API call:', requestData);

            // Create abort controller for timeout
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

            const response = await fetch(CONFIG.API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestData),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                // Try to get error message from response
                let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                try {
                    const errorData = await response.json();
                    if (errorData.error) {
                        errorMessage = errorData.error;
                    }
                } catch (e) {
                    // Use default error message
                }
                throw new APIError(errorMessage, response.status);
            }

            const data = await response.json();
            console.log('API response:', data);

            return await this.handleAPIResponse(data);

        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Request timeout. Please try again.');
            }
            console.error('API call failed:', error);
            this.handleAPIError(error);
            throw error;
        } finally {
            if (!this.isFinalizing) {
                this.hideLoading();
            }
        }
    }

    /**
     * Handle API response from backend
     */
    async handleAPIResponse(response) {
        // Handle completion
        if (response.isComplete || response.message === 'Form completed successfully') {
            this.handleFormCompletion(response.history || []);
            return;
        }

        // Update current state from backend
        this.isFinalizing = false;
        this.currentStep = response.currentStep;
        this.currentQuestionData = response;

        // Render the question
        this.renderQuestion(response);

        // Update UI
        this.updateStepInfo(response);
        this.updateSubmitButton(response);

        return response;
    }

    /**
     * Handle form completion
     */
    async handleFormCompletion(history = []) {
        // Ensure submission loader is active while final submission is in-flight
            if (!this.isLoading) {
                this.showLoading(this.submissionLoadingMessage, { useLottie: true });
            } else {
                if (this.elements.loadingMessage) {
                    this.elements.loadingMessage.textContent = this.submissionLoadingMessage;
                }
                this.setLoaderMode(true);
            }
        this.finalHistory = Array.isArray(history) ? history : [];

        try {       
            const finalJobData = this.buildFinalJobData();

            console.log('Submitting final job data:', finalJobData);

            const result = await this.submitFinalJob(finalJobData);
            console.log('Final submission result:', result);

            const jobId = result?.item_name || result?.jobId || result?.id;
            const userId = finalJobData.user_id || this.userId;

            if (jobId && userId) {
                this.showSuccessToast('Submission received. Preparing your presentation...');
                this.startPollingJob(userId, jobId);
                return;
            }

            this.hideLoading();

            if (this.elements.formNavigation) {
                this.elements.formNavigation.style.display = 'none';
            }

            if (this.elements.successMessage) {
                this.elements.successMessage.classList.remove('msf-v4-hidden');
            }

            this.showSuccessToast('Form submitted successfully! Thank you.');

        } catch (error) {
            console.error('Final submission error:', error);
            this.hideLoading();
            this.isFinalizing = false;
            this.showError(error?.message || 'Failed to submit form. Please try again.');
        }
    }

    /**
     * Build final job data payload combining base fields only
     */
    buildFinalJobData() {
        const history = (this.finalHistory && this.finalHistory.length) ? this.finalHistory : this.allAnswers;
        const sanitizedHistory = history.map((entry, index) => ({
            step: entry?.step ?? index + 1,
            question: entry?.question ?? '',
            answer: entry?.answer ?? {}
        }));

        const sectorDescriptor = this.sector && this.sector.trim() ? this.sector.trim() : 'an unspecified sector';
        
        // Adjust intro based on whether company is provided
        let intro;
        if (this.company && this.company.trim()) {
            intro = `I want a strategic plan for ${this.company.trim()} in the sector ${sectorDescriptor}. Please take into account the following questions that were asked:`;
        } else {
            intro = `I want a strategic plan for a company in the sector ${sectorDescriptor}. Please take into account the following questions that were asked:`;
        }
        
        const historyJson = JSON.stringify(sanitizedHistory, null, 2);

        return {
            user_id: this.userId,
            process: this.process,
            session_id: this.sessionId,
            user_prompt: `${intro}\n${historyJson}`
        };
    }

    /**
     * Handle submit action (replaces handleNext)
     */
    async handleSubmit() {
        if (this.isLoading || this.isSubmitting) return;

        this.isSubmitting = true;

        try {
            // Validate current answer
            this.validateCurrentAnswer();

            // Collect answer
            const answer = this.collectCurrentAnswer();

            // Handle file upload if needed
            if (answer.payload.fileUpload && this.selectedFile) {
                await this.handleFileUpload();
            }

            const isFinalStep = Boolean(this.currentQuestionData?.isLastStep || this.currentQuestionData?.isFinalStep);

            if (isFinalStep) {
                this.isFinalizing = true;
                this.showLoading(this.submissionLoadingMessage, { useLottie: true });
            }

            // Make API call
            await this.makeAPICall(answer);

        } catch (error) {
            if (error instanceof ValidationError) {
                this.showError(error.message);
            } else {
                console.error('Error in handleSubmit:', error);
                this.showError('Failed to proceed. Please try again.');
            }

            if (this.isFinalizing) {
            this.isFinalizing = false;
            this.hideLoading();
            }
        } finally {
            this.isSubmitting = false;
        }
    }

    /**
     * Render question based on type
     */
    renderQuestion(questionData) {
        if (!this.elements.questionContent) return;

        // Update question text
        if (this.elements.questionText) {
            this.elements.questionText.textContent = questionData.question || '';
        }

        // Clear previous content
        this.elements.questionContent.innerHTML = '';
        this.selectedFile = null;

        // Render based on question type
        switch (questionData.questionType) {
            case 'multiple_choice':
                this.renderMCQQuestion(questionData.config || {});
                break;
            case 'range':
                this.renderRangeQuestion(questionData.config || {});
                break;
            case 'text_input':
                this.renderTextQuestion(questionData.config || {});
                break;
            case 'file_upload':
                this.renderFileUploadQuestion(questionData.config || {});
                break;
            default:
                this.elements.questionContent.innerHTML = '<p class="msf-v4-error">Unknown question type</p>';
        }
    }

    /**
     * Render Multiple Choice Question (auto-submit on selection)
     */
    renderMCQQuestion(config) {
        const container = document.createElement('div');
        container.className = 'msf-v4-mcq-options msf-v4-animated';
        this.renderAnimatedMCQ(container, config);
        this.elements.questionContent.appendChild(container);
    }

    /**
     * Render animated MCQ with auto-submit and dynamic scaling
     */
    renderAnimatedMCQ(container, config) {
        const numOptions = config.options.length;
        const unitHeight = Math.max(300, numOptions * 60); // Scale height based on options
        
        // Create the main structure
        const wrapper = document.createElement('div');
        wrapper.className = 'msf-v4-mcq-wrapper';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.justifyContent = 'center';
        
        // Create the align unit (animated visual indicator)
        const alignUnit = document.createElement('div');
        alignUnit.className = 'msf-v4-align-unit';
        alignUnit.style.height = `${unitHeight}px`;

        // Create the animated icon
        const icon = document.createElement('div');
        icon.className = 'msf-v4-icon';

        // Always use 3 bars for visual consistency
        for (let i = 0; i < 3; i++) {
            const l = document.createElement('div');
            l.className = 'msf-v4-l';
            l.style.setProperty('--delay', `${i * 0.08}s`);
            
            const s = document.createElement('div');
            s.className = 'msf-v4-s';
            // Middle bar is shorter
            s.style.height = i === 1 ? '25px' : '40px';
            
            l.appendChild(s);
            icon.appendChild(l);
        }
        alignUnit.appendChild(icon);

        // Create radio inputs overlaid on the align unit
        const radioHeight = 100 / numOptions;
        config.options.forEach((option, index) => {
            const input = document.createElement('input');
            input.type = 'radio';
            input.className = 'msf-v4-align-radio';
            input.name = 'mcq-option';
            input.value = option.value || option.text;
            input.id = `msf-v4-align-opt${index + 1}`;
            input.setAttribute('value', `option${index + 1}`);
            input.setAttribute('aria-label', option.text);
            
            // Position radio inputs evenly across the height
            input.style.height = `${radioHeight}%`;
            input.style.top = `${index * radioHeight}%`;
            
            alignUnit.appendChild(input);
        });

        // Create labels container
        const labelsContainer = document.createElement('div');
    labelsContainer.className = 'msf-v4-mcq-labels';
    labelsContainer.style.marginLeft = '16px';
        labelsContainer.style.display = 'flex';
        labelsContainer.style.flexDirection = 'column';
        labelsContainer.style.justifyContent = 'space-around';
    labelsContainer.style.height = `${unitHeight - 32}px`;
        labelsContainer.style.fontSize = `${Math.max(14, 18 - numOptions)}px`;

        config.options.forEach((option, index) => {
            const label = document.createElement('label');
            label.htmlFor = `msf-v4-align-opt${index + 1}`;
            label.className = 'msf-v4-mcq-label';
            label.textContent = option.text;
            label.setAttribute('data-value', `option${index + 1}`);
            label.style.cursor = 'pointer';
            label.style.padding = '6px 10px';
            label.style.borderRadius = '6px';
            label.style.transition = 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
            labelsContainer.appendChild(label);
        });

        wrapper.appendChild(alignUnit);
        wrapper.appendChild(labelsContainer);
        container.appendChild(wrapper);

        // Initialize GSAP animations with auto-submit and dynamic states
        this.initializeAnimatedMCQ(icon, alignUnit, numOptions);
    }

    /**
     * Initialize animated MCQ interactions with auto-submit and dynamic states
     */
    initializeAnimatedMCQ(icon, alignUnit, numOptions) {
        const radios = alignUnit.querySelectorAll('.msf-v4-align-radio');
        const labels = alignUnit.parentElement.querySelectorAll('.msf-v4-mcq-label');
        
        // Generate dynamic alignment states based on number of options
        const generateAlignmentStates = () => {
            const states = {};
            
            for (let i = 0; i < numOptions; i++) {
                if (i === 0) {
                    // Top alignment
                    states[`option${i + 1}`] = { i1: 0, i2: numOptions - 1 };
                } else if (i === numOptions - 1) {
                    // Bottom alignment
                    states[`option${i + 1}`] = { i1: numOptions - 1, i2: 0 };
                } else {
                    // Middle alignments - create varied patterns
                    const before = i;
                    const after = numOptions - 1 - i;
                    states[`option${i + 1}`] = { i1: before, i2: after };
                }
            }
            
            return states;
        };
        
        const alignmentStates = generateAlignmentStates();

        const updateState = (selectedValue, animate = false) => {
            const state = alignmentStates[selectedValue];
            if (!state) return;

            // Update label styles
            labels.forEach(label => {
                const isSelected = label.dataset.value === selectedValue;
                label.classList.toggle('msf-v4-selected', isSelected);
                
                // Enhanced styling for selected state
                if (isSelected) {
                    label.style.color = '#1f2937';
                } else {
                    label.style.color = '#6b7280';
                    label.style.fontWeight = '500';
                }
            });

            // Animate the icon if GSAP is available
            if (typeof gsap !== 'undefined') {
                const animationProps = {
                    '--i1': state.i1,
                    '--i2': state.i2,
                    duration: animate ? 0.2 : 0,
                    ease: 'power3.inOut'
                };
                gsap.to(icon, animationProps);
            }
        };

        const selectOptionAndProceed = (value) => {
            if (this.isSubmitting) return;

            // Find and check the corresponding radio button
            const targetRadio = alignUnit.querySelector(`input[value="${value}"]`);
            if (targetRadio) {
                targetRadio.checked = true;
                updateState(value, true);
                
                // Add processing state to selected label
                const selectedLabel = alignUnit.parentElement.querySelector(`[data-value="${value}"]`);
                if (selectedLabel) {
                    selectedLabel.classList.add('msf-v4-processing');
                }
                
                // Auto-proceed to next question after a short delay
                setTimeout(() => {
                    if (!this.isSubmitting) {
                        this.handleSubmit();
                    }
                }, 600);
            }
        };

        // Add event listeners for radios
        radios.forEach(radio => {
            radio.addEventListener('click', (e) => {
                e.preventDefault();
                selectOptionAndProceed(e.target.value);
            });
            
            radio.addEventListener('mouseenter', (e) => updateState(e.target.value, true));
            radio.addEventListener('mouseleave', () => {
                const checkedRadio = alignUnit.querySelector('.msf-v4-align-radio:checked');
                if (checkedRadio) {
                    updateState(checkedRadio.value, true);
                } else {
                    labels.forEach(label => label.classList.remove('msf-v4-selected'));
                }
            });
        });

        // Add hover and click events to labels for better UX
        labels.forEach(label => {
            label.addEventListener('mouseenter', () => updateState(label.dataset.value, true));
            label.addEventListener('mouseleave', () => {
                const checkedRadio = alignUnit.querySelector('.msf-v4-align-radio:checked');
                if (checkedRadio) {
                    updateState(checkedRadio.value, true);
                } else {
                    labels.forEach(l => l.classList.remove('msf-v4-selected'));
                }
            });
            
            // Make labels clickable and auto-proceed
            label.addEventListener('click', (e) => {
                e.preventDefault();
                selectOptionAndProceed(label.dataset.value);
            });
        });
    }

    /**
     * Render Range Question (auto-submit on selection)
     */
    renderRangeQuestion(config) {
        const container = document.createElement('div');
        container.className = 'msf-v4-range-slider-container';

        // Create the range slider
        const slider = document.createElement('div');
        slider.className = 'msf-v4-range-slider';
        slider.id = 'msf-v4-range-slider';

        // Create tracks
        const track = document.createElement('div');
        track.className = 'msf-v4-slider-track';
        
        const activeTrack = document.createElement('div');
        activeTrack.className = 'msf-v4-slider-track-active';

        // Create the sliding tick mark
        const tick = document.createElement('div');
        tick.className = 'msf-v4-slider-tick';

        slider.appendChild(track);
        slider.appendChild(activeTrack);
        slider.appendChild(tick);

        // Create range options
        config.options.forEach((option, index) => {
            const optionDiv = document.createElement('div');
            optionDiv.className = 'msf-v4-slider-option';

            const input = document.createElement('input');
            input.type = 'radio';
            input.id = `msf-v4-range-opt${index + 1}`;
            input.name = 'range-selection';
            input.value = option.id || option.value || (index + 1);
            input.setAttribute('aria-label', option.text);

            const label = document.createElement('label');
            label.htmlFor = `msf-v4-range-opt${index + 1}`;
            label.textContent = option.text;

            optionDiv.appendChild(input);
            optionDiv.appendChild(label);
            slider.appendChild(optionDiv);
        });

        container.appendChild(slider);
        this.elements.questionContent.appendChild(container);

        // Initialize range slider with auto-submit
        this.initializeRangeSlider(slider);
    }

    /**
     * Initialize range slider interactions
     */
    initializeRangeSlider(slider) {
        const track = slider.querySelector('.msf-v4-slider-track');
        const activeTrack = slider.querySelector('.msf-v4-slider-track-active');
        const tick = slider.querySelector('.msf-v4-slider-tick');
        const options = slider.querySelectorAll('.msf-v4-slider-option');

        if (options.length <= 1) return; // No need for a track if there's only one option

        let trackStart = 0;

        // Function to set up and update all track dimensions
        const setupAndResize = () => {
            // Calculate the start position (center of the first option)
            const firstOption = options[0];
            trackStart = firstOption.offsetLeft + firstOption.offsetWidth / 2;

            // Calculate the end position (center of the last option)
            const lastOption = options[options.length - 1];
            const trackEnd = lastOption.offsetLeft + lastOption.offsetWidth / 2;

            // Set the main track's position and width
            track.style.left = `${trackStart}px`;
            track.style.width = `${trackEnd - trackStart}px`;

            // Set the active track's starting position
            activeTrack.style.left = `${trackStart}px`;

            // Update the active track's width based on the current selection
            const currentlyChecked = slider.querySelector('input[type="radio"]:checked');
            if (currentlyChecked) {
                updateSliderState(currentlyChecked, false); // Update without animation
            }
        };

        // Function to update the slider state (track width and tick position)
        const updateSliderState = (selectedRadio, animate = true) => {
            const selectedOption = selectedRadio.parentElement;
            if (!selectedOption) return;

            const targetPosition = selectedOption.offsetLeft + selectedOption.offsetWidth / 2;
            const targetWidth = targetPosition - trackStart;

            const animationOptions = {
                duration: animate ? 0.4 : 0,
                ease: "power3.inOut"
            };

            // Animate the active track width and tick position using GSAP
            if (typeof gsap !== 'undefined') {
                gsap.to(activeTrack, { width: targetWidth, ...animationOptions });
                gsap.to(tick, { x: targetPosition, ...animationOptions });
            } else {
                // Fallback without GSAP
                activeTrack.style.width = `${targetWidth}px`;
                tick.style.transform = `translateX(${targetPosition - tick.offsetWidth / 2}px)`;
            }
        };

        // Function to handle selection and auto-submit
        const selectOptionAndProceed = (selectedRadio) => {
            if (this.isSubmitting) return;

            selectedRadio.checked = true;
            updateSliderState(selectedRadio, true);

            // Auto-proceed to next question after a short delay
            setTimeout(() => {
                if (!this.isSubmitting) {
                    this.handleSubmit();
                }
            }, 800);
        };

        // Function to handle all user interactions
        const handleSliderInteractions = () => {
            // Add a class to the slider when the mouse is over it
            slider.addEventListener('mouseenter', () => {
                slider.classList.add('msf-v4-is-interacting');
            });

            // Handle when the mouse leaves the entire slider component
            slider.addEventListener('mouseleave', () => {
                // Remove the interaction class
                slider.classList.remove('msf-v4-is-interacting');
                // Reset the track to the actually checked radio button's position
                const currentlyChecked = slider.querySelector('input[type="radio"]:checked');
                if (currentlyChecked) {
                    updateSliderState(currentlyChecked, true);
                }
            });

            // Handle hover events on each option for track animation
            options.forEach(option => {
                option.addEventListener('mouseenter', () => {
                    // On hover, update the track to this option's position
                    const radio = option.querySelector('input[type="radio"]');
                    updateSliderState(radio, true);
                });

                // Handle click events for selection
                option.addEventListener('click', () => {
                    const radio = option.querySelector('input[type="radio"]');
                    selectOptionAndProceed(radio);
                });
            });
        };

        // Initial Setup
        setTimeout(() => {
            setupAndResize();
            handleSliderInteractions();

            // Recalculate on window resize to maintain responsiveness
            window.addEventListener('resize', setupAndResize);
        }, 100);
    }

    /**
     * Render Text Input Question (submit on Enter)
     */
    renderTextQuestion(config) {
        const container = document.createElement('div');
        container.className = 'msf-v4-text-input-container';

        let input;
        if (config.multiline) {
            input = document.createElement('textarea');
            input.className = 'msf-v4-text-area';
            input.rows = config.rows || 4;
        } else {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'msf-v4-text-input';
        }

        input.placeholder = config.placeholder || 'Enter your answer and press Enter to continue...';
        input.required = config.required !== false;

        // Add direct enter key listener to the input
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !this.isLoading && !this.isSubmitting) {
                // For textarea, only submit on Ctrl+Enter to allow line breaks
                if (input.tagName === 'TEXTAREA' && !e.ctrlKey) {
                    // Allow normal line break behavior for newlines
                    return;
                }
                
                e.preventDefault();
                this.handleSubmit();
            }
        });

        // Add hint for Enter key
        const hint = document.createElement('div');
        hint.className = 'msf-v4-input-hint';
        hint.textContent = config.multiline ? 'Press Ctrl+Enter to continue' : 'Press Enter to continue';

        container.appendChild(input);
        container.appendChild(hint);
        this.elements.questionContent.appendChild(container);

        // Focus the input
        setTimeout(() => input.focus(), 100);
    }

    /**
     * Render File Upload Question (submit button appears after upload)
     */
    renderFileUploadQuestion(config) {
        const container = document.createElement('div');
        container.className = 'msf-v4-file-upload-container';

        // Create drop zone
        const dropZone = document.createElement('div');
        dropZone.className = 'msf-v4-file-drop-zone';
        const accepted = (config.acceptedFileTypes || config.acceptedTypes || []).join(', ');
        dropZone.innerHTML = `
            <div class="msf-v4-orb"></div>
            <div class="msf-v4-upload-inner">
                <div class="msf-v4-file-upload-icon" aria-hidden="true">
                    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <defs>
                            <linearGradient id="msf-v4-grad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                                <stop stop-color="#8b5cf6"/>
                                <stop offset="0.5" stop-color="#3b82f6"/>
                                <stop offset="1" stop-color="#10b981"/>
                            </linearGradient>
                        </defs>
                        <rect x="8" y="8" width="48" height="48" rx="12" stroke="url(#msf-v4-grad)" stroke-width="2"/>
                        <path d="M32 42V22M32 22l-8 8M32 22l8 8" stroke="url(#msf-v4-grad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <div class="msf-v4-file-upload-text">Drag & drop to upload</div>
                <div class="msf-v4-upload-subtitle">or <span class="msf-v4-accent">click</span> to choose</div>
                <div class="msf-v4-file-upload-hint">Maximum file size: ${config.maxSize || '10MB'}${accepted ? ' • ' + accepted : ''}</div>
            </div>
        `;

        // Hidden file input
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.className = 'msf-v4-file-input';
        fileInput.style.display = 'none';

        if (config.acceptedFileTypes) {
            fileInput.accept = config.acceptedFileTypes.join(',');
        }

        // File preview area
        const filePreview = document.createElement('div');
        filePreview.className = 'msf-v4-file-preview';

        // Upload progress
        const progressContainer = document.createElement('div');
        progressContainer.className = 'msf-v4-upload-progress';
        progressContainer.innerHTML = '<div class="msf-v4-upload-progress-bar"></div>';

        // Event listeners
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', this.handleDragOver.bind(this));
        dropZone.addEventListener('dragleave', this.handleDragLeave.bind(this));
        dropZone.addEventListener('drop', this.handleFileDrop.bind(this));
        fileInput.addEventListener('change', this.handleFileSelect.bind(this));

        // Store config for validation
        container.dataset.uploadConfig = JSON.stringify(config);

        container.appendChild(dropZone);
        container.appendChild(fileInput);
        container.appendChild(filePreview);
        container.appendChild(progressContainer);
        this.elements.questionContent.appendChild(container);
    }

    /**
     * Handle file drag over
     */
    handleDragOver(e) {
        e.preventDefault();
        e.currentTarget.classList.add('msf-v4-drag-over');
    }

    /**
     * Handle file drag leave
     */
    handleDragLeave(e) {
        e.preventDefault();
        e.currentTarget.classList.remove('msf-v4-drag-over');
    }

    /**
     * Handle file drop
     */
    handleFileDrop(e) {
        e.preventDefault();
        e.currentTarget.classList.remove('msf-v4-drag-over');
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            this.handleFileSelection(files[0]);
        }
    }

    /**
     * Handle file select from input
     */
    handleFileSelect(e) {
        const files = e.target.files;
        if (files.length > 0) {
            this.handleFileSelection(files[0]);
        }
    }

    /**
     * Handle file selection and validation
     */
    handleFileSelection(file) {
        const container = document.querySelector('.msf-v4-file-upload-container');
        const config = JSON.parse(container.dataset.uploadConfig || '{}');

        try {
            // Validate file
            this.validateFile(file, config);

            // Store file
            this.selectedFile = file;

            // Show preview
            this.showFilePreview(file);

            // Show submit button
            this.showSubmitButton();

            // Show success toast
            this.showToast(`File selected: ${file.name}`, 'success');

        } catch (error) {
            if (error instanceof ValidationError) {
                this.showError(error.message);
            } else {
                this.showError('Failed to select file. Please try again.');
            }
        }
    }

    /**
     * Show submit button for file uploads
     */
    showSubmitButton() {
        if (this.elements.submitBtn) {
            this.elements.submitBtn.style.display = 'block';
            this.elements.submitBtn.disabled = false;
        }
    }

    /**
     * Hide submit button
     */
    hideSubmitButton() {
        if (this.elements.submitBtn) {
            this.elements.submitBtn.style.display = 'none';
        }
    }

    /**
     * Validate selected file
     */
    validateFile(file, config) {
        // Check file size
        const maxSize = this.parseFileSize(config.maxFileSize || '10MB');
        if (file.size > maxSize) {
            throw new ValidationError(`File size exceeds maximum limit of ${config.maxSize || '10MB'}`);
        }

        // Check file type
        if (config.acceptedTypes && config.acceptedTypes.length > 0) {
            const fileExt = '.' + file.name.split('.').pop().toLowerCase();
            const isValidType = config.acceptedTypes.some(type => 
                type === fileExt || type === file.type
            );
            
            if (!isValidType) {
                throw new ValidationError(`File type not allowed. Accepted types: ${config.acceptedTypes.join(', ')}`);
            }
        }
    }

    /**
     * Parse file size string to bytes
     */
    parseFileSize(sizeStr) {
        const units = { 'B': 1, 'KB': 1024, 'MB': 1024 * 1024, 'GB': 1024 * 1024 * 1024 };
        const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*([A-Z]{1,2})$/i);
        if (!match) return CONFIG.MAX_FILE_SIZE;
        return parseFloat(match[1]) * (units[match[2].toUpperCase()] || 1);
    }

    /**
     * Show file preview
     */
    showFilePreview(file) {
        const preview = document.querySelector('.msf-v4-file-preview');
        if (!preview) return;

        preview.innerHTML = `
            <div class="msf-v4-file-info">
                <div class="msf-v4-file-details">
                    <span class="msf-v4-file-icon">📄</span>
                    <div>
                        <div class="msf-v4-file-name">${file.name}</div>
                        <div class="msf-v4-file-size">${this.formatFileSize(file.size)}</div>
                    </div>
                </div>
                <button type="button" class="msf-v4-remove-file" aria-label="Remove file">×</button>
            </div>
        `;

        preview.classList.add('msf-v4-visible');

        // Add remove functionality
        preview.querySelector('.msf-v4-remove-file').addEventListener('click', () => {
            this.selectedFile = null;
            preview.classList.remove('msf-v4-visible');
            this.hideSubmitButton();
        });
    }

    /**
     * Format file size for display
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Handle file upload to S3
     */
    async handleFileUpload() {
        if (!this.selectedFile || !this.currentQuestionData?.config?.uploadUrl) {
            throw new Error('No file selected or upload URL not available');
        }

        try {
            this.showProgressBar(0);
            
            const response = await fetch(this.currentQuestionData.config.uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'binary/octet-stream'
                },
                body: this.selectedFile
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('S3 upload error:', response.status, response.statusText, errorText);
                throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
            }

            this.showProgressBar(100);
            console.log('File uploaded successfully:', this.currentQuestionData.config.s3Key);

        } catch (error) {
            console.error('File upload failed:', error);
            throw new Error('File upload failed. Please try again.');
        }
    }

    /**
     * Validate current answer
     */
    validateCurrentAnswer() {
        const content = this.elements.questionContent;
        this.clearErrors();

        if (!this.currentQuestionData) {
            throw new ValidationError('No question data available');
        }

        switch (this.currentQuestionData.questionType) {
            case 'multiple_choice':
                const selectedMcqRadio = content.querySelector('.msf-v4-mcq-options input[type="radio"]:checked');
                if (!selectedMcqRadio) {
                    throw new ValidationError('Please select an option');
                }
                break;

            case 'range':
                const selectedRangeRadio = content.querySelector('.msf-v4-range-slider input[type="radio"]:checked');
                if (!selectedRangeRadio) {
                    throw new ValidationError('Please select a value on the range');
                }
                break;

            case 'text_input':
                const textInput = content.querySelector('.msf-v4-text-input, .msf-v4-text-area');
                if (!textInput || !textInput.value.trim()) {
                    throw new ValidationError('Please enter your answer');
                }
                break;

            case 'file_upload':
                if (!this.selectedFile) {
                    throw new ValidationError('Please select a file');
                }
                break;
        }
    }

    /**
     * Collect current answer in the format expected by backend
     */
    collectCurrentAnswer() {
        const content = this.elements.questionContent;
        const question = this.elements.questionText?.textContent || '';
        
        let payload = {};

        // Collect MCQ answer
        const selectedMcqRadio = content.querySelector('.msf-v4-mcq-options input[type="radio"]:checked');
        if (selectedMcqRadio) {
            payload.mcqInput = selectedMcqRadio.value;
        }

        // Collect Range answer
        const selectedRangeRadio = content.querySelector('.msf-v4-range-slider input[type="radio"]:checked');
        if (selectedRangeRadio) {
            const selectedOption = selectedRangeRadio.parentElement;
            const selectedText = selectedOption.querySelector('label').textContent;
            payload.rangeInput = {
                selectedValue: selectedRangeRadio.value,
                selectedText: selectedText
            };
        }

        // Collect text answer
        const textInput = content.querySelector('.msf-v4-text-input, .msf-v4-text-area');
        if (textInput && textInput.value.trim()) {
            payload.textInput = textInput.value.trim();
        }

        // Collect file upload answer
        if (this.selectedFile) {
            payload.fileUpload = {
                fileName: this.selectedFile.name,
                fileSize: this.selectedFile.size,
                fileType: this.selectedFile.type
            };
        }

        const answer = { question, payload };
        console.log('Collected answer:', answer);
        return answer;
    }

    /**
     * Update submit button based on question type
     */
    updateSubmitButton(response) {
        if (!this.elements.submitBtn) return;

        // Hide submit button by default
        this.hideSubmitButton();

        // Only show for file uploads (after file is selected)
        if (response.questionType === 'file_upload') {
            // Button will be shown after file selection
            this.elements.submitBtn.textContent = response.isLastStep ? 'Submit Form' : 'Continue';
        }
    }

    /**
     * Update step information display
     */
    updateStepInfo(response) {
        if (this.elements.stepNumber) {
            this.elements.stepNumber.textContent = `Step ${response.currentStep}`;
        }

        if (this.elements.totalSteps && response.progress?.total) {
            this.elements.totalSteps.textContent = `of ${response.progress.total}`;
        }
    }

    /**
     * Show loading overlay
     */
    showLoading(message = this.defaultLoadingMessage, options = {}) {
        this.isLoading = true;
        const { useLottie = false } = options || {};

        if (this.elements.loadingMessage && message) {
            this.elements.loadingMessage.textContent = message;
        }

        this.setLoaderMode(useLottie);

        if (this.elements.loadingOverlay) {
            this.elements.loadingOverlay.classList.remove('msf-v4-hidden');
        }
    }

    /**
     * Hide loading overlay
     */
    hideLoading() {
        this.isLoading = false;
        this.isFinalizing = false;
        this.setLoaderMode(false);

        if (this.elements.loadingMessage) {
            this.elements.loadingMessage.textContent = this.defaultLoadingMessage;
        }

        if (this.elements.loadingOverlay) {
            this.elements.loadingOverlay.classList.add('msf-v4-hidden');
        }
    }

    /**
     * Show progress bar for file uploads
     */
    showProgressBar(percentage) {
        const progressBar = document.querySelector('.msf-v4-upload-progress-bar');
        if (progressBar) {
            progressBar.style.width = `${percentage}%`;
        }
    }

    /**
     * Submit final job payload to backend
     */
    async submitFinalJob(jobData) {
        const memberCookie = window?.$memberstackDom?.getMemberCookie?.();
        const formData = new FormData();

        Object.entries(jobData).forEach(([key, value]) => {
            if (value === undefined) {
                return;
            }

            if (value instanceof Blob) {
                formData.append(key, value);
            } else if (Array.isArray(value) || typeof value === 'object') {
                formData.append(key, JSON.stringify(value));
            } else {
                formData.append(key, value);
            }
        });

        const headers = {};
        if (memberCookie) {
            headers['Authorization'] = `Bearer ${memberCookie}`;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.UPLOAD_TIMEOUT);

        try {
            const response = await fetch(CONFIG.FINAL_SUBMISSION_ENDPOINT, {
                method: 'POST',
                headers,
                body: formData,
                signal: controller.signal
            });

            if (!response.ok) {
                const message = `Final submission failed: ${response.status} ${response.statusText}`;
                throw new Error(message);
            }

            return await response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Final submission request timed out.');
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Poll for job status updates
     */
    startPollingJob(userId, jobId) {
        if (!userId || !jobId) {
            throw new Error('Missing identifiers for polling.');
        }

        this.stopPollingJob();
        this.pollAttempts = 0;
        this.lastJobId = jobId;

        this.isFinalizing = true;

        console.log('[Polling] Starting job status checks', { userId, jobId });

        const poll = async () => {
            try {
                if (this.pollAttempts >= CONFIG.MAX_POLL_ATTEMPTS) {
                    throw new Error('Job took too long to finish. Please try again later.');
                }

                this.pollAttempts += 1;
                console.log('[Polling] Attempt', this.pollAttempts);
                const status = await this.fetchJobStatus(userId, jobId);
                console.log('[Polling] Status response', status);

                if (this.isJobComplete(status)) {
                    this.handlePollingSuccess(status);
                    return;
                }

                this.pollingIntervalId = setTimeout(poll, CONFIG.POLL_INTERVAL);
            } catch (error) {
                this.handlePollingFailure(error);
            }
        };

        poll();
    }

    /**
     * Stop polling timer
     */
    stopPollingJob() {
        if (this.pollingIntervalId) {
            clearTimeout(this.pollingIntervalId);
            this.pollingIntervalId = null;
        }
    }

    /**
     * Retrieve job status from backend
     */
    async fetchJobStatus(userId, jobId) {
        const memberCookie = window?.$memberstackDom?.getMemberCookie?.();

        const headers = {
            'Content-Type': 'application/json'
        };

        if (memberCookie) {
            headers['Authorization'] = `Bearer ${memberCookie}`;
        }

        const response = await fetch(CONFIG.POLLING_ENDPOINT, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                user_id: userId,
                item_name: jobId
            })
        });

        if (!response.ok) {
            throw new Error(`Polling failed: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    }

    /**
     * Determine if job has completed successfully
     */
    isJobComplete(status) {
        if (!status) {
            return false;
        }

        const completedStates = ['ITEM_PUBLISHED', 'ITEM_PUBLISHED_POLL'];
        return completedStates.includes(status.item_status) && status.item_link && status.item_link !== 'testeLink';
    }

    /**
     * Handle successful polling completion
     */
    handlePollingSuccess(status) {
        this.stopPollingJob();
        this.hideLoading();

        console.log('[Polling] Job completed', status);

        const documentUrl = status.item_link;
        if (documentUrl) {
            const destinationURL = `${window.location.origin}/models/xavier-ai-editor?id=${encodeURIComponent(documentUrl)}`;
            this.showSuccessToast('Presentation ready! Redirecting...');
            window.location.assign(destinationURL);
        } else {
            this.showSuccessToast('Job completed successfully.');
        }
    }

    /**
     * Handle polling failure or timeout
     */
    handlePollingFailure(error) {
        this.stopPollingJob();
        this.hideLoading();
        console.error('Polling error:', error);
        this.showError(error?.message || 'Unable to complete the job. Please try again.');
    }

    /**
     * Handle API errors
     */
    handleAPIError(error) {
        let message = 'An unexpected error occurred. Please try again.';
        
        if (error instanceof APIError) {
            if (error.statusCode === 404) {
                message = 'Form not found. Please check your configuration.';
            } else if (error.statusCode === 400) {
                message = 'Invalid request. Please refresh the page and try again.';
            } else if (error.statusCode >= 500) {
                message = 'Server error. Please try again in a moment.';
            } else {
                message = error.message;
            }
        } else if (error.name === 'NetworkError' || !navigator.onLine) {
            message = 'Network error. Please check your connection and try again.';
        } else if (error instanceof TypeError && error.message.includes('fetch')) {
            message = 'Connection error. Please check your internet connection.';
        }

        this.showError(message);
    }

    /**
     * Show error message
     */
    showError(message) {
        this.clearErrors();
        
        // Show toast notification
        this.showToast(message, 'error');
        
        // Add error message to form
        const errorDiv = document.createElement('div');
        errorDiv.className = 'msf-v4-error-message msf-v4-visible';
        errorDiv.textContent = message;
        
        if (this.elements.questionContent) {
            this.elements.questionContent.appendChild(errorDiv);
        }
    }

    /**
     * Clear error messages
     */
    clearErrors() {
        const errorMessages = document.querySelectorAll('.msf-v4-error-message');
        errorMessages.forEach(error => error.remove());
        
        const errorElements = document.querySelectorAll('.msf-v4-error');
        errorElements.forEach(element => element.classList.remove('msf-v4-error'));
    }

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        const styles = {
            success: { background: "linear-gradient(to right, #00b09b, #96c93d)" },
            error: { background: "linear-gradient(to right, #ff5f6d, #ffc371)" },
            info: { background: "linear-gradient(to right, #6b7280, #9ca3af)" }
        };

        if (typeof Toastify !== 'undefined') {
            Toastify({
                text: message,
                duration: 3000,
                gravity: "bottom",
                position: "right",
                style: {
                    ...styles[type],
                    borderRadius: "8px",
                    boxShadow: "0 3px 6px rgba(0,0,0,0.16)"
                }
            }).showToast();
        } else {
            // Fallback to console if Toastify not available
            console.log(`${type.toUpperCase()}: ${message}`);
        }
    }

    /**
     * Show success toast
     */
    showSuccessToast(message) {
        this.showToast(message, 'success');
    }
}

// Initialize form when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    try {
        new MultiStepFormV4();
    } catch (error) {
        console.error('Failed to initialize form:', error);
        
        // Show fallback error message
        const errorDiv = document.createElement('div');
        errorDiv.className = 'msf-v4-error-message msf-v4-visible';
        errorDiv.textContent = 'Failed to initialize form. Please refresh the page.';
        errorDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #ff5f6d;
            color: white;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 3px 6px rgba(0,0,0,0.16);
            z-index: 1000;
        `;
        document.body.appendChild(errorDiv);
    }
});
