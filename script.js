/* ============================================
   QURAN MEMORIZER — Application Logic
   Handles page navigation, ayah reveal,
   progress tracking, and API integration
   ============================================ */

(function () {
  'use strict';

  // ===================== CONSTANTS =====================
  const TOTAL_PAGES = 604;
  const API_BASE = 'https://api.alquran.cloud/v1';
  const STORAGE_KEY = 'quran-memorizer-progress';
  const COORDS_STORAGE_KEY = 'quran-memorizer-coords';
  const IMAGE_DIR = 'Mushaf7';
  const CSV_PATH = 'quran_english.csv';

  // ===================== STATE =====================
  const state = {
    currentPage: 1,
    ayahs: [],                    // Array of ayah data for current page
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
    isListenMode: false,
    isListenPaused: false,        // Tracks if the microphone is temporarily paused
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
    lastTranscriptTime: 0,        // For debouncing transcript processing
    highestConfidenceWord: '',    // Track the best-matched word for UI feedback
    pageLocked: false,            // When true, system stays on this page
    lastCurrentPageMatchTime: 0,  // Timestamp of the most recent match on the current page (for time-based lock decay)
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
    listenModeBtn: $('#listenModeBtn'),
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
    systemToast: $('#systemToast'),
    systemToastText: $('#systemToastText'),
    globalIndexProgressContainer: $('#globalIndexProgressContainer'),
    globalIndexProgressBar: $('#globalIndexProgressBar'),
    globalIndexProgressText: $('#globalIndexProgressText'),
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
    const url = `${API_BASE}/page/${pageNum}/quran-uthmani`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const json = await response.json();
    if (json.code !== 200 || !json.data || !json.data.ayahs) {
      throw new Error('Invalid API response');
    }

    let ayahs = json.data.ayahs;

    // If the UthmaniScriptQuran.doc was successfully parsed, inject its exact text and positioning!
    if (state.customQuranData && state.customQuranData.extractedAyahs) {
      ayahs = ayahs.map(apiAyah => {
        const customText = findMatchingAyahInDoc(apiAyah, state.customQuranData.extractedAyahs);
        if (customText) {
          return { ...apiAyah, text: customText };
        }
        return apiAyah;
      });
    }

    return ayahs;
  }

  // ===================== PARALLEL PAGE LOADER =====================
  // Fetches text and image in parallel for maximum speed.
  // CV marker detection is deferred until memory mode is first used.
  let _memoryModeEverActivated = false;

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

    els.currentPageDisplay.textContent = targetPage;
    els.pageInput.value = targetPage;
    
    if (!state.isTextMode) {
      els.pageLoading.classList.remove('hidden');
    }
    els.pageImage.classList.add('loading');

    try {
      // 🚀 PARALLEL: Fetch API text AND start image download simultaneously
      const [ayahs] = await Promise.all([
        fetchPageAyahs(targetPage),
        // Start image loading in parallel with API fetch
        new Promise((resolve) => {
          els.pageImage.onload = () => resolve();
          els.pageImage.onerror = () => resolve(); // Don't reject, let text work
          els.pageImage.src = `${IMAGE_DIR}/${targetPage}.jpg`;
          // Timeout after 8s to prevent infinite loading
          setTimeout(() => resolve(), 8000);
        })
      ]);

      if (state.currentPage !== targetPage) return;

      state.ayahs = ayahs;
      state.lastPageAyahCount = ayahs.length;

      // Render text immediately
      renderAyahList();
      renderPageText();
      updateProgress();

      state.isLoading = false;
      
      if (state.pendingTranscript && state.isListenMode) {
        const pending = state.pendingTranscript;
        state.pendingTranscript = null;
        setTimeout(() => processTranscript(pending), 30);
      }

      // Image finished (or timed out)
      els.pageImage.classList.remove('loading');
      els.pageLoading.classList.add('hidden');

      // 🔍 CV marker detection: ONLY run when memory mode is first used, then cache
      if (_memoryModeEverActivated) {
        state.ayahCoordinates = await detectAyahMarkers(els.pageImage, ayahs);
        if (state.isMemoryMode) renderMemoryCircles();
      }

      // Track this page as viewed
      state.pagesViewed.add(targetPage);
      saveProgress();

    } catch (err) {
      console.error('Failed to load page:', err);
      if (state.currentPage !== targetPage) return;
      
      els.pageImage.classList.remove('loading');
      els.pageLoading.classList.add('hidden');
      state.isLoading = false;

      if (err.message === 'IMAGE_ERROR') {
        els.pageLoading.innerHTML = `
          <div style="font-size:2rem;opacity:0.5">📄</div>
          <span>Could not load page ${targetPage}</span>
        `;
        els.pageLoading.classList.remove('hidden');
      } else {
        els.ayahList.innerHTML = `
          <div class="ayah-list-empty">
            <div class="empty-icon">⚠️</div>
            <p>Could not load ayah data. Check your internet connection.</p>
            <button onclick="location.reload()" style="margin-top:12px;padding:8px 20px;background:var(--gold);border:none;border-radius:8px;color:var(--navy);font-weight:600;cursor:pointer">Retry</button>
          </div>
        `;
      }
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

      card.innerHTML = `
        <div class="ayah-card-header">
          <div class="ayah-number-badge">${ayah.numberInSurah}</div>
          <div class="ayah-surah-info">
            ${surahName ? `<span>${surahName}</span>` : ''}
          </div>
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
    state.isTextMode = !state.isTextMode;
    els.toggleTextBtn.classList.toggle('active', state.isTextMode);

    if (state.isTextMode) {
      els.pageTextOverlay.classList.add('active');
      els.pageImageContainer.classList.add('hide-image');
    } else {
      els.pageTextOverlay.classList.remove('active');
      els.pageImageContainer.classList.remove('hide-image');
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
    let html = '<div class="text-overlay-content">';
    let globalWordIdx = 0;
    state.pageWordsNormalized = [];
    state.pageWordData = [];

    state.ayahs.forEach(ayah => {
      // Tokenize the text strictly preserving all spaces and newlines (\n)
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
        if (/\S/.test(tokens[i])) { // If token is a word
          let idAttr = '';
          let extraClass = '';
          if (i === firstWordIdx) { idAttr = `id="text-start-${ayah.number}"`; extraClass = ' word-start'; }
          else if (i === lastWordIdx && i !== firstWordIdx) { idAttr = `id="text-end-${ayah.number}"`; extraClass = ' word-end'; }
          
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
      
      html += `<span class="ayah-marker-inline"> ﴿${toArabicNumerals(ayah.numberInSurah)}﴾ </span>`;
    });
    html += '</div>';
    els.pageTextOverlay.innerHTML = html;
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
    return text
      .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D4-\u08E2\u08E4-\u08FE\u08FF]/g, '') // Remove tashkeel/diacritics
        .replace(/[أإآاٱ]/g, 'ا') // Normalize Alif and Alef Wasla
      .replace(/[يىیئ]/g, 'ي') // Normalize Yaa/Alif Maqsura variations
      .replace(/ة/g, 'ه') // Normalize Taa Marbutah
      .replace(/[ؤو]/g, 'و') // Normalize Waw
      .replace(/[ء]/g, '') // Remove lone hamza which STT often misses
      .replace(/ـ/g, '') // Remove Tatweel
      .trim();
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
    if (!waveform) return;
    waveform.classList.remove('hidden');
    
    try {
      // Request raw audio access for the real-time analyser
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Setup Web Audio API
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      
      // 64 fftSize gives us 32 frequency bins, which is perfect for mapping to our 8 bars
      analyser.fftSize = 64; 
      analyser.smoothingTimeConstant = 0.7; // Smooths out the jumps naturally
      
      const source = audioContext.createMediaStreamSource(microphoneStream);
      source.connect(analyser);
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const bars = waveform.querySelectorAll('.waveform-bar');
      
      function updateWaveform() {
        if (!analyser) return;
        analyser.getByteFrequencyData(dataArray);
        
        // Map the frequency bins into our 8 visual bars
        const step = Math.floor(analyser.frequencyBinCount / bars.length);
        
        bars.forEach((bar, i) => {
          let sum = 0;
          for(let j = 0; j < step; j++) {
            sum += dataArray[i * step + j];
          }
          const avg = sum / step;
          
          // Map 0-255 dB scale to physical pixel height (4px to 28px)
          const height = 4 + (avg / 255) * 24;
          bar.style.height = `${height}px`;
        });
        
        waveformAnimId = requestAnimationFrame(updateWaveform);
      }
      updateWaveform();
    } catch (err) {
      console.warn('Real-time audio level failed, using fallback animation.', err);
      const bars = waveform.querySelectorAll('.waveform-bar');
      bars.forEach(bar => {
        bar.style.animation = 'waveform-bounce 0.5s ease-in-out infinite alternate';
        bar.style.animationDuration = `${0.3 + Math.random() * 0.6}s`;
        bar.style.animationDelay = `${Math.random() * 0.4}s`;
      });
    }
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

  function toggleListenMode() {
    state.isListenMode = !state.isListenMode;
    els.listenModeBtn.classList.toggle('active', state.isListenMode);

    if (state.isListenMode) {
      if (!state.isTextMode) toggleTextMode();
      
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

      startWaveform();
      startListening();
    } else {
      stopListening();
      stopWaveform();
      
      const indicator = document.getElementById('listenIndicator');
      if (indicator) indicator.classList.add('hidden');
      
      if (els.pauseListenBtn) els.pauseListenBtn.classList.add('hidden');
      document.querySelectorAll('.word.highlighted, .word.just-matched').forEach(el => {
        el.classList.remove('highlighted', 'just-matched');
      });
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

  function startListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Microphone speech recognition is not supported in this browser. Please try Chrome, Edge, or Safari.');
      toggleListenMode();
      return;
    }

    if (!recognition) {
      recognition = new SpeechRecognition();
      recognition.lang = 'ar-SA'; // Optimized for Arabic Speech
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onstart = () => {
        els.listenModeBtn.classList.add('recording');
      };

      recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
          else interimTranscript += event.results[i][0].transcript;
        }
        
        processTranscript(finalTranscript || interimTranscript);
      };

      recognition.onerror = (e) => console.warn('Speech recognition error:', e.error);

      recognition.onend = () => {
        els.listenModeBtn.classList.remove('recording');
        if (state.isListenMode && !state.isListenPaused) {
          try { recognition.start(); } catch (e) {} // Auto-restart if active (handles silence timeouts)
        }
      };
    }
    try { recognition.start(); } catch (e) {}
  }

  function stopListening() {
    if (recognition) recognition.stop();
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
    if (Math.abs(w1.length - w2.length) > 2) return false;
    const dist = getEditDistance(w1, w2);
    if (w1.length <= 2) return dist === 0; // Very short words need exact match
    if (w1.length <= 5) return dist <= 1;  // Allow 1 typo for medium words
    return dist <= 2;                      // Allow 2 typos for long words
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
    if (state.isLoading || !transcript.trim() || state.pageWordsNormalized.length === 0) return;
    
    // Debounce: ignore rapid-fire interim results
    const now = Date.now();
    if (now - state.lastTranscriptTime < 150) return;
    state.lastTranscriptTime = now;
    
    // Normalize and split transcript into words
    let spokenWords = transcript.split(/\s+/).map(normalizeArabic).filter(w => w.length > 0);
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
    
    if (anyCurrentPageMatch && (state.pageLocked || currentScore >= 2)) {
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
        if (lateralMatchedAyahNum && lateralMatchedAyahNum !== state.lastMatchedAyahNum) {
          state.lastMatchedAyahNum = lateralMatchedAyahNum;
          revealAyah(lateralMatchedAyahNum);
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
        if (matchedAyahNum && matchedAyahNum !== state.lastMatchedAyahNum) {
          state.lastMatchedAyahNum = matchedAyahNum;
          revealAyah(matchedAyahNum);
        }
      } else {
        updateListenIndicator('', 0);
      }
    } else {
      // No confidence we're on the right page — just update the indicator
      updateListenIndicator('', 0);
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
    els.memoryModeBtn.setAttribute('aria-pressed', state.isMemoryMode);
    els.memoryModeBtn.classList.toggle('active', state.isMemoryMode);

    if (state.isMemoryMode) {
      // 🔍 Trigger CV detection on first memory mode use (deferred optimization)
      if (!_memoryModeEverActivated) {
        _memoryModeEverActivated = true;
        // Run CV detection in background, don't await
        detectAyahMarkers(els.pageImage, state.ayahs).then(coords => {
          state.ayahCoordinates = coords;
          if (state.isMemoryMode) renderMemoryCircles();
        });
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
    els.pagesViewed.textContent = state.pagesViewed.size;
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
      const response = await fetch(CSV_PATH);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
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

      console.log(`Loaded English translations for ${Object.keys(translations).length} surahs`);
    } catch (err) {
      console.warn('Could not load English translations from CSV:', err);
    }
  }

  function getEnglishTranslation(surahNum, ayahNum) {
    if (!state.englishTranslations[surahNum]) return '';
    return state.englishTranslations[surahNum][ayahNum] || '';
  }

  async function loadCustomQuranData() {
    try {
      // Fetch a clean Plain Text file instead of a binary Word document
      const response = await fetch('UthmaniScriptQuran.txt');
      if (response.ok) {
        const rawText = await response.text();
        state.customQuranData = parseDocFile(rawText);
        console.log('Successfully extracted custom text from UthmaniScriptQuran.txt!');
      }
    } catch (err) {
      console.warn('Could not read .txt file locally, safely falling back to API text.');
    }
  }

  function parseDocFile(rawContent) {
    if (!rawContent) return { extractedAyahs: [] };
    
    // Clean up horizontal whitespace but PRESERVE newlines (\n) so it wraps exactly like the doc
    let cleanText = rawContent.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
    
    // Split the document into an array of ayahs using the end marker
    const rawAyahs = cleanText.split('﴾');
    // Remove ONLY leading horizontal spaces, keeping \n intact for perfect vertical layout
    const extractedAyahs = rawAyahs.map(text => text.replace(/^[ \t]+/, '') + ' ﴾').filter(b => b.trim().length > 1);

    return { extractedAyahs };
  }

  function findMatchingAyahInDoc(apiAyah, extractedAyahs) {
    const arabicNumbers = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
    const ayahNumStr = String(apiAyah.numberInSurah).split('').map(d => arabicNumbers[d]).join('');
    
    // Find the ayah in the extracted document array that matches this number
    const found = extractedAyahs.find(text => text.includes(ayahNumStr) && text.includes('﴾'));
    
    if (found) {
      // Strip the native document brackets but keep the structural whitespace (\n)
      return found.replace(/﴿.*?﴾/g, '').replace(/^[ \t]+/, '');
    }
    return null;
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

  // ===================== GLOBAL INDEX (CACHED, INSTANT) =====================
  const GLOBAL_INDEX_CACHE_KEY = 'quran-global-index-v2';
  const GLOBAL_INDEX_MAP_KEY = 'quran-global-wordmap-v2';

  async function buildGlobalIndex() {
    try {
      // Check localStorage cache FIRST for instant detection
      const cachedWords = localStorage.getItem(GLOBAL_INDEX_CACHE_KEY);
      const cachedMap = localStorage.getItem(GLOBAL_INDEX_MAP_KEY);
      
      if (cachedWords && cachedMap) {
        try {
          state.globalWords = JSON.parse(cachedWords);
          state.globalWordMap = new Map(JSON.parse(cachedMap));
          state.globalIndexBuilt = true;
          console.log(`Loaded global index from cache: ${state.globalWords.length} words, ${state.globalWordMap.size} unique entries`);
          showToast('Voice engine ready ✦', true);
          return;
        } catch (cacheErr) {
          console.warn('Cache corrupted, rebuilding...', cacheErr);
          localStorage.removeItem(GLOBAL_INDEX_CACHE_KEY);
          localStorage.removeItem(GLOBAL_INDEX_MAP_KEY);
        }
      }

      if (els.globalIndexProgressContainer) {
        els.globalIndexProgressContainer.classList.remove('hidden');
        els.globalIndexProgressBar.style.width = '0%';
        els.globalIndexProgressText.textContent = 'Building index...';
      }

      showToast('Building voice navigation index...');

      // Fetch the full Quran data
      const res = await fetch(`${API_BASE}/quran/quran-uthmani`);
      const json = await res.json();
      
      if (!json.data || !json.data.surahs) throw new Error('Invalid API response');

      showToast('Optimizing voice engine...');
      
      const words = [];
      const wordMap = new Map();
      let totalAyahs = 0;
      json.data.surahs.forEach(surah => { totalAyahs += surah.ayahs.length; });
      let processedAyahs = 0;

      // Process all surahs in one batch for speed (processing is fast, fetch is the bottleneck)
      for (const surah of json.data.surahs) {
        for (const ayah of surah.ayahs) {
          const tokens = ayah.text.match(/(\S+|\s+)/g) || [];
          let wordIdx = 0;
          tokens.forEach(t => {
            if (/\S/.test(t)) {
              const norm = normalizeArabic(t);
              if (norm.length > 0) {
                words.push({ text: norm, page: ayah.page });
                // Build hash map for O(1) word → page/ayah lookups
                if (!wordMap.has(norm)) {
                  wordMap.set(norm, []);
                }
                wordMap.get(norm).push({ page: ayah.page, ayahNum: ayah.number, wordIdx });
                wordIdx++;
              }
            }
          });
          processedAyahs++;
          // Update real progress based on actual processing
          const pct = Math.floor((processedAyahs / totalAyahs) * 100);
          if (els.globalIndexProgressBar && pct % 5 === 0) {
            els.globalIndexProgressBar.style.width = `${pct}%`;
            els.globalIndexProgressText.textContent = `${pct}%`;
          }
        }
      }

      state.globalWords = words;
      state.globalWordMap = wordMap;
      state.globalIndexBuilt = true;

      // Cache in localStorage for instant loading on next visit
      try {
        localStorage.setItem(GLOBAL_INDEX_CACHE_KEY, JSON.stringify(words));
        localStorage.setItem(GLOBAL_INDEX_MAP_KEY, JSON.stringify([...wordMap]));
        console.log('Cached global index to localStorage');
      } catch (storageErr) {
        console.warn('Could not cache index (storage full?):', storageErr);
      }

      // Complete progress
      if (els.globalIndexProgressBar) {
        els.globalIndexProgressBar.style.width = '100%';
        els.globalIndexProgressText.textContent = 'Ready!';
      }
      showToast('Voice navigation ready ✦', true);
      
      if (els.globalIndexProgressContainer) {
        setTimeout(() => els.globalIndexProgressContainer.classList.add('hidden'), 2000);
      }
    } catch (err) {
      console.warn('Could not build global index:', err);
      if (els.systemToast) els.systemToast.classList.add('hidden');
      if (els.globalIndexProgressContainer) els.globalIndexProgressContainer.classList.add('hidden');
      // Even without global index, local page matching still works
      state.globalIndexBuilt = true; // Mark as attempted so we don't retry
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
      case 'm':
      case 'M':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          toggleMemoryMode();
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
    els.totalPages.textContent = TOTAL_PAGES;
    updateGlobalStats();

    // Event listeners
    els.prevPageBtn.addEventListener('click', prevPage);
    els.nextPageBtn.addEventListener('click', nextPage);
    els.firstPageBtn.addEventListener('click', firstPage);
    els.lastPageBtn.addEventListener('click', lastPage);
    els.goToPageBtn.addEventListener('click', () => goToPage(els.pageInput.value));
    els.showAllBtn.addEventListener('click', revealAllAyahs);
    els.memoryModeBtn.addEventListener('click', toggleMemoryMode);
    els.resetPageBtn.addEventListener('click', resetPage);
    els.toggleTextBtn.addEventListener('click', toggleTextMode);
    els.listenModeBtn.addEventListener('click', toggleListenMode);
    if (els.pauseListenBtn) els.pauseListenBtn.addEventListener('click', togglePauseListen);
    els.surahBtn.addEventListener('click', openSurahPanel);
    els.surahPanelOverlay.addEventListener('click', closeSurahPanel);
    els.surahPanelClose.addEventListener('click', closeSurahPanel);
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

    // Load English translations from CSV
    fetchEnglishTranslations();

    // Attempt to load custom Uthmani text from the local folder
    loadCustomQuranData();

    // 🚀 START BUILDING GLOBAL INDEX IMMEDIATELY (no wait for first page)
    // This downloads the full Quran word index in background so voice detection
    // works instantly as soon as the user activates Listen Mode.
    // The result is cached in localStorage for subsequent visits.
    buildGlobalIndex();

    // Handle window resizes
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.isMemoryMode) renderMemoryCircles();
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

    // Load initial page
    loadPage(1);

    // Preload adjacent pages intelligently
    const imagesToPreload = [2, 3, 604];
    imagesToPreload.forEach(p => {
      const img = new Image();
      img.src = `${IMAGE_DIR}/${p}.jpg`;
    });
  }

  // Expose sort function for inline onclick in surah panel
  window.__setSurahSort = function(mode) {
    setSurahSort(mode);
  };

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
