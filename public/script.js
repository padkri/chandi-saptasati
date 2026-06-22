document.addEventListener("DOMContentLoaded", () => {
    const slokaList = document.getElementById("sloka-list");
    const slokaView = document.getElementById("sloka-view");
    const loadingSpinner = document.getElementById("loading-spinner");
    const printBtn = document.getElementById("print-btn");
    const expertModeToggle = document.getElementById("expertModeToggle");
    const template = document.getElementById("sloka-template");

    let currentSlokaId = null;
    let currentSlokaData = null;
    const tocIndex = new Map();

    if (expertModeToggle) {
        expertModeToggle.checked = localStorage.getItem("readerExpertMode") === "true";
        expertModeToggle.addEventListener("change", () => {
            localStorage.setItem("readerExpertMode", String(expertModeToggle.checked));
            document.body.classList.toggle("expert-mode", expertModeToggle.checked);
            if (currentSlokaData) renderSloka(currentSlokaData);
        });
        document.body.classList.toggle("expert-mode", expertModeToggle.checked);
    }

    function getTodoKey(chapter, id) {
        return `${chapter}_${id}`;
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function normalizeWhitespace(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function normalizeSlokaForDisplay(original) {
        return String(original || "")
            .replace(/\r?\n/g, " ")
            .replace(/\s+/g, " ")
            .replace(/\s*\|\|\s*([0-9०-९౦-౯]+)\s*\|\|\s*$/g, "॥")
            .replace(/\s*॥\s*([0-9०-९౦-౯]+)\s*\|\|\s*$/g, "॥")
            .replace(/\s*\|\|\s*$/g, "॥")
            .trim();
    }

    function splitPadas(original) {
        const text = normalizeSlokaForDisplay(original)
            .replace(/।/g, "।\n")
            .replace(/॥/g, "॥\n");

        return text
            .split(/\n+/)
            .map(line => line.trim())
            .filter(Boolean);
    }

    function countIndicSyllables(line) {
        const cleaned = String(line || "").replace(/[।॥|,.;:!?0-9०-९౦-౯]/g, " ");
        const vowels = cleaned.match(/[अआइईउऊऋॠऌॡएऐओऔఅఆఇఈఉఊఋౠఌౡఎఏఐఒఓఔ]|[ािीुूृॄॢॣेैोौాిీుూృౄెేైొోౌ]/g);
        return vowels ? vowels.length : 0;
    }

    function parseChandasText(value) {
        const text = String(value || "");
        const lowered = text.toLowerCase();
        if (!text || lowered.includes("not a standard") || lowered.includes("irregular")) {
            return null;
        }

        const match = text.match(/chandas:\s*([^.;।]+)/i) || text.match(/([^.;।]*छन्द[^.;।]*)/i);
        const rawName = match ? match[1].trim() : text.trim();
        if (!rawName) return null;

        const syllablesPerPada = lowered.includes("trishtubh") || lowered.includes("triṣṭubh") || lowered.includes("त्रिष्टुभ") ? 11 :
            lowered.includes("jagati") || lowered.includes("jagatī") || lowered.includes("जगती") ? 12 : undefined;

        return {
            name: rawName,
            syllablesPerPada,
            confidence: syllablesPerPada ? "medium" : "low",
            source: "llm"
        };
    }

    function detectChandas(data) {
        if (data.chandas?.name) return data.chandas;

        const parsed = parseChandasText(data.alamkaram_chandas);
        if (parsed) return parsed;

        const padas = splitPadas(data.sloka_original);
        if (padas.length !== 4) return null;

        const counts = padas.map(countIndicSyllables);
        const near = (target) => counts.every(count => Math.abs(count - target) <= 1);
        if (near(11)) {
            return { name: "Trishtubh", syllablesPerPada: 11, confidence: "medium", source: "heuristic" };
        }
        if (near(12)) {
            return { name: "Jagati", syllablesPerPada: 12, confidence: "medium", source: "heuristic" };
        }
        return null;
    }

    function normalizeWords(data) {
        const words = data.words || data.pada_vibhaga || [];
        return words.map((item, index) => ({
            word: item.word || "",
            transliteration: item.transliteration || item.roman || "",
            meaning: item.meaning || "",
            contextualMeaning: item.contextualMeaning || item.contextual_meaning || "",
            padaIndex: Number.isInteger(item.padaIndex) ? item.padaIndex : item.pada_index,
            expert: item.expert || {
                grammar: item.grammar,
                vibhakti: item.vibhakti,
                vachana: item.vachana,
                dhatu: item.dhatu
            },
            key: `${item.word || "word"}-${index}`
        }));
    }

    function normalizeSamasas(data) {
        return (data.samasas || []).map(item => ({
            compound: item.compound || item.word || "",
            type: item.type || "",
            split: item.split || "",
            meaning: item.meaning || "",
            explanation: item.explanation || ""
        }));
    }

    function hasReaderContent(data) {
        const sloka = normalizeWhitespace(data?.sloka_original);
        const tatparyam = data?.tatparyam;
        const meaning = typeof tatparyam === "string"
            ? tatparyam
            : `${tatparyam?.telugu || ""} ${tatparyam?.english || ""}`;
        return Boolean(sloka && normalizeWhitespace(meaning));
    }

    function renderChandasBadge(chandas) {
        if (!chandas?.name) return "";
        const detail = chandas.syllablesPerPada ? `${chandas.syllablesPerPada} syllables per pada` : "detected";
        return `
            <div class="chandas-meter">
                <span class="label">Chandas</span>
                <strong>${escapeHtml(chandas.name)}</strong>
                <span>${escapeHtml(detail)} · ${escapeHtml(chandas.confidence || "low")} confidence</span>
            </div>
        `;
    }

    function renderSlokaLines(data, chandas) {
        const hasCuratedPadas = Array.isArray(data.padas) && data.padas.length > 1;
        const padas = hasCuratedPadas ? data.padas : splitPadas(data.sloka_original);
        const canSplit = hasCuratedPadas || (chandas?.name && padas.length > 1);
        if (!canSplit) {
            return `<h2 class="original-sloka">${escapeHtml(normalizeSlokaForDisplay(data.sloka_original))}</h2>`;
        }

        return `
            <div class="pada-lines">
                ${padas.map((pada, index) => `
                    <div class="pada-line">
                        <span class="pada-number">${index + 1}</span>
                        <span>${escapeHtml(pada)}</span>
                    </div>
                `).join("")}
            </div>
        `;
    }

    function routeChapterId() {
        const key = currentSlokaId || "";
        const separatorIndex = key.lastIndexOf("_");
        return separatorIndex > 0 ? key.slice(0, separatorIndex) : "";
    }

    function readerChapterLabel(data) {
        const routeChapter = routeChapterId();
        const sacredSections = {
            "saptasloki": "సప్తశ్లోకీ",
            "argala": "అర్గలాస్తోత్రమ్",
            "keelakam": "కీలకం",
            "ratri-suktam": "రాత్రి సూక్తం",
            "devisuktam": "దేవీ సూక్తం"
        };

        if (sacredSections[routeChapter]) return sacredSections[routeChapter];
        if (/^\d+$/.test(routeChapter)) return `అధ్యాయం ${routeChapter}`;

        const rawChapter = String(data.chapter ?? "").trim();
        if (rawChapter && rawChapter !== "0") return `అధ్యాయం ${rawChapter}`;

        const item = tocIndex.get(currentSlokaId);
        return item?.title || "పాఠం";
    }

    function readerSlokaLabel(data) {
        if (data.sloka_number === "dhyanam") return "ధ్యాన శ్లోకం";
        return `శ్లోకం ${data.sloka_number ?? ""}`;
    }

    function activateReaderTab(card, tabName) {
        card.querySelectorAll(".reader-tab").forEach(tab => {
            tab.classList.toggle("active", tab.dataset.tab === tabName);
        });
        card.querySelectorAll(".reader-tab-panel").forEach(panel => {
            panel.classList.toggle("active", panel.dataset.panel === tabName);
        });
    }

    function renderMeaningPanel(data) {
        return `
            <div class="meaning-section reader-tab-panel active" data-panel="meaning">
                ${data.tatparyam?.telugu ? `<p class="telugu-meaning">${escapeHtml(data.tatparyam.telugu)}</p>` : ""}
                ${data.tatparyam?.english ? `<p class="english-meaning">${escapeHtml(data.tatparyam.english)}</p>` : ""}
                ${data.summary ? `<p class="summary-meaning">${escapeHtml(data.summary)}</p>` : ""}
                ${data.anvaya ? `<div class="anvaya-box"><span class="label">అన్వయము:</span> ${escapeHtml(data.anvaya)}</div>` : ""}
            </div>
        `;
    }

    function renderWordCards(words) {
        if (!words.length) {
            return '<div class="empty-work">Word meanings are not available yet.</div>';
        }

        return `
            <div class="word-card-grid">
                ${words.map(item => {
                    const expertEntries = Object.entries(item.expert || {}).filter(([, value]) => value);
                    return `
                        <article class="word-card" data-word="${escapeHtml(item.word)}">
                            <h4>
                                <span>${escapeHtml(item.word)}</span>
                                ${item.transliteration ? `<small>(${escapeHtml(item.transliteration)})</small>` : ""}
                            </h4>
                            <p>${escapeHtml(item.meaning || "Meaning not available")}</p>
                            ${item.contextualMeaning ? `<div class="context-note"><span>Context</span>${escapeHtml(item.contextualMeaning)}</div>` : ""}
                            ${expertEntries.length ? `
                                <details class="expert-details" ${expertModeToggle?.checked ? "open" : ""}>
                                    <summary>Expert details</summary>
                                    ${expertEntries.map(([key, value]) => `
                                        <div><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value)}</div>
                                    `).join("")}
                                </details>
                            ` : ""}
                        </article>
                    `;
                }).join("")}
            </div>
        `;
    }

    function renderSamasasPanel(samasas) {
        if (!samasas.length) {
            return '<div class="empty-work">No samasas are listed for this sloka.</div>';
        }

        return `
            <div class="samasa-card-grid">
                ${samasas.map(item => `
                    <article class="samasa-card">
                        <h4>${escapeHtml(item.compound)}</h4>
                        ${item.type ? `<p><strong>Type:</strong> ${escapeHtml(item.type)}</p>` : ""}
                        ${item.split ? `<p><strong>Split:</strong> ${escapeHtml(item.split)}</p>` : ""}
                        ${item.meaning ? `<p>${escapeHtml(item.meaning)}</p>` : ""}
                        ${item.explanation ? `<p class="context-note">${escapeHtml(item.explanation)}</p>` : ""}
                    </article>
                `).join("")}
            </div>
        `;
    }

    function expandChapter(chapter) {
        const section = slokaList.querySelector(`[data-chapter-section="${CSS.escape(chapter)}"]`);
        if (!section) return;
        section.classList.remove("collapsed");
        const toggle = section.querySelector(".toc-chapter-toggle");
        if (toggle) toggle.setAttribute("aria-expanded", "true");
    }

    function toggleChapter(section) {
        const collapsed = section.classList.toggle("collapsed");
        const toggle = section.querySelector(".toc-chapter-toggle");
        if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
    }

    async function recordTodo(chapter, id, label, title) {
        try {
            await fetch('/api/todos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chapter,
                    item_id: id,
                    label,
                    title,
                    source: 'reader'
                })
            });
        } catch (err) {
            console.warn("Unable to record TODO:", err);
        }
    }

    function renderUnavailable(chapter, id, label, title) {
        currentSlokaId = null;
        recordTodo(chapter, id, label, title);
        const publisherHref = `/publisher#${encodeURIComponent(`${chapter}_${id}`)}`;
        slokaView.innerHTML = `
            <div class="empty-state">
                <h3>Content Not Available</h3>
                <p>${escapeHtml(label)} is not available yet. It has been added to Publisher Critical.</p>
                <p class="vedic-wit">The mantra is still in tapas. The scribe has been summoned.</p>
                <a class="todo-callout" href="${publisherHref}">TODO for Publisher</a>
            </div>
        `;
    }

    // Probe available slokas in static folder (we try up to 700)
    // In a real production app, an index.json would be generated by the python script.
    async function loadSidebar() {
        slokaList.innerHTML = '';
        try {
            const response = await fetch('/api/toc');
            if (!response.ok) throw new Error("Failed to load TOC");
            const data = await response.json();
            
            data.toc.forEach(chapterData => {
                const section = document.createElement("div");
                section.className = "toc-chapter collapsed";
                section.dataset.chapterSection = chapterData.chapter;

                const chapterHeader = document.createElement("button");
                chapterHeader.type = "button";
                chapterHeader.className = "toc-chapter-header toc-chapter-toggle";
                chapterHeader.setAttribute("aria-expanded", "false");
                chapterHeader.textContent = chapterData.title;
                chapterHeader.addEventListener("click", () => toggleChapter(section));
                section.appendChild(chapterHeader);
                
                // Create Items list
                const ul = document.createElement("ul");
                ul.className = "toc-chapter-items";
                
                chapterData.items.forEach(item => {
                    tocIndex.set(getTodoKey(chapterData.chapter, item.id), {
                        label: item.label,
                        title: chapterData.title,
                        isReady: item.is_ready
                    });

                    const li = document.createElement("li");
                    const a = document.createElement("a");
                    a.href = `#${chapterData.chapter}_${item.id}`;
                    a.textContent = item.label;
                    
                    if (!item.is_ready) {
                        a.classList.add('not-ready');
                        a.title = "Not generated yet";
                    }
                    
                    a.addEventListener('click', (e) => {
                        e.preventDefault();
                        document.querySelectorAll('.sidebar-nav a').forEach(el => el.classList.remove('active'));
                        a.classList.add('active');
                        expandChapter(chapterData.chapter);
                        
                        if (!item.is_ready) {
                            renderUnavailable(chapterData.chapter, item.id, item.label, chapterData.title);
                            return;
                        }
                        
                        if (['overview', 'header'].includes(item.id)) {
                            loadMetadata(chapterData.chapter, item.id);
                        } else if (item.id === 'dhyanam') {
                            loadSloka(chapterData.chapter, 'dhyanam');
                        } else {
                            loadSloka(chapterData.chapter, item.id);
                        }
                    });

                    li.appendChild(a);
                    ul.appendChild(li);
                });
                
                section.appendChild(ul);
                slokaList.appendChild(section);
            });
        } catch (err) {
            console.error("TOC Load Error:", err);
            slokaList.innerHTML = '<li class="error-text">Failed to load index.</li>';
        }
    }

    async function loadMetadata(chapter, type) {
        currentSlokaId = `${chapter}_${type}`;
        slokaView.innerHTML = '';
        loadingSpinner.classList.remove('hidden');

        try {
            const response = await fetch(`/api/chapter_metadata?chapter=${chapter}&type=${type}`);
            if (!response.ok) throw new Error("Failed to load metadata");
            const data = await response.json();
            
            // Convert simple markdown-like text to HTML
            // Just wrap lines in <p> tags and bold text between **
            let htmlContent = data.content
                .split('\\n')
                .map(line => `<p>${line.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')}</p>`)
                .join('');
                
            slokaView.innerHTML = `
                <div class="metadata-card">
                    <h2 style="color: var(--primary); margin-bottom: 1rem; border-bottom: 2px solid var(--primary); padding-bottom: 0.5rem; text-transform: capitalize;">${type}</h2>
                    <div style="line-height: 1.8; color: var(--text-color); font-size: 1.1rem;">
                        ${htmlContent}
                    </div>
                </div>
            `;
        } catch (error) {
            slokaView.innerHTML = `
                <div class="empty-state">
                    <h3>Error Loading Metadata</h3>
                    <p>${error.message}</p>
                </div>
            `;
        } finally {
            loadingSpinner.classList.add('hidden');
        }
    }


    function unifySchema(data) {
        let unified = { ...data };
        
        // Unify original sloka text
        unified.sloka_original = data.sloka_original || data.original_text_telugu || data.sloka_text || "Original text missing";
        
        // Unify anvaya
        unified.anvaya = data.anvaya || "";
        
        // Unify meaning
        unified.tatparyam = data.tatparyam || {};
        if (!unified.tatparyam.english && data.overall_meaning) {
            unified.tatparyam.english = data.overall_meaning;
        }
        
        // Handle sentence_split from Chapter 2/3
        if (data.sentence_split && Array.isArray(data.sentence_split)) {
            let combinedWords = [];
            let combinedAnvaya = [];
            let combinedEnglish = [];
            let combinedTelugu = [];
            
            data.sentence_split.forEach(s => {
                if (s.anvaya) combinedAnvaya.push(s.anvaya);
                if (s.devotional_meaning_english) combinedEnglish.push(s.devotional_meaning_english);
                if (s.devotional_meaning_telugu) combinedTelugu.push(s.devotional_meaning_telugu);
                if (s.word_analysis) {
                    s.word_analysis.forEach(w => combinedWords.push(w));
                }
            });
            
            if (!unified.anvaya) unified.anvaya = combinedAnvaya.join(" ");
            if (!unified.tatparyam.english) unified.tatparyam.english = combinedEnglish.join(" ");
            if (!unified.tatparyam.telugu) unified.tatparyam.telugu = combinedTelugu.join(" ");
            if (!unified.pada_vibhaga) unified.pada_vibhaga = combinedWords;
        }
        
        // Handle word_by_word from Chapter 5
        if (data.word_by_word) {
            unified.pada_vibhaga = data.word_by_word;
        }
        
        return unified;
    }

    async function loadSloka(chapter, id) {
        currentSlokaId = `${chapter}_${id}`;
        slokaView.innerHTML = '';
        loadingSpinner.classList.remove('hidden');

        try {
            const response = await fetch(`data/sloka_${chapter}_${id}.json`);
            if (!response.ok) {
                throw new Error("Sloka not found or not generated yet.");
            }
            const data = await response.json();
            if (!hasReaderContent(data)) {
                throw new Error("Sloka analysis is incomplete and needs regeneration.");
            }
            renderSloka(data);
        } catch (error) {
            const item = tocIndex.get(getTodoKey(chapter, id));
            renderUnavailable(
                chapter,
                id,
                item?.label || `Sloka ${id}`,
                item?.title || `Chapter ${chapter}`
            );
        } finally {
            loadingSpinner.classList.add('hidden');
        }
    }

    function renderSloka(data) {
        currentSlokaData = data;
        const chandas = detectChandas(data);
        const words = normalizeWords(data);
        const samasas = normalizeSamasas(data);

        slokaView.innerHTML = '';
        slokaView.innerHTML = `
            <div class="sloka-card reader-card">
                <div class="reader-book-heading">
                    <span class="chapter-pill">${escapeHtml(readerChapterLabel(data))}</span>
                    <span class="separator-mark">॥</span>
                    <span class="chapter-pill">${escapeHtml(readerSlokaLabel(data))}</span>
                </div>

                <div class="sanskrit-section">
                    ${renderSlokaLines(data, chandas)}
                </div>

                <div class="ornament reader-ornament" aria-hidden="true">
                    <span></span><strong>శ్రీమాతే నమః</strong><span></span>
                </div>

                <div class="reader-tabs no-print" role="tablist" aria-label="Sloka meaning views">
                    <button class="reader-tab active" type="button" data-tab="meaning">Meaning</button>
                    <button class="reader-tab" type="button" data-tab="words">Word Meanings</button>
                    <button class="reader-tab" type="button" data-tab="samasas">Samasas</button>
                </div>

                ${renderMeaningPanel(data)}
                <div class="reader-tab-panel" data-panel="words">${renderWordCards(words)}</div>
                <div class="reader-tab-panel" data-panel="samasas">${renderSamasasPanel(samasas)}</div>
            </div>
        `;

        const card = slokaView.querySelector(".reader-card");
        card.querySelectorAll(".reader-tab").forEach(tab => {
            tab.addEventListener("click", () => activateReaderTab(card, tab.dataset.tab));
        });
    }

    printBtn.addEventListener('click', () => {
        if (!currentSlokaId) {
            alert("Please select a sloka first.");
            return;
        }
        window.print();
    });

    function loadFromHash() {
        const hash = window.location.hash;
        if (!hash || !hash.startsWith('#')) return;

        const id = decodeURIComponent(hash.replace('#', ''));
        const parts = id.split('_');
        if (parts.length < 2) return;

        const chap = parts[0];
        const sloka = parts.slice(1).join('_');
        expandChapter(chap);
        if (['overview', 'header'].includes(sloka)) {
            loadMetadata(chap, sloka);
        } else {
            loadSloka(chap, sloka);
        }
    }

    // Initialize
    loadSidebar().then(() => {
        loadFromHash();
    });

    window.addEventListener('hashchange', loadFromHash);
    
});
