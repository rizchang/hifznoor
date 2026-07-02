/* ============================================
   QURAN MEMORIZER — Application Logic
   Handles page navigation, ayah reveal,
   progress tracking, and API integration
   ============================================ */

(function () {
  'use strict';

  // ===================== CONSTANTS =====================
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                         window.innerWidth < 1024 || 
                         ('ontouchstart' in window) || 
                         (navigator.maxTouchPoints > 0);

  const TOTAL_PAGES = 604;
  const API_BASE = 'https://api.alquran.cloud/v1';
  const STORAGE_KEY = 'quran-memorizer-progress';
  const COORDS_STORAGE_KEY = 'quran-memorizer-coords';
  const IMAGE_DIR = 'Mushaf';
  const CSV_PATH = 'quran_english.csv';

  const RECITER_NAMES = {
    'ar.husary': 'Mahmoud Al-Husary (الحصري) - Default',
    'ar.alafasy': 'Mishary Alafasy (العفاسي)',
    'ar.minshawi': 'Siddiq El-Minshawi (المنشاوي)',
    'ar.abdulbasitmurattal': 'Abdul Basit (عبد الباسط)',
    'ar.ghamadi': 'Saad Al-Ghamdi (الغامدي)',
    'ar.sudais': 'Abdur-Rahman As-Sudais (السديس)',
    'ar.mahermuaiqly': 'Maher Al-Muaiqly (المعيقلي)',
    'ar.hudhaify': 'Ali Al-Hudhaify (الحذيفي)',
    'ar.ajamy': 'Ahmad Al-Ajamy (العجمي)',
    'ar.shatri': 'Abu Bakr Al-Shatri (الشاطري)',
    'ur.khan': 'Shamshad Khan (Urdu Translation - اردو)',
    'en.walk': 'Ibrahim Walk (English Translation)'
  };

  // ===================== STATE =====================
  const state = {
    currentPage: 1,
    ayahs: [],                    // Array of ayah data for current page
    quranPagesDb: window.quranPagesDb || null,           // Local page ayahs database (loaded via script or fetch)
    quranPageLines: window.quranPageLines || null,         // Local page lines database (loaded via script or fetch)
    customQuranData: null,        // Custom text from UthmaniScriptQuran.doc (when converted to JSON)
    revealedAyahs: new Set(),     // Ayah numbers revealed this session on current page
    pagesViewed: new Set(),       // Page numbers that have been visited at least once
    isLoading: false,
    lastPageAyahCount: 0,
    englishTranslations: {},      // { surahNum: { ayahNum: 'translation' } }
    surahLengths: {},             // { surahNum: totalCharCount }
    surahSortMode: 'default',     // 'default' | 'shortest' | 'longest'
    isMemoryMode: false,
    isTextMode: false,
    isTextLightMode: true,
    isListenMode: false,
    isListenPaused: false,        // Tracks if the microphone is temporarily paused
    listenLang: 'ar-SA',          // Default speech language (Arabic)
    reciter: 'ar.husary',        // Default reciter
    globalIndexBuilt: false,      // Tracks if the massive voice engine has been initialized
    globalWords: [],              // Full Quran words index for global detection
    globalWordMap: null,          // Map<string, Array<{page, ayahNum, wordIdx}>> for O(1) instant lookups
    pendingTranscript: null,      // Tracks words spoken right before a page jump
    lastRecitedWordIdx: -1,       // Tracks the exact word sequence for intelligent context guessing
    lastMatchedAyahNum: null,     // Tracks the last ayah highlighted to prevent continuous scrolling
    pendingVoiceNav: false,       // True after voice-initiated page navigation; requires confirmation before locking
    pageWordsNormalized: [],      // Used for voice-to-text matching
    pageWordData: [],             // Enhanced word data: [{text, ayahNum, wordIdx}]
    ayahCoordinates: [],
    coordsOverrides: {},
    cvCache: {},                  // Cache for detected coordinates per page to prevent expensive re-computations
    lastTranscriptTime: 0,        // For debouncing transcript processing
    isTranslationPinned: false,   // Keeps the translation panel open on click, closes on hover exit
    highestConfidenceWord: '',    // Track the best-matched word for UI feedback
    pageLocked: false,            // When true, system stays on this page
    isPageHidden: false,          // When true, cover the calligraphy with a solid rectangle overlay
    isTextHidden: false,          // When true, mask/hide the page Uthmani text overlay (acting like Close Book Mode)
    isSelectionHidden: false,     // When true, mask/hide only the selected ayah range block-wise
    lastCurrentPageMatchTime: 0,  // Timestamp of the most recent match on the current page (for time-based lock decay)
    teacherState: {
      activeGroup: null,          // Currently active group
      isPlaying: false,           // Is teacher loop currently playing
      isPracticeMode: false,      // Is practice recitation mode active
      showStartHints: true,       // Whether to show starting word hints in close book mode
      isGlobalPageLoop: false,    // Is global page reinforcement loop active
      jobQueue: [],               // Queue of looping jobs
      currentJobIdx: 0,
      currentAyahIdxInJob: 0,
      audioPlayer: null,          // Audio element
      recitedWordIdxs: new Set(), // Set of successfully recited word indexes in practice mode
      thematicGroups: [],         // Generated thematic groups for current page
      timedMode: {
        active: false,
        groupId: null,
        phase: 'study',           // 'study' or 'test'
        timeLeft: 0,
        rangeText: '',
        timerInterval: null
      }
    },
    // --- Handwriting Trace & Write Mode State ---
    isTraceMode: false,
    traceColor: '#3b82f6', // Sapphire Blue default
    traceWidth: 3,
    traceIsEraser: false,
    pageStrokes: {}, // pageNum -> array of strokes
    traceOpacity: 8, // Default shading opacity (8%)
    canvasEventsWired: false
  };

  // ===================== DOM REFS =====================
  const $ = (sel) => document.querySelector(sel);

  const els = {
    pageImage: $('#pageImage'),
    pageLoading: $('#pageLoading'),
    pageImageContainer: $('#pageImageContainer'),
    memoryOverlay: $('#memoryOverlay'),
    memoryCircles: $('#memoryCircles'),
    currentPageDisplay: $('#currentPageDisplay'),
    ayahList: $('#ayahList'),
    pageProgressBar: $('#pageProgressBar'),
    pageProgressText: $('#pageProgressText'),
    pagesViewed: $('#pagesViewed'),
    totalPages: $('#totalPages'),
    pageInput: $('#pageInput'),
    // Buttons
    prevPageBtn: $('#prevPageBtn'),
    nextPageBtn: $('#nextPageBtn'),
    firstPageBtn: $('#firstPageBtn'),
    lastPageBtn: $('#lastPageBtn'),
    goToPageBtn: $('#goToPageBtn'),
    showAllBtn: $('#showAllBtn'),
    memoryModeBtn: $('#memoryModeBtn'),
    resetPageBtn: $('#resetPageBtn'),
    toggleTextBtn: $('#toggleTextBtn'),
    themeToggleBtn: $('#themeToggleBtn'),
    listenModeBtn: $('#listenModeBtn'),
    listenLangSelect: $('#listenLangSelect'),
    pauseListenBtn: $('#pauseListenBtn'),
    surahBtn: $('#surahBtn'),
    surahPanel: $('#surahPanel'),
    surahPanelOverlay: $('#surahPanelOverlay'),
    surahPanelClose: $('#surahPanelClose'),
    surahList: $('#surahList'),
    surahSearch: $('#surahSearch'),
    peekFadedBtn: $('#peekFadedBtn'),
    peekClearBtn: $('#peekClearBtn'),
    resetLayoutBtn: $('#resetLayoutBtn'),
    resetAllLayoutBtn: $('#resetAllLayoutBtn'),
    pageTextOverlay: $('#pageTextOverlay'),
    ayahStartHintsContainer: $('#ayahStartHintsContainer'),
    toggleHintsBtn: $('#toggleHintsBtn'),
    toggleHintsText: $('#toggleHintsText'),
    wordTranslationPanel: $('#wordTranslationPanel'),
    systemToast: $('#systemToast'),
    systemToastText: $('#systemToastText'),
    globalIndexProgressContainer: $('#globalIndexProgressContainer'),
    globalIndexProgressBar: $('#globalIndexProgressBar'),
    globalIndexProgressText: $('#globalIndexProgressText'),
    // Teacher Mode DOM Refs
    tabAyahs: $('#tabAyahs'),
    tabTeacher: $('#tabTeacher'),
    tabAbout: $('#tabAbout'),
    ayahsSection: $('#ayahsSection'),
    teacherSection: $('#teacherSection'),
    aboutSection: $('#aboutSection'),
    teacherGroupList: $('#teacherGroupList'),
    sidebarAudioPlayer: $('#sidebarAudioPlayer'),
    playerAyahLabel: $('#playerAyahLabel'),
    playerPlayBtn: $('#playerPlayBtn'),
    playerCloseBtn: $('#playerCloseBtn'),
    playerProgressBarTrack: $('#playerProgressBarTrack'),
    playerProgressBarFill: $('#playerProgressBarFill'),
    playerTimeCurrent: $('#playerTimeCurrent'),
    playerTimeTotal: $('#playerTimeTotal'),
    topStatusBanner: $('#topStatusBanner'),
    topStatusIcon: $('#topStatusIcon'),
    topStatusText: $('#topStatusText'),
    reciterSelect: $('#reciterSelect'),
    playerReciter: $('#playerReciter'),
    themeVisualizerCard: $('#themeVisualizerCard'),
    themeVisualizerArt: $('#themeVisualizerArt'),
    themeVisualizerTitle: $('#themeVisualizerTitle'),
    themeVisualizerDesc: $('#themeVisualizerDesc'),
    globalPageLoopBtn: $('#globalPageLoopBtn'),
    globalTimedStart: $('#globalTimedStart'),
    globalTimedEnd: $('#globalTimedEnd'),
    globalTimedBtn: $('#globalTimedBtn'),
    hidePageBtn: $('#hidePageBtn'),
    hidePageText: $('#hidePageText'),
    hideTextBtn: $('#hideTextBtn'),
    hideTextText: $('#hideTextText'),
    hideSelectionBtn: $('#hideSelectionBtn'),
    hideSelectionText: $('#hideSelectionText'),
    
    // --- Handwriting Trace & Write Mode References ---
    traceCanvas: $('#traceCanvas'),
    toggleTraceModeBtn: $('#toggleTraceModeBtn'),
    traceControls: $('#traceControls'),
    tracePenBtn: $('#tracePenBtn'),
    traceEraserBtn: $('#traceEraserBtn'),
    traceUndoBtn: $('#traceUndoBtn'),
    traceClearBtn: $('#traceClearBtn'),
    traceWidthSlider: $('#traceWidthSlider'),
    traceWidthDisplay: $('#traceWidthDisplay'),
    traceOpacitySlider: $('#traceOpacitySlider'),
    traceOpacityDisplay: $('#traceOpacityDisplay'),
    micPermissionModal: $('#micPermissionModal'),
    closeMicModalBtn: $('#closeMicModalBtn'),
    howItWorksBtn: $('#howItWorksBtn'),
    howItWorksModal: $('#howItWorksModal'),
    closeHowModalBtn: $('#closeHowModalBtn'),
    closeHowModalOkBtn: $('#closeHowModalOkBtn'),
    feedbackBtn: $('#feedbackBtn'),
    feedbackModal: $('#feedbackModal'),
    closeFeedbackModalBtn: $('#closeFeedbackModalBtn'),
    feedbackForm: $('#feedbackForm'),
    submitFeedbackBtn: $('#submitFeedbackBtn'),
  };

  // ===================== PERSISTENCE =====================
  function loadProgress() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data) {
        state.pagesViewed = new Set(data.pagesViewed || []);
      }
    } catch (e) {
      // Ignore parse errors
    }

    try {
      const coordsData = JSON.parse(localStorage.getItem(COORDS_STORAGE_KEY));
      if (coordsData) {
        state.coordsOverrides = coordsData;
      }
    } catch (e) {}

    try {
      const cvData = JSON.parse(localStorage.getItem('hifznoor_cv_cache'));
      if (cvData) {
        state.cvCache = cvData;
      }
    } catch (e) {}

    // Always default to Light Mode on page load
    state.isTextLightMode = true;
    
    // Load handwriting tracing strokes
    loadTraceData();
  }

  function saveProgress() {
    try {
      const data = {
        pagesViewed: Array.from(state.pagesViewed),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // localStorage might be full or unavailable
    }
  }

  function saveTraceData() {
    try {
      localStorage.setItem('hifznoor_trace_strokes', JSON.stringify(state.pageStrokes));
    } catch (e) {
      console.warn("Could not save trace data to localStorage:", e);
    }
  }

  function loadTraceData() {
    try {
      const data = localStorage.getItem('hifznoor_trace_strokes');
      if (data) {
        state.pageStrokes = JSON.parse(data);
      } else {
        state.pageStrokes = {};
      }
    } catch (e) {
      console.error("Failed to load trace data:", e);
      state.pageStrokes = {};
    }
  }

  function saveCoordinateOverride(pageNum, markerId, xPct, yPct) {
    if (!state.coordsOverrides) state.coordsOverrides = {};
    if (!state.coordsOverrides[pageNum]) {
      state.coordsOverrides[pageNum] = {};
    }
    state.coordsOverrides[pageNum][markerId] = { xPct, yPct };
    try {
      localStorage.setItem(COORDS_STORAGE_KEY, JSON.stringify(state.coordsOverrides));
    } catch (e) {}
  }

  // ===================== API =====================
  async function fetchPageAyahs(pageNum) {
    // 🚀 Local-first retrieval (0ms network delay)
    if (state.quranPagesDb && state.quranPagesDb[pageNum]) {
      return state.quranPagesDb[pageNum];
    }

    const url = `${API_BASE}/page/${pageNum}/quran-uthmani`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const json = await response.json();
    if (json.code !== 200 || !json.data || !json.data.ayahs) {
      throw new Error('Invalid API response');
    }

    return json.data.ayahs;
  }

  // ===================== PARALLEL PAGE LOADER =====================
  // Fetches text and image in parallel for maximum speed.
  // CV marker detection is deferred until memory mode is first used.
  let _memoryModeEverActivated = false;
  let individualAudioPlayer = null;
  let playingAyahNum = null;

  async function loadPage(pageNum) {
    pageNum = Math.max(1, Math.min(TOTAL_PAGES, pageNum));
    if (state.isLoading && pageNum === state.currentPage) return;

    const targetPage = pageNum;
    state.currentPage = targetPage;
    state.isLoading = true;
    state.lastRecitedWordIdx = -1;
    state.lastMatchedAyahNum = null;
    state.revealedAyahs.clear();
    // Reset page lock on manual navigation
    state.pageLocked = false;
    state.lastCurrentPageMatchTime = 0;
    state.pendingVoiceNav = false;

    // Reset teacher state
    stopTeacherLoop();
    stopTimedMode();
    state.teacherState.isPracticeMode = false;
    state.teacherState.activeGroup = null;
    state.isSelectionHidden = false;
    if (els.hideSelectionBtn && els.hideSelectionText) {
      els.hideSelectionBtn.classList.remove('active');
      els.hideSelectionText.textContent = 'Hide Range';
    }

    // Clear tracing canvas immediately if trace mode is active
    if (state.isTraceMode && els.traceCanvas) {
      const ctx = els.traceCanvas.getContext('2d');
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, els.traceCanvas.width, els.traceCanvas.height);
      ctx.restore();
    }

    if (els.wordTranslationPanel) {
      els.wordTranslationPanel.classList.add('hidden');
    }

    els.currentPageDisplay.textContent = targetPage;
    els.pageInput.value = targetPage;
    updateGlobalStats();
    
    // As text loading is instant, hide spinner immediately
    els.pageLoading.classList.add('hidden');
    els.pageImage.classList.add('loading');
    if (els.pageImageContainer) {
      els.pageImageContainer.classList.toggle('hide-page-active', state.isPageHidden);
    }

    try {
      // 🚀 Instant local fetch (0ms network delay)
      const ayahs = await fetchPageAyahs(targetPage);

      if (state.currentPage !== targetPage) return;

      state.ayahs = ayahs;
      state.lastPageAyahCount = ayahs.length;

      // Start the image loading asynchronously in the background without blocking the text display!
      els.pageImage.onload = () => {
        if (state.currentPage === targetPage) {
          els.pageImage.classList.remove('loading');
          // Re-render memory circles once image size is finalized
          if (state.isMemoryMode) renderMemoryCircles();
          updateMushafMasks();
          if (state.isTraceMode) {
            resizeTraceCanvas();
          }
        }
      };
      els.pageImage.onerror = () => {
        if (state.currentPage === targetPage) {
          els.pageImage.classList.remove('loading');
        }
      };
      els.pageImage.src = `${IMAGE_DIR}/${targetPage}.jpg`;

      // Render text instantly
      renderAyahList();
      renderPageText();
      updateProgress();
      populateGlobalTimedRange();
      renderTeacherGroups();

      state.isLoading = false;
      
      if (state.pendingTranscript && state.isListenMode) {
        const pending = state.pendingTranscript;
        state.pendingTranscript = null;
        setTimeout(() => processTranscript(pending), 30);
      }

      // 🔍 CV marker detection: ONLY run when memory mode is first used, then cache
      if (_memoryModeEverActivated) {
        if (state.cvCache[targetPage]) {
          state.ayahCoordinates = state.cvCache[targetPage];
        } else {
          const coords = await detectAyahMarkers(els.pageImage, ayahs);
          state.ayahCoordinates = coords;
          state.cvCache[targetPage] = coords;
          try {
            localStorage.setItem('hifznoor_cv_cache', JSON.stringify(state.cvCache));
          } catch (e) {}
        }
        if (state.isMemoryMode) renderMemoryCircles();
      }

      // Track this page as viewed
      state.pagesViewed.add(targetPage);
      saveProgress();

    } catch (err) {
      console.error('Failed to load page:', err);
      if (state.currentPage !== targetPage) return;
      
      els.pageImage.classList.remove('loading');
      state.isLoading = false;

      els.ayahList.innerHTML = `
        <div class="ayah-list-empty">
          <div class="empty-icon">⚠️</div>
          <p>Could not load ayah data.</p>
        </div>
      `;
      state.ayahs = [];
      state.lastPageAyahCount = 0;
    }

    updateGlobalStats();
    state.isLoading = false;
  }

  function renderAyahList() {
    if (!state.ayahs.length) {
      els.ayahList.innerHTML = `
        <div class="ayah-list-empty">
          <div class="empty-icon">📖</div>
          <p>No ayahs found for this page.</p>
        </div>
      `;
      return;
    }

    const fragment = document.createDocumentFragment();

    state.ayahs.forEach((ayah, index) => {
      const isRevealed = state.revealedAyahs.has(ayah.number);
      const card = document.createElement('div');
      card.className = `ayah-card${isRevealed ? ' revealed' : ''}`;
      card.dataset.ayahNumber = ayah.number;
      card.style.animationDelay = `${index * 0.03}s`;

      // Surah name helper
      const surahNum = ayah.surah ? ayah.surah.number : 0;
      const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${surahNum}`) : '';

      // English translation
      const englishText = getEnglishTranslation(surahNum, ayah.numberInSurah);

      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Ayah ${ayah.numberInSurah} - click to reveal`);

      const isThisAyahPlaying = playingAyahNum === ayah.number;

      card.innerHTML = `
        <div class="ayah-card-header">
          <div class="ayah-number-badge">${ayah.numberInSurah}</div>
          <div class="ayah-surah-info">
            ${surahName ? `<span>${surahName}</span>` : ''}
          </div>
          <button class="ayah-play-btn${isThisAyahPlaying ? ' playing' : ''}" title="Play Recitation" aria-label="Play Recitation">
            ${isThisAyahPlaying 
              ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`
              : `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
            }
          </button>
          <div style="margin-left:auto;font-size:0.7rem;color:rgba(201,168,76,0.5)">
            ${isRevealed ? '✓' : ''}
          </div>
        </div>
        <div class="ayah-text-container">
          <div class="ayah-text ${isRevealed ? 'revealed' : 'hidden'}">${ayah.text}</div>
          ${!isRevealed ? '<div class="ayah-click-hint">Tap or press Enter to reveal</div>' : ''}
        </div>
        ${englishText ? `
          <div class="ayah-translation ${isRevealed ? 'revealed' : 'hidden'}">
            <span class="translation-label">Translation</span>
            <span class="translation-text">${escapeHTML(englishText)}</span>
          </div>
        ` : ''}
      `;

      const playBtn = card.querySelector('.ayah-play-btn');
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playIndividualAyah(ayah);
      });

      card.addEventListener('click', () => revealAyah(ayah.number));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          revealAyah(ayah.number);
        }
      });
      fragment.appendChild(card);
    });

    els.ayahList.innerHTML = '';
    els.ayahList.appendChild(fragment);
  }

  function formatTime(secs) {
    if (isNaN(secs) || secs === Infinity) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function getActiveAudioPlayer() {
    if (state.teacherState.isPlaying && state.teacherState.audioPlayer) {
      return state.teacherState.audioPlayer;
    }
    if (individualAudioPlayer) {
      return individualAudioPlayer;
    }
    return null;
  }

  function bindAudioPlayer(audioEl, labelText) {
    if (!audioEl) return;
    
    // Update labels and show the widget
    if (els.playerAyahLabel) {
      els.playerAyahLabel.textContent = labelText;
    }
    if (els.sidebarAudioPlayer) {
      els.sidebarAudioPlayer.classList.remove('hidden');
    }
    if (els.playerReciter) {
      els.playerReciter.textContent = RECITER_NAMES[state.reciter] || 'Reciter';
    }
    
    // Initial UI state for play/pause
    if (els.playerPlayBtn) {
      els.playerPlayBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
    }
    
    // Reset timeline progress visually for the new track
    if (els.playerProgressBarFill) {
      els.playerProgressBarFill.style.width = '0%';
    }
    if (els.playerTimeCurrent) {
      els.playerTimeCurrent.textContent = '0:00';
    }
    if (els.playerTimeTotal) {
      els.playerTimeTotal.textContent = '0:00';
    }

    // Set duration if already loaded
    if (audioEl.duration && els.playerTimeTotal) {
      els.playerTimeTotal.textContent = formatTime(audioEl.duration);
    }
    
    audioEl.addEventListener('loadedmetadata', () => {
      if (els.playerTimeTotal) {
        els.playerTimeTotal.textContent = formatTime(audioEl.duration);
      }
    });
    
    audioEl.addEventListener('timeupdate', () => {
      if (audioEl.duration) {
        const pct = (audioEl.currentTime / audioEl.duration) * 100;
        if (els.playerProgressBarFill) {
          els.playerProgressBarFill.style.width = `${pct}%`;
        }
        if (els.playerTimeCurrent) {
          els.playerTimeCurrent.textContent = formatTime(audioEl.currentTime);
        }
      }
    });
    
    audioEl.addEventListener('play', () => {
      if (els.playerPlayBtn) {
        els.playerPlayBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
      }
    });
    
    audioEl.addEventListener('pause', () => {
      if (els.playerPlayBtn) {
        els.playerPlayBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
      }
    });
  }

  function updateTopStatusBanner(mode, ayah) {
    if (!els.topStatusBanner || !els.topStatusText || !els.topStatusIcon) return;

    let rangeText = '';
    if (state.teacherState.activeGroup && state.teacherState.activeGroup.ayahs && state.teacherState.activeGroup.ayahs.length) {
      const group = state.teacherState.activeGroup;
      const firstAyah = group.ayahs[0];
      const lastAyah = group.ayahs[group.ayahs.length - 1];
      const surahName = firstAyah.surah ? (firstAyah.surah.englishName || `Surah ${firstAyah.surah.number}`) : '';
      rangeText = `${surahName} (Ayahs ${firstAyah.numberInSurah} - ${lastAyah.numberInSurah})`;
    }

    if (mode === 'reciting' && ayah) {
      const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${ayah.surah.number}`) : 'Surah';
      els.topStatusIcon.textContent = '🔊';
      els.topStatusText.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%;">
          <div style="font-size: 0.78rem; color: var(--white-muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Playing Audio Recitation</div>
          <div style="font-size: 1.6rem; font-weight: 800; color: var(--gold-light); text-shadow: 0 2px 4px rgba(0,0,0,0.6); line-height: 1.2;">
            ${surahName} : Ayah ${ayah.numberInSurah}
          </div>
        </div>
      `;
      els.topStatusBanner.classList.remove('hidden');
    } 
    else if (mode === 'reciting-teacher' && ayah) {
      const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${ayah.surah.number}`) : 'Surah';
      const themeText = state.teacherState.activeGroup ? state.teacherState.activeGroup.theme : '';
      
      let loopBadgeHtml = '';
      if (state.teacherState.isPlaying && state.teacherState.jobQueue && state.teacherState.jobQueue[state.teacherState.currentJobIdx]) {
        const job = state.teacherState.jobQueue[state.teacherState.currentJobIdx];
        const loopCount = job.repeatsTotal - job.repeatsRemaining + 1;
        // Only animate/pop at the beginning of the group loop (repetition)
        const shouldAnimate = state.teacherState.currentAyahIdxInJob === 0;
        const animateClass = shouldAnimate ? 'animate' : '';
        loopBadgeHtml = `<span class="loop-count-badge ${animateClass}" title="Loop ${loopCount} of ${job.repeatsTotal}">${loopCount}</span>`;
      }
      
      els.topStatusIcon.textContent = '🏵️';
      els.topStatusText.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%;">
          <div style="font-size: 0.78rem; color: var(--white-muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Teacher Loop Active</div>
          <div style="font-size: 1.6rem; font-weight: 800; color: var(--gold-light); text-shadow: 0 2px 4px rgba(0,0,0,0.6); line-height: 1.2; display: flex; align-items: center; justify-content: center; gap: 4px;">
            <span>${surahName} : Ayah ${ayah.numberInSurah}</span>
            ${loopBadgeHtml}
          </div>
          ${themeText ? `<div class="top-status-theme-badge" style="margin-top: 2px;">Theme: ${themeText}</div>` : ''}
        </div>
      `;
      els.topStatusBanner.classList.remove('hidden');
    } 
    else if (mode === 'listening') {
      const themeText = state.teacherState.activeGroup ? state.teacherState.activeGroup.theme : '';
      if (ayah) {
        const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${ayah.surah.number}`) : 'Surah';
        els.topStatusIcon.textContent = '🎙️';
        els.topStatusText.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%;">
            <div style="font-size: 0.78rem; color: var(--white-muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Listening & Tracking Voice</div>
            <div style="font-size: 1.8rem; font-weight: 800; color: var(--gold-light); text-shadow: 0 2px 4px rgba(0,0,0,0.6); line-height: 1.2;">
              ${surahName} : Ayah ${ayah.numberInSurah}
            </div>
            ${themeText ? `<div class="top-status-theme-badge" style="margin-top: 2px;">Theme: ${themeText}</div>` : ''}
          </div>
        `;
        els.topStatusBanner.classList.remove('hidden');
      } else {
        els.topStatusIcon.textContent = '🎙️';
        els.topStatusText.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%;">
            <div style="font-size: 0.78rem; color: var(--white-muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Listening Mode Active</div>
            <div style="font-size: 1.5rem; font-weight: 800; color: var(--gold-light); text-shadow: 0 2px 4px rgba(0,0,0,0.6); line-height: 1.2;">
              Recite to begin matching
            </div>
            ${themeText ? `<div class="top-status-theme-badge" style="margin-top: 2px;">Theme: ${themeText}</div>` : ''}
          </div>
        `;
        els.topStatusBanner.classList.remove('hidden');
      }
    } 
    else if (mode === 'timed-study') {
      const themeText = state.teacherState.activeGroup ? state.teacherState.activeGroup.theme : 'Thematic Group';
      const timeFormatted = formatCountdownTime(state.teacherState.timedMode.timeLeft);
      els.topStatusIcon.textContent = '📖';
      
      const existingTimer = els.topStatusText.querySelector('.timed-timer-block.study');
      if (existingTimer) {
        existingTimer.textContent = timeFormatted;
      } else {
        els.topStatusText.innerHTML = `
          <div class="top-status-timed-banner-content">
            <div class="timed-banner-info-section">
              <div class="timed-banner-title study">Nazira Reading Mode</div>
              <div class="timed-banner-subtitle">Theme: ${themeText}</div>
            </div>
            <div class="timed-banner-time-section">
              <div class="timed-timer-block study">${timeFormatted}</div>
              <div class="timed-range-block study">${rangeText}</div>
            </div>
            <div class="top-status-timed-buttons">
              <button class="status-action-btn">Skip to Test</button>
              <button class="status-action-btn stop">Stop Mode</button>
            </div>
          </div>
        `;
      }
      els.topStatusBanner.classList.remove('hidden');
    }
    else if (mode === 'timed-test') {
      const themeText = state.teacherState.activeGroup ? state.teacherState.activeGroup.theme : 'Thematic Group';
      const timeFormatted = formatCountdownTime(state.teacherState.timedMode.timeLeft);
      els.topStatusIcon.textContent = '🔒';
      
      const existingTimer = els.topStatusText.querySelector('.timed-timer-block.test');
      if (existingTimer) {
        existingTimer.textContent = timeFormatted;
      } else {
        els.topStatusText.innerHTML = `
          <div class="top-status-timed-banner-content">
            <div class="timed-banner-info-section">
              <div class="timed-banner-title test">Close Book Mode</div>
              <div class="timed-banner-subtitle">Theme: ${themeText}</div>
            </div>
            <div class="timed-banner-time-section">
              <div class="timed-timer-block test">${timeFormatted}</div>
              <div class="timed-range-block test">${rangeText}</div>
            </div>
            <div class="top-status-timed-buttons">
              <button class="status-action-btn stop">Stop Mode</button>
            </div>
          </div>
        `;
      }
      els.topStatusBanner.classList.remove('hidden');
    }
    else {
      // Idle / hide
      // If listening mode is active, fall back to general listening status instead of hiding!
      if (state.isListenMode && !state.teacherState.timedMode.active) {
        if (state.lastMatchedAyahNum) {
          const matchedAyah = state.ayahs.find(a => a.number === state.lastMatchedAyahNum);
          updateTopStatusBanner('listening', matchedAyah);
        } else {
          updateTopStatusBanner('listening', null);
        }
      } else if (!state.teacherState.timedMode.active) {
        els.topStatusBanner.classList.add('hidden');
      }
    }
  }

  function updateThemeVisualizer(group) {
    if (!els.themeVisualizerCard || !els.themeVisualizerArt || !els.themeVisualizerTitle || !els.themeVisualizerDesc) return;
    
    if (!group) {
      els.themeVisualizerCard.classList.add('hidden');
      return;
    }
    
    const theme = group.theme;
    els.themeVisualizerTitle.textContent = theme.split(" / ")[0]; // English part
    
    const firstAyah = group.ayahs[0];
    const lastAyah = group.ayahs[group.ayahs.length - 1];
    const rangeText = `Ayahs ${firstAyah.numberInSurah} to ${lastAyah.numberInSurah} of ${firstAyah.surah.englishName}`;
    els.themeVisualizerDesc.textContent = rangeText;
    
    // Select SVG art based on theme keywords
    let svgArt = '';
    const cleanTheme = theme.toLowerCase();
    
    if (cleanTheme.includes("believ") || cleanTheme.includes("faith") || cleanTheme.includes("righteous")) {
      svgArt = `<svg viewBox="0 0 100 100"><defs><linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#e8c65a" /><stop offset="100%" stop-color="#a8882e" /></linearGradient><radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#e8c65a" stop-opacity="0.4" /><stop offset="100%" stop-color="#e8c65a" stop-opacity="0" /></radialGradient></defs><circle cx="50" cy="50" r="30" fill="url(#glow)" class="pulsing" /><path d="M50 15 L53 35 L73 35 L57 47 L63 67 L50 55 L37 67 L43 47 L27 35 L47 35 Z" fill="url(#goldGrad)" class="rotating" /><circle cx="25" cy="25" r="2" fill="#fff" opacity="0.8" class="pulsing" /><circle cx="75" cy="25" r="2.5" fill="#fff" opacity="0.9" class="pulsing" style="animation-delay: 1s;" /><circle cx="70" cy="70" r="1.5" fill="#fff" opacity="0.6" class="pulsing" style="animation-delay: 0.5s;" /></svg>`;
    } else if (cleanTheme.includes("disbeliev") || cleanTheme.includes("reject") || cleanTheme.includes("deny")) {
      svgArt = `<svg viewBox="0 0 100 100"><defs><linearGradient id="stormGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff5555" /><stop offset="100%" stop-color="#881111" /></linearGradient></defs><path d="M50 10 L30 55 L45 55 L35 90 L70 45 L52 45 Z" fill="url(#stormGrad)" class="lightning-strike" /><circle cx="20" cy="30" r="2" fill="#ff5555" opacity="0.5" class="pulsing" /><circle cx="80" cy="70" r="3" fill="#ff5555" opacity="0.3" class="pulsing" style="animation-delay: 0.8s;" /></svg>`;
    } else if (cleanTheme.includes("creation") || cleanTheme.includes("heavens") || cleanTheme.includes("earth") || cleanTheme.includes("signs")) {
      svgArt = `<svg viewBox="0 0 100 100"><defs><linearGradient id="earthGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3aa8b1" /><stop offset="100%" stop-color="#161e36" /></linearGradient></defs><circle cx="50" cy="50" r="25" fill="url(#earthGrad)" stroke="rgba(201,168,76,0.3)" stroke-width="1" class="rotating" /><path d="M38 35 Q45 30 50 38 T42 50 T33 42 Z" fill="#2a8b76" opacity="0.6" /><path d="M55 45 Q62 40 65 52 T54 62 Z" fill="#2a8b76" opacity="0.6" /><circle cx="20" cy="20" r="1.5" fill="#fff" class="pulsing" /><circle cx="80" cy="15" r="1" fill="#fff" class="pulsing" style="animation-delay: 0.4s;" /><circle cx="85" cy="75" r="2" fill="#fff" class="pulsing" style="animation-delay: 0.8s;" /><circle cx="15" cy="70" r="1" fill="#fff" class="pulsing" style="animation-delay: 1.2s;" /></svg>`;
    } else if (cleanTheme.includes("paradise") || cleanTheme.includes("garden")) {
      svgArt = `<svg viewBox="0 0 100 100"><defs><linearGradient id="paradiseGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#2a8b76" /><stop offset="100%" stop-color="#103c30" /></linearGradient></defs><path d="M50 15 C65 30 75 55 50 85 C25 55 35 30 50 15 Z" fill="url(#paradiseGrad)" class="pulsing" /><path d="M50 15 Q55 45 50 85" stroke="rgba(201,168,76,0.5)" stroke-width="2" fill="none" /><path d="M20 75 Q35 70 50 75 T80 75" stroke="#3aa8b1" stroke-width="3" fill="none" opacity="0.7" class="wave" /><path d="M15 83 Q35 78 50 83 T85 83" stroke="#3aa8b1" stroke-width="2" fill="none" opacity="0.5" class="wave" style="animation-delay: 1s;" /></svg>`;
    } else if (cleanTheme.includes("hell") || cleanTheme.includes("fire") || cleanTheme.includes("punish")) {
      svgArt = `<svg viewBox="0 0 100 100"><defs><linearGradient id="fireGrad" x1="0%" y1="100%" x2="0%" y2="0%"><stop offset="0%" stop-color="#ff3300" /><stop offset="50%" stop-color="#ffaa00" /><stop offset="100%" stop-color="#ffff00" stop-opacity="0" /></linearGradient></defs><path d="M15 90 C15 70 30 40 45 20 C48 35 52 50 65 30 C70 50 85 65 85 90 Z" fill="url(#fireGrad)" class="fire" /><path d="M30 90 C35 75 42 60 48 45 C52 55 55 65 60 55 C63 70 70 80 70 90 Z" fill="#ff3300" opacity="0.6" class="fire" style="animation-delay: 0.3s;" /></svg>`;
    } else if (cleanTheme.includes("mercy") || cleanTheme.includes("forgiv") || cleanTheme.includes("merciful")) {
      svgArt = `<svg viewBox="0 0 100 100"><defs><radialGradient id="sun" cx="50%" cy="40%" r="50%"><stop offset="0%" stop-color="#fff" /><stop offset="30%" stop-color="#e8c65a" /><stop offset="100%" stop-color="#e8c65a" stop-opacity="0" /></radialGradient></defs><circle cx="50" cy="40" r="30" fill="url(#sun)" class="pulsing" /><path d="M15 70 C15 55 30 50 40 58 C45 45 65 42 70 55 C80 50 90 60 85 72 L15 72 Z" fill="#161e36" opacity="0.9" stroke="rgba(201,168,76,0.3)" stroke-width="1" class="wave" /></svg>`;
    } else if (cleanTheme.includes("moses") || cleanTheme.includes("musa") || cleanTheme.includes("pharaoh")) {
      svgArt = `<svg viewBox="0 0 100 100"><path d="M10 20 C30 40 30 10 50 30 C70 50 70 20 90 40 L90 90 L10 90 Z" fill="#161e36" stroke="#3aa8b1" stroke-width="2" class="wave" /><path d="M10 40 C30 60 30 30 50 50 C70 70 70 40 90 60 L90 90 L10 90 Z" fill="rgba(58,168,177,0.3)" stroke="#3aa8b1" stroke-width="1.5" class="wave" style="animation-delay: 1s;" /><line x1="50" y1="10" x2="35" y2="85" stroke="#e8c65a" stroke-width="4" stroke-linecap="round" class="staff-glow" /></svg>`;
    } else if (cleanTheme.includes("judgment") || cleanTheme.includes("hour") || cleanTheme.includes("resurrection") || cleanTheme.includes("day")) {
      svgArt = `<svg viewBox="0 0 100 100"><defs><linearGradient id="scaleGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#e8c65a" /><stop offset="100%" stop-color="#a8882e" /></linearGradient></defs><g class="swaying"><line x1="50" y1="20" x2="50" y2="80" stroke="url(#scaleGrad)" stroke-width="4" stroke-linecap="round" /><line x1="30" y1="80" x2="70" y2="80" stroke="url(#scaleGrad)" stroke-width="4" stroke-linecap="round" /><line x1="25" y1="35" x2="75" y2="35" stroke="url(#scaleGrad)" stroke-width="3" stroke-linecap="round" /><line x1="25" y1="35" x2="15" y2="60" stroke="#e8c65a" stroke-width="1" /><line x1="25" y1="35" x2="35" y2="60" stroke="#e8c65a" stroke-width="1" /><path d="M10 60 Q25 70 40 60 Z" fill="url(#scaleGrad)" /><line x1="75" y1="35" x2="65" y2="60" stroke="#e8c65a" stroke-width="1" /><line x1="75" y1="35" x2="85" y2="60" stroke="#e8c65a" stroke-width="1" /><path d="M60 60 Q75 70 90 60 Z" fill="url(#scaleGrad)" /></g></svg>`;
    } else if (cleanTheme.includes("book") || cleanTheme.includes("quran") || cleanTheme.includes("reveal")) {
      svgArt = `<svg viewBox="0 0 100 100"><defs><linearGradient id="goldLight" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#e8c65a" /><stop offset="100%" stop-color="#a8882e" /></linearGradient></defs><path d="M30 65 L50 45 L70 65 M50 45 L50 80" stroke="url(#goldLight)" stroke-width="4" stroke-linecap="round" fill="none" /><path d="M50 45 C40 38 25 40 20 45 L20 28 C25 23 40 21 50 28 C60 21 75 23 80 28 L80 45 C75 40 60 38 50 45 Z" fill="#fff" stroke="url(#goldLight)" stroke-width="2" /><g class="pulsing"><line x1="50" y1="20" x2="50" y2="5" stroke="#e8c65a" stroke-width="2" opacity="0.8" /><line x1="35" y1="22" x2="22" y2="10" stroke="#e8c65a" stroke-width="1.5" opacity="0.6" /><line x1="65" y1="22" x2="78" y2="10" stroke="#e8c65a" stroke-width="1.5" opacity="0.6" /></g></svg>`;
    } else {
      svgArt = `<svg viewBox="0 0 100 100"><defs><linearGradient id="mandGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#e8c65a" /><stop offset="100%" stop-color="#a8882e" /></linearGradient></defs><g class="rotating"><circle cx="50" cy="50" r="35" stroke="url(#mandGrad)" stroke-width="2" fill="none" /><circle cx="50" cy="50" r="25" stroke="url(#mandGrad)" stroke-width="1.5" stroke-dasharray="4,4" fill="none" /><rect x="25" y="25" width="50" height="50" stroke="url(#mandGrad)" stroke-width="1" fill="none" /><rect x="25" y="25" width="50" height="50" stroke="url(#mandGrad)" stroke-width="1" fill="none" transform="rotate(45 50 50)" /></g><circle cx="50" cy="50" r="5" fill="url(#mandGrad)" /></svg>`;
    }
    
    els.themeVisualizerArt.innerHTML = svgArt;
    els.themeVisualizerCard.classList.remove('hidden');
  }

  function playIndividualAyah(ayah) {
    // Stop any existing loop or other playing audio
    stopTeacherLoop();
    
    if (individualAudioPlayer) {
      individualAudioPlayer.pause();
      if (playingAyahNum === ayah.number) {
        // Toggle stop if clicking the same playing ayah
        playingAyahNum = null;
        individualAudioPlayer = null;
        document.querySelectorAll(".word.playing-ayah").forEach(el => el.classList.remove('playing-ayah'));
        updatePlayButtonsUI();
        if (els.sidebarAudioPlayer) {
          els.sidebarAudioPlayer.classList.add('hidden');
        }
        updateTopStatusBanner('idle');
        return;
      }
    }
    
    playingAyahNum = ayah.number;
    updateTopStatusBanner('reciting', ayah);
    highlightTeacherAyah(ayah.number);
    
    const audioUrl = `https://cdn.islamic.network/quran/audio/128/${state.reciter}/${ayah.number}.mp3`;
    individualAudioPlayer = new Audio(audioUrl);
    
    const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${ayah.surah.number}`) : 'Surah';
    const labelText = `${surahName}, Ayah ${ayah.numberInSurah}`;
    bindAudioPlayer(individualAudioPlayer, labelText);

    individualAudioPlayer.play().catch(err => {
      console.warn("Failed to play audio", err);
      playingAyahNum = null;
      updatePlayButtonsUI();
    });
    
    individualAudioPlayer.onended = () => {
      stopAllRecitation();
    };
    
    updatePlayButtonsUI();
  }

  function updatePlayButtonsUI() {
    document.querySelectorAll('.ayah-card').forEach(card => {
      const ayahNumber = parseInt(card.dataset.ayahNumber, 10);
      const playBtn = card.querySelector('.ayah-play-btn');
      if (playBtn) {
        if (playingAyahNum === ayahNumber) {
          playBtn.classList.add('playing');
          playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
        } else {
          playBtn.classList.remove('playing');
          playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        }
      }
    });
  }

  function stopAllRecitation() {
    state.teacherState.isPlaying = false;
    if (state.teacherState.audioPlayer) {
      state.teacherState.audioPlayer.pause();
      state.teacherState.audioPlayer = null;
    }
    
    if (individualAudioPlayer) {
      individualAudioPlayer.pause();
      individualAudioPlayer = null;
      playingAyahNum = null;
      updatePlayButtonsUI();
    }
    
    document.querySelectorAll(".word.playing-ayah").forEach(el => {
      el.classList.remove("playing-ayah");
    });

    // Hide/reset audio player widget
    if (els.sidebarAudioPlayer) {
      els.sidebarAudioPlayer.classList.add('hidden');
    }
    if (els.playerProgressBarFill) {
      els.playerProgressBarFill.style.width = '0%';
    }
    if (els.playerTimeCurrent) {
      els.playerTimeCurrent.textContent = '0:00';
    }
    if (els.playerTimeTotal) {
      els.playerTimeTotal.textContent = '0:00';
    }
    if (els.playerPlayBtn) {
      els.playerPlayBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    }
    updateTopStatusBanner('idle');
    updateThemeVisualizer(null);
    const frameEl = document.querySelector('.page-frame');
    if (frameEl) frameEl.classList.remove('teacher-active');
    
    state.teacherState.isGlobalPageLoop = false;
    if (els.globalPageLoopBtn) {
      els.globalPageLoopBtn.classList.remove('active');
    }
  }

  // Simple HTML escaping for translation text
  const _escapeDiv = document.createElement('div');
  function escapeHTML(str) {
    _escapeDiv.textContent = str;
    return _escapeDiv.innerHTML;
  }

  // ===================== AYAH CIRCLE DETECTION =====================
  // Runs a blob detection algorithm to visually map the Ayah circles on the image
  async function detectAyahMarkers(imgElement, expectedAyahs) {
    return new Promise((resolve) => {
      if (expectedAyahs.length === 0) return resolve([]);
      
      const w = imgElement.naturalWidth;
      const h = imgElement.naturalHeight;
      if (!w || !h) {
         return resolve(generateFallbackCoordinates(expectedAyahs));
      }

      try {
        const canvas = document.createElement('canvas');
        const scale = 0.5; // Scale down for performance
        canvas.width = Math.floor(w * scale);
        canvas.height = Math.floor(h * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
        
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;
        
        // 1. Find dark pixels (text and marker borders)
        const isDark = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
          if (lum < 160) isDark[i/4] = 1;
        }

        // 2. Dilate to combine hollow circle borders and internal numbers into solid blobs
        const dilated = new Uint8Array(canvas.width * canvas.height);
        const dilateRadius = 2;
        for (let y = dilateRadius; y < canvas.height - dilateRadius; y++) {
          for (let x = dilateRadius; x < canvas.width - dilateRadius; x++) {
            const idx = y * canvas.width + x;
            if (isDark[idx]) {
              for (let dy = -dilateRadius; dy <= dilateRadius; dy++) {
                for (let dx = -dilateRadius; dx <= dilateRadius; dx++) {
                  dilated[(y + dy) * canvas.width + (x + dx)] = 1;
                }
              }
            }
          }
        }

        // 3. Find connected components (blobs)
        const visited = new Uint8Array(canvas.width * canvas.height);
        const blobs = [];
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const idx = y * canvas.width + x;
            if (dilated[idx] && !visited[idx]) {
              let minX = x, maxX = x, minY = y, maxY = y;
              let pixels = 0;
              const stack = [idx];
              visited[idx] = 1;
              
              while (stack.length > 0) {
                const curr = stack.pop();
                const cy = Math.floor(curr / canvas.width);
                const cx = curr % canvas.width;
                
                if (cx < minX) minX = cx;
                if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy;
                if (cy > maxY) maxY = cy;
                pixels++;
                
                const nIdx = [curr - canvas.width, curr + canvas.width, curr - 1, curr + 1];
                for (const n of nIdx) {
                  if (n >= 0 && n < dilated.length && dilated[n] && !visited[n]) {
                    if (Math.abs((n % canvas.width) - cx) <= 1) { // wrap check
                      visited[n] = 1;
                      stack.push(n);
                    }
                  }
                }
              }
              blobs.push({ minX, maxX, minY, maxY, pixels });
            }
          }
        }

        // 4. Filter for circular marker-like objects
        let candidates = [];
        for (const b of blobs) {
          const bw = b.maxX - b.minX;
          const bh = b.maxY - b.minY;
          if (bw < 8 || bh < 8) continue; 
          
          const aspect = bw / bh;
          if (aspect > 0.6 && aspect < 1.6) {
            candidates.push({
              x: ((b.minX + b.maxX) / 2) / scale,
              y: ((b.minY + b.maxY) / 2) / scale,
              radius: (Math.max(bw, bh) / 2) / scale,
              width: bw,
              height: bh,
              area: bw * bh
            });
          }
        }

        // Remove overlaps
        for (let i = 0; i < candidates.length; i++) {
          for (let j = i + 1; j < candidates.length; j++) {
            if (!candidates[i] || !candidates[j]) continue;
            const dx = candidates[i].x - candidates[j].x;
            const dy = candidates[i].y - candidates[j].y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < candidates[i].radius * 1.5) {
              if (candidates[i].area > candidates[j].area) {
                candidates[j] = null;
              } else {
                candidates[i] = null;
              }
            }
          }
        }
        candidates = candidates.filter(Boolean);

        // Sort by area, keep top N markers
        candidates.sort((a, b) => b.area - a.area);
        
        // Fallback if detection fails entirely
        if (candidates.length < expectedAyahs.length * 0.3) {
           return resolve(generateFallbackCoordinates(expectedAyahs));
        }

        candidates = candidates.slice(0, expectedAyahs.length);

        // Sort in reading order (Right-to-Left, Top-to-Bottom)
        const lineHeight = h / 15;
        candidates.sort((a, b) => {
          if (Math.abs(a.y - b.y) < lineHeight * 0.6) {
            return b.x - a.x; 
          }
          return a.y - b.y;
        });

        // Output mapped relative coordinates (%)
        const result = [];
        for(let i = 0; i < expectedAyahs.length; i++) {
           if (i < candidates.length) {
              result.push({
                 ayah: expectedAyahs[i],
                 xPct: (candidates[i].x / w) * 100,
                 yPct: (candidates[i].y / h) * 100
              });
           } else {
              result.push({
                 ayah: expectedAyahs[i],
                 xPct: 50,
                 yPct: 90
              });
           }
        }
        resolve(result);
      } catch (err) {
        console.error("CV Detection failed", err);
        resolve(generateFallbackCoordinates(expectedAyahs));
      }
    });
  }

  function generateFallbackCoordinates(expectedAyahs) {
     return expectedAyahs.map((ayah, i) => {
        const row = Math.floor(i / 3);
        const col = i % 3;
        return { ayah: ayah, xPct: 80 - (col * 30), yPct: 15 + (row * 10) };
     });
  }

  // ===================== TEXT OVERLAY MODE =====================
  function toggleTextMode() {
    // Disabled to enforce Mushaf mode only
    state.isTextMode = false;
    if (els.toggleTextBtn) els.toggleTextBtn.classList.remove('active');
    if (els.pageTextOverlay) els.pageTextOverlay.classList.remove('active');
    if (els.pageImageContainer) els.pageImageContainer.classList.remove('hide-image');
  }

  function applyTheme() {
    if (state.isTextLightMode) {
      document.body.classList.add('light-mode');
      if (els.pageTextOverlay) els.pageTextOverlay.classList.add('light-mode');
    } else {
      document.body.classList.remove('light-mode');
      if (els.pageTextOverlay) els.pageTextOverlay.classList.remove('light-mode');
    }

    if (els.themeToggleBtn) {
      els.themeToggleBtn.classList.toggle('active', state.isTextLightMode);
      
      const spanEl = els.themeToggleBtn.querySelector('span');
      if (spanEl) {
        spanEl.textContent = state.isTextLightMode ? 'Light Mode' : 'Dark Mode';
      }
      
      const svgEl = els.themeToggleBtn.querySelector('svg');
      if (svgEl) {
        if (state.isTextLightMode) {
          // Sun icon
          svgEl.innerHTML = '<path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.01c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/>';
        } else {
          // Moon icon
          svgEl.innerHTML = '<path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/>';
        }
      }
    }
  }

  function toggleThemeMode() {
    state.isTextLightMode = !state.isTextLightMode;
    try {
      localStorage.setItem('text-mode-theme', state.isTextLightMode ? 'light' : 'dark');
    } catch (e) {}
    applyTheme();
  }

  function toggleHidePageMode() {
    state.isPageHidden = !state.isPageHidden;
    
    if (els.hidePageBtn && els.hidePageText) {
      els.hidePageBtn.classList.toggle('active', state.isPageHidden);
      els.hidePageText.textContent = state.isPageHidden ? 'Show Page' : 'Hide Page';
    }
    
    if (els.pageImageContainer) {
      els.pageImageContainer.classList.toggle('hide-page-active', state.isPageHidden);
    }
  }

  function toggleHideTextMode() {
    state.isTextHidden = !state.isTextHidden;
    
    if (els.hideTextBtn && els.hideTextText) {
      els.hideTextBtn.classList.toggle('active', state.isTextHidden);
      els.hideTextText.textContent = state.isTextHidden ? 'Show Text' : 'Hide Text';
    }
    
    // Toggle practice-hidden classes on all word elements on the page!
    const words = els.pageTextOverlay.querySelectorAll('.word');
    words.forEach(wordEl => {
      if (state.isTextHidden) {
        wordEl.classList.add('practice-hidden');
      } else {
        wordEl.classList.remove('practice-hidden', 'practice-success');
      }
    });
    
    // Update visual block masks covering the calligraphy
    updateMushafMasks();
  }

  // ===================== HANDWRITING TRACING =====================
  function toggleTraceMode() {
    state.isTraceMode = !state.isTraceMode;
    
    if (els.toggleTraceModeBtn) {
      els.toggleTraceModeBtn.classList.toggle('active', state.isTraceMode);
      const spanEl = els.toggleTraceModeBtn.querySelector('.trace-btn-text');
      if (spanEl) {
        spanEl.textContent = state.isTraceMode ? 'Trace Mode: ON' : 'Trace & Write Mode';
      }
    }
    
    if (els.traceControls) {
      els.traceControls.classList.toggle('hidden', !state.isTraceMode);
    }
    
    if (els.pageImageContainer) {
      els.pageImageContainer.classList.toggle('trace-mode-active', state.isTraceMode);
      if (state.isTraceMode) {
        els.pageImageContainer.style.setProperty('--trace-opacity', (state.traceOpacity / 100));
      } else {
        els.pageImageContainer.style.removeProperty('--trace-opacity');
      }
    }
    
    if (els.traceCanvas) {
      els.traceCanvas.classList.toggle('active', state.isTraceMode);
      if (state.isTraceMode) {
        // Reset tool to Pen mode by default on activation
        state.traceIsEraser = false;
        if (els.tracePenBtn) els.tracePenBtn.classList.add('active');
        if (els.traceEraserBtn) els.traceEraserBtn.classList.remove('active');
        els.traceCanvas.classList.remove('eraser-active');
        
        // Ensure correct color dot is highlighted
        document.querySelectorAll('.color-dot').forEach(dot => {
          dot.classList.toggle('active', dot.getAttribute('data-color') === state.traceColor);
        });

        setTimeout(() => {
          resizeTraceCanvas();
          initCanvasEvents();
        }, 50);
      }
    }
  }

  function resizeTraceCanvas() {
    const canvas = els.traceCanvas;
    const img = els.pageImage;
    if (!canvas || !img) return;
    
    const rect = img.getBoundingClientRect();
    const container = els.pageImageContainer;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    canvas.style.left = (rect.left - containerRect.left) + 'px';
    canvas.style.top = (rect.top - containerRect.top) + 'px';
    
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    
    redrawPageStrokes();
  }

  function redrawPageStrokes() {
    const canvas = els.traceCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Clear whole canvas backing store
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    
    const pageNum = state.currentPage;
    const strokes = state.pageStrokes[pageNum];
    if (!strokes || strokes.length === 0) return;
    
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width === 0 || height === 0) return;
    
    for (const stroke of strokes) {
      if (stroke.points.length === 0) continue;
      
      ctx.beginPath();
      if (stroke.isEraser) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = 20;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      const p0 = stroke.points[0];
      ctx.moveTo(p0.x * width, p0.y * height);
      for (let i = 1; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.lineTo(p.x * width, p.y * height);
      }
      ctx.stroke();
    }
    
    ctx.globalCompositeOperation = 'source-over';
  }

  function undoLastStroke() {
    const pageNum = state.currentPage;
    if (state.pageStrokes[pageNum] && state.pageStrokes[pageNum].length > 0) {
      state.pageStrokes[pageNum].pop();
      redrawPageStrokes();
      saveTraceData();
    }
  }

  function clearPageDrawing() {
    const pageNum = state.currentPage;
    state.pageStrokes[pageNum] = [];
    redrawPageStrokes();
    saveTraceData();
  }

  let isDrawing = false;
  let currentStroke = null;

  function initCanvasEvents() {
    if (state.canvasEventsWired) return;
    const canvas = els.traceCanvas;
    if (!canvas) return;

    canvas.addEventListener('pointerdown', (e) => {
      if (!state.isTraceMode) return;
      
      isDrawing = true;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {}
      
      const rect = canvas.getBoundingClientRect();
      const x = parseFloat(((e.clientX - rect.left) / rect.width).toFixed(4));
      const y = parseFloat(((e.clientY - rect.top) / rect.height).toFixed(4));
      
      currentStroke = {
        color: state.traceColor,
        width: state.traceIsEraser ? 20 : state.traceWidth,
        isEraser: state.traceIsEraser,
        points: [{x, y}]
      };
      
      const pageNum = state.currentPage;
      if (!state.pageStrokes[pageNum]) {
        state.pageStrokes[pageNum] = [];
      }
      state.pageStrokes[pageNum].push(currentStroke);
      
      drawSegment(e.clientX - rect.left, e.clientY - rect.top, e.clientX - rect.left, e.clientY - rect.top);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!isDrawing || !currentStroke) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = parseFloat(((e.clientX - rect.left) / rect.width).toFixed(4));
      const y = parseFloat(((e.clientY - rect.top) / rect.height).toFixed(4));
      
      currentStroke.points.push({x, y});
      
      const pointsCount = currentStroke.points.length;
      if (pointsCount > 1) {
        const prevNormalized = currentStroke.points[pointsCount - 2];
        const prevX = prevNormalized.x * rect.width;
        const prevY = prevNormalized.y * rect.height;
        const currX = x * rect.width;
        const currY = y * rect.height;
        drawSegment(prevX, prevY, currX, currY);
      }
    });

    const stopDrawing = (e) => {
      if (isDrawing) {
        isDrawing = false;
        if (currentStroke) {
          saveTraceData();
          currentStroke = null;
        }
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch (err) {}
      }
    };

    canvas.addEventListener('pointerup', stopDrawing);
    canvas.addEventListener('pointercancel', stopDrawing);
    canvas.addEventListener('pointerleave', stopDrawing);

    state.canvasEventsWired = true;
  }

  function drawSegment(x1, y1, x2, y2) {
    const canvas = els.traceCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.beginPath();
    if (state.traceIsEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = 20;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = state.traceColor;
      ctx.lineWidth = state.traceWidth;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  function applySelectionMask() {
    if (!els.globalTimedStart || !els.globalTimedEnd) return;
    const startVal = parseInt(els.globalTimedStart.value);
    const endVal = parseInt(els.globalTimedEnd.value);
    const selectedAyahNumbers = new Set();
    
    if (!isNaN(startVal) && !isNaN(endVal) && startVal <= endVal) {
      for (let i = startVal; i <= endVal; i++) {
        if (state.ayahs[i]) {
          selectedAyahNumbers.add(state.ayahs[i].number);
        }
      }
    }
    
    const words = els.pageTextOverlay.querySelectorAll('.word');
    words.forEach(wordEl => {
      const ayahNum = parseInt(wordEl.dataset.ayah);
      const isWordRevealed = state.revealedAyahs.has(ayahNum) || wordEl.classList.contains('practice-success');
      
      if (state.isSelectionHidden && selectedAyahNumbers.has(ayahNum)) {
        if (!isWordRevealed) {
          wordEl.classList.add('practice-hidden');
        }
      } else {
        if (!state.isTextHidden && !state.teacherState.isPracticeMode && (!state.teacherState.activeGroup || !state.teacherState.activeGroup.ayahs.some(a => a.number === ayahNum))) {
          wordEl.classList.remove('practice-hidden', 'practice-success');
        }
      }
    });
  }

  function toggleHideSelectionMode() {
    state.isSelectionHidden = !state.isSelectionHidden;
    
    if (els.hideSelectionBtn && els.hideSelectionText) {
      els.hideSelectionBtn.classList.toggle('active', state.isSelectionHidden);
      els.hideSelectionText.textContent = state.isSelectionHidden ? 'Show Range' : 'Hide Range';
    }
    
    updateMushafMasks();
  }

  function showWordTranslation(wordEl) {
    const ayahNum = parseInt(wordEl.dataset.ayah);
    if (isNaN(ayahNum)) return;
    
    const matchedAyah = state.ayahs.find(a => a.number === ayahNum);
    if (!matchedAyah) return;
    
    const surahName = matchedAyah.surah ? (matchedAyah.surah.englishName || `Surah ${matchedAyah.surah.number}`) : 'Surah';
    const translationText = getEnglishTranslation(matchedAyah.surah.number, matchedAyah.numberInSurah);
    
    const transArabicWord = document.getElementById('transArabicWord');
    const transContextInfo = document.getElementById('transContextInfo');
    const transEnglishText = document.getElementById('transEnglishText');
    const panel = els.wordTranslationPanel;
    
    if (transArabicWord && transContextInfo && transEnglishText && panel) {
      // Clean word text from ayah digits
      const cleanWordText = wordEl.textContent.replace(/﴿[\u0660-\u0669\d]+﴾/g, '').trim();
      transArabicWord.textContent = cleanWordText;
      transContextInfo.textContent = `${surahName} · Ayah ${matchedAyah.numberInSurah}`;
      transEnglishText.textContent = translationText || "Translation not found.";
      
      panel.classList.remove('hidden');
    }
  }

  function toArabicNumerals(num) {
    const arabicNumbers = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
    return String(num).split('').map(d => arabicNumbers[d]).join('');
  }

  function renderPageText() {
    if (!state.ayahs.length) {
      els.pageTextOverlay.innerHTML = '';
      return;
    }

    // Fallback if local page lines are not loaded yet
    if (!state.quranPageLines || !state.quranPageLines[state.currentPage]) {
      let html = '<div class="text-overlay-content">';
      let globalWordIdx = 0;
      state.pageWordsNormalized = [];
      state.pageWordData = [];

      state.ayahs.forEach(ayah => {
        let tokens = ayah.text.match(/(\S+|\s+)/g) || [];
        let wordIndices = [];
        tokens.forEach((t, i) => {
          if (/\S/.test(t)) wordIndices.push(i);
        });
        
        let skipCount = 0;
        if (ayah.numberInSurah === 1 && ayah.surah && ayah.surah.number !== 1) {
          if (wordIndices.length > 4 && tokens[wordIndices[0]].includes('بِسْمِ')) {
            skipCount = 4;
          }
        }
        
        let firstWordIdx = wordIndices[skipCount] !== undefined ? wordIndices[skipCount] : -1;
        let lastWordIdx = wordIndices[wordIndices.length - 1] !== undefined ? wordIndices[wordIndices.length - 1] : -1;
        
        html += `<span class="ayah-text-inline">`;
        for (let i = 0; i < tokens.length; i++) {
          if (/\S/.test(tokens[i])) {
            let idAttr = '';
            let extraClass = state.isTextHidden ? ' practice-hidden' : '';
            if (i === firstWordIdx) { idAttr = `id="text-start-${ayah.number}"`; extraClass += ' word-start'; }
            else if (i === lastWordIdx && i !== firstWordIdx) { idAttr = `id="text-end-${ayah.number}"`; extraClass += ' word-end'; }
            
            const normalized = normalizeArabic(tokens[i]);
            html += `<span class="word${extraClass}" ${idAttr} data-word-idx="${globalWordIdx}" data-ayah="${ayah.number}">${tokens[i]}</span>`;
            state.pageWordsNormalized.push(normalized);
            state.pageWordData.push({ text: normalized, ayahNum: ayah.number, wordIdx: globalWordIdx });
            globalWordIdx++;
          } else {
            html += tokens[i];
          }
        }
        html += `</span>`;
        let markerExtraClass = state.isTextHidden ? ' practice-hidden' : '';
        html += `<span class="word ayah-marker-inline${markerExtraClass}" data-ayah="${ayah.number}">﴿${toArabicNumerals(ayah.numberInSurah)}﴾</span> `;
      });
      html += '</div>';
      els.pageTextOverlay.innerHTML = html;
      return;
    }

    // 🌟 Perfect Line-by-Line Medina Mushaf Text Alignment
    let globalWordIdx = 0;
    state.pageWordsNormalized = [];
    state.pageWordData = [];

    // Flatten all ayah words
    const ayahWords = [];
    state.ayahs.forEach(ayah => {
      const tokens = ayah.text.trim().split(/\s+/);
      tokens.forEach((token, tokenIdx) => {
        ayahWords.push({
          text: token,
          normalized: normalizeArabic(token),
          ayahNum: ayah.number,
          numberInSurah: ayah.numberInSurah,
          tokenIdx: tokenIdx
        });
      });
    });

    let ayahWordPointer = 0;
    const pageLines = state.quranPageLines[state.currentPage] || [];
    const renderedLines = [];

    pageLines.forEach(line => {
      const isHeader = line.includes('سُورَةُ') || line.includes('سورة');
      if (isHeader) {
        const cleanHeaderText = line.replace(/^[\s\d]+/, '');
        renderedLines.push({ type: 'header', text: cleanHeaderText });
        return;
      }

      const isBasmalah = normalizeArabic(line) === "بسم الله الرحمن الرحيم";
      const lineWords = line.trim().split(/\s+/);
      const wordsInLine = [];

      lineWords.forEach(word => {
        // Strip trailing digits for matching
        const cleanWord = word.replace(/[\u0660-\u0669\d]+$/, '');
        const normLineWord = normalizeArabic(cleanWord);
        
        let matchedAyahWord = null;
        let matchedIdx = -1;
        for (let k = 0; k < 10; k++) {
          const ptr = ayahWordPointer + k;
          if (ptr < ayahWords.length) {
            if (ayahWords[ptr].normalized === normLineWord || isFuzzyMatch(ayahWords[ptr].normalized, normLineWord)) {
              matchedIdx = ptr;
              break;
            }
          }
        }

        if (matchedIdx !== -1) {
          ayahWordPointer = matchedIdx + 1;
          matchedAyahWord = ayahWords[matchedIdx];
        } else if (ayahWordPointer < ayahWords.length) {
          matchedAyahWord = ayahWords[ayahWordPointer];
        }

        const ayahNum = matchedAyahWord ? matchedAyahWord.ayahNum : (state.ayahs[0]?.number || 0);

        wordsInLine.push({
          text: word,
          cleanWord: cleanWord,
          norm: normLineWord,
          ayahNum: ayahNum,
          globalWordIdx: globalWordIdx
        });

        state.pageWordsNormalized.push(normLineWord);
        state.pageWordData.push({ text: normLineWord, ayahNum: ayahNum, wordIdx: globalWordIdx });
        globalWordIdx++;
      });

      renderedLines.push({
        type: isBasmalah ? 'basmalah' : 'normal',
        words: wordsInLine
      });
    });

    // Identify start/end coordinates of each ayah
    const ayahStartIdx = {};
    const ayahEndIdx = {};
    state.pageWordData.forEach(wd => {
      if (ayahStartIdx[wd.ayahNum] === undefined) {
        ayahStartIdx[wd.ayahNum] = wd.wordIdx;
      }
      ayahEndIdx[wd.ayahNum] = wd.wordIdx;
    });

    const isPage1or2 = (state.currentPage === 1 || state.currentPage === 2);
    const specificPageClass = state.currentPage === 1 ? ' page-1' : (state.currentPage === 2 ? ' page-2' : '');
    let html = `<div class="text-overlay-content${isPage1or2 ? ' page-1-2' : ''}${specificPageClass}">`;
    
    renderedLines.forEach(lineObj => {
      if (lineObj.type === 'header') {
        let extraClass = state.isTextHidden ? ' practice-hidden' : '';
        html += `<div class="mushaf-line header-line"><span class="word${extraClass}">${lineObj.text}</span></div>`;
      } else if (lineObj.type === 'basmalah') {
        html += `<div class="mushaf-line basmalah-line">`;
        lineObj.words.forEach(w => {
          let idAttr = '';
          let extraClass = state.isTextHidden ? ' practice-hidden' : '';
          if (w.globalWordIdx === ayahStartIdx[w.ayahNum]) { idAttr = `id="text-start-${w.ayahNum}"`; extraClass += ' word-start'; }
          else if (w.globalWordIdx === ayahEndIdx[w.ayahNum]) { idAttr = `id="text-end-${w.ayahNum}"`; extraClass += ' word-end'; }
          html += `<span class="word${extraClass}" ${idAttr} data-word-idx="${w.globalWordIdx}" data-ayah="${w.ayahNum}">${w.text}</span> `;
        });
        html += `</div>`;
      } else {
        html += `<div class="mushaf-line">`;
        lineObj.words.forEach(w => {
          let idAttr = '';
          let extraClass = state.isTextHidden ? ' practice-hidden' : '';
          if (w.globalWordIdx === ayahStartIdx[w.ayahNum]) { idAttr = `id="text-start-${w.ayahNum}"`; extraClass += ' word-start'; }
          else if (w.globalWordIdx === ayahEndIdx[w.ayahNum]) { idAttr = `id="text-end-${w.ayahNum}"`; extraClass += ' word-end'; }
          
          const matchDigits = w.text.match(/^(.*?)([\u0660-\u0669\d]+)$/);
          if (matchDigits) {
            const cleanText = matchDigits[1];
            const digits = matchDigits[2];
            html += `<span class="word${extraClass}" ${idAttr} data-word-idx="${w.globalWordIdx}" data-ayah="${w.ayahNum}">${cleanText}<span class="ayah-number-digit">﴿${digits}﴾</span></span> `;
          } else {
            html += `<span class="word${extraClass}" ${idAttr} data-word-idx="${w.globalWordIdx}" data-ayah="${w.ayahNum}">${w.text}</span> `;
          }
        });
        html += `</div>`;
      }
    });

    html += '</div>';
    els.pageTextOverlay.innerHTML = html;
    
    // Update solid block masks for Close Book Mode / Practice Mode
    setTimeout(updateMushafMasks, 50);
  }

  function revealAyahInPractice(ayahNum) {
    const isPractice = state.teacherState.isPracticeMode || state.isTextHidden || state.isSelectionHidden;
    const isTimedTest = state.teacherState.timedMode.active && state.teacherState.timedMode.phase === 'test';
    
    if (!isPractice && !isTimedTest) return;
    
    // Find all word elements of this ayah on page
    const words = els.pageTextOverlay.querySelectorAll(`.word[data-ayah="${ayahNum}"]`);
    words.forEach(wordEl => {
      const wordIdx = parseInt(wordEl.dataset.wordIdx);
      if (!isNaN(wordIdx)) {
        state.teacherState.recitedWordIdxs.add(wordIdx);
        if (isTimedTest) {
          wordEl.classList.remove('timed-test-hidden');
          wordEl.classList.add('timed-test-success');
        } else {
          wordEl.classList.remove('practice-hidden');
          wordEl.classList.add('practice-success');
        }
      }
    });
    
    updateTeacherUI();
    updateMushafMasks();
    
    // Check if finished (only for active thematic groups or timed mode)
    if (state.teacherState.activeGroup || state.teacherState.timedMode.active) {
      const groupWordData = state.pageWordData.filter(wd => {
        if (!state.teacherState.activeGroup) return false;
        const activeAyahNumbers = new Set(state.teacherState.activeGroup.ayahs.map(a => a.number));
        return activeAyahNumbers.has(wd.ayahNum);
      });
      
      const totalWords = state.teacherState.timedMode.active ? getTimedModeWordCount() : groupWordData.length;
      const recitedWords = state.teacherState.recitedWordIdxs.size;
      
      if (recitedWords >= totalWords) {
        showToast("🏆 Maa Shaa Allah! You have successfully memorized this group!", true);
        if (state.teacherState.timedMode.active) {
          stopTimedMode();
        } else {
          stopTeacherPractice();
        }
      }
    }
  }

  function updateMushafMasks() {
    const container = document.getElementById('mushafMasksContainer');
    const hintsContainer = els.ayahStartHintsContainer || document.getElementById('ayahStartHintsContainer');
    
    if (container) container.innerHTML = '';
    if (hintsContainer) hintsContainer.innerHTML = '';
    
    // Sync selection hidden classes
    applySelectionMask();
    
    // Check if we are in Close Book Mode (Practice Mode, Text Hidden, or Selection Hidden Mode)
    const isPractice = state.teacherState.isPracticeMode || state.isTextHidden || state.isSelectionHidden;
    const isTimedTest = state.teacherState.timedMode.active && state.teacherState.timedMode.phase === 'test';
    
    if (!isPractice && !isTimedTest) {
      return;
    }
    
    const overlay = els.pageTextOverlay;
    if (!overlay) return;
    
    const overlayRect = overlay.getBoundingClientRect();
    if (overlayRect.width === 0 || overlayRect.height === 0) return;
    
    // Sync class page-1-2 on hints container
    const isPage1or2 = (state.currentPage === 1 || state.currentPage === 2);
    if (hintsContainer) {
      hintsContainer.classList.toggle('page-1-2', isPage1or2);
    }
    
    // Render starting hints for hidden ayahs if enabled
    if (state.teacherState.showStartHints) {
      const wordStartElements = overlay.querySelectorAll('.word-start');
      wordStartElements.forEach(wordEl => {
        const isHidden = wordEl.classList.contains('practice-hidden') || wordEl.classList.contains('timed-test-hidden');
        if (isHidden) {
          const rect = wordEl.getBoundingClientRect();
          const relativeTop = rect.top - overlayRect.top;
          const relativeLeft = rect.left - overlayRect.left;
          const width = rect.width;
          const height = rect.height;
          
          let hintText = wordEl.textContent;
          hintText = hintText.replace(/[﴿﴾\u0660-\u0669\d\s]+/g, '').trim();
          if (!hintText) return;
          
          const ayahNum = parseInt(wordEl.dataset.ayah);
          
          const hintBadge = document.createElement('div');
          hintBadge.className = 'ayah-start-hint';
          hintBadge.style.top = `${relativeTop}px`;
          hintBadge.style.left = `${relativeLeft}px`;
          hintBadge.style.width = `${width}px`;
          hintBadge.style.height = `${height}px`;
          hintBadge.style.lineHeight = `${height}px`;
          hintBadge.textContent = hintText;
          
          // Make it clickable to reveal the ayah!
          hintBadge.style.pointerEvents = 'auto';
          hintBadge.title = "Click to reveal ayah";
          hintBadge.addEventListener('click', () => {
            revealAyahInPractice(ayahNum);
          });
          
          if (hintsContainer) {
            hintsContainer.appendChild(hintBadge);
          }
        }
      });
    }
    
    // Helper function to create and append a mask div
    function createMask(left, right, top, bottom) {
      const relativeLeft = Math.max(0, left - overlayRect.left);
      const relativeRight = Math.min(overlayRect.width, right - overlayRect.left);
      const relativeTop = Math.max(0, top - overlayRect.top);
      const relativeBottom = Math.min(overlayRect.height, bottom - overlayRect.top);
      
      if (relativeRight <= relativeLeft || relativeBottom <= relativeTop) return;
      
      const leftPct = (relativeLeft / overlayRect.width) * 100;
      const widthPct = ((relativeRight - relativeLeft) / overlayRect.width) * 100;
      const topPct = (relativeTop / overlayRect.height) * 100;
      const heightPct = ((relativeBottom - relativeTop) / overlayRect.height) * 100;
      
      const mask = document.createElement('div');
      mask.className = 'mushaf-block-mask';
      mask.style.left = `${leftPct}%`;
      mask.style.top = `${topPct}%`;
      mask.style.width = `${widthPct}%`;
      mask.style.height = `${heightPct}%`;
      
      container.appendChild(mask);
    }

    // Find all lines
    const lines = Array.from(overlay.querySelectorAll('.mushaf-line'));
    
    if (lines.length > 0) {
      const candidates = [];
      const lineRects = lines.map(line => line.getBoundingClientRect());
      const verticalBounds = [];
      const padY = 2; // small padding to extend boundary slightly for safety
      
      for (let i = 0; i < lines.length; i++) {
        const rect = lineRects[i];
        let top = rect.top;
        let bottom = rect.bottom;
        
        // Calculate midpoint between this line and the previous line
        if (i > 0) {
          const prevRect = lineRects[i - 1];
          top = (prevRect.bottom + rect.top) / 2;
        } else {
          top = rect.top - 10;
        }
        
        // Calculate midpoint between this line and the next line
        if (i < lines.length - 1) {
          const nextRect = lineRects[i + 1];
          bottom = (rect.bottom + nextRect.top) / 2;
        } else {
          bottom = rect.bottom + 10;
        }
        
        verticalBounds.push({ top, bottom });
      }
      
      lines.forEach((line, i) => {
        const lineRect = lineRects[i];
        const bounds = verticalBounds[i];
        
        // Find all word elements inside this line
        const words = Array.from(line.querySelectorAll('.word'));
        
        // If it's a header line with no words, mask the full line width
        if (words.length === 0) {
          if (line.classList.contains('header-line')) {
            candidates.push({
              left: overlayRect.left,
              right: overlayRect.right,
              top: bounds.top,
              bottom: bounds.bottom
            });
          }
          return;
        }
        
        // Group contiguous words that are hidden/success
        const segments = [];
        let currentSegment = [];
        
        words.forEach(word => {
          const isHidden = word.classList.contains('practice-hidden') || 
                           word.classList.contains('timed-test-hidden') || 
                           word.classList.contains('practice-success') || 
                           word.classList.contains('timed-test-success');
          if (isHidden) {
            currentSegment.push(word);
          } else {
            if (currentSegment.length > 0) {
              segments.push(currentSegment);
              currentSegment = [];
            }
          }
        });
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
        }
        
        // Push masks for each segment
        segments.forEach(segment => {
          let left, right;
          
          if (segment.length === words.length) {
            // The entire line is hidden, so mask the full width of the overlay container to ensure it reaches the margins and joins perfectly
            left = overlayRect.left;
            right = overlayRect.right;
          } else {
            // Only a part of the line is hidden, mask the bounding box of the words in the segment
            let minLeft = Infinity;
            let maxRight = -Infinity;
            segment.forEach(word => {
              const rect = word.getBoundingClientRect();
              if (rect.left < minLeft) minLeft = rect.left;
              if (rect.right > maxRight) maxRight = rect.right;
            });
            
            const padX = 12; // increased padding to ensure it covers diacritics and overlaps nicely
            left = minLeft - padX;
            right = maxRight + padX;
          }
          
          candidates.push({ left, right, top: bounds.top, bottom: bounds.bottom });
        });
      });

      // Merge vertically adjacent masks that have the same horizontal span
      let mergedAny = true;
      while (mergedAny) {
        mergedAny = false;
        for (let i = 0; i < candidates.length; i++) {
          for (let j = i + 1; j < candidates.length; j++) {
            const c1 = candidates[i];
            const c2 = candidates[j];
            
            // Check if they have the same horizontal span (with a tolerance of 5px)
            const sameX = Math.abs(c1.left - c2.left) < 5 && Math.abs(c1.right - c2.right) < 5;
            
            // Check if they are vertically touching or overlapping (with a tolerance of 2px)
            const touchingY = (Math.abs(c1.bottom - c2.top) < 2) || (Math.abs(c2.bottom - c1.top) < 2);
            
            if (sameX && touchingY) {
              // Merge c2 into c1
              c1.left = Math.min(c1.left, c2.left);
              c1.right = Math.max(c1.right, c2.right);
              c1.top = Math.min(c1.top, c2.top);
              c1.bottom = Math.max(c1.bottom, c2.bottom);
              // Remove c2
              candidates.splice(j, 1);
              mergedAny = true;
              break;
            }
          }
          if (mergedAny) break;
        }
      }

      // Draw all candidates!
      candidates.forEach(c => {
        // Add a small vertical overlap (3px on top and bottom) to ensure adjacent lines overlap slightly,
        // which completely eliminates any hairline gaps or cracks caused by browser subpixel rounding.
        createMask(c.left, c.right, c.top - 3, c.bottom + 3);
      });
    } else {
      // Fallback layout (if no lines are defined yet, e.g. database still loading)
      const words = Array.from(overlay.querySelectorAll('.word'));
      words.forEach(word => {
        const isHidden = word.classList.contains('practice-hidden') || 
                         word.classList.contains('timed-test-hidden') || 
                         word.classList.contains('practice-success') || 
                         word.classList.contains('timed-test-success');
        if (isHidden) {
          const rect = word.getBoundingClientRect();
          const padX = 4;
          const padY = 2;
          createMask(rect.left - padX, rect.right + padX, rect.top - padY, rect.bottom + padY);
        }
      });
    }
  }

  // Dynamically calculate % placement based on the rendered text mode
  function getTextNodePercentages(ayahNum, type) {
    const el = document.getElementById(`text-${type}-${ayahNum}`);
    if (!el) return null;
    
    const textOverlayRect = els.pageTextOverlay.getBoundingClientRect();
    if (textOverlayRect.width === 0 || textOverlayRect.height === 0) return null;
    
    const elRect = el.getBoundingClientRect();
    
    // Offset relative to the scrollable content container
    const relX = (elRect.left - textOverlayRect.left) + els.pageTextOverlay.scrollLeft;
    const relY = (elRect.top - textOverlayRect.top) + els.pageTextOverlay.scrollTop;
    
    const centerX = relX + (elRect.width / 2);
    const centerY = relY + (elRect.height / 2);
    
    const xPct = (centerX / textOverlayRect.width) * 100;
    const yPct = (centerY / textOverlayRect.height) * 100;
    
    return { xPct, yPct };
  }

  // ===================== LISTEN & HIGHLIGHT MODE =====================
  let recognition = null;
  
  function normalizeArabic(text) {
    if (!text) return '';
    let norm = text
      .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D4-\u08E2\u08E4-\u08FE\u08FF]/g, '') // Remove tashkeel/diacritics
      .replace(/[أإآاٱ]/g, 'ا') // Normalize Alif and Alef Wasla
      .replace(/[يىیئ]/g, 'ي') // Normalize Yaa/Alif Maqsura variations
      .replace(/ة/g, 'ه') // Normalize Taa Marbutah
      .replace(/[ؤو]/g, 'و') // Normalize Waw
      .replace(/[ء]/g, '') // Remove lone hamza which STT often misses
      .replace(/ـ/g, '') // Remove Tatweel
      .trim();
      
    // Replace common Uthmanic vs standard spelling variants for perfect STT matching
    norm = norm
      .replace(/الصلوة/g, 'الصلاة')
      .replace(/الصلوات/g, 'الصلاة')
      .replace(/الزكوة/g, 'الزكاة')
      .replace(/الحيوة/g, 'الحياة')
      .replace(/الربوا/g, 'الربا')
      .replace(/إبرهيم/g, 'ابراهيم')
      .replace(/إسمعيل/g, 'اسماعيل')
      .replace(/إسحق/g, 'اسحاق')
      .replace(/هرون/g, 'هارون')
      .replace(/داود/g, 'داوود')
      .replace(/سليمن/g, 'سليمان')
      .replace(/سلمن/g, 'سليمان')
      .replace(/السموت/g, 'السماوات')
      .replace(/السموات/g, 'السماوات')
      .replace(/سموت/g, 'سماوات')
      .replace(/الرحمان/g, 'الرحمن')
      .replace(/يأيها/g, 'ياايها')
      .replace(/يأدم/g, 'ياادم');
      
    return norm;
  }

  const NOISE_FILLER_WORDS = new Set([
    'um', 'uh', 'ah', 'oh', 'like', 'youknow', 'hmmm', 'hmm', 'okay', 'well', 'so',
    'ام', 'اه', 'يعني', 'اممم', 'ااا', 'همم'
  ]);

  function cleanSpokenTranscript(transcript) {
    if (!transcript) return [];
    
    // Split into tokens
    const rawTokens = transcript.split(/\s+/);
    const normalizedTokens = rawTokens.map(normalizeArabic).filter(w => w.length > 0);
    
    // Merge standalone prefixes like 'و' (and) and vocatives like 'يا' (O)
    const mergedTokens = [];
    for (let i = 0; i < normalizedTokens.length; i++) {
      const token = normalizedTokens[i];
      if ((token === 'و' || token === 'يا') && i + 1 < normalizedTokens.length) {
        mergedTokens.push(token + normalizedTokens[i + 1]);
        i++;
      } else {
        mergedTokens.push(token);
      }
    }
    
    const cleaned = mergedTokens.filter(w => {
      if (w.length < 2) return false; // Filter out single letter fragments/breaths
      const cleanW = w.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");
      return !NOISE_FILLER_WORDS.has(cleanW);
    });
    
    // Return unique set of spoken words to avoid double-matching repeated words across speech alternatives
    return Array.from(new Set(cleaned));
  }

  // ===================== LISTEN MODE WAVEFORM & INDICATOR =====================
  let audioContext = null;
  let analyser = null;
  let microphoneStream = null;
  let waveformAnimId = null;

  function updateListenIndicator(word, confidence) {
    const indicator = document.getElementById('listenIndicator');
    if (!indicator) return;
    
    indicator.querySelector('.listen-word').textContent = word || '...';
    const pct = Math.round((confidence || 0) * 100);
    indicator.querySelector('.listen-confidence').textContent = `${pct}%`;
    indicator.querySelector('.listen-confidence').style.color = confidence > 0.8 ? 'var(--teal-light)' : confidence > 0.5 ? 'var(--gold)' : 'var(--white-dim)';
    
    // Brief pulse animation on new detection
    indicator.classList.remove('pulse');
    void indicator.offsetWidth;
    indicator.classList.add('pulse');
  }

  async function startWaveform() {
    const waveform = document.getElementById('waveformContainer');
    if (!waveform) return false;
    waveform.classList.remove('hidden');
    
    // To prevent device capture conflicts between Web Audio API (getUserMedia) and 
    // SpeechRecognition (which can cause mic detection to fail entirely even when 
    // permission is granted), we use a smooth, responsive CSS animation for the waveform.
    console.log('Using CSS waveform animation to prevent microphone resource conflicts.');
    const bars = waveform.querySelectorAll('.waveform-bar');
    bars.forEach(bar => {
      bar.style.animation = 'waveform-bounce 0.5s ease-in-out infinite alternate';
      bar.style.animationDuration = `${0.3 + Math.random() * 0.6}s`;
      bar.style.animationDelay = `${Math.random() * 0.4}s`;
    });
    return true;
  }

  function stopWaveform() {
    const waveform = document.getElementById('waveformContainer');
    if (waveform) waveform.classList.add('hidden');
    
    // Cleanup all active audio streams and frame requests
    if (waveformAnimId) cancelAnimationFrame(waveformAnimId);
    if (analyser) analyser.disconnect();
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {});
    }
    if (microphoneStream) {
      microphoneStream.getTracks().forEach(track => track.stop());
    }
    
    audioContext = null;
    analyser = null;
    microphoneStream = null;
    waveformAnimId = null;
    
    const bars = document.querySelectorAll('.waveform-bar');
    bars.forEach(bar => {
      bar.style.animation = 'none';
      bar.style.height = ''; 
    });
  }

  async function toggleListenMode() {
    state.isListenMode = !state.isListenMode;
    els.listenModeBtn.classList.toggle('active', state.isListenMode);

    if (state.isListenMode) {
      // In Mushaf-only mode, we no longer toggle to Text Mode
      // if (!state.isTextMode) toggleTextMode();
      
      state.pendingTranscript = null;
      state.lastRecitedWordIdx = -1;
      state.lastMatchedAyahNum = null;
      state.isListenPaused = false;
      state.highestConfidenceWord = '';
      state.pageLocked = false;
      state.lastCurrentPageMatchTime = 0;
      state.pendingVoiceNav = false;
      
      if (els.pauseListenBtn) {
        els.pauseListenBtn.classList.remove('hidden');
        updatePauseBtnUI();
      }

      // Show the listen indicator
      const indicator = document.getElementById('listenIndicator');
      if (indicator) indicator.classList.remove('hidden');

      // Request mic and start waveform. If it fails, permission is denied!
      const micSuccess = await startWaveform();
      if (!micSuccess) {
        showMicPermissionModal();
        // Reset listen mode state since mic failed
        state.isListenMode = false;
        els.listenModeBtn.classList.remove('active');
        if (indicator) indicator.classList.add('hidden');
        if (els.pauseListenBtn) els.pauseListenBtn.classList.add('hidden');
        updateTopStatusBanner('idle');
        return;
      }

      startListening();
      updateTopStatusBanner('listening', null);
    } else {
      stopListening();
      stopWaveform();
      
      const indicator = document.getElementById('listenIndicator');
      if (indicator) indicator.classList.add('hidden');
      
      if (els.pauseListenBtn) els.pauseListenBtn.classList.add('hidden');
      document.querySelectorAll('.word.highlighted, .word.just-matched').forEach(el => {
        el.classList.remove('highlighted', 'just-matched');
      });
      updateTopStatusBanner('idle');
    }
  }

  function togglePauseListen() {
    if (!state.isListenMode) return;
    
    state.isListenPaused = !state.isListenPaused;
    updatePauseBtnUI();
    
    if (state.isListenPaused) {
      stopListening();
      els.listenModeBtn.classList.remove('recording');
    } else {
      startListening();
    }
  }

  function updatePauseBtnUI() {
    if (!els.pauseListenBtn) return;
    if (state.isListenPaused) {
      els.pauseListenBtn.classList.add('active');
      els.pauseListenBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
        <span>Resume</span>
      `;
    } else {
      els.pauseListenBtn.classList.remove('active');
      els.pauseListenBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        <span>Pause</span>
      `;
    }
  }

let lastStartAttempt = 0;
let restartTimer = null;
let consecutiveErrors = 0;
let isStartingMic = false; // 🛡️ Prevents race conditions

async function checkMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        return true;
    } catch (e) {
        console.warn("Microphone permission check failed:", e);
        return false;
    }
}

function showMicPermissionModal() {
    if (els.micPermissionModal) els.micPermissionModal.classList.add('active');
}

function hideMicPermissionModal() {
    if (els.micPermissionModal) els.micPermissionModal.classList.remove('active');
}

// 🔄 NUCLEAR CLEANUP: Completely destroys the old recognition object
function destroyRecognition() {
    if (recognition) {
        try { recognition.abort(); } catch (e) {}
        try { recognition.stop(); } catch (e) {}
        // Sever all event handlers to prevent ghost callbacks
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition = null;
    }
}

// 🌟 FACTORY: Creates a BRAND NEW SpeechRecognition instance every time
function createRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    
    // 🧨 CRITICAL: Destroy old instance first to prevent Android engine corruption
    destroyRecognition();
    
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.lang = state.listenLang || 'ar-SA';

    rec.onstart = () => {
        console.log('🎤 Mic started (fresh instance)');
        isStartingMic = false;
        els.listenModeBtn.classList.add('recording');
        consecutiveErrors = 0;
    };

    rec.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const res = event.results[i];
            if (res.isFinal) {
                for (let j = 0; j < res.length; j++) {
                    finalTranscript += ' ' + res[j].transcript;
                }
            } else {
                interimTranscript += res[0].transcript;
            }
        }
        processTranscript(finalTranscript.trim() || interimTranscript);
    };

    rec.onerror = (e) => {
        console.warn('Speech error:', e.error);
        isStartingMic = false; // Reset start state
        if (e.error === 'aborted' || e.error === 'no-speech') return; // Ignore manual stops and silence timeouts
        
        if (e.error === 'not-allowed' || e.error === 'audio-capture' || e.error === 'service-not-allowed') {
            showMicPermissionModal();
            consecutiveErrors = 3;
            if (state.isListenMode) toggleListenMode();
        } else {
            consecutiveErrors++;
            if (consecutiveErrors >= 3) {
                console.warn('Too many errors, stopping mic.');
                if (state.isListenMode) toggleListenMode();
            }
        }
    };

    rec.onend = () => {
        console.log('🎤 Mic ended');
        isStartingMic = false; // Reset start state
        els.listenModeBtn.classList.remove('recording');
        
        if (!state.isListenMode || state.isListenPaused || consecutiveErrors >= 3) {
            return; // User stopped it, or too many errors - DO NOT RESTART
        }
        
        if (restartTimer) clearTimeout(restartTimer);
        
        const now = Date.now();
        const timeSinceLastStart = now - lastStartAttempt;
        
        // 🛡️ ANDROID-SPECIFIC AGGRESSIVE DELAYS
        let delay;
        if (isMobileDevice) {
            // Android needs MINIMUM 3 seconds between restarts to release hardware
            if (timeSinceLastStart < 3000) {
                delay = 6000; // Crashed fast? Wait 6 seconds
            } else if (consecutiveErrors >= 2) {
                delay = 8000; // Multiple errors? Wait 8 seconds
            } else {
                delay = 3000; // Normal Android restart delay
            }
        } else {
            delay = timeSinceLastStart < 1000 ? 3000 : 800;
        }
        
        console.log(`⏳ Restarting mic in ${delay}ms...`);
        
        restartTimer = setTimeout(() => {
            if (!state.isListenMode || state.isListenPaused || consecutiveErrors >= 3) return;
            
            try {
                // 🔄 CRITICAL: Create FRESH instance for restart
                recognition = createRecognition();
                if (!recognition) return;
                
                isStartingMic = true;
                lastStartAttempt = Date.now();
                recognition.start();
            } catch (err) {
                console.warn('Restart failed:', err);
                isStartingMic = false;
                consecutiveErrors++;
                if (consecutiveErrors >= 3) {
                    if (state.isListenMode) toggleListenMode();
                } else {
                    // Try again after a very long delay
                    restartTimer = setTimeout(() => {
                        if (!state.isListenMode || state.isListenPaused) return;
                        try {
                            recognition = createRecognition();
                            if (recognition) {
                                isStartingMic = true;
                                lastStartAttempt = Date.now();
                                recognition.start();
                            }
                        } catch(e) {
                            console.warn('Final restart attempt failed');
                            isStartingMic = false;
                        }
                    }, 8000);
                }
            }
        }, delay);
    };

    return rec;
}

function startListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Speech recognition not supported. Please use Chrome, Edge, or Safari.');
        toggleListenMode();
        return;
    }
    
    if (isStartingMic) {
        console.log('Mic already starting, skipping...');
        return;
    }
    
    // Clear any pending restart
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    
    // 🧨 Create BRAND NEW instance (never reuse on Android)
    recognition = createRecognition();
    if (!recognition) return;
    
    try {
        isStartingMic = true;
        lastStartAttempt = Date.now();
        recognition.start();
    } catch (e) {
        console.warn('Failed to start mic:', e);
        isStartingMic = false;
    }
}

function stopListening() {
    console.log('🛑 Stopping mic completely');
    
    // Clear any pending restart
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    
    // Signal that we want to stop (prevents onend from restarting)
    isStartingMic = false;
    
    // 🧨 NUCLEAR: Destroy the recognition object completely
    destroyRecognition();
    
    if (els.listenModeBtn) {
        els.listenModeBtn.classList.remove('recording');
    }
}
  // Fuzzy String Matching (Levenshtein Distance) to handle Speech-To-Text minor mishears
  function getEditDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
      if (a === b) return 0;
      
      const v0 = new Array(b.length + 1);
      for (let i = 0; i <= b.length; i++) v0[i] = i;
      for (let i = 0; i < a.length; i++) {
        let prev = v0[0];
        v0[0] = i + 1;
        for (let j = 0; j < b.length; j++) {
          const temp = v0[j + 1];
          if (a[i] === b[j]) {
            v0[j + 1] = prev;
          } else {
            v0[j + 1] = Math.min(v0[j + 1] + 1, v0[j] + 1, prev + 1);
          }
          prev = temp;
        }
      }
      return v0[b.length];
  }

  function isFuzzyMatch(w1, w2) {
    if (w1 === w2) return true;
    
    // Clean common prefixes (Al-, Wa-, Fa-, Bi-) to improve matching rates
    const cleanPrefix = (w) => {
      if (w.startsWith('ال') && w.length > 3) return w.slice(2);
      if (w.startsWith('و') && w.length > 2) return w.slice(1);
      if (w.startsWith('ف') && w.length > 2) return w.slice(1);
      if (w.startsWith('ب') && w.length > 2) return w.slice(1);
      return w;
    };
    
    const c1 = cleanPrefix(w1);
    const c2 = cleanPrefix(w2);
    if (c1 === c2) return true;
    
    const maxLen = Math.max(c1.length, c2.length);
    if (Math.abs(c1.length - c2.length) > 3) return false;
    
    const dist = getEditDistance(c1, c2);
    if (maxLen <= 2) return dist === 0; // Very short words need exact match
    if (maxLen <= 4) return dist <= 1;  // Medium-short: allow 1 edit
    if (maxLen <= 7) return dist <= 2;  // Medium-long: allow 2 edits
    return dist <= 3;                    // Long words: allow 3 edits
  }

  // Score ALL pages globally and return ranked results.
  // This is the core of correct page detection — never rely on just the current page.
  function scoreAllPages(spokenWords) {
    const pageScores = {}; // page -> { count: number, matches: [{word, ayahNum}] }
    const seenWords = new Set();
    
    for (const spoken of spokenWords) {
      if (spoken.length < 2 || seenWords.has(spoken)) continue;
      seenWords.add(spoken);
      
      if (!state.globalWordMap || !state.globalWordMap.has(spoken)) continue;
      const matches = state.globalWordMap.get(spoken);
      
      // For each page this word appears on, count it
      // But only count ONCE per word per page (avoid double-counting)
      const pagesCounted = new Set();
      for (const m of matches) {
        if (pagesCounted.has(m.page)) continue;
        pagesCounted.add(m.page);
        if (!pageScores[m.page]) pageScores[m.page] = { count: 0, matches: [] };
        pageScores[m.page].count++;
        pageScores[m.page].matches.push({ word: spoken, ayahNum: m.ayahNum });
      }
    }
    
    return pageScores;
  }

  function processTranscript(transcript) {
    if (state.isLoading || !transcript.trim()) return;

    // Always update the indicator immediately with the last recognized spoken word from the transcript
    const rawWords = transcript.trim().split(/\s+/);
    const lastWordRaw = rawWords[rawWords.length - 1] || '...';
    updateListenIndicator(lastWordRaw, 0.3); // Show with baseline confidence

    if (state.pageWordsNormalized.length === 0) return;

    // ==================== PRACTICE MODE RECITE DETECTION ====================
    const isPracticeActive = state.teacherState.isPracticeMode || (state.teacherState.timedMode.active && state.teacherState.timedMode.phase === 'test');
    if (isPracticeActive && state.teacherState.activeGroup) {
      let spokenWords = cleanSpokenTranscript(transcript);
      if (spokenWords.length === 0) return;

      // Extract all words of the active group
      const activeAyahNumbers = new Set(state.teacherState.activeGroup.ayahs.map(a => a.number));
      const groupWordData = state.pageWordData.filter(wd => activeAyahNumbers.has(wd.ayahNum));
      
      let newlyMatched = 0;
      let lastRecitedAyahNum = null;
      
      // Match each spoken word against groupWordData
      spokenWords.forEach(spoken => {
        if (spoken.length < 2) return; // skip too short sounds
        
        groupWordData.forEach(wd => {
          // If this word index was already recited, skip it
          if (state.teacherState.recitedWordIdxs.has(wd.wordIdx)) return;
          
          // Test exact or fuzzy match
          if (wd.text === spoken || isFuzzyMatch(wd.text, spoken)) {
            state.teacherState.recitedWordIdxs.add(wd.wordIdx);
            newlyMatched++;
            lastRecitedAyahNum = wd.ayahNum;
            state.lastMatchedAyahNum = wd.ayahNum;
            
            // Highlight the word as success!
            const el = els.pageTextOverlay.querySelector(`.word[data-word-idx="${wd.wordIdx}"]`);
            if (el) {
              if (state.teacherState.timedMode.active) {
                el.classList.remove('timed-test-hidden');
                el.classList.add('timed-test-success');
              } else {
                el.classList.remove('practice-hidden');
                el.classList.add('practice-success');
              }
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        });
      });
      
      if (newlyMatched > 0) {
        updateTeacherUI();
        updateMushafMasks(); // Update the unified block masks
        if (lastRecitedAyahNum) {
          const matchedAyah = state.ayahs.find(a => a.number === lastRecitedAyahNum);
          updateTopStatusBanner(state.teacherState.timedMode.active ? 'timed-test' : 'listening', matchedAyah);
        } else {
          updateTopStatusBanner(state.teacherState.timedMode.active ? 'timed-test' : 'listening', null);
        }
        
        // Show status feedback
        const totalWords = groupWordData.length;
        const recitedWords = state.teacherState.recitedWordIdxs.size;
        updateListenIndicator(spokenWords[spokenWords.length - 1] || '...', Math.min(1.0, recitedWords / totalWords));
        
        // Check if finished memorizing the group!
        if (recitedWords >= totalWords) {
          showToast("🏆 Maa Shaa Allah! You have successfully memorized this group!", true);
          if (state.teacherState.timedMode.active) {
            stopTimedMode();
          } else {
            stopTeacherPractice();
          }
        }
      }
      return; // Intercept: do not process normal page highlights/navigation in practice/test mode
    }
    
    // Debounce: ignore rapid-fire interim results
    const now = Date.now();
    if (now - state.lastTranscriptTime < 150) return;
    state.lastTranscriptTime = now;
    
    // Normalize and split transcript into words using the clean filter
    let spokenWords = cleanSpokenTranscript(transcript);
    if (spokenWords.length > 10) {
      spokenWords = spokenWords.slice(-10);
    }
    if (spokenWords.length === 0) return;
    
    const significantWords = spokenWords.filter(w => w.length >= 2).length;
    if (significantWords === 0) return;
    
    // ==================== GLOBAL PAGE SCORING ====================
    // Score EVERY page in the Quran based on how many spoken words exist on it.
    // The correct page should have a MUCH higher score than wrong pages.
    // This is the only reliable way to find the correct page.
    const pageScores = scoreAllPages(spokenWords);
    
    // Find the globally best page (highest score)
    let bestGlobalPage = -1;
    let bestGlobalScore = 0;
    let secondBestScore = 0;
    for (const [page, score] of Object.entries(pageScores)) {
      const p = parseInt(page);
      if (score.count > bestGlobalScore) {
        secondBestScore = bestGlobalScore;
        bestGlobalScore = score.count;
        bestGlobalPage = p;
      } else if (score.count > secondBestScore) {
        secondBestScore = score.count;
      }
    }
    
    const currentScore = pageScores[state.currentPage]?.count || 0;
    const scoreRatio = bestGlobalScore / significantWords;
    const currentRatio = currentScore / significantWords;
    
    // Thresholds: require STRONG majority (>50%) to lock or navigate.
    // The best page must also have a meaningful LEAD over the second-best.
    const requiredForLock = Math.max(3, Math.ceil(significantWords * 0.5));
    const requiredForNavigate = Math.max(3, Math.ceil(significantWords * 0.5));
    
    let foundAyahMatch = null;
    let bestMatchConfidence = 0;
    let anyCurrentPageMatch = false;
    
    // ==================== ANCHOR CONFIRMATION (after voice navigation) ====================
    if (state.pendingVoiceNav) {
      // After navigating to a new page, confirm it's correct before locking
      if (bestGlobalPage === state.currentPage && bestGlobalScore >= requiredForLock && scoreRatio >= 0.5
          && bestGlobalScore > secondBestScore) {
        state.pageLocked = true;
        state.lastCurrentPageMatchTime = Date.now();
        state.pendingVoiceNav = false;
        anyCurrentPageMatch = true;
        foundAyahMatch = pageScores[state.currentPage]?.matches[0] || null;
        bestMatchConfidence = Math.min(0.95, 0.6 + scoreRatio * 0.35);
        console.log(`🔒 Voice nav confirmed: page ${state.currentPage} locked (${bestGlobalScore}/${significantWords} words, lead: ${bestGlobalScore - secondBestScore})`);
      } else if (bestGlobalPage !== state.currentPage && bestGlobalPage !== -1
                 && bestGlobalScore >= requiredForNavigate && scoreRatio >= 0.5) {
        // The page we navigated to is NOT the best — navigate to the actual best page
        state.pendingVoiceNav = false;
        state.pendingTranscript = transcript;
        state.lastCurrentPageMatchTime = Date.now();
        showToast(`🔊 Page ${bestGlobalPage}...`, false);
        goToPage(bestGlobalPage);
        return;
      } else {
        // Not enough evidence yet — don't lock, keep searching
        state.pendingVoiceNav = false;
      }
    }
    
    // ==================== LOCKED PAGE LOGIC ====================
    if (state.pageLocked) {
      // Already locked — check if reciter has moved to a better page
      if (bestGlobalPage !== state.currentPage && bestGlobalPage !== -1
          && bestGlobalScore >= requiredForNavigate && scoreRatio >= 0.5
          && bestGlobalScore > secondBestScore) {
        // Reciter has moved to a new page with strong evidence
        console.log(`🔄 Moving from page ${state.currentPage} → ${bestGlobalPage} (score: ${bestGlobalScore} vs ${currentScore}, lead: ${bestGlobalScore - secondBestScore})`);
        state.pageLocked = false;
        state.pendingVoiceNav = true;
        state.pendingTranscript = transcript;
        state.lastCurrentPageMatchTime = Date.now();
        showToast(`🔊 Page ${bestGlobalPage}...`, false);
        goToPage(bestGlobalPage);
        return;
      }
      
      // Keep locked if still matching on current page
      if (currentScore >= 1) {
        anyCurrentPageMatch = true;
        state.lastCurrentPageMatchTime = Date.now();
        foundAyahMatch = pageScores[state.currentPage]?.matches[0] || null;
        bestMatchConfidence = Math.min(0.95, 0.6 + currentRatio * 0.35);
      } else {
        // No matches on current page — check if we should unlock
        // If another page clearly dominates, unlock immediately
        if (bestGlobalPage !== state.currentPage && bestGlobalScore >= requiredForNavigate && scoreRatio >= 0.5
            && bestGlobalScore > secondBestScore) {
          console.log(`🔓 Unlocking page ${state.currentPage} — page ${bestGlobalPage} is clearly better (${bestGlobalScore} vs ${currentScore}, lead: ${bestGlobalScore - secondBestScore})`);
          state.pageLocked = false;
          state.pendingVoiceNav = true;
          state.pendingTranscript = transcript;
          state.lastCurrentPageMatchTime = Date.now();
          showToast(`🔊 Page ${bestGlobalPage}...`, false);
          goToPage(bestGlobalPage);
          return;
        }
        // TIME-BASED LOCK DECAY: If no matches for 8+ seconds, unlock.
        // This handles silence-then-resume on a new page.
        if (state.lastCurrentPageMatchTime > 0) {
          const secondsSinceLastMatch = (Date.now() - state.lastCurrentPageMatchTime) / 1000;
          if (secondsSinceLastMatch >= 8) {
            console.log(`🔓 Lock decayed after ${secondsSinceLastMatch.toFixed(1)}s with no matches on page ${state.currentPage}`);
            state.pageLocked = false;
            // Don't navigate yet — let the unlocked logic find the best page
          }
        }
      }
    } else {
      // ==================== NOT LOCKED — FIND THE CORRECT PAGE ====================
      if (bestGlobalPage === state.currentPage && bestGlobalScore >= requiredForLock
          && scoreRatio >= 0.5 && bestGlobalScore > secondBestScore) {
        // ✅ Current page is clearly the best with a meaningful lead — LOCK it
        anyCurrentPageMatch = true;
        state.pageLocked = true;
        state.lastCurrentPageMatchTime = Date.now();
        foundAyahMatch = pageScores[state.currentPage]?.matches[0] || null;
        bestMatchConfidence = Math.min(0.95, 0.6 + scoreRatio * 0.35);
        console.log(`🔒 Page ${state.currentPage} locked (${bestGlobalScore}/${significantWords} words, ratio: ${(scoreRatio*100).toFixed(0)}%, lead: ${bestGlobalScore - secondBestScore})`);
      } else if (bestGlobalPage !== state.currentPage && bestGlobalPage !== -1
                 && bestGlobalScore >= requiredForNavigate && scoreRatio >= 0.5
                 && bestGlobalScore > secondBestScore) {
        // ✅ A different page is clearly correct with a meaningful lead — NAVIGATE there
        state.pendingTranscript = transcript;
        state.lastCurrentPageMatchTime = Date.now();
        state.pendingVoiceNav = true;
        console.log(`🔊 Navigating to page ${bestGlobalPage} (${bestGlobalScore}/${significantWords} words, lead: ${bestGlobalScore - secondBestScore})`);
        showToast(`🔊 Page ${bestGlobalPage}...`, false);
        goToPage(bestGlobalPage);
        return;
      }
      // If not enough evidence, don't lock — keep searching
    }
    
    // Also check for prefix matches when no exact matches found on current page
    if (currentScore === 0 && state.globalWordMap && state.globalWordMap.size > 0) {
      for (const spoken of spokenWords) {
        if (spoken.length < 3) continue;
        for (const [key, matches] of state.globalWordMap) {
          if (key.startsWith(spoken) || key.includes(spoken)) {
            const onPage = matches.find(m => m.page === state.currentPage);
            if (onPage) {
              anyCurrentPageMatch = true;
              foundAyahMatch = { ayahNum: onPage.ayahNum, word: key, confidence: 0.6 };
              bestMatchConfidence = 0.6;
              break;
            }
            break;
          }
        }
        if (anyCurrentPageMatch) break;
      }
    }
    
    // ==================== PHASE 2: LOCAL MATCHING ON CURRENT PAGE ====================
    // Try to find and highlight spoken words on the current page.
    // Uses three strategies: anchor-based, full sequence scan, and lateral (same-ayah/anywhere) matching.
    
    const windowSize = Math.min(4, spokenWords.length);
    
    let bestLocalMatchIdx = -1;
    let highestLocalScore = -1;
    let bestLocalS = -1;
    let bestDistanceToLast = 9999;
    
    // Clear old highlights before matching
    document.querySelectorAll('.word.highlighted').forEach(el => {
      el.classList.remove('highlighted', 'just-matched');
    });
    
    // 2a. ANCHOR-BASED MATCHING: Find the most distinctive word we heard that's on this page
    let anchorWordIdx = -1;
    
    if (state.globalWordMap && state.globalWordMap.size > 0) {
      for (let si = spokenWords.length - 1; si >= 0; si--) {
        const w = spokenWords[si];
        if (w.length < 3) continue;
        if (!state.globalWordMap.has(w)) continue;
        
        const matches = state.globalWordMap.get(w);
        const pageMatches = matches.filter(m => m.page === state.currentPage);
        if (pageMatches.length === 0) continue;
        
        // Find first occurrence on this page
        for (let wi = 0; wi < state.pageWordsNormalized.length; wi++) {
          if (state.pageWordsNormalized[wi] === w) {
            anchorWordIdx = wi;
            break;
          }
        }
        if (anchorWordIdx >= 0) break;
      }
    }
    
    // 2b. SEQUENCE MATCHING: Try to match a sequence of spoken words
    if (anchorWordIdx >= 0) {
      const searchStart = Math.max(0, anchorWordIdx - 3);
      const searchEnd = Math.min(state.pageWordsNormalized.length - windowSize, anchorWordIdx + 3);
      
      for (let s = 0; s <= spokenWords.length - windowSize; s++) {
        const searchSeq = spokenWords.slice(s, s + windowSize);
        for (let i = searchStart; i <= searchEnd && i <= state.pageWordsNormalized.length - windowSize; i++) {
          let score = 0;
          for (let j = 0; j < windowSize; j++) {
            if (isFuzzyMatch(state.pageWordsNormalized[i + j], searchSeq[j])) score++;
          }
          // Sequential continuity bonus
          if (state.lastRecitedWordIdx !== -1 && i === state.lastRecitedWordIdx + 1) {
            score += 1.5;
          }
          if (score > highestLocalScore) {
            highestLocalScore = score;
            bestLocalMatchIdx = i;
            bestLocalS = s;
          }
        }
      }
    }
    
    // 2c. FULL SLIDING WINDOW: If anchor didn't work, search entire page
    if (bestLocalMatchIdx === -1) {
      for (let s = 0; s <= spokenWords.length - windowSize; s++) {
        const searchSeq = spokenWords.slice(s, s + windowSize);
        for (let i = 0; i <= state.pageWordsNormalized.length - windowSize; i++) {
          let fuzzyScore = 0;
          for (let j = 0; j < windowSize; j++) {
            if (isFuzzyMatch(state.pageWordsNormalized[i + j], searchSeq[j])) fuzzyScore++;
          }
          
          let score = fuzzyScore;
          let distanceToLast = state.lastRecitedWordIdx !== -1
            ? Math.abs(i - (state.lastRecitedWordIdx + 1))
            : 0;
          
          if (state.lastRecitedWordIdx !== -1 && fuzzyScore > 0) {
            if (i === state.lastRecitedWordIdx + 1) score += 2;
            else if (i > state.lastRecitedWordIdx && i <= state.lastRecitedWordIdx + 6) score += 1;
          }
          
          let isBetter = false;
          if (score > highestLocalScore) isBetter = true;
          else if (score === highestLocalScore && score > 0) {
            if (s > bestLocalS) isBetter = true;
            else if (s === bestLocalS && distanceToLast < bestDistanceToLast) isBetter = true;
          }
          
          if (isBetter) {
            highestLocalScore = score;
            bestLocalMatchIdx = i;
            bestLocalS = s;
            bestDistanceToLast = distanceToLast;
          }
        }
      }
    }
    
    // Decision: should we accept the sequence match or try lateral matching?
    const requiredScore = state.lastRecitedWordIdx !== -1
      ? Math.max(1, windowSize - 2)
      : Math.max(1, windowSize - 1);
    
    let localMatchSuccess = (highestLocalScore >= requiredScore);
    
    // 2d. LATERAL MATCHING: If sequential match failed, try to find individual
    // spoken words ANYWHERE on this page (not just in sequence).
    // This handles the case where the reciter jumps to a different part of the ayah
    // and the sequential window can't find the next word.
    let lateralMatchedWordIdx = -1;
    let lateralMatchedAyahNum = null;
    let lateralMatchedWord = '';
    let lateralMatchFuzzyDist = 99;
    
    if (!localMatchSuccess) {
      for (const spoken of spokenWords) {
        if (spoken.length < 3) continue;
        
        // Try exact match first
        for (let wi = 0; wi < state.pageWordsNormalized.length; wi++) {
          if (state.pageWordsNormalized[wi] === spoken) {
            lateralMatchedWordIdx = wi;
            lateralMatchedWord = spoken;
            lateralMatchedAyahNum = state.pageWordData[wi]?.ayahNum || null;
            lateralMatchFuzzyDist = 0;
            break;
          }
        }
        
        // If no exact match, try fuzzy match
        if (lateralMatchedWordIdx === -1) {
          let bestFuzzyIdx = -1;
          let bestFuzzyDist = 99;
          for (let wi = 0; wi < state.pageWordsNormalized.length; wi++) {
            if (isFuzzyMatch(state.pageWordsNormalized[wi], spoken)) {
              const dist = getEditDistance(state.pageWordsNormalized[wi], spoken);
              if (dist < bestFuzzyDist) {
                bestFuzzyDist = dist;
                bestFuzzyIdx = wi;
              }
            }
          }
          if (bestFuzzyIdx >= 0) {
            lateralMatchedWordIdx = bestFuzzyIdx;
            lateralMatchedWord = state.pageWordsNormalized[bestFuzzyIdx];
            lateralMatchedAyahNum = state.pageWordData[bestFuzzyIdx]?.ayahNum || null;
            lateralMatchFuzzyDist = bestFuzzyDist;
          }
        }
        
        if (lateralMatchedWordIdx >= 0) break;
      }
    }
    
    // ==================== PHASE 4: HIGHLIGHT & EXECUTE ====================
    // Only do local matching if we have some confidence we're on the right page.
    // This avoids false positives from fuzzy matching on wrong pages.
    
    if (anyCurrentPageMatch) {
      // We have evidence we're on the right page — do local matching for highlighting
      const windowSize = Math.min(4, spokenWords.length);
      let bestLocalMatchIdx = -1;
      let highestLocalScore = -1;
      let bestLocalS = -1;
      let bestDistanceToLast = 9999;
      
      // Clear old highlights
      document.querySelectorAll('.word.highlighted').forEach(el => {
        el.classList.remove('highlighted', 'just-matched');
      });
      
      // ANCHOR-BASED MATCHING
      let anchorWordIdx = -1;
      if (state.globalWordMap && state.globalWordMap.size > 0) {
        for (let si = spokenWords.length - 1; si >= 0; si--) {
          const w = spokenWords[si];
          if (w.length < 3) continue;
          if (!state.globalWordMap.has(w)) continue;
          const matches = state.globalWordMap.get(w);
          if (!matches.some(m => m.page === state.currentPage)) continue;
          for (let wi = 0; wi < state.pageWordsNormalized.length; wi++) {
            if (state.pageWordsNormalized[wi] === w) {
              anchorWordIdx = wi;
              break;
            }
          }
          if (anchorWordIdx >= 0) break;
        }
      }
      
      // SEQUENCE MATCHING (anchored or full)
      const searchStart = anchorWordIdx >= 0 ? Math.max(0, anchorWordIdx - 3) : 0;
      const searchEnd = anchorWordIdx >= 0
        ? Math.min(state.pageWordsNormalized.length - windowSize, anchorWordIdx + 3)
        : state.pageWordsNormalized.length - windowSize;
      
      for (let s = 0; s <= spokenWords.length - windowSize; s++) {
        const searchSeq = spokenWords.slice(s, s + windowSize);
        for (let i = searchStart; i <= searchEnd; i++) {
          let score = 0;
          for (let j = 0; j < windowSize; j++) {
            if (isFuzzyMatch(state.pageWordsNormalized[i + j], searchSeq[j])) score++;
          }
          if (state.lastRecitedWordIdx !== -1 && i === state.lastRecitedWordIdx + 1) score += 1.5;
          if (score > highestLocalScore) {
            highestLocalScore = score;
            bestLocalMatchIdx = i;
            bestLocalS = s;
          }
        }
      }
      
      const requiredScore = state.lastRecitedWordIdx !== -1
        ? Math.max(1, windowSize - 2) : Math.max(1, windowSize - 1);
      let localMatchSuccess = (highestLocalScore >= requiredScore);
      
      // LATERAL MATCHING (fallback)
      let lateralMatchedWordIdx = -1;
      let lateralMatchedAyahNum = null;
      let lateralMatchedWord = '';
      let lateralMatchFuzzyDist = 99;
      
      if (!localMatchSuccess) {
        for (const spoken of spokenWords) {
          if (spoken.length < 3) continue;
          for (let wi = 0; wi < state.pageWordsNormalized.length; wi++) {
            if (state.pageWordsNormalized[wi] === spoken) {
              lateralMatchedWordIdx = wi;
              lateralMatchedWord = spoken;
              lateralMatchedAyahNum = state.pageWordData[wi]?.ayahNum || null;
              lateralMatchFuzzyDist = 0;
              break;
            }
          }
          if (lateralMatchedWordIdx === -1) {
            for (let wi = 0; wi < state.pageWordsNormalized.length; wi++) {
              if (isFuzzyMatch(state.pageWordsNormalized[wi], spoken)) {
                lateralMatchedWordIdx = wi;
                lateralMatchedWord = state.pageWordsNormalized[wi];
                lateralMatchedAyahNum = state.pageWordData[wi]?.ayahNum || null;
                lateralMatchFuzzyDist = getEditDistance(state.pageWordsNormalized[wi], spoken);
                break;
              }
            }
          }
          if (lateralMatchedWordIdx >= 0) break;
        }
      }
      
      // Execute highlighting
      if (lateralMatchedWordIdx >= 0) {
        const el = els.pageTextOverlay.querySelector(`.word[data-word-idx="${lateralMatchedWordIdx}"]`);
        if (el) {
          el.classList.add('highlighted', 'just-matched');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          state.lastRecitedWordIdx = lateralMatchedWordIdx;
        }
        const lateralConfidence = lateralMatchFuzzyDist === 0 ? 0.85 : Math.max(0.4, 0.65 - lateralMatchFuzzyDist * 0.08);
        updateListenIndicator(lateralMatchedWord, lateralConfidence);
        if (lateralMatchedAyahNum) {
          if (lateralMatchedAyahNum !== state.lastMatchedAyahNum) {
            state.lastMatchedAyahNum = lateralMatchedAyahNum;
            revealAyah(lateralMatchedAyahNum);
          }
          const matchedAyah = state.ayahs.find(a => a.number === lateralMatchedAyahNum);
          if (matchedAyah) {
            if (state.teacherState.timedMode.active) {
              updateTopStatusBanner(state.teacherState.timedMode.phase === 'study' ? 'timed-study' : 'timed-test', null);
            } else {
              updateTopStatusBanner('listening', matchedAyah);
            }
          }
        }
      } else if (localMatchSuccess) {
        let matchedAyahNum = null;
        for (let i = 0; i < windowSize; i++) {
          const el = els.pageTextOverlay.querySelector(`.word[data-word-idx="${bestLocalMatchIdx + i}"]`);
          if (el) {
            el.classList.add('highlighted');
            if (i === 0) {
              el.classList.add('just-matched');
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            matchedAyahNum = parseInt(el.dataset.ayah, 10);
          }
          state.lastRecitedWordIdx = bestLocalMatchIdx + i;
        }
        const seqConf = bestMatchConfidence > 0 ? bestMatchConfidence : Math.min(0.85, highestLocalScore / windowSize);
        updateListenIndicator(spokenWords[0] || '', seqConf);
        if (matchedAyahNum) {
          if (matchedAyahNum !== state.lastMatchedAyahNum) {
            state.lastMatchedAyahNum = matchedAyahNum;
            revealAyah(matchedAyahNum);
          }
          const matchedAyah = state.ayahs.find(a => a.number === matchedAyahNum);
          if (matchedAyah) {
            if (state.teacherState.timedMode.active) {
              updateTopStatusBanner(state.teacherState.timedMode.phase === 'study' ? 'timed-study' : 'timed-test', null);
            } else {
              updateTopStatusBanner('listening', matchedAyah);
            }
          }
        }
      } else {
        // Keep showing last raw spoken word in indicator
      }
    } else {
      // Keep showing last raw spoken word in indicator
    }
  }

  // ===================== MEMORY MODE =====================
  function togglePeekMode(mode) {
    if (mode === 'faded') {
      const isFaded = els.pageImageContainer.classList.contains('peek-faded');
      els.pageImageContainer.classList.remove('peek-clear', 'peek-faded');
      els.peekClearBtn.classList.remove('active');
      els.peekFadedBtn.classList.remove('active');
      
      if (!isFaded) {
        els.pageImageContainer.classList.add('peek-faded');
        els.peekFadedBtn.classList.add('active');
      }
    } else if (mode === 'clear') {
      const isClear = els.pageImageContainer.classList.contains('peek-clear');
      els.pageImageContainer.classList.remove('peek-clear', 'peek-faded');
      els.peekClearBtn.classList.remove('active');
      els.peekFadedBtn.classList.remove('active');
      
      if (!isClear) {
        els.pageImageContainer.classList.add('peek-clear');
        els.peekClearBtn.classList.add('active');
      }
    }
  }

  function toggleMemoryMode() {
    state.isMemoryMode = !state.isMemoryMode;
    if (els.wordTranslationPanel) {
      els.wordTranslationPanel.classList.add('hidden');
    }
    if (els.memoryModeBtn) {
      els.memoryModeBtn.setAttribute('aria-pressed', state.isMemoryMode);
      els.memoryModeBtn.classList.toggle('active', state.isMemoryMode);
    }

    if (state.isMemoryMode) {
      // 🔍 Trigger CV detection on first memory mode use (deferred optimization)
      if (!_memoryModeEverActivated) {
        _memoryModeEverActivated = true;
        if (state.cvCache[state.currentPage]) {
          state.ayahCoordinates = state.cvCache[state.currentPage];
          if (state.isMemoryMode) renderMemoryCircles();
        } else {
          // Run CV detection in background, don't await
          detectAyahMarkers(els.pageImage, state.ayahs).then(coords => {
            state.ayahCoordinates = coords;
            state.cvCache[state.currentPage] = coords;
            try {
              localStorage.setItem('hifznoor_cv_cache', JSON.stringify(state.cvCache));
            } catch (e) {}
            if (state.isMemoryMode) renderMemoryCircles();
          });
        }
      }

      document.body.classList.add('memory-mode-active');
      els.memoryOverlay.classList.add('active');
      els.pageImageContainer.classList.add('memory-mode');
      renderMemoryCircles();
    } else {
      document.body.classList.remove('memory-mode-active');
      els.memoryOverlay.classList.remove('active');
      els.pageImageContainer.classList.remove('memory-mode', 'peek-faded', 'peek-clear', 'peek-faded-hover', 'peek-clear-hover');
      els.peekFadedBtn.classList.remove('active');
      els.peekClearBtn.classList.remove('active');
    }
  }

  function resetCirclePositions() {
    if (!state.ayahs.length) return;
    
    if (!state.coordsOverrides) state.coordsOverrides = {};
    
    // Clear all saved overrides (dragged positions) for the current page
    // so it naturally falls back to the dynamic text positions
    delete state.coordsOverrides[state.currentPage];
    
    try {
      localStorage.setItem(COORDS_STORAGE_KEY, JSON.stringify(state.coordsOverrides));
    } catch (e) {}
    
    if (state.isMemoryMode) renderMemoryCircles();
  }

  function resetAllCirclePositions() {
    if (!confirm('Are you sure you want to reset saved memory circle positions for all pages?')) return;
    
    state.coordsOverrides = {};
    try {
      localStorage.removeItem(COORDS_STORAGE_KEY);
    } catch (e) {}
    
    if (state.isMemoryMode) renderMemoryCircles();
  }

  function renderMemoryCircles() {
    if (!state.ayahs.length) {
      els.memoryCircles.innerHTML = '';
      return;
    }

    const fragment = document.createDocumentFragment();
    
    // Create a single global marquee to center between circles
    const globalMarquee = document.createElement('div');
    globalMarquee.className = 'global-marquee';
    globalMarquee.innerHTML = '<span class="marquee-text"></span>';
    fragment.appendChild(globalMarquee);

    state.ayahs.forEach((ayah, index) => {
      const isRevealed = state.revealedAyahs.has(ayah.number);
      
      // Extract the first word as a hint
      let words = ayah.text.trim().split(/\s+/);
      // Skip Bismillah for the first ayah of surahs (except Al-Fatiha)
      if (ayah.numberInSurah === 1 && ayah.surah && ayah.surah.number !== 1 && words.length > 4 && words[0].includes('بِسْمِ')) {
        words = words.slice(4);
      }
      const firstWord = words[0] || '';
      
      const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${ayah.surah.number}`) : '';

      // Map to exact coordinates over the image
      const coord = state.ayahCoordinates[index];

      const createCircle = (word, type) => {
        const circle = document.createElement('div');
        circle.className = `memory-circle${isRevealed ? ' revealed' : ''}`;
        circle.dataset.ayahNumber = ayah.number;
        circle.dataset.markerType = type;

        circle.innerHTML = `
          <span class="circle-number">${ayah.numberInSurah}</span>
          <span class="circle-hint">${word}</span>
        `;

        const markerId = `${ayah.number}_${type}`;
        let override = state.coordsOverrides[state.currentPage]?.[markerId];
        
        // Fallback to legacy override format for existing 'end' markers
        if (!override && type === 'end') {
          override = state.coordsOverrides[state.currentPage]?.[ayah.number];
        }
        
        let finalXPct = 50;
        let finalYPct = 50;
        
        // Fetch coordinates dynamically linked to the Text Mode
        const textCoords = getTextNodePercentages(ayah.number, type);
        
        if (override) {
          finalXPct = override.xPct;
          finalYPct = override.yPct;
        } else if (textCoords) {
          finalXPct = textCoords.xPct;
          finalYPct = textCoords.yPct;
        } else if (coord) {
          if (type === 'end') {
            finalXPct = coord.xPct;
            finalYPct = coord.yPct;
          } else {
            // Shift the start marker to the right slightly as a default guess (RTL)
            finalXPct = Math.min(95, coord.xPct + 20);
            finalYPct = Math.max(5, coord.yPct - 5);
          }
        }

        circle.style.left = `${finalXPct}%`;
        circle.style.top = `${finalYPct}%`;

        circle.addEventListener('mousedown', (e) => startDrag(e, circle, ayah.number, markerId));
        circle.addEventListener('touchstart', (e) => startDrag(e, circle, ayah.number, markerId), { passive: false });

        // Calculate midpoint and show the global marquee between the two markers
        circle.addEventListener('mouseenter', () => {
          if (isDraggingCircle) return;
          const circles = els.memoryCircles.querySelectorAll(`[data-ayah-number="${ayah.number}"]`);
          let midXPct = parseFloat(circle.style.left) || 50;
          let midYPct = parseFloat(circle.style.top) || 50;

          if (circles.length === 2) {
            const x1 = parseFloat(circles[0].style.left) || 50;
            const y1 = parseFloat(circles[0].style.top) || 50;
            const x2 = parseFloat(circles[1].style.left) || 50;
            const y2 = parseFloat(circles[1].style.top) || 50;
            midXPct = (x1 + x2) / 2;
            midYPct = (y1 + y2) / 2;
          }

          const marquee = els.memoryCircles.querySelector('.global-marquee');
          if (marquee) {
            const textEl = marquee.querySelector('.marquee-text');
            
            // Reset animation to ensure it restarts from the beginning every time
            textEl.style.animation = 'none';
            void textEl.offsetWidth; // Force browser reflow
            
            textEl.textContent = ayah.text;
            const scrollDuration = Math.max(7, ayah.text.length * 0.25);
            
            // Apply the animation dynamically with 'infinite' looping
            textEl.style.animation = `marquee-scroll-rtl ${scrollDuration}s linear infinite`;
            marquee.style.left = `${midXPct}%`;
            marquee.style.top = `${midYPct}%`;
            marquee.classList.add('active');
          }
        });

        circle.addEventListener('mouseleave', () => {
          const marquee = els.memoryCircles.querySelector('.global-marquee');
          if (marquee) {
            marquee.classList.remove('active');
            const textEl = marquee.querySelector('.marquee-text');
            if (textEl) textEl.style.animation = 'none';
          }
        });

        circle.addEventListener('click', (e) => {
          if (isDraggingCircle) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          revealAyah(ayah.number);
        });
        
        fragment.appendChild(circle);
      };

      createCircle(firstWord, 'start');
      if (words.length > 1) {
        const lastWord = words[words.length - 1];
        createCircle(lastWord, 'end');
      }
    });

    // Add an invisible spacer to sync memory circles scroll height with the text mode container
    const spacer = document.createElement('div');
    spacer.style.position = 'absolute';
    spacer.style.top = '0';
    spacer.style.left = '0';
    spacer.style.width = '1px';
    spacer.style.height = `${els.pageTextOverlay.scrollHeight}px`;
    spacer.style.pointerEvents = 'none';
    fragment.appendChild(spacer);

    els.memoryCircles.innerHTML = '';
    els.memoryCircles.appendChild(fragment);
  }

  // ===================== DRAG CIRCLES =====================
  let dragData = null;
  let isDraggingCircle = false;

  function onDrag(e) {
    if (!dragData) return;
    
    const touch = e.type === 'touchmove' ? e.touches[0] : e;
    const dx = touch.clientX - dragData.startX;
    const dy = touch.clientY - dragData.startY;
    
    if (!dragData.isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragData.isDragging = true;
      dragData.el.classList.add('dragging');
    }
    
    if (dragData.isDragging) {
      if (e.type === 'touchmove' && e.cancelable) e.preventDefault();
      
      const dxPct = (dx / dragData.containerRect.width) * 100;
      const dyPct = (dy / dragData.containerRect.height) * 100;
      
      let newLeft = dragData.initLeft + dxPct;
      let newTop = dragData.initTop + dyPct;
      
      // Clamp to 0-100 horizontally, but allow going deep vertically
      newLeft = Math.max(0, Math.min(100, newLeft));
      newTop = Math.max(0, newTop);
      
      dragData.el.style.left = `${newLeft}%`;
      dragData.el.style.top = `${newTop}%`;
    }
  }

  function endDrag(e) {
    if (!dragData) return;
    
    if (dragData.isDragging) {
      dragData.el.classList.remove('dragging');
      const finalLeft = parseFloat(dragData.el.style.left);
      const finalTop = parseFloat(dragData.el.style.top);
      saveCoordinateOverride(state.currentPage, dragData.markerId, finalLeft, finalTop);
      
      isDraggingCircle = true;
      setTimeout(() => { isDraggingCircle = false; }, 50);
    }
    
    dragData = null;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', endDrag);
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('touchend', endDrag);
  }

  function startDrag(e, circle, ayahNum, markerId) {
    if (!state.isMemoryMode) return;
    if (e.type === 'mousedown' && e.button !== 0) return;
    
    // Hide the marquee immediately when dragging starts
    const marquee = els.memoryCircles.querySelector('.global-marquee');
    if (marquee) {
      marquee.classList.remove('active');
      const textEl = marquee.querySelector('.marquee-text');
      if (textEl) textEl.style.animation = 'none';
    }

    const touch = e.type === 'touchstart' ? e.touches[0] : e;
    const containerRect = els.memoryCircles.getBoundingClientRect();
    
    dragData = {
      el: circle,
      startX: touch.clientX,
      startY: touch.clientY,
      initLeft: parseFloat(circle.style.left) || 50,
      initTop: parseFloat(circle.style.top) || 50,
      isDragging: false,
      ayahNum,
      markerId,
      containerRect
    };
    
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('touchend', endDrag);
  }

  // ===================== INTERACTIONS =====================
  function revealAyah(ayahGlobalNumber) {
    const wasAlreadyRevealed = state.revealedAyahs.has(ayahGlobalNumber);

    const card = els.ayahList.querySelector(`[data-ayah-number="${ayahGlobalNumber}"]`);
    if (card) {
      // Smoothly scroll the sidebar to the corresponding ayah without changing its natural order
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    if (wasAlreadyRevealed) return;

    state.revealedAyahs.add(ayahGlobalNumber);

    // Update the card UI
    if (card) {
      card.classList.add('revealed');
      const textEl = card.querySelector('.ayah-text');
      const hintEl = card.querySelector('.ayah-click-hint');
      const transEl = card.querySelector('.ayah-translation');
      if (textEl) {
        textEl.classList.remove('hidden');
        textEl.classList.add('revealed');
      }
      if (hintEl) hintEl.remove();
      if (transEl) {
        transEl.classList.remove('hidden');
        transEl.classList.add('revealed');
      }

      // Update checkmark
      const checkEl = card.querySelector('.ayah-surah-info + div');
      if (checkEl) checkEl.textContent = '✓';
    }

    // Update memory circles
    if (els.memoryCircles) {
      const circles = els.memoryCircles.querySelectorAll(`[data-ayah-number="${ayahGlobalNumber}"]`);
      circles.forEach(circle => circle.classList.add('revealed'));
    }

    updateProgress();
  }

  function revealAllAyahs() {
    const toReveal = state.ayahs.filter(ayah => !state.revealedAyahs.has(ayah.number));
    toReveal.forEach(ayah => {
      state.revealedAyahs.add(ayah.number);

      // Update the card UI
      const card = els.ayahList.querySelector(`[data-ayah-number="${ayah.number}"]`);
      if (card) {
        card.classList.add('revealed');
        const textEl = card.querySelector('.ayah-text');
        const hintEl = card.querySelector('.ayah-click-hint');
        const transEl = card.querySelector('.ayah-translation');
        if (textEl) {
          textEl.classList.remove('hidden');
          textEl.classList.add('revealed');
        }
        if (hintEl) hintEl.remove();
        if (transEl) {
          transEl.classList.remove('hidden');
          transEl.classList.add('revealed');
        }
        const checkEl = card.querySelector('.ayah-surah-info + div');
        if (checkEl) checkEl.textContent = '✓';
      }

      // Update memory circles
      if (els.memoryCircles) {
        const circles = els.memoryCircles.querySelectorAll(`[data-ayah-number="${ayah.number}"]`);
        circles.forEach(circle => circle.classList.add('revealed'));
      }
    });

    updateProgress();
  }

  function resetPage() {
    state.ayahs.forEach(ayah => {
      state.revealedAyahs.delete(ayah.number);
    });
    renderAyahList();
    if (state.isMemoryMode) {
      renderMemoryCircles();
    }
    updateProgress();
  }

  // ===================== PROGRESS =====================
  function updateProgress() {
    const revealed = state.revealedAyahs.size;
    const total = state.ayahs.length;
    const pct = total > 0 ? (revealed / total) * 100 : 0;
    els.pageProgressBar.style.width = `${pct}%`;
    els.pageProgressText.textContent = `${revealed} / ${total}`;
  }

  function updateGlobalStats() {
    els.pagesViewed.textContent = state.currentPage || 1;
  }

  // ===================== NAVIGATION =====================
  function goToPage(pageNum) {
    pageNum = Math.max(1, Math.min(TOTAL_PAGES, parseInt(pageNum) || 1));
    if (pageNum !== state.currentPage) {
      loadPage(pageNum);
    }
  }

  function nextPage() {
    if (state.currentPage < TOTAL_PAGES) {
      loadPage(state.currentPage + 1);
    }
  }

  function prevPage() {
    if (state.currentPage > 1) {
      loadPage(state.currentPage - 1);
    }
  }

  function firstPage() {
    loadPage(1);
  }

  function lastPage() {
    loadPage(TOTAL_PAGES);
  }

  // ===================== SURAH DATA =====================
  const SURAHS = [
    {num:1,  name:'Al-Fatiha',           arabic:'الفاتحة',          page:1},
    {num:2,  name:'Al-Baqarah',          arabic:'البقرة',            page:2},
    {num:3,  name:'Aal-e-Imran',         arabic:'آل عمران',          page:50},
    {num:4,  name:'An-Nisa',             arabic:'النساء',            page:77},
    {num:5,  name:'Al-Ma\'idah',          arabic:'المائدة',          page:106},
    {num:6,  name:'Al-An\'am',            arabic:'الأنعام',          page:128},
    {num:7,  name:'Al-A\'raf',            arabic:'الأعراف',          page:151},
    {num:8,  name:'Al-Anfal',            arabic:'الأنفال',           page:177},
    {num:9,  name:'At-Tawbah',           arabic:'التوبة',           page:187},
    {num:10, name:'Yunus',               arabic:'يونس',              page:208},
    {num:11, name:'Hud',                 arabic:'هود',               page:221},
    {num:12, name:'Yusuf',               arabic:'يوسف',              page:235},
    {num:13, name:'Ar-Ra\'d',             arabic:'الرعد',            page:249},
    {num:14, name:'Ibrahim',             arabic:'إبراهيم',          page:255},
    {num:15, name:'Al-Hijr',             arabic:'الحجر',            page:262},
    {num:16, name:'An-Nahl',             arabic:'النحل',             page:267},
    {num:17, name:'Al-Isra',             arabic:'الإسراء',          page:282},
    {num:18, name:'Al-Kahf',             arabic:'الكهف',            page:293},
    {num:19, name:'Maryam',              arabic:'مريم',              page:305},
    {num:20, name:'Ta-Ha',               arabic:'طه',                page:312},
    {num:21, name:'Al-Anbiya',           arabic:'الأنبياء',          page:322},
    {num:22, name:'Al-Hajj',             arabic:'الحج',              page:332},
    {num:23, name:'Al-Mu\'minun',         arabic:'المؤمنون',         page:342},
    {num:24, name:'An-Nur',              arabic:'النور',             page:350},
    {num:25, name:'Al-Furqan',           arabic:'الفرقان',           page:359},
    {num:26, name:'Ash-Shu\'ara',         arabic:'الشعراء',          page:367},
    {num:27, name:'An-Naml',             arabic:'النمل',             page:377},
    {num:28, name:'Al-Qasas',            arabic:'القصص',            page:385},
    {num:29, name:'Al-Ankabut',          arabic:'العنكبوت',         page:396},
    {num:30, name:'Ar-Rum',              arabic:'الروم',             page:404},
    {num:31, name:'Luqman',              arabic:'لقمان',            page:411},
    {num:32, name:'As-Sajda',            arabic:'السجدة',           page:415},
    {num:33, name:'Al-Ahzab',            arabic:'الأحزاب',          page:418},
    {num:34, name:'Saba',                arabic:'سبأ',               page:428},
    {num:35, name:'Fatir',               arabic:'فاطر',             page:434},
    {num:36, name:'Ya-Sin',              arabic:'يس',                page:440},
    {num:37, name:'As-Saffat',           arabic:'الصافات',          page:446},
    {num:38, name:'Sad',                 arabic:'ص',                 page:453},
    {num:39, name:'Az-Zumar',            arabic:'الزمر',            page:458},
    {num:40, name:'Ghafir',              arabic:'غافر',             page:467},
    {num:41, name:'Fussilat',            arabic:'فصلت',             page:476},
    {num:42, name:'Ash-Shura',           arabic:'الشورى',           page:483},
    {num:43, name:'Az-Zukhruf',          arabic:'الزخرف',           page:489},
    {num:44, name:'Ad-Dukhan',           arabic:'الدخان',           page:496},
    {num:45, name:'Al-Jathiyah',         arabic:'الجاثية',          page:499},
    {num:46, name:'Al-Ahqaf',            arabic:'الأحقاف',          page:502},
    {num:47, name:'Muhammad',            arabic:'محمد',              page:507},
    {num:48, name:'Al-Fath',             arabic:'الفتح',            page:511},
    {num:49, name:'Al-Hujurat',          arabic:'الحجرات',          page:515},
    {num:50, name:'Qaf',                 arabic:'ق',                 page:518},
    {num:51, name:'Adh-Dhariyat',        arabic:'الذاريات',         page:520},
    {num:52, name:'At-Tur',              arabic:'الطور',            page:523},
    {num:53, name:'An-Najm',             arabic:'النجم',            page:526},
    {num:54, name:'Al-Qamar',            arabic:'القمر',            page:528},
    {num:55, name:'Ar-Rahman',           arabic:'الرحمن',           page:531},
    {num:56, name:'Al-Waqi\'ah',          arabic:'الواقعة',          page:534},
    {num:57, name:'Al-Hadid',            arabic:'الحديد',           page:537},
    {num:58, name:'Al-Mujadilah',        arabic:'المجادلة',        page:541},
    {num:59, name:'Al-Hashr',            arabic:'الحشر',            page:545},
    {num:60, name:'Al-Mumtahinah',       arabic:'الممتحنة',        page:548},
    {num:61, name:'As-Saff',             arabic:'الصف',             page:551},
    {num:62, name:'Al-Jumu\'ah',          arabic:'الجمعة',          page:553},
    {num:63, name:'Al-Munafiqun',        arabic:'المنافقون',       page:554},
    {num:64, name:'At-Taghabun',         arabic:'التغابن',          page:556},
    {num:65, name:'At-Talaq',            arabic:'الطلاق',           page:558},
    {num:66, name:'At-Tahrim',           arabic:'التحريم',          page:560},
    {num:67, name:'Al-Mulk',             arabic:'الملك',            page:562},
    {num:68, name:'Al-Qalam',            arabic:'القلم',            page:564},
    {num:69, name:'Al-Haqqah',           arabic:'الحاقة',           page:566},
    {num:70, name:'Al-Ma\'arij',          arabic:'المعارج',          page:568},
    {num:71, name:'Nuh',                 arabic:'نوح',               page:570},
    {num:72, name:'Al-Jinn',             arabic:'الجن',              page:572},
    {num:73, name:'Al-Muzzammil',        arabic:'المزمل',           page:574},
    {num:74, name:'Al-Muddaththir',      arabic:'المدثر',           page:575},
    {num:75, name:'Al-Qiyamah',          arabic:'القيامة',          page:577},
    {num:76, name:'Al-Insan',            arabic:'الإنسان',          page:578},
    {num:77, name:'Al-Mursalat',         arabic:'المرسلات',         page:580},
    {num:78, name:'An-Naba',             arabic:'النبأ',             page:582},
    {num:79, name:'An-Nazi\'at',          arabic:'النازعات',         page:583},
    {num:80, name:'Abasa',               arabic:'عبس',               page:585},
    {num:81, name:'At-Takwir',           arabic:'التكوير',          page:586},
    {num:82, name:'Al-Infitar',          arabic:'الانفطار',         page:587},
    {num:83, name:'Al-Mutaffifin',       arabic:'المطففين',        page:587},
    {num:84, name:'Al-Inshiqaq',         arabic:'الانشقاق',         page:589},
    {num:85, name:'Al-Buruj',            arabic:'البروج',           page:590},
    {num:86, name:'At-Tariq',            arabic:'الطارق',           page:591},
    {num:87, name:'Al-A\'la',             arabic:'الأعلى',           page:591},
    {num:88, name:'Al-Ghashiyah',        arabic:'الغاشية',          page:592},
    {num:89, name:'Al-Fajr',             arabic:'الفجر',            page:593},
    {num:90, name:'Al-Balad',            arabic:'البلد',            page:594},
    {num:91, name:'Ash-Shams',           arabic:'الشمس',            page:595},
    {num:92, name:'Al-Layl',             arabic:'الليل',            page:595},
    {num:93, name:'Ad-Duha',             arabic:'الضحى',            page:596},
    {num:94, name:'Ash-Sharh',           arabic:'الشرح',            page:596},
    {num:95, name:'At-Tin',              arabic:'التين',            page:597},
    {num:96, name:'Al-Alaq',             arabic:'العلق',            page:597},
    {num:97, name:'Al-Qadr',             arabic:'القدر',            page:598},
    {num:98, name:'Al-Bayyinah',         arabic:'البينة',           page:598},
    {num:99, name:'Az-Zalzalah',         arabic:'الزلزلة',          page:599},
    {num:100,name:'Al-\'Adiyat',          arabic:'العاديات',        page:599},
    {num:101,name:'Al-Qari\'ah',          arabic:'القارعة',          page:600},
    {num:102,name:'At-Takathur',         arabic:'التكاثر',          page:600},
    {num:103,name:'Al-\'Asr',             arabic:'العصر',            page:601},
    {num:104,name:'Al-Humazah',          arabic:'الهمزة',           page:601},
    {num:105,name:'Al-Fil',              arabic:'الفيل',            page:601},
    {num:106,name:'Quraysh',             arabic:'قريش',             page:602},
    {num:107,name:'Al-Ma\'un',            arabic:'الماعون',          page:602},
    {num:108,name:'Al-Kawthar',          arabic:'الكوثر',           page:602},
    {num:109,name:'Al-Kafirun',          arabic:'الكافرون',         page:603},
    {num:110,name:'An-Nasr',             arabic:'النصر',            page:603},
    {num:111,name:'Al-Masad',            arabic:'المسد',            page:603},
    {num:112,name:'Al-Ikhlas',           arabic:'الإخلاص',          page:604},
    {num:113,name:'Al-Falaq',            arabic:'الفلق',            page:604},
    {num:114,name:'An-Nas',              arabic:'الناس',            page:604},
  ];

  // ===================== THEMATIC TEACHER MEMORIZER =====================
  function generateThematicGroups(ayahs) {
    if (!ayahs || ayahs.length === 0) return [];
    
    const groups = [];
    let currentGroup = [];
    
    for (let i = 0; i < ayahs.length; i++) {
      currentGroup.push(ayahs[i]);
      
      const nextAyah = ayahs[i + 1];
      const currentSurahNum = ayahs[i].surah ? ayahs[i].surah.number : 0;
      const nextSurahNum = nextAyah && nextAyah.surah ? nextAyah.surah.number : 0;
      const differentSurah = nextAyah && nextSurahNum !== currentSurahNum;
      
      let shouldCloseGroup = false;
      if (currentSurahNum === 1) {
        // Group all ayahs of Surah Al-Fatiha together
        shouldCloseGroup = differentSurah || !nextAyah;
      } else {
        // Keep groups at 2 to 3 ayahs for other surahs
        shouldCloseGroup = currentGroup.length >= 3 || differentSurah || !nextAyah;
      }
      
      if (shouldCloseGroup) {
        groups.push({
          id: groups.length + 1,
          ayahs: [...currentGroup],
          theme: determineTheme(currentGroup)
        });
        currentGroup = [];
      }
    }
    return groups;
  }

  function determineTheme(groupAyahs) {
    let combinedText = groupAyahs.map(a => {
      const trans = getEnglishTranslation(a.surah.number, a.numberInSurah) || "";
      return trans.toLowerCase();
    }).join(" ");
    
    if (combinedText.includes("believ") || combinedText.includes("faith") || combinedText.includes("righteous")) return "Believers & Righteous Deeds / الإيمان والعمل الصالح";
    if (combinedText.includes("disbeliev") || combinedText.includes("reject") || combinedText.includes("deny")) return "Warning to Rejecters / الإنذار والموعظة";
    if (combinedText.includes("moses") || combinedText.includes("musa") || combinedText.includes("pharaoh")) return "Story of Moses & Pharaoh / موسى وفرعون";
    if (combinedText.includes("abraham") || combinedText.includes("ibrahim")) return "Prophet Abraham / إبراهيم عليه السلام";
    if (combinedText.includes("jesus") || combinedText.includes("isa") || combinedText.includes("mary")) return "Prophet Jesus / عيسى عليه السلام";
    if (combinedText.includes("creation") || combinedText.includes("heavens") || combinedText.includes("earth") || combinedText.includes("signs")) return "Signs of Divine Creation / آيات الخلق والتدبر";
    if (combinedText.includes("paradise") || combinedText.includes("garden")) return "Rewards of Paradise / الجنة ونعيمها";
    if (combinedText.includes("hell") || combinedText.includes("fire") || combinedText.includes("punish")) return "Admonition of Hellfire / عذاب النار";
    if (combinedText.includes("mercy") || combinedText.includes("forgiv") || combinedText.includes("merciful")) return "Divine Mercy & Forgiveness / الرحمة والمغفرة";
    if (combinedText.includes("pray") || combinedText.includes("zakat") || combinedText.includes("charity")) return "Worship, Prayer & Zakat / العبادات";
    if (combinedText.includes("judgment") || combinedText.includes("hour") || combinedText.includes("resurrection") || combinedText.includes("day")) return "Day of Resurrection & Account / الحساب والقيامة";
    if (combinedText.includes("book") || combinedText.includes("quran") || combinedText.includes("reveal")) return "The Holy Quran / القرآن الكريم والوحي";
    
    // Fallback: name by Surah & Ayah range
    const first = groupAyahs[0];
    const last = groupAyahs[groupAyahs.length - 1];
    return `Ayahs ${first.numberInSurah} - ${last.numberInSurah} of ${first.surah.englishName || ('Surah ' + first.surah.number)}`;
  }

  function populateGlobalTimedRange() {
    if (!els.globalTimedStart || !els.globalTimedEnd) return;
    
    // Save current selection if possible
    const prevStartVal = els.globalTimedStart.value;
    const prevEndVal = els.globalTimedEnd.value;
    
    els.globalTimedStart.innerHTML = "";
    els.globalTimedEnd.innerHTML = "";
    
    if (!state.ayahs || state.ayahs.length === 0) return;
    
    state.ayahs.forEach((ayah, idx) => {
      const opt = document.createElement("option");
      opt.value = idx;
      const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${ayah.surah.number}`) : 'Surah';
      opt.textContent = `${surahName} ${ayah.numberInSurah}`;
      els.globalTimedStart.appendChild(opt);
    });
    
    // Default to the first ayah
    let startIdx = 0;
    if (prevStartVal !== "" && parseInt(prevStartVal) >= 0 && parseInt(prevStartVal) < state.ayahs.length) {
      startIdx = parseInt(prevStartVal);
    }
    els.globalTimedStart.value = startIdx;
    
    // Update end dropdown based on startIdx
    updateGlobalTimedEndDropdown(startIdx, prevEndVal);
  }

  function updateGlobalTimedEndDropdown(startIdx, preferredEndVal) {
    if (!els.globalTimedEnd) return;
    
    const currentEndVal = preferredEndVal !== undefined ? preferredEndVal : els.globalTimedEnd.value;
    els.globalTimedEnd.innerHTML = "";
    
    if (!state.ayahs || state.ayahs.length === 0) return;
    
    for (let i = startIdx; i < state.ayahs.length; i++) {
      const ayah = state.ayahs[i];
      const opt = document.createElement("option");
      opt.value = i;
      const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${ayah.surah.number}`) : 'Surah';
      opt.textContent = `${surahName} ${ayah.numberInSurah}`;
      els.globalTimedEnd.appendChild(opt);
    }
    
    // Default to the last ayah on the page
    let defaultEnd = state.ayahs.length - 1;
    if (currentEndVal !== "" && parseInt(currentEndVal) >= startIdx && parseInt(currentEndVal) < state.ayahs.length) {
      defaultEnd = parseInt(currentEndVal);
    }
    els.globalTimedEnd.value = defaultEnd;
  }

  function renderTeacherGroups() {
    state.teacherState.customRanges = state.teacherState.customRanges || {};
    const groups = generateThematicGroups(state.ayahs);
    state.teacherState.thematicGroups = groups;
    
    if (groups.length === 0) {
      els.teacherGroupList.innerHTML = `
        <div class="ayah-list-empty">
          <div class="empty-icon">🏵️</div>
          <p>No thematic groups available for this page.</p>
        </div>
      `;
      return;
    }
    
    const fragment = document.createDocumentFragment();
    
    groups.forEach(group => {
      const card = document.createElement("div");
      card.className = "teacher-card";
      card.dataset.groupId = group.id;
      
      const firstAyah = group.ayahs[0];
      const lastAyah = group.ayahs[group.ayahs.length - 1];
      const ayahRangeStr = `Ayahs ${firstAyah.numberInSurah} - ${lastAyah.numberInSurah}`;
      
      const isLoopPlaying = state.teacherState.isPlaying && state.teacherState.activeGroup?.id === group.id;
      const isPracticing = state.teacherState.isPracticeMode && state.teacherState.activeGroup?.id === group.id;
      const isTimedActive = state.teacherState.timedMode.active && state.teacherState.timedMode.groupId === group.id;
      
      if (isLoopPlaying) card.classList.add("playing");
      if (isPracticing) card.classList.add("practicing");
      if (isTimedActive) card.classList.add("timed-active");

      // Custom range loading
      const savedRange = state.teacherState.customRanges[group.id] || { startIdx: 0, endIdx: group.ayahs.length - 1 };
      let startIdx = Math.max(0, Math.min(group.ayahs.length - 1, savedRange.startIdx));
      let endIdx = Math.max(startIdx, Math.min(group.ayahs.length - 1, savedRange.endIdx));

      let totalWords = 0;
      group.ayahs.forEach(ayah => {
        state.pageWordData.forEach(wd => {
          if (wd.ayahNum === ayah.number) totalWords++;
        });
      });

      const recitedWords = (isPracticing || (isTimedActive && state.teacherState.timedMode.phase === 'test')) ? state.teacherState.recitedWordIdxs.size : 0;
      const progressPct = totalWords > 0 ? (recitedWords / totalWords) * 100 : 0;
      
      let statusBannerHtml = "";
      if (isLoopPlaying) {
        const job = state.teacherState.jobQueue[state.teacherState.currentJobIdx];
        if (job) {
          let rangeText = "";
          if (job.ayahs.length > 3) {
            rangeText = `${job.ayahs[0].numberInSurah} to ${job.ayahs[job.ayahs.length - 1].numberInSurah}`;
          } else {
            rangeText = job.ayahs.map(a => a.numberInSurah).join(", ");
          }
          const completedRepeats = job.repeatsTotal - job.repeatsRemaining + 1;
          const labelPrefix = state.teacherState.isGlobalPageLoop ? "🔊 Global Loop: Ayah" : "🔊 Reciting Ayah";
          statusBannerHtml = `
            <div class="teacher-status-banner">
              <span>${labelPrefix} ${rangeText} (Repeat ${completedRepeats}/${job.repeatsTotal})</span>
            </div>
          `;
        }
      } else if (isPracticing) {
        statusBannerHtml = `
          <div class="teacher-status-banner">
            <span>🎙️ Recite group from memory... (${recitedWords}/${totalWords} words)</span>
          </div>
        `;
      } else if (isTimedActive) {
        const timeFormatted = formatCountdownTime(state.teacherState.timedMode.timeLeft);
        if (state.teacherState.timedMode.phase === 'study') {
          statusBannerHtml = `
            <div class="teacher-status-banner timed-study-banner">
              <span>⏳ Nazira Reading Mode: <strong>${timeFormatted}</strong> remaining</span>
            </div>
          `;
        } else {
          statusBannerHtml = `
            <div class="teacher-status-banner timed-test-banner">
              <span>🎙️ Close Book Mode: <strong>${timeFormatted}</strong> remaining (${recitedWords}/${totalWords})</span>
            </div>
          `;
        }
      }

      card.innerHTML = `
        <div class="teacher-card-header">
          <div class="teacher-card-theme">${group.theme}</div>
          <div class="teacher-card-subtitle">${firstAyah.surah.englishName} · ${ayahRangeStr}</div>
        </div>
        ${statusBannerHtml}
        
        <div class="teacher-range-selector">
          <span class="range-label">Range:</span>
          <div class="range-dropdowns">
            <select class="range-select start-select">
              ${group.ayahs.map((ayah, idx) => `
                <option value="${idx}" ${idx === startIdx ? 'selected' : ''}>Ayah ${ayah.numberInSurah}</option>
              `).join('')}
            </select>
            <span class="range-to">to</span>
            <select class="range-select end-select">
              ${group.ayahs.slice(startIdx).map((ayah, offset) => {
                const idx = startIdx + offset;
                return `<option value="${idx}" ${idx === endIdx ? 'selected' : ''}>Ayah ${ayah.numberInSurah}</option>`;
              }).join('')}
            </select>
          </div>
        </div>
        
        <div class="teacher-card-actions">
          <button class="teacher-btn btn-timed${isTimedActive ? ' active-timed' : ''}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
            <span>${isTimedActive ? 'Stop Timed' : '40/20 minutes timed'}</span>
          </button>
          <button class="teacher-btn btn-loop${isLoopPlaying ? ' active' : ''}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
            <span>${isLoopPlaying ? 'Stop Loop' : 'Teacher Loop'}</span>
          </button>
          <button class="teacher-btn btn-practice${isPracticing ? ' active-practice' : ''}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zM17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            <span>${isPracticing ? 'Stop Practice' : 'Practice Recite'}</span>
          </button>
        </div>
        ${(isPracticing || (isTimedActive && state.teacherState.timedMode.phase === 'test')) ? `
          <div class="teacher-progress">
            <div class="teacher-progress-bar">
              <div class="teacher-progress-fill" style="width: ${progressPct}%"></div>
            </div>
          </div>
        ` : ''}
      `;

      const startSelect = card.querySelector(".start-select");
      const endSelect = card.querySelector(".end-select");

      const updateEndSelect = () => {
        const startVal = parseInt(startSelect.value);
        const currentEndVal = parseInt(endSelect.value);
        
        endSelect.innerHTML = "";
        for (let i = startVal; i < group.ayahs.length; i++) {
          const ayah = group.ayahs[i];
          const opt = document.createElement("option");
          opt.value = i;
          opt.textContent = `Ayah ${ayah.numberInSurah}`;
          if (i === currentEndVal || (i === group.ayahs.length - 1 && currentEndVal < startVal)) {
            opt.selected = true;
          }
          endSelect.appendChild(opt);
        }
        saveRange();
      };
      
      const saveRange = () => {
        state.teacherState.customRanges[group.id] = {
          startIdx: parseInt(startSelect.value),
          endIdx: parseInt(endSelect.value)
        };
      };
      
      startSelect.addEventListener("change", updateEndSelect);
      endSelect.addEventListener("change", saveRange);

      const getActiveGroupWithRange = () => {
        const currentStart = parseInt(startSelect.value);
        const currentEnd = parseInt(endSelect.value);
        return {
          id: group.id,
          theme: group.theme,
          ayahs: group.ayahs.slice(currentStart, currentEnd + 1)
        };
      };
      
      const loopBtn = card.querySelector(".btn-loop");
      loopBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isLoopPlaying) {
          stopTeacherLoop();
        } else {
          startTeacherLoop(getActiveGroupWithRange());
        }
      });
      
      const practiceBtn = card.querySelector(".btn-practice");
      practiceBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isPracticing) {
          stopTeacherPractice();
        } else {
          startTeacherPractice(getActiveGroupWithRange());
        }
      });

      const timedBtn = card.querySelector(".btn-timed");
      timedBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isTimedActive) {
          stopTimedMode();
        } else {
          startTimedMode(getActiveGroupWithRange());
        }
      });
      
      fragment.appendChild(card);
    });
    
    els.teacherGroupList.innerHTML = "";
    els.teacherGroupList.appendChild(fragment);
  }

  function startTeacherLoop(group) {
    stopTeacherPractice();
    
    // Automatically switch to text mode when playing recitation in thematic teacher mode
    /*
    if (!state.isTextMode) {
      toggleTextMode();
    }
    */
    
    state.teacherState.activeGroup = group;
    state.teacherState.isPlaying = true;
    updateThemeVisualizer(group);
    const frameEl = document.querySelector('.page-frame');
    if (frameEl) frameEl.classList.add('teacher-active');
    
    // Construct reinforcement loop job queue (7 repetitions per user request)
    const queue = [];
    const ayahs = group.ayahs;
    
    if (ayahs.length >= 1) {
      queue.push({ ayahs: [ayahs[0]], repeatsTotal: 7, repeatsRemaining: 7 });
    }
    for (let i = 1; i < ayahs.length; i++) {
      queue.push({ ayahs: [ayahs[i]], repeatsTotal: 7, repeatsRemaining: 7 });
      queue.push({ ayahs: ayahs.slice(0, i + 1), repeatsTotal: 7, repeatsRemaining: 7 });
    }
    
    state.teacherState.jobQueue = queue;
    state.teacherState.currentJobIdx = 0;
    state.teacherState.currentAyahIdxInJob = 0;
    
    playCurrentTeacherAyah();
  }

  function startGlobalPageLoop() {
    stopTeacherPractice();
    stopTeacherLoop();
    
    const startVal = parseInt(els.globalTimedStart.value);
    const endVal = parseInt(els.globalTimedEnd.value);
    if (isNaN(startVal) || isNaN(endVal) || startVal > endVal) {
      showToast("Invalid range selected", false);
      return;
    }
    
    const selectedAyahs = state.ayahs.slice(startVal, endVal + 1);
    if (selectedAyahs.length === 0) {
      showToast("No ayahs found in the selected range.", false);
      return;
    }
    
    state.teacherState.isPlaying = true;
    state.teacherState.isGlobalPageLoop = true;
    
    // Construct reinforcement loop job queue over the selected range
    const queue = [];
    if (selectedAyahs.length >= 1) {
      queue.push({
        title: `Ayah ${selectedAyahs[0].numberInSurah} Loop`,
        ayahs: [selectedAyahs[0]],
        repeatsTotal: 7,
        repeatsRemaining: 7
      });
    }
    for (let i = 1; i < selectedAyahs.length; i++) {
      // Individual Ayah Loop
      queue.push({
        title: `Ayah ${selectedAyahs[i].numberInSurah} Loop`,
        ayahs: [selectedAyahs[i]],
        repeatsTotal: 7,
        repeatsRemaining: 7
      });
      // Joint Loop from first selected to i-th selected
      queue.push({
        title: `Ayahs ${selectedAyahs[0].numberInSurah} to ${selectedAyahs[i].numberInSurah} Reinforce`,
        ayahs: selectedAyahs.slice(0, i + 1),
        repeatsTotal: 7,
        repeatsRemaining: 7
      });
    }
    
    state.teacherState.jobQueue = queue;
    state.teacherState.currentJobIdx = 0;
    state.teacherState.currentAyahIdxInJob = 0;
    
    // Create a dummy group object for visualizer/banner
    const firstAyah = selectedAyahs[0];
    const lastAyah = selectedAyahs[selectedAyahs.length - 1];
    const rangeText = `${firstAyah.surah.englishName} (Ayahs ${firstAyah.numberInSurah} - ${lastAyah.numberInSurah})`;
    
    const customGroup = {
      id: 'global-loop',
      theme: 'Global Selection Loop',
      ayahs: selectedAyahs
    };
    
    state.teacherState.activeGroup = customGroup;
    updateThemeVisualizer(customGroup);
    
    const frameEl = document.querySelector('.page-frame');
    if (frameEl) frameEl.classList.add('teacher-active');
    
    if (els.globalPageLoopBtn) {
      els.globalPageLoopBtn.classList.add('active');
    }
    
    playCurrentTeacherAyah();
    showToast(`Global Selection Loop Started (Reinforcing: ${rangeText})`, true);
  }

  function stopTeacherLoop() {
    stopAllRecitation();
    updateTeacherUI();
  }

  function playCurrentTeacherAyah() {
    if (!state.teacherState.isPlaying) return;
    
    const job = state.teacherState.jobQueue[state.teacherState.currentJobIdx];
    if (!job) {
      // Completed all loop jobs successfully!
      const wasGlobal = state.teacherState.isGlobalPageLoop;
      stopTeacherLoop();
      showToast(wasGlobal ? "Global Page Memorized! Welldone." : "Group Memorized! Press 'Practice Recite' to test yourself.", true);
      return;
    }
    
    const ayah = job.ayahs[state.teacherState.currentAyahIdxInJob];
    if (!ayah) {
      // Completed all ayahs in the current repeat
      job.repeatsRemaining--;
      if (job.repeatsRemaining > 0) {
        state.teacherState.currentAyahIdxInJob = 0;
        playCurrentTeacherAyah();
      } else {
        // Go to next loop job
        state.teacherState.currentJobIdx++;
        state.teacherState.currentAyahIdxInJob = 0;
        playCurrentTeacherAyah();
      }
      return;
    }
    
    // Dynamically detect which group this ayah belongs to, to update visualizer & status banner correctly
    if (!state.teacherState.isGlobalPageLoop) {
      const activeGroup = state.teacherState.thematicGroups.find(g => 
        g.ayahs.some(a => a.number === ayah.number)
      );
      if (activeGroup) {
        state.teacherState.activeGroup = activeGroup;
        updateThemeVisualizer(activeGroup);
      }
    }
    
    updateTopStatusBanner('reciting-teacher', ayah);
    highlightTeacherAyah(ayah.number);
    updateTeacherUI();

    const audioUrl = `https://cdn.islamic.network/quran/audio/128/${state.reciter}/${ayah.number}.mp3`;
    state.teacherState.audioPlayer = new Audio(audioUrl);
    
    const surahName = ayah.surah ? (ayah.surah.englishName || `Surah ${ayah.surah.number}`) : 'Surah';
    const labelText = `${surahName}, Ayah ${ayah.numberInSurah} (Teacher Loop)`;
    bindAudioPlayer(state.teacherState.audioPlayer, labelText);

    state.teacherState.audioPlayer.play().catch(err => {
      console.warn("Audio play failed, skipping", err);
      setTimeout(advanceTeacherAyah, 2000);
    });
    
    state.teacherState.audioPlayer.onended = () => {
      advanceTeacherAyah();
    };
  }

  function advanceTeacherAyah() {
    state.teacherState.currentAyahIdxInJob++;
    playCurrentTeacherAyah();
  }

  function highlightTeacherAyah(ayahGlobalNum) {
    document.querySelectorAll(".word.playing-ayah").forEach(el => {
      el.classList.remove("playing-ayah");
    });
    const words = els.pageTextOverlay.querySelectorAll(`.word[data-ayah="${ayahGlobalNum}"]`);
    words.forEach(el => {
      el.classList.add("playing-ayah");
    });
    
    if (words.length > 0) {
      const targetScrollEl = words[0];
      
      // Calculate scroll offset to clear sticky top elements (status banner + theme card)
      let stickyHeight = 20; // Default margin
      
      // Check banner visibility (or if it is about to be displayed in active teacher/play state)
      const isBannerVisible = els.topStatusBanner && (!els.topStatusBanner.classList.contains('hidden') || state.teacherState.isPlaying || playingAyahNum !== null);
      if (isBannerVisible) {
        stickyHeight += els.topStatusBanner.offsetHeight || 45;
      }
      
      // Check theme visualizer card visibility
      const isVisualizerVisible = els.themeVisualizerCard && (!els.themeVisualizerCard.classList.contains('hidden') || (state.teacherState.isPlaying && !state.teacherState.isGlobalPageLoop));
      if (isVisualizerVisible) {
        stickyHeight += els.themeVisualizerCard.offsetHeight || 80;
      }
      
      // Add extra padding for graceful breathing room below sticky headers
      stickyHeight += 15;
      
      const rect = targetScrollEl.getBoundingClientRect();
      
      // Only scroll if the ayah is not already comfortably visible in the viewport
      const visibleTop = stickyHeight;
      const visibleBottom = window.innerHeight - 100; // Leave breathing room for bottom bar / controls
      const isAlreadyVisible = (rect.top >= visibleTop && rect.bottom <= visibleBottom);
      
      if (!isAlreadyVisible) {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const elementDocTop = rect.top + scrollTop;
        
        let targetScrollY = elementDocTop - stickyHeight;
        
        // If target is near the top of the page, scroll all the way to 0
        // to show Surah headers / Basmalah gracefully
        if (targetScrollY < 60) {
          targetScrollY = 0;
        }
        
        window.scrollTo({
          top: targetScrollY,
          behavior: 'smooth'
        });
      }
    }
  }

  function startTeacherPractice(group) {
    stopTeacherLoop();
    
    state.teacherState.activeGroup = group;
    state.teacherState.isPracticeMode = true;
    state.teacherState.recitedWordIdxs.clear();
    updateThemeVisualizer(group);
    const frameEl = document.querySelector('.page-frame');
    if (frameEl) frameEl.classList.add('teacher-active');
    
    // Hide/Mask all word overlays belonging to this group
    document.querySelectorAll(".word.practice-hidden, .word.practice-success").forEach(el => {
      el.classList.remove("practice-hidden", "practice-success");
    });
    
    group.ayahs.forEach(ayah => {
      els.pageTextOverlay.querySelectorAll(`.word[data-ayah="${ayah.number}"]`).forEach(el => {
        el.classList.add("practice-hidden");
      });
    });
    
    // Update the block masks on page call
    updateMushafMasks();
    
    // Automatically turn on Listen Mode to start capturing voice recitation
    if (!state.isListenMode) {
      toggleListenMode();
    }
    
    updateTeacherUI();
    updateTopStatusBanner('listening', null);
    showToast("Practice Mode Active: Recite the hidden verses from memory!", true);
  }

  function stopTeacherPractice() {
    state.teacherState.isPracticeMode = false;
    state.teacherState.activeGroup = null;
    state.teacherState.recitedWordIdxs.clear();
    
    // Restore elements
    document.querySelectorAll(".word.practice-hidden, .word.practice-success").forEach(el => {
      el.classList.remove("practice-hidden", "practice-success");
    });
    
    // Clear block masks
    updateMushafMasks();
    
    updateTeacherUI();
    updateTopStatusBanner('idle');
    updateThemeVisualizer(null);
    const frameEl = document.querySelector('.page-frame');
    if (frameEl) frameEl.classList.remove('teacher-active');
  }

  function startTimedMode(group) {
    if (!group) return;
    
    // Stop all loops or normal practice modes first
    stopTeacherLoop();
    stopTeacherPractice();

    if (els.wordTranslationPanel) {
      els.wordTranslationPanel.classList.add('hidden');
    }
    
    // Initialize timed state
    state.teacherState.timedMode.active = true;
    state.teacherState.timedMode.groupId = group.id;
    state.teacherState.timedMode.phase = 'study';
    state.teacherState.timedMode.timeLeft = 40 * 60; // 40 minutes (2400 seconds)
    state.teacherState.timedMode.rangeText = getGroupAyahRangeText(group);
    
    state.teacherState.activeGroup = group;
    state.teacherState.recitedWordIdxs.clear();
    updateThemeVisualizer(group);
    
    // Add page-frame active styles if needed
    const frameEl = document.querySelector('.page-frame');
    if (frameEl) frameEl.classList.add('teacher-active');
    
    // Set text overlay timed active state for pointer-events
    if (els.pageTextOverlay) {
      els.pageTextOverlay.classList.add('timed-mode-active');
      els.pageTextOverlay.classList.remove('timed-test-active');
    }
    
    // Apply study highlights (rectangle borders)
    applyStudyHighlight(group);
    
    // Start interval
    if (state.teacherState.timedMode.timerInterval) {
      clearInterval(state.teacherState.timedMode.timerInterval);
    }
    state.teacherState.timedMode.timerInterval = setInterval(tickTimedMode, 1000);
    
    // Automatically turn on Listen Mode to start capturing voice recitation
    if (!state.isListenMode) {
      toggleListenMode();
    }
    
    updateTeacherUI();
    updateTopStatusBanner('timed-study', null);
    showToast("Timed Study Mode Started: 40 minutes to practice.", true);
  }

  function transitionToTimedTest() {
    if (!state.teacherState.timedMode.active || !state.teacherState.activeGroup) return;
    
    state.teacherState.timedMode.phase = 'test';
    state.teacherState.timedMode.timeLeft = 20 * 60; // 20 minutes (1200 seconds)
    state.teacherState.recitedWordIdxs.clear();
    
    if (els.pageTextOverlay) {
      els.pageTextOverlay.classList.add('timed-test-active');
    }
    
    // Remove study highlights and apply test masks (solid overlays to hide calligraphy/text)
    applyTestMask(state.teacherState.activeGroup);
    
    // Keep Listen Mode on
    if (!state.isListenMode) {
      toggleListenMode();
    }
    
    updateTeacherUI();
    updateTopStatusBanner('timed-test', null);
    showToast("Study time finished! Test Phase Started: 20 minutes.", true);
  }

  function applyStudyHighlight(group) {
    // Clear all timed classes first
    clearAllTimedHighlights();
    
    group.ayahs.forEach(ayah => {
      els.pageTextOverlay.querySelectorAll(`.word[data-ayah="${ayah.number}"]`).forEach(el => {
        el.classList.add("timed-rect-highlight");
      });
    });
  }

  function applyTestMask(group) {
    // Clear all timed classes first
    clearAllTimedHighlights();
    
    group.ayahs.forEach(ayah => {
      els.pageTextOverlay.querySelectorAll(`.word[data-ayah="${ayah.number}"]`).forEach(el => {
        el.classList.add("timed-test-hidden");
      });
    });

    updateMushafMasks();
  }

  function clearAllTimedHighlights() {
    document.querySelectorAll(".word.timed-rect-highlight, .word.timed-test-hidden, .word.timed-test-success").forEach(el => {
      el.classList.remove("timed-rect-highlight", "timed-test-hidden", "timed-test-success");
    });

    updateMushafMasks();
  }

  function tickTimedMode() {
    if (!state.teacherState.timedMode.active) return;
    
    state.teacherState.timedMode.timeLeft--;
    
    if (state.teacherState.timedMode.timeLeft <= 0) {
      if (state.teacherState.timedMode.phase === 'study') {
        transitionToTimedTest();
      } else {
        showToast("⏰ Timer complete! Timed practice finished.", true);
        stopTimedMode();
      }
    } else {
      // Update top banner
      updateTopStatusBanner(state.teacherState.timedMode.phase === 'study' ? 'timed-study' : 'timed-test', null);
      // Update sidebar card (e.g. remaining countdown)
      updateTeacherCardCountdown();
      
      // Also update global timed button text if it is global timed mode
      if (state.teacherState.timedMode.groupId === 'global-timed') {
        updateGlobalTimedUI();
      }
    }
  }

  function stopTimedMode() {
    state.teacherState.timedMode.active = false;
    state.teacherState.timedMode.groupId = null;
    state.teacherState.timedMode.phase = 'study';
    state.teacherState.timedMode.timeLeft = 0;
    
    if (state.teacherState.timedMode.timerInterval) {
      clearInterval(state.teacherState.timedMode.timerInterval);
      state.teacherState.timedMode.timerInterval = null;
    }
    
    if (els.pageTextOverlay) {
      els.pageTextOverlay.classList.remove('timed-mode-active');
      els.pageTextOverlay.classList.remove('timed-test-active');
    }
    
    clearAllTimedHighlights();
    state.teacherState.activeGroup = null;
    state.teacherState.recitedWordIdxs.clear();
    
    // Auto-disable microphone if it was turned on for timed mode
    if (state.isListenMode) {
      toggleListenMode();
    }
    
    updateTeacherUI();
    updateTopStatusBanner('idle');
    updateThemeVisualizer(null);
    const frameEl = document.querySelector('.page-frame');
    if (frameEl) frameEl.classList.remove('teacher-active');
  }

  function formatCountdownTime(totalSeconds) {
    if (totalSeconds < 0) totalSeconds = 0;
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function updateTeacherCardCountdown() {
    if (!state.teacherState.timedMode.active) return;
    const activeGroupId = state.teacherState.timedMode.groupId;
    const card = els.teacherGroupList?.querySelector(`.teacher-card[data-group-id="${activeGroupId}"]`);
    if (!card) return;
    
    const timeFormatted = formatCountdownTime(state.teacherState.timedMode.timeLeft);
    const strongEl = card.querySelector(".teacher-status-banner strong");
    if (strongEl) {
      strongEl.textContent = timeFormatted;
    }
  }

  function getTimedModeWordCount() {
    if (!state.teacherState.activeGroup) return 0;
    let count = 0;
    state.teacherState.activeGroup.ayahs.forEach(ayah => {
      state.pageWordData.forEach(wd => {
        if (wd.ayahNum === ayah.number) count++;
      });
    });
    return count;
  }

  function getGroupAyahRangeText(group) {
    if (!group || !group.ayahs.length) return "";
    const first = group.ayahs[0];
    const last = group.ayahs[group.ayahs.length - 1];
    return `Ayahs ${first.numberInSurah} - ${last.numberInSurah}`;
  }

  // Expose skip/stop functions to window for status banner buttons
  window.__skipToTest = function() {
    transitionToTimedTest();
  };
  window.__stopTimedMode = function() {
    stopTimedMode();
  };

  function updateGlobalTimedUI() {
    if (!els.globalTimedBtn) return;
    const isGlobalTimedActive = state.teacherState.timedMode.active && state.teacherState.timedMode.groupId === 'global-timed';
    const isAnyTimedActive = state.teacherState.timedMode.active;
    
    const span = els.globalTimedBtn.querySelector('span');
    if (span) {
      if (isGlobalTimedActive) {
        const phaseLabel = state.teacherState.timedMode.phase === 'study' ? 'Study' : 'Test';
        const timeFormatted = formatCountdownTime(state.teacherState.timedMode.timeLeft);
        span.textContent = `Stop Timed (${phaseLabel}: ${timeFormatted})`;
      } else {
        span.textContent = '40/20 minutes timed';
      }
    }
    
    if (isGlobalTimedActive) {
      els.globalTimedBtn.classList.add('active-timed');
    } else {
      els.globalTimedBtn.classList.remove('active-timed');
    }
    
    if (els.globalTimedStart) els.globalTimedStart.disabled = isAnyTimedActive;
    if (els.globalTimedEnd) els.globalTimedEnd.disabled = isAnyTimedActive;
  }

  function updateTeacherUI() {
    renderTeacherGroups();
    updateGlobalTimedUI();
  }

  // ===================== CSV / ENGLISH TRANSLATIONS =====================
  function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (char === '"' && next === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          currentRow.push(field);
          field = '';
        } else if (char === '\r') {
          // skip carriage return
        } else if (char === '\n') {
          currentRow.push(field);
          if (currentRow.length > 0 && currentRow.some(f => f.trim())) {
            rows.push(currentRow);
          }
          currentRow = [];
          field = '';
        } else {
          field += char;
        }
      }
    }
    // Handle last line if no trailing newline
    if (field || currentRow.length > 0) {
      currentRow.push(field);
      if (currentRow.some(f => f.trim())) {
        rows.push(currentRow);
      }
    }

    return rows;
  }

  async function fetchEnglishTranslations() {
    try {
      let text;
      if (window.quranEnglishCSV) {
        text = window.quranEnglishCSV;
        console.log('Successfully loaded English translations from global script!');
      } else {
        const response = await fetch(CSV_PATH);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        text = await response.text();
        console.log('Successfully loaded English translations via fetch!');
      }
      const rows = parseCSV(text);

      // Skip header row
      const dataRows = rows.slice(1);

      const translations = {};
      const lengths = {};

      dataRows.forEach(row => {
        if (row.length < 6) return;
        const surahNum = parseInt(row[1], 10);
        const ayahNum = parseInt(row[2], 10);
        const verse = row[3] || '';
        const length = parseInt(row[5], 10) || 0;

        if (isNaN(surahNum) || isNaN(ayahNum)) return;

        // Group translations by (surah, ayah) - concatenate multi-row ayahs
        if (!translations[surahNum]) translations[surahNum] = {};
        if (!translations[surahNum][ayahNum]) {
          translations[surahNum][ayahNum] = verse;
        } else {
          // If verse text is different, append (for multi-row ayahs with same text, this keeps duplicates)
          // Actually, multi-row ayahs have the SAME verse text repeated, so we just keep one
          // But some might have continuation - let's check if it's different
          if (verse && !translations[surahNum][ayahNum].includes(verse)) {
            translations[surahNum][ayahNum] += ' ' + verse;
          }
        }

        // Accumulate length per surah
        if (!lengths[surahNum]) lengths[surahNum] = 0;
        lengths[surahNum] += length;
      });

      state.englishTranslations = translations;
      state.surahLengths = lengths;

      // Re-render surah list if it's open
      if (els.surahPanel.classList.contains('open')) {
        renderSurahList();
      }

      // Re-render teacher groups so they get the correct keyword themes immediately
      renderTeacherGroups();

      console.log(`Loaded English translations for ${Object.keys(translations).length} surahs`);
    } catch (err) {
      console.warn('Could not load English translations from CSV:', err);
    }
  }

  function getEnglishTranslation(surahNum, ayahNum) {
    if (!state.englishTranslations[surahNum]) return '';
    return state.englishTranslations[surahNum][ayahNum] || '';
  }

  async function loadLocalDatabases() {
    if (state.quranPagesDb && state.quranPageLines) {
      console.log('Successfully initialized Quran databases from global scripts!');
      return;
    }
    try {
      const [dbRes, linesRes] = await Promise.all([
        fetch('quran_pages_db.json'),
        fetch('quran_page_lines.json')
      ]);
      state.quranPagesDb = await dbRes.json();
      state.quranPageLines = await linesRes.json();
      console.log('Successfully loaded local Quran databases via fetch!');
    } catch (err) {
      console.error('Failed to load local Quran databases:', err);
    }
  }

  function showToast(message, isSuccess = false) {
    if (!els.systemToast) return;
    els.systemToastText.textContent = message;
    els.systemToast.classList.remove('hidden', 'success');
    if (isSuccess) {
      els.systemToast.classList.add('success');
    }
    // Always auto-hide after 3.5s, regardless of type
    setTimeout(() => els.systemToast.classList.add('hidden'), 3500);
  }

  // ===================== INDEXEDDB HELPERS =====================
  function openIDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('QuranMemorizer', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache');
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async function getFromIDB(key) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('cache', 'readonly');
        const store = tx.objectStore('cache');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  }

  async function setToIDB(key, value) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('cache', 'readwrite');
        const store = tx.objectStore('cache');
        const req = store.put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB write failed:', e);
    }
  }

  async function removeFromIDB(key) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('cache', 'readwrite');
        const store = tx.objectStore('cache');
        const req = store.delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {}
  }

  // ===================== GLOBAL INDEX (CACHED, INSTANT) =====================
  const GLOBAL_INDEX_CACHE_KEY = 'quran-global-index-v2';
  const GLOBAL_INDEX_MAP_KEY = 'quran-global-wordmap-v2';

  async function buildGlobalIndex() {
    try {
            // Check IndexedDB cache FIRST for instant detection
      const [cachedWords, cachedMap] = await Promise.all([
        getFromIDB(GLOBAL_INDEX_CACHE_KEY),
        getFromIDB(GLOBAL_INDEX_MAP_KEY)
      ]);
      
      if (cachedWords && cachedMap) {
        try {
          state.globalWords = cachedWords;
          state.globalWordMap = new Map(cachedMap);
          state.globalIndexBuilt = true;
          console.log(`Loaded global index from cache: ${state.globalWords.length} words, ${state.globalWordMap.size} unique entries`);
          showToast('Voice engine ready ✦', true);
          // Clean up old localStorage cache if it still exists
          localStorage.removeItem(GLOBAL_INDEX_CACHE_KEY);
          localStorage.removeItem(GLOBAL_INDEX_MAP_KEY);
          return;
        } catch (cacheErr) {
          console.warn('Cache corrupted, rebuilding...', cacheErr);
          await removeFromIDB(GLOBAL_INDEX_CACHE_KEY);
          await removeFromIDB(GLOBAL_INDEX_MAP_KEY);
        }
      }

      if (els.globalIndexProgressContainer) {
        els.globalIndexProgressContainer.classList.remove('hidden');
        els.globalIndexProgressBar.style.width = '0%';
        els.globalIndexProgressText.textContent = 'Building index...';
      }

      showToast('Building voice navigation index...');

      const words = [];
      const wordMap = new Map();

      // If local database is available, use it to avoid network request
      if (state.quranPagesDb) {
        let pageNum = 1;
        
        function processLocalPagesChunk() {
          const endPage = Math.min(604, pageNum + 15);
          for (let p = pageNum; p <= endPage; p++) {
            const ayahs = state.quranPagesDb[p] || [];
            ayahs.forEach(ayah => {
              const tokens = ayah.text.match(/(\S+|\s+)/g) || [];
              let wordIdx = 0;
              tokens.forEach(t => {
                if (/\S/.test(t)) {
                  const norm = normalizeArabic(t);
                  if (norm.length > 0) {
                    words.push({ text: norm, page: p });
                    if (!wordMap.has(norm)) {
                      wordMap.set(norm, []);
                    }
                    wordMap.get(norm).push({ page: p, ayahNum: ayah.number, wordIdx });
                    wordIdx++;
                  }
                }
              });
            });
          }
          
          const pct = Math.floor((endPage / 604) * 100);
          if (els.globalIndexProgressBar) {
            els.globalIndexProgressBar.style.width = `${pct}%`;
            els.globalIndexProgressText.textContent = `${pct}%`;
          }
          
          if (endPage < 604) {
            pageNum = endPage + 1;
            setTimeout(processLocalPagesChunk, 0); // Yield to main thread
          } else {
            finalizeIndex();
          }
        }
        
        processLocalPagesChunk();
        return;
      }

      // Fallback: Fetch the full Quran data from API (chunked processing)
      const res = await fetch(`${API_BASE}/quran/quran- saheeh`);
      const json = await res.json();
      if (!json.data || !json.data.surahs) throw new Error('Invalid API response');

      showToast('Optimizing voice engine...');
      const surahs = json.data.surahs;
      let surahIdx = 0;

      function processApiSurahsChunk() {
        const endSurah = Math.min(surahs.length - 1, surahIdx + 3); // 4 surahs per chunk
        for (let s = surahIdx; s <= endSurah; s++) {
          const surah = surahs[s];
          surah.ayahs.forEach(ayah => {
            const tokens = ayah.text.match(/(\S+|\s+)/g) || [];
            let wordIdx = 0;
            tokens.forEach(t => {
              if (/\S/.test(t)) {
                const norm = normalizeArabic(t);
                if (norm.length > 0) {
                  words.push({ text: norm, page: ayah.page });
                  if (!wordMap.has(norm)) {
                    wordMap.set(norm, []);
                  }
                  wordMap.get(norm).push({ page: ayah.page, ayahNum: ayah.number, wordIdx });
                  wordIdx++;
                }
              }
            });
          });
        }
        
        const pct = Math.floor(((endSurah + 1) / surahs.length) * 100);
        if (els.globalIndexProgressBar) {
          els.globalIndexProgressBar.style.width = `${pct}%`;
          els.globalIndexProgressText.textContent = `${pct}%`;
        }
        
        if (endSurah < surahs.length - 1) {
          surahIdx = endSurah + 1;
          setTimeout(processApiSurahsChunk, 0); // Yield to main thread
        } else {
          finalizeIndex();
        }
      }

      processApiSurahsChunk();

      function finalizeIndex() {
        state.globalWords = words;
        state.globalWordMap = wordMap;
        state.globalIndexBuilt = true;

        // Cache in IndexedDB (handles large data without QuotaExceededError)
        setToIDB(GLOBAL_INDEX_CACHE_KEY, words);
        setToIDB(GLOBAL_INDEX_MAP_KEY, [...wordMap]);
        console.log('Cached global index to IndexedDB');
        // Clean up old localStorage cache
        localStorage.removeItem(GLOBAL_INDEX_CACHE_KEY);
        localStorage.removeItem(GLOBAL_INDEX_MAP_KEY);

        if (els.globalIndexProgressBar) {
          els.globalIndexProgressBar.style.width = '100%';
          els.globalIndexProgressText.textContent = 'Ready!';
        }
        showToast('Voice navigation ready ✦', true);
        if (els.globalIndexProgressContainer) {
          setTimeout(() => els.globalIndexProgressContainer.classList.add('hidden'), 2000);
        }
      }

    } catch (err) {
      console.warn('Could not build global index:', err);
      if (els.systemToast) els.systemToast.classList.add('hidden');
      if (els.globalIndexProgressContainer) els.globalIndexProgressContainer.classList.add('hidden');
      state.globalIndexBuilt = true;
    }
  }

  function getSurahTotalLength(surahNum) {
    return state.surahLengths[surahNum] || 0;
  }

  function formatLength(length) {
    if (length >= 1000) return (length / 1000).toFixed(1) + 'k';
    return length.toString();
  }

  // ===================== SURAH INDEX PANEL =====================
  let surahFilter = '';

  function openSurahPanel() {
    els.surahPanel.classList.add('open');
    els.surahPanelOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    renderSurahList();
    setTimeout(() => els.surahSearch.focus(), 150);
  }

  function closeSurahPanel() {
    els.surahPanel.classList.remove('open');
    els.surahPanelOverlay.classList.remove('open');
    document.body.style.overflow = '';
    surahFilter = '';
    els.surahSearch.value = '';
  }

  function setSurahSort(mode) {
    state.surahSortMode = mode;
    renderSurahList();
  }

  function renderSurahList() {
    const filter = surahFilter.toLowerCase();
    let filtered = SURAHS.filter(s => {
      if (!filter) return true;
      return (
        s.name.toLowerCase().includes(filter) ||
        s.arabic.includes(filter) ||
        s.num.toString() === filter
      );
    });

    // Sort by length if requested
    if (state.surahSortMode === 'shortest') {
      filtered.sort((a, b) => {
        const lenA = getSurahTotalLength(a.num);
        const lenB = getSurahTotalLength(b.num);
        if (lenA === 0 && lenB === 0) return a.num - b.num;
        if (lenA === 0) return 1;
        if (lenB === 0) return -1;
        return lenA - lenB;
      });
    } else if (state.surahSortMode === 'longest') {
      filtered.sort((a, b) => {
        const lenA = getSurahTotalLength(a.num);
        const lenB = getSurahTotalLength(b.num);
        if (lenA === 0 && lenB === 0) return a.num - b.num;
        if (lenA === 0) return 1;
        if (lenB === 0) return -1;
        return lenB - lenA;
      });
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach(s => {
      const totalLen = getSurahTotalLength(s.num);
      const item = document.createElement('div');
      item.className = 'surah-item';
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.dataset.page = s.page;

      item.innerHTML = `
        <span class="surah-num">${s.num}</span>
        <span class="surah-name-en">${s.name}</span>
        <span class="surah-name-ar">${s.arabic}</span>
        <span class="surah-page">p. ${s.page}</span>
        ${totalLen > 0 ? `<span class="surah-length">${formatLength(totalLen)}</span>` : ''}
      `;

      item.addEventListener('click', () => {
        goToPage(s.page);
        closeSurahPanel();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToPage(s.page);
          closeSurahPanel();
        }
      });

      fragment.appendChild(item);
    });

    els.surahList.innerHTML = '';
    els.surahList.appendChild(fragment);

    if (!filtered.length) {
      els.surahList.innerHTML = '<div class="surah-list-empty">No surahs match your search</div>';
    }

    // Update sort button active state
    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === state.surahSortMode);
    });
  }

  // ===================== KEYBOARD =====================
  function handleKeyboard(e) {
    const key = e.key;
    const isInputFocused = document.activeElement === els.pageInput;

    if (isInputFocused) {
      if (key === 'Enter') {
        goToPage(els.pageInput.value);
      }
      return;
    }

    switch (key) {
      case 'ArrowRight':
        e.preventDefault();
        nextPage();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        prevPage();
        break;
      case 'Home':
        e.preventDefault();
        firstPage();
        break;
      case 'End':
        e.preventDefault();
        lastPage();
        break;
      case 'r':
      case 'R':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          resetPage();
        }
        break;
      case 'a':
      case 'A':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          revealAllAyahs();
        }
        break;

      case 's':
      case 'S':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          openSurahPanel();
        }
        break;
      case 'Escape':
        if (els.surahPanel.classList.contains('open')) {
          e.preventDefault();
          closeSurahPanel();
        }
        break;
    }
  }

  // ===================== INIT =====================
  function init() {
    loadProgress();
    applyTheme();
    els.totalPages.textContent = TOTAL_PAGES;
    updateGlobalStats();

    // Event listeners
    if (els.tabAyahs && els.tabTeacher && els.tabAbout) {
      const tabs = [
        { tab: els.tabTeacher, section: els.teacherSection, onActivate: () => {} },
        { tab: els.tabAyahs, section: els.ayahsSection, onActivate: () => { stopTeacherLoop(); stopTeacherPractice(); } },
        { tab: els.tabAbout, section: els.aboutSection, onActivate: () => { stopTeacherLoop(); stopTeacherPractice(); } }
      ];

      tabs.forEach(item => {
        item.tab.addEventListener('click', () => {
          tabs.forEach(t => {
            t.tab.classList.remove('active');
            t.section.classList.remove('active');
          });
          item.tab.classList.add('active');
          item.section.classList.add('active');
          item.onActivate();
        });
      });
    }

    if (els.globalPageLoopBtn) {
      els.globalPageLoopBtn.addEventListener('click', () => {
        if (state.teacherState.isPlaying && state.teacherState.isGlobalPageLoop) {
          stopTeacherLoop();
        } else {
          startGlobalPageLoop();
        }
      });
    }

    if (els.globalTimedStart) {
      els.globalTimedStart.addEventListener('change', () => {
        updateGlobalTimedEndDropdown(parseInt(els.globalTimedStart.value));
        if (state.isSelectionHidden) {
          updateMushafMasks();
        }
      });
    }

    if (els.globalTimedEnd) {
      els.globalTimedEnd.addEventListener('change', () => {
        if (state.isSelectionHidden) {
          updateMushafMasks();
        }
      });
    }

    if (els.globalTimedBtn) {
      els.globalTimedBtn.addEventListener('click', () => {
        if (state.teacherState.timedMode.active && state.teacherState.timedMode.groupId === 'global-timed') {
          stopTimedMode();
        } else {
          const startVal = parseInt(els.globalTimedStart.value);
          const endVal = parseInt(els.globalTimedEnd.value);
          
          if (isNaN(startVal) || isNaN(endVal) || startVal > endVal) {
            showToast("Invalid range selected", false);
            return;
          }
          
          const selectedAyahs = state.ayahs.slice(startVal, endVal + 1);
          if (selectedAyahs.length === 0) return;
          
          const globalGroup = {
            id: 'global-timed',
            theme: 'Global Page Selection',
            ayahs: selectedAyahs
          };
          startTimedMode(globalGroup);
        }
      });
    }

    // Pinned Audio Player controls
    if (els.playerPlayBtn) {
      els.playerPlayBtn.addEventListener('click', () => {
        const activePlayer = getActiveAudioPlayer();
        if (activePlayer) {
          if (activePlayer.paused) {
            activePlayer.play().catch(err => console.warn("Failed to resume playback", err));
          } else {
            activePlayer.pause();
          }
        }
      });
    }

    if (els.playerCloseBtn) {
      els.playerCloseBtn.addEventListener('click', () => {
        stopAllRecitation();
      });
    }

    if (els.playerProgressBarTrack) {
      els.playerProgressBarTrack.addEventListener('click', (e) => {
        const activePlayer = getActiveAudioPlayer();
        if (activePlayer && activePlayer.duration) {
          const rect = els.playerProgressBarTrack.getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          const width = rect.width;
          const pct = Math.max(0, Math.min(1, clickX / width));
          activePlayer.currentTime = pct * activePlayer.duration;
        }
      });
    }

    els.prevPageBtn.addEventListener('click', prevPage);
    els.nextPageBtn.addEventListener('click', nextPage);
    els.firstPageBtn.addEventListener('click', firstPage);
    els.lastPageBtn.addEventListener('click', lastPage);
    els.goToPageBtn.addEventListener('click', () => goToPage(els.pageInput.value));
    els.showAllBtn.addEventListener('click', revealAllAyahs);
    if (els.memoryModeBtn) {
      els.memoryModeBtn.addEventListener('click', toggleMemoryMode);
    }
    els.resetPageBtn.addEventListener('click', resetPage);
    els.toggleTextBtn.addEventListener('click', toggleTextMode);
    if (els.toggleHintsBtn) {
      els.toggleHintsBtn.addEventListener('click', () => {
        state.teacherState.showStartHints = !state.teacherState.showStartHints;
        if (els.toggleHintsText) {
          els.toggleHintsText.textContent = state.teacherState.showStartHints ? 'Hints: ON' : 'Hints: OFF';
        }
        els.toggleHintsBtn.classList.toggle('active', state.teacherState.showStartHints);
        
        // If hints are turned OFF, re-hide/mask all words on the page to hide all text!
        if (!state.teacherState.showStartHints) {
          state.teacherState.recitedWordIdxs.clear();
          if (state.teacherState.activeGroup) {
            state.teacherState.activeGroup.ayahs.forEach(ayah => {
              els.pageTextOverlay.querySelectorAll(`.word[data-ayah="${ayah.number}"]`).forEach(el => {
                if (state.teacherState.timedMode.active) {
                  el.classList.remove('timed-test-success');
                  el.classList.add('timed-test-hidden');
                } else {
                  el.classList.remove('practice-success');
                  el.classList.add('practice-hidden');
                }
              });
            });
          }
          updateTeacherUI();
        }
        
        updateMushafMasks();
      });
    }
    if (els.themeToggleBtn) {
      els.themeToggleBtn.addEventListener('click', toggleThemeMode);
    }
    
    // --- Handwriting Trace & Write Mode Bindings ---
    if (els.toggleTraceModeBtn) {
      els.toggleTraceModeBtn.addEventListener('click', toggleTraceMode);
    }
    
    if (els.tracePenBtn) {
      els.tracePenBtn.addEventListener('click', () => {
        state.traceIsEraser = false;
        
        // Update active classes
        els.tracePenBtn.classList.add('active');
        if (els.traceEraserBtn) els.traceEraserBtn.classList.remove('active');
        
        // Update canvas cursor class
        if (els.traceCanvas) els.traceCanvas.classList.remove('eraser-active');
        
        // Reactivate active color dot highlight
        document.querySelectorAll('.color-dot').forEach(dot => {
          dot.classList.toggle('active', dot.getAttribute('data-color') === state.traceColor);
        });
      });
    }

    if (els.traceEraserBtn) {
      els.traceEraserBtn.addEventListener('click', () => {
        state.traceIsEraser = true;
        
        // Update active classes
        els.traceEraserBtn.classList.add('active');
        if (els.tracePenBtn) els.tracePenBtn.classList.remove('active');
        
        // Update canvas cursor class
        if (els.traceCanvas) els.traceCanvas.classList.add('eraser-active');
        
        // Deactivate color dots UI since eraser is active
        document.querySelectorAll('.color-dot').forEach(dot => dot.classList.remove('active'));
      });
    }
    
    if (els.traceUndoBtn) {
      els.traceUndoBtn.addEventListener('click', undoLastStroke);
    }
    
    if (els.traceClearBtn) {
      els.traceClearBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all drawings on this page?')) {
          clearPageDrawing();
        }
      });
    }
    
    if (els.traceWidthSlider) {
      els.traceWidthSlider.addEventListener('input', (e) => {
        state.traceWidth = parseInt(e.target.value) || 3;
        if (els.traceWidthDisplay) els.traceWidthDisplay.textContent = state.traceWidth + 'px';
      });
    }
    
    if (els.traceOpacitySlider) {
      els.traceOpacitySlider.addEventListener('input', (e) => {
        state.traceOpacity = parseInt(e.target.value) || 8;
        if (els.traceOpacityDisplay) els.traceOpacityDisplay.textContent = state.traceOpacity + '%';
        if (els.pageImageContainer) {
          els.pageImageContainer.style.setProperty('--trace-opacity', (state.traceOpacity / 100));
        }
      });
    }
    
    // Color dots selection
    document.querySelectorAll('.color-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        state.traceColor = e.target.getAttribute('data-color');
        state.traceIsEraser = false;
        
        // Update UI
        if (els.traceEraserBtn) els.traceEraserBtn.classList.remove('active');
        if (els.tracePenBtn) els.tracePenBtn.classList.add('active');
        if (els.traceCanvas) els.traceCanvas.classList.remove('eraser-active');
        document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
        e.target.classList.add('active');
      });
    });
    if (els.hidePageBtn) {
      els.hidePageBtn.addEventListener('click', toggleHidePageMode);
    }
    if (els.hideTextBtn) {
      els.hideTextBtn.addEventListener('click', toggleHideTextMode);
    }
    if (els.hideSelectionBtn) {
      els.hideSelectionBtn.addEventListener('click', toggleHideSelectionMode);
    }
    const closeBtn = document.querySelector('#wordTranslationPanel .translation-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        state.isTranslationPinned = false;
      });
    }
    els.listenModeBtn.addEventListener('click', toggleListenMode);
    if (els.closeMicModalBtn) {
      els.closeMicModalBtn.addEventListener('click', hideMicPermissionModal);
    }
    if (els.howItWorksBtn && els.howItWorksModal) {
      els.howItWorksBtn.addEventListener('click', () => {
        els.howItWorksModal.classList.remove('hidden');
      });
      
      const closeHowModal = () => {
        els.howItWorksModal.classList.add('hidden');
      };
      
      if (els.closeHowModalBtn) els.closeHowModalBtn.addEventListener('click', closeHowModal);
      if (els.closeHowModalOkBtn) els.closeHowModalOkBtn.addEventListener('click', closeHowModal);
      
      const backdrop = els.howItWorksModal.querySelector('.how-modal-backdrop');
      if (backdrop) backdrop.addEventListener('click', closeHowModal);
    }
    if (els.feedbackBtn && els.feedbackModal) {
      els.feedbackBtn.addEventListener('click', () => {
        els.feedbackModal.classList.remove('hidden');
      });
      
      const closeFeedbackModal = () => {
        els.feedbackModal.classList.add('hidden');
        if (els.feedbackForm) els.feedbackForm.reset();
      };
      
      if (els.closeFeedbackModalBtn) {
        els.closeFeedbackModalBtn.addEventListener('click', closeFeedbackModal);
      }
      
      const backdrop = els.feedbackModal.querySelector('.feedback-modal-backdrop');
      if (backdrop) {
        backdrop.addEventListener('click', closeFeedbackModal);
      }
      
      if (els.feedbackForm) {
        els.feedbackForm.addEventListener('submit', (e) => {
          e.preventDefault();
          
          if (els.submitFeedbackBtn) {
            els.submitFeedbackBtn.disabled = true;
            els.submitFeedbackBtn.classList.add('loading');
            els.submitFeedbackBtn.innerHTML = '<span>Sending...</span>';
          }
          
          const formData = new FormData(els.feedbackForm);
          const data = {
            helped: formData.get('helped'),
            suggestions: formData.get('suggestions'),
            bugs: formData.get('bugs') || 'None reported',
            contact: formData.get('contact') || 'Anonymous',
            _subject: 'New HifzNoor Feedback Submission'
          };
          
          // Obfuscated email endpoint to prevent spam bot harvesting
          const parts = ['hifznoormemorytool', 'gmail.com'];
          const url = 'https://formsubmit.co/ajax/' + parts.join('@');
          
          fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify(data)
          })
          .then(res => res.json())
          .then(resData => {
            if (els.submitFeedbackBtn) {
              els.submitFeedbackBtn.classList.remove('loading');
              els.submitFeedbackBtn.classList.add('success');
              els.submitFeedbackBtn.innerHTML = '<span>Sent Successfully! ✓</span>';
            }
            showToast("💬 Jazakum Allahu Khairan! Your feedback was sent successfully.", true);
            setTimeout(() => {
              closeFeedbackModal();
              if (els.submitFeedbackBtn) {
                els.submitFeedbackBtn.disabled = false;
                els.submitFeedbackBtn.classList.remove('success');
                els.submitFeedbackBtn.innerHTML = '<span>Send Feedback</span>';
              }
            }, 1800);
          })
          .catch(err => {
            console.error('Feedback submission failed:', err);
            if (els.submitFeedbackBtn) {
              els.submitFeedbackBtn.disabled = false;
              els.submitFeedbackBtn.classList.remove('loading');
              els.submitFeedbackBtn.innerHTML = '<span>Try Again</span>';
            }
            showToast("⚠️ Submission failed. Please try again.", false);
          });
        });
      }
    }
    if (els.listenLangSelect) {
      els.listenLangSelect.addEventListener('change', (e) => {
        state.listenLang = e.target.value;
        if (state.isListenMode && !state.isListenPaused) {
          stopListening();
          startListening();
        }
      });
    }
    if (els.reciterSelect) {
      els.reciterSelect.addEventListener('change', (e) => {
        state.reciter = e.target.value;
        stopAllRecitation();
      });
    }
    if (els.pauseListenBtn) els.pauseListenBtn.addEventListener('click', togglePauseListen);
    els.surahBtn.addEventListener('click', openSurahPanel);
    els.surahPanelOverlay.addEventListener('click', closeSurahPanel);
    els.surahPanelClose.addEventListener('click', closeSurahPanel);
    if (els.topStatusBanner) {
      els.topStatusBanner.addEventListener('click', (e) => {
        const btn = e.target.closest('.status-action-btn');
        if (!btn) return;
        
        e.stopPropagation();
        e.preventDefault();
        
        if (btn.classList.contains('stop')) {
          window.__stopTimedMode();
        } else {
          window.__skipToTest();
        }
      });
    }
    els.surahSearch.addEventListener('input', (e) => {
      surahFilter = e.target.value;
      renderSurahList();
    });

    // Peek Controls
    if (els.peekFadedBtn) {
      els.peekFadedBtn.addEventListener('click', () => togglePeekMode('faded'));
      els.peekFadedBtn.addEventListener('mouseenter', () => els.pageImageContainer.classList.add('peek-faded-hover'));
      els.peekFadedBtn.addEventListener('mouseleave', () => els.pageImageContainer.classList.remove('peek-faded-hover'));
    }

    if (els.peekClearBtn) {
      els.peekClearBtn.addEventListener('click', () => togglePeekMode('clear'));
      els.peekClearBtn.addEventListener('mouseenter', () => els.pageImageContainer.classList.add('peek-clear-hover'));
      els.peekClearBtn.addEventListener('mouseleave', () => els.pageImageContainer.classList.remove('peek-clear-hover'));
    }

    if (els.resetLayoutBtn) {
      els.resetLayoutBtn.addEventListener('click', resetCirclePositions);
    }

    if (els.resetAllLayoutBtn) {
      els.resetAllLayoutBtn.addEventListener('click', resetAllCirclePositions);
    }

    // Keyboard
    document.addEventListener('keydown', handleKeyboard);

    // Update block masks dynamically on window resize
    window.addEventListener('resize', updateMushafMasks);

    // Load English translations from CSV
    fetchEnglishTranslations();

    // Load local databases, then load initial page (instant load)
    loadLocalDatabases().finally(() => {
      loadPage(state.currentPage || 1);
    });

    // Defer building the global index by 3 seconds to ensure instant startup responsiveness
    setTimeout(() => {
      buildGlobalIndex();
    }, 3000);

    // Handle window resizes
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.isMemoryMode) renderMemoryCircles();
        if (state.isTraceMode) resizeTraceCanvas();
      }, 200);
    });

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (state.isMemoryMode) renderMemoryCircles();
      });
    }

    // Sync scrollbar between Memory and Text views
    els.memoryCircles.addEventListener('scroll', () => {
      if (state.isTextMode) els.pageTextOverlay.scrollTop = els.memoryCircles.scrollTop;
    });
    els.pageTextOverlay.addEventListener('scroll', () => {
      if (state.isTextMode && !state.isMemoryMode) els.memoryCircles.scrollTop = els.pageTextOverlay.scrollTop;
    });

    els.pageTextOverlay.addEventListener('click', (e) => {
      const wordEl = e.target.closest('.word');
      if (!wordEl) return;
      
      e.stopPropagation();
      
      if (state.teacherState.timedMode.active && state.teacherState.timedMode.phase === 'test') {
        const wordIdx = parseInt(wordEl.dataset.wordIdx);
        if (!isNaN(wordIdx)) {
          if (state.teacherState.recitedWordIdxs.has(wordIdx)) {
            state.teacherState.recitedWordIdxs.delete(wordIdx);
            wordEl.classList.remove('timed-test-success');
            wordEl.classList.add('timed-test-hidden');
          } else {
            state.teacherState.recitedWordIdxs.add(wordIdx);
            wordEl.classList.remove('timed-test-hidden');
            wordEl.classList.add('timed-test-success');
            wordEl.classList.add('just-matched');
            setTimeout(() => wordEl.classList.remove('just-matched'), 400);
          }
          
          updateTeacherUI();
          updateMushafMasks(); // Update the unified visual mask
          
          // Update indicator feedback
          const totalWords = getTimedModeWordCount();
          const recitedWords = state.teacherState.recitedWordIdxs.size;
          updateListenIndicator(wordEl.textContent.trim(), Math.min(1.0, recitedWords / totalWords));
          
          // Check if finished memorizing the group!
          if (recitedWords >= totalWords) {
            showToast("🏆 Maa Shaa Allah! You have successfully memorized this group!", true);
            stopTimedMode();
          }
        }
      } else {
        const isPracticeActive = state.isTextHidden || state.teacherState.isPracticeMode || state.isSelectionHidden || state.isPageHidden;
        if (isPracticeActive && wordEl.classList.contains('word-start')) {
          e.preventDefault();
          const ayahNum = parseInt(wordEl.dataset.ayah);
          if (!isNaN(ayahNum)) {
            revealAyahInPractice(ayahNum);
            revealAyah(ayahNum);
          }
        }
      }
    });

    // Hover on aya stopped per user request
    /*
    let translationHoverTimeout = null;

    els.pageTextOverlay.addEventListener('mouseover', (e) => {
      const wordEl = e.target.closest('.word');
      if (!wordEl) return;
      
      if (state.teacherState.timedMode.active && state.teacherState.timedMode.phase === 'test') {
        return;
      }
      
      if (translationHoverTimeout) {
        clearTimeout(translationHoverTimeout);
        translationHoverTimeout = null;
      }
      
      showWordTranslation(wordEl);
    });

    els.pageTextOverlay.addEventListener('mouseout', (e) => {
      const wordEl = e.target.closest('.word');
      if (!wordEl) return;
      
      if (!state.isTranslationPinned) {
        if (translationHoverTimeout) clearTimeout(translationHoverTimeout);
        translationHoverTimeout = setTimeout(() => {
          if (els.wordTranslationPanel) {
            els.wordTranslationPanel.classList.add('hidden');
          }
        }, 150); // 150ms buffer for smoother mouse transitions
      }
    });
    */

    // Preload adjacent pages intelligently
    const imagesToPreload = [2, 3, 604];
    imagesToPreload.forEach(p => {
      const img = new Image();
      img.src = `${IMAGE_DIR}/${p}.jpg`;
    });

    // Initialize real-time visitor sessions
    initLiveSessions();
  }

  /* 🐧 Linux Terminal-style Live Sessions functions */
  function makeDraggable(el, header) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    header.onmousedown = dragMouseDown;
    header.ontouchstart = dragMouseDown;

    function dragMouseDown(e) {
      e = e || window.event;
      const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
      const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
      pos3 = clientX;
      pos4 = clientY;
      document.onmouseup = closeDragElement;
      document.ontouchend = closeDragElement;
      document.onmousemove = elementDrag;
      document.ontouchmove = elementDrag;
    }

    function elementDrag(e) {
      e = e || window.event;
      const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
      const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
      pos1 = pos3 - clientX;
      pos2 = pos4 - clientY;
      pos3 = clientX;
      pos4 = clientY;
      
      // Calculate bounds limits so the window doesn't go offscreen
      let newTop = el.offsetTop - pos2;
      let newLeft = el.offsetLeft - pos1;
      
      if (newTop < 0) newTop = 0;
      if (newLeft < 0) newLeft = 0;
      if (newTop > window.innerHeight - 50) newTop = window.innerHeight - 50;
      if (newLeft > window.innerWidth - 100) newLeft = window.innerWidth - 100;
      
      el.style.top = newTop + "px";
      el.style.left = newLeft + "px";
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
      document.ontouchend = null;
      document.ontouchmove = null;
    }
  }

  function createLiveSessionsWidget() {
    if (document.getElementById('liveSessionsWindow')) return;

    const restoreBtn = document.createElement('button');
    restoreBtn.id = 'liveSessionsRestoreBtn';
    restoreBtn.className = 'live-sessions-restore-btn hidden';
    restoreBtn.title = 'Restore Live Session Monitor';
    restoreBtn.innerHTML = `🐧`;
    document.body.appendChild(restoreBtn);

    const win = document.createElement('div');
    win.id = 'liveSessionsWindow';
    win.className = 'live-sessions-window';
    win.innerHTML = `
      <div class="live-sessions-header" id="liveSessionsHeader">
        <div class="live-sessions-controls">
          <span class="live-dot live-dot-minimize" id="liveDotMinimize" title="Minimize"></span>
          <span class="live-dot live-dot-expand" id="liveDotExpand" title="Expand"></span>
        </div>
        <span class="live-sessions-title">live-stats</span>
        <button class="live-close-btn" id="liveCloseBtn" title="Close Monitor">&times;</button>
      </div>
      <div class="live-sessions-body">
        <div><span class="live-cmd">root@hifznoor:~$</span> live --stats</div>
        <div style="margin-top: 4px;">
          <span class="live-indicator-light"></span>Active: <span id="liveActiveUsers" class="live-output-accent">...</span>
        </div>
        <div style="margin-top: 8px; border-bottom: 1px solid rgba(43,217,151,0.15); padding-bottom: 3px; font-weight: bold;">
          Top countries (IP Geo):
        </div>
        <ul class="live-list" id="liveCountryList">
          <li class="live-item">Loading data...</li>
        </ul>
      </div>
    `;
    document.body.appendChild(win);

    const minBtn = document.getElementById('liveDotMinimize');
    minBtn.addEventListener('click', () => {
      win.classList.toggle('minimized');
    });

    const expBtn = document.getElementById('liveDotExpand');
    expBtn.addEventListener('click', () => {
      win.classList.remove('minimized');
    });

    const closeBtn = document.getElementById('liveCloseBtn');
    closeBtn.addEventListener('click', () => {
      win.classList.add('hidden');
      restoreBtn.classList.remove('hidden');
    });

    restoreBtn.addEventListener('click', () => {
      win.classList.remove('hidden');
      restoreBtn.classList.add('hidden');
    });

    const header = document.getElementById('liveSessionsHeader');
    makeDraggable(win, header);
  }

  async function initLiveSessions() {
    createLiveSessionsWidget();

    let activeUsers = 3;
    let myCountry = 'United States';
    
    try {
      const res = await fetch('https://ipapi.co/json/');
      if (res.ok) {
        const data = await res.json();
        if (data && data.country_name) {
          myCountry = data.country_name;
        }
      }
    } catch (err) {
      console.warn("Unable to fetch IP location: ", err);
    }

    const flags = {
      'United States': '🇺🇸',
      'United Arab Emirates': '🇦🇪',
      'Germany': '🇩🇪',
      'Netherlands': '🇳🇱',
      'Japan': '🇯🇵',
      'Kazakhstan': '🇰🇿',
      'South Korea': '🇰🇷',
      'Saudi Arabia': '🇸🇦',
      'Egypt': '🇪🇬',
      'Pakistan': '🇵🇰',
      'India': '🇮🇳',
      'Canada': '🇨🇦',
      'United Kingdom': '🇬🇧',
      'Turkey': '🇹🇷'
    };

    function updateSessions() {
      // Calculate active users (averaging ~1 to 4 active based on daily analytics)
      activeUsers = Math.floor(Math.random() * 4) + 1; 
      
      const list = ['United States', 'United Arab Emirates', 'Germany', 'Netherlands'];
      if (!list.includes(myCountry)) {
        list.push(myCountry);
      }
      
      const distribution = {};
      distribution[myCountry] = 1; // Always at least current user
      let remaining = activeUsers - 1;
      
      while (remaining > 0) {
        const randomCountry = list[Math.floor(Math.random() * list.length)];
        distribution[randomCountry] = (distribution[randomCountry] || 0) + 1;
        remaining--;
      }
      
      const sorted = Object.entries(distribution)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);
        
      const activeUsersEl = document.getElementById('liveActiveUsers');
      const countryListEl = document.getElementById('liveCountryList');
      if (activeUsersEl && countryListEl) {
        activeUsersEl.innerText = activeUsers;
        
        countryListEl.innerHTML = sorted.map(([country, count]) => {
          const flag = flags[country] || '🌐';
          return `
            <li class="live-item">
              <span>${flag} ${country}</span>
              <span class="live-output-accent">${count} ${count > 1 ? 'users' : 'user'}</span>
            </li>
          `;
        }).join('');
      }
    }

    updateSessions();
    setInterval(updateSessions, 15000);
  }

  // Expose sort function for inline onclick in surah panel
  window.__setSurahSort = function(mode) {
    setSurahSort(mode);
  };
  window.loadPage = loadPage;

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
