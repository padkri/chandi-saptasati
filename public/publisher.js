document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("publisher-form");
    const startBtn = document.getElementById("startBtn");
    const progressContainer = document.getElementById("progressContainer");
    const progressFill = document.getElementById("progressFill");
    const progressStatus = document.getElementById("progressStatus");
    const progressPercent = document.getElementById("progressPercent");
    const logContainer = document.getElementById("logContainer");
    const criticalList = document.getElementById("criticalList");
    const backlogList = document.getElementById("backlogList");
    const criticalCount = document.getElementById("criticalCount");
    const backlogCount = document.getElementById("backlogCount");
    const selectedWorkPanel = document.getElementById("selectedWorkPanel");
    const selectedKicker = document.getElementById("selectedKicker");
    const selectedTitle = document.getElementById("selectedTitle");
    const selectedDescription = document.getElementById("selectedDescription");
    const selectedState = document.getElementById("selectedState");
    const selectedActionBtn = document.getElementById("selectedActionBtn");
    const rebuildCatalogBtn = document.getElementById("rebuildCatalogBtn");
    const scopeHelp = document.getElementById("scopeHelp");
    const ALL_CHAPTERS_VALUE = "__all_chapters__";

    // Modal elements
    const modal = document.getElementById("overwriteModal");
    const modalTitle = document.getElementById("modalTitle");
    const modalPreview = document.getElementById("modalPreview");
    const btnSkip = document.getElementById("btnSkip");
    const btnOverwrite = document.getElementById("btnOverwrite");

    // Tabs
    let currentMode = 'mode-extract';
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            currentMode = btn.dataset.tab;
            document.getElementById(currentMode).classList.add('active');
        });
    });

    function logMessage(msg, type = "normal") {
        const div = document.createElement("div");
        div.className = `log-entry ${type === 'success' ? 'success-text' : type === 'error' ? 'error-text' : ''}`;
        div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Promise wrapper for the modal
    function askOverwrite(slokaNumber, data) {
        return new Promise((resolve) => {
            modalTitle.textContent = `Sloka ${slokaNumber} Already Exists`;
            modalPreview.innerHTML = `<strong>Original:</strong><br>${data.sloka_original}<br><br><strong>Meaning:</strong><br>${data.tatparyam?.english || ''}<br>${data.tatparyam?.telugu || ''}`;
            
            modal.style.display = 'flex';

            const handleSkip = () => { cleanup(); resolve('skip'); };
            const handleOverwrite = () => { cleanup(); resolve('overwrite'); };

            const cleanup = () => {
                modal.style.display = 'none';
                btnSkip.removeEventListener('click', handleSkip);
                btnOverwrite.removeEventListener('click', handleOverwrite);
            };

            btnSkip.addEventListener('click', handleSkip);
            btnOverwrite.addEventListener('click', handleOverwrite);
        });
    }

    const slokaList = document.getElementById("toc-list");
    let tocData = [];
    let criticalIds = new Set();
    let selectedWork = null;
    let selectedStatus = "todo";
    let contentScope = "all";

    function getWorkKey(chapter, id) {
        return `${chapter}_${id}`;
    }

    function processableItems(chapterData, scope = "all") {
        return chapterData.items.filter(item => {
            if (item.id === "overview" || item.id === "header") return false;
            if (scope === "dhyana") return item.id === "dhyanam";
            return item.type === "dhyanam" || item.type === "sloka" || item.id === "dhyanam" || /^\d+$/.test(item.id);
        });
    }

    function selectedScope() {
        return document.querySelector('input[name="contentScope"]:checked')?.value || "all";
    }

    function updateScopeOptions() {
        contentScope = selectedScope();
        document.querySelectorAll(".scope-option").forEach(option => {
            const input = option.querySelector("input");
            option.classList.toggle("active", input?.checked);
        });

        const chapterSelect = document.getElementById("extChapterSelect");
        const slokaSelect = document.getElementById("extSlokaSelect");
        const allChapters = chapterSelect.value === ALL_CHAPTERS_VALUE;

        slokaSelect.disabled = contentScope === "dhyana" || allChapters;
        if (contentScope === "dhyana") {
            slokaSelect.innerHTML = '<option value="dhyanam">Dhyana Slokas Only</option>';
            scopeHelp.textContent = allChapters
                ? "All available dhyana slokas across the corpus will be generated."
                : "Only this chapter's dhyana sloka will be generated, if it exists.";
        } else if (allChapters) {
            slokaSelect.innerHTML = '<option value="all">All Slokas</option>';
            scopeHelp.textContent = "All processable slokas across all chapters and sections will be generated.";
        } else {
            scopeHelp.textContent = "Choose all slokas in this chapter, or narrow to one item.";
        }
    }

    function findWork(chapter, id) {
        const chapterData = tocData.find(c => c.chapter === chapter);
        const item = chapterData?.items.find(entry => entry.id === id);
        if (!chapterData || !item) return null;
        return {
            ...item,
            chapter,
            chapterTitle: chapterData.title,
            key: getWorkKey(chapter, id),
        };
    }

    function setSelectedState(state, message) {
        selectedStatus = state;
        selectedState.className = `state-pill ${state}`;
        selectedState.textContent = state === "todo" ? "To Start" :
            state === "in-progress" ? "In Progress" :
            state === "error" ? "Error" : "Completed";

        if (message) {
            selectedDescription.textContent = message;
        }

        selectedActionBtn.disabled = state === "in-progress" || (state === "completed" && !selectedWork?.is_ready);
        selectedActionBtn.textContent = state === "in-progress" ? "Generating..." :
            state === "completed" ? "Open in Reader" : "Start Generation";
    }

    function renderSelectedWork(work, state = null, message = null) {
        selectedWork = work;
        if (!work) {
            selectedWorkPanel.classList.add("hidden");
            return;
        }

        selectedWorkPanel.classList.remove("hidden");
        selectedKicker.textContent = criticalIds.has(work.key) ? "Critical Work" : "Publisher Work";
        selectedTitle.textContent = `${work.chapterTitle}: ${work.label}`;

        if (work.is_ready) {
            setSelectedState("completed", message || "This item is already available to readers.");
        } else if (state) {
            setSelectedState(state, message);
        } else {
            setSelectedState("todo", message || "Ready to generate this item for Reader Mode.");
        }
    }

    function selectWork(chapter, id, linkEl = null) {
        const work = findWork(chapter, id);
        if (!work) return;

        document.querySelectorAll('.sidebar-nav a').forEach(el => el.classList.remove('active'));
        if (linkEl) linkEl.classList.add('active');
        expandChapter(chapter);

        const chapterSelect = document.getElementById("extChapterSelect");
        const slokaSelect = document.getElementById("extSlokaSelect");
        chapterSelect.value = chapter;
        chapterSelect.dispatchEvent(new Event('change'));
        slokaSelect.value = id;

        window.history.replaceState(null, "", `#${work.key}`);
        renderSelectedWork(work);
        selectedWorkPanel.scrollIntoView({ behavior: "smooth", block: "start" });
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

    function createWorkItem(item, chapterTitle, isCritical) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "work-item";
        button.innerHTML = `
            <div>
                <div class="work-item-title">${chapterTitle}: ${item.label}</div>
                <div class="work-item-meta">${isCritical ? "Requested from Reader" : "Yet to complete"}</div>
            </div>
            ${isCritical ? '<span class="critical-chip">Critical</span>' : ''}
        `;
        button.addEventListener("click", () => selectWork(item.chapter, item.id));
        return button;
    }

    function renderWorkQueues(todos) {
        criticalIds = new Set(todos.map(todo => todo.id));
        criticalList.innerHTML = '';
        backlogList.innerHTML = '';

        const missingItems = [];
        tocData.forEach(chapterData => {
            chapterData.items.forEach(item => {
                if (item.critical) criticalIds.add(`${chapterData.chapter}_${item.id}`);
                if (item.is_ready) return;
                missingItems.push({
                    ...item,
                    chapter: chapterData.chapter,
                    chapterTitle: chapterData.title,
                    key: `${chapterData.chapter}_${item.id}`,
                });
            });
        });

        const criticalItems = missingItems.filter(item => criticalIds.has(item.key));
        const backlogItems = missingItems;

        criticalCount.textContent = criticalItems.length;
        backlogCount.textContent = missingItems.length;

        if (criticalItems.length === 0) {
            criticalList.innerHTML = '<div class="empty-work">No flames on the altar. Reader has not summoned anything urgent.</div>';
        } else {
            criticalItems.forEach(item => {
                criticalList.appendChild(createWorkItem(item, item.chapterTitle, true));
            });
        }

        if (backlogItems.length === 0) {
            backlogList.innerHTML = '<div class="empty-work">Backlog is clear. The palm leaves are smiling.</div>';
        } else {
            backlogItems.forEach(item => {
                backlogList.appendChild(createWorkItem(item, item.chapterTitle, criticalIds.has(item.key)));
            });
        }
    }

    async function loadSidebar() {
        slokaList.innerHTML = '';
        try {
            const [response, todoResponse] = await Promise.all([
                fetch('/api/toc'),
                fetch('/api/todos')
            ]);
            if (!response.ok) throw new Error("Failed to load TOC");
            const data = await response.json();
            const todoData = todoResponse.ok ? await todoResponse.json() : { todos: [] };
            tocData = data.toc;
            renderWorkQueues(todoData.todos || []);
            
            // Populate Chapter Dropdown
            const chapterSelect = document.getElementById("extChapterSelect");
            chapterSelect.innerHTML = '';

            const allOption = document.createElement("option");
            allOption.value = ALL_CHAPTERS_VALUE;
            allOption.textContent = "All chapters and sections";
            chapterSelect.appendChild(allOption);
            
            tocData.forEach((chapterData, index) => {
                // Populate Dropdown
                const option = document.createElement("option");
                option.value = chapterData.chapter;
                option.textContent = chapterData.title;
                chapterSelect.appendChild(option);

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
                
                // Create Items list in Sidebar
                const ul = document.createElement("ul");
                ul.className = "toc-chapter-items";
                
                chapterData.items.forEach(item => {
                    const li = document.createElement("li");
                    const a = document.createElement("a");
                    a.href = `#${chapterData.chapter}_${item.id}`;
                    a.textContent = item.label;
                    
                    if (!item.is_ready) {
                        a.classList.add('not-ready');
                        if (criticalIds.has(`${chapterData.chapter}_${item.id}`)) {
                            a.classList.add('critical');
                        }
                        a.title = "Not generated yet";
                    } else {
                        a.classList.add('ready');
                    }
                    
                    a.addEventListener('click', (e) => {
                        e.preventDefault();
                        selectWork(chapterData.chapter, item.id, a);
                    });

                    li.appendChild(a);
                    ul.appendChild(li);
                });
                
                section.appendChild(ul);
                slokaList.appendChild(section);
            });

            // Handle Chapter Select Change to populate Sloka Select
            chapterSelect.onchange = () => {
                const selectedChapter = chapterSelect.value;
                const chapterInfo = tocData.find(c => c.chapter === selectedChapter);
                const slokaSelect = document.getElementById("extSlokaSelect");
                slokaSelect.innerHTML = '<option value="all">All Available</option>';
                
                if (chapterInfo) {
                    processableItems(chapterInfo, contentScope).forEach(item => {
                        const option = document.createElement("option");
                        option.value = item.id;
                        option.textContent = item.label;
                        slokaSelect.appendChild(option);
                    });
                }

                updateScopeOptions();
            };

            // Trigger initial change
            if (tocData.length > 0) chapterSelect.dispatchEvent(new Event('change'));

            const hash = window.location.hash.replace("#", "");
            if (hash) {
                const [chapter, ...idParts] = decodeURIComponent(hash).split("_");
                const itemId = idParts.join("_");
                if (chapter && itemId) selectWork(chapter, itemId);
            }

        } catch (err) {
            console.error("TOC Load Error:", err);
            slokaList.innerHTML = '<li class="error-text">Failed to load index.</li>';
        }
    }

    document.querySelectorAll('input[name="contentScope"]').forEach(input => {
        input.addEventListener("change", () => {
            const chapterSelect = document.getElementById("extChapterSelect");
            chapterSelect.dispatchEvent(new Event("change"));
        });
    });

    // Call on load
    loadSidebar();

    rebuildCatalogBtn.addEventListener("click", async () => {
        rebuildCatalogBtn.disabled = true;
        progressContainer.style.display = 'block';
        logMessage("Rebuilding static catalog database...");

        try {
            const response = await fetch('/api/rebuild', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.detail || "Database rebuild failed.");
            }

            logMessage(`Database rebuilt: ${result.chapters} chapters.`, "success");
            await loadSidebar();
        } catch (err) {
            logMessage(`Rebuild failed: ${err.message}`, "error");
            alert(err.message);
        } finally {
            rebuildCatalogBtn.disabled = false;
        }
    });

    async function extractSlokasFor(chapter, range) {
        const res = await fetch('/api/extract_slokas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chapter, range })
        });
        if (!res.ok) throw new Error((await res.json()).detail || "Failed to extract");
        const data = await res.json();
        return data.slokas;
    }

    async function buildExtractionPlan(scope, chapterChoice, rangeChoice) {
        const chapters = chapterChoice === ALL_CHAPTERS_VALUE
            ? tocData
            : tocData.filter(chapterData => chapterData.chapter === chapterChoice);

        const plan = [];
        for (const chapterData of chapters) {
            const items = processableItems(chapterData, scope);
            if (!items.length) continue;

            const range = scope === "dhyana"
                ? "dhyanam"
                : chapterChoice === ALL_CHAPTERS_VALUE
                    ? "all"
                    : rangeChoice;

            const slokas = await extractSlokasFor(chapterData.chapter, range);
            if (slokas.length) {
                plan.push({
                    chapter: chapterData.chapter,
                    title: chapterData.title,
                    slokas
                });
            }
        }

        if (!plan.length) {
            throw new Error(scope === "dhyana"
                ? "No dhyana slokas are available for this selection."
                : "No slokas are available for this selection.");
        }
        return plan;
    }

    async function processExtractionPlan(plan, sourceName) {
        logContainer.innerHTML = '';
        for (const entry of plan) {
            logMessage(`Queue: ${entry.title} (${entry.slokas.length} item${entry.slokas.length === 1 ? "" : "s"})`);
            await processSlokas(entry.slokas, sourceName, entry.chapter, {
                appendLog: true,
                label: entry.title
            });
        }
    }

    async function processSlokas(slokasToProcess, sourceName, chapter, options = {}) {
        const apiKey = document.getElementById("apiKey").value.trim();

        if (slokasToProcess.length === 0) {
            throw new Error("No slokas found to process.");
        }

        // UI Reset
        startBtn.disabled = true;
        progressContainer.style.display = 'block';
        if (!options.appendLog) logContainer.innerHTML = '';
        logMessage(`Starting ${options.label || "batch"} process for ${slokasToProcess.length} slokas...`);

        const total = slokasToProcess.length;
        let hadError = false;

        for (let i = 0; i < total; i++) {
            const slokaObj = slokasToProcess[i];
            const slokaNumber = slokaObj.number;
            const slokaText = slokaObj.text;
            
            progressStatus.textContent = `Processing Sloka ${slokaNumber} (${i+1} of ${total})`;
            logMessage(`Processing Sloka ${slokaNumber}...`);

            // Phase 1: Try without force overwrite (allows caching)
            try {
                let response = await fetch('/api/process_single', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sloka: slokaText,
                        api_key: apiKey,
                        source: sourceName,
                        chapter: chapter,
                        sloka_number: slokaNumber,
                        force_overwrite: false
                    })
                });

                let result = await response.json();

                if (response.ok && result.cached) {
                    logMessage(`Sloka ${slokaNumber} found in cache. Prompting user...`, "success");
                    const decision = await askOverwrite(slokaNumber, result.data);
                    
                    if (decision === 'skip') {
                        logMessage(`Skipped Sloka ${slokaNumber}.`);
                    } else if (decision === 'overwrite') {
                        logMessage(`Overwriting Sloka ${slokaNumber}...`);
                        response = await fetch('/api/process_single', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                sloka: slokaText, api_key: apiKey, source: sourceName,
                                chapter: chapter, sloka_number: slokaNumber, force_overwrite: true
                            })
                        });
                        result = await response.json();
                        if (response.ok) {
                            logMessage(`Overwritten Sloka ${slokaNumber} successfully.`, "success");
                            if (i < total - 1) await sleep(4000); // LLM called, must sleep
                        } else {
                            hadError = true;
                            logMessage(`Error overwriting ${slokaNumber}: ${result.detail}`, "error");
                        }
                    }
                } else if (response.ok && !result.cached) {
                    logMessage(`Sloka ${slokaNumber} processed and saved via LLM.`, "success");
                    if (i < total - 1) await sleep(4000); // LLM called, must sleep
                } else {
                    hadError = true;
                    logMessage(`Error Sloka ${slokaNumber}: ${result.detail}`, "error");
                }
            } catch (err) {
                hadError = true;
                logMessage(`Network Error Sloka ${slokaNumber}: ${err.message}`, "error");
            }

            // Update Progress Bar
            const pct = Math.round(((i + 1) / total) * 100);
            progressFill.style.width = `${pct}%`;
            progressPercent.textContent = `${pct}%`;
        }

        logMessage("Batch processing complete!", "success");
        startBtn.disabled = false;
        progressStatus.textContent = "Complete!";
        await loadSidebar();
        if (hadError) throw new Error("Generation finished with errors. See the log for details.");
        return true;
    }

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        
        let slokasToProcess = [];
        let sourceName = "Manual Input";
        let chapter = "manual";

        try {
            if (currentMode === 'mode-extract') {
                sourceName = document.getElementById("extSourceName").value.trim();
                chapter = document.getElementById("extChapterSelect").value;
                const slokaRange = document.getElementById("extSlokaSelect").value;
                const plan = await buildExtractionPlan(selectedScope(), chapter, slokaRange);
                await processExtractionPlan(plan, sourceName);
                return;
            } else {
                const rawText = document.getElementById("slokaText").value;
                const lines = rawText.split('\n').map(s => s.trim()).filter(s => s.length > 0);
                slokasToProcess = lines.map((text, i) => ({ number: `${i+1}`, text }));
            }

            await processSlokas(slokasToProcess, sourceName, chapter);
        } catch (err) {
            alert(err.message);
            startBtn.disabled = false;
        }
    });

    selectedActionBtn.addEventListener("click", async () => {
        if (!selectedWork) return;

        if (selectedStatus === "completed" || selectedWork.is_ready) {
            window.location.href = `/#${selectedWork.key}`;
            return;
        }

        if (selectedWork.id === "overview" || selectedWork.id === "header") {
            renderSelectedWork(selectedWork, "error", "This item is metadata, not a processable sloka. Add source content first.");
            return;
        }

        try {
            renderSelectedWork(selectedWork, "in-progress", "Generating reader content now.");
            const sourceName = document.getElementById("extSourceName").value.trim();
            const slokasToProcess = await extractSlokasFor(selectedWork.chapter, selectedWork.id);
            await processSlokas(slokasToProcess, sourceName, selectedWork.chapter);
            const refreshedWork = findWork(selectedWork.chapter, selectedWork.id) || selectedWork;
            refreshedWork.is_ready = true;
            renderSelectedWork(refreshedWork, "completed", "Completed. Reader Mode can open this now.");
        } catch (err) {
            renderSelectedWork(selectedWork, "error", err.message);
            logMessage(`Selected item failed: ${err.message}`, "error");
            startBtn.disabled = false;
        }
    });
});
