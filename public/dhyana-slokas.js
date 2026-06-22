document.addEventListener("DOMContentLoaded", () => {
    const list = document.getElementById("dhyanaList");
    const loading = document.getElementById("dhyanaLoading");
    const printBtn = document.getElementById("dhyanaPrintBtn");

    function escapeHtml(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
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

    function slokaText(data) {
        const padas = Array.isArray(data.padas) && data.padas.length
            ? data.padas
            : normalizeSlokaForDisplay(data.sloka_original)
                .replace(/\s*।\s*/g, "।\n")
                .replace(/\s*॥\s*/g, "॥\n")
                .split(/\r?\n+/)
                .map(line => line.trim())
                .filter(Boolean);
        return padas.length ? padas : [data.sloka_original || ""];
    }

    function renderChapter(chapter, data) {
        const meaning = data.tatparyam?.telugu || "తాత్పర్యము అందుబాటులో లేదు.";
        return `
            <article class="dhyana-entry">
                <div class="dhyana-entry-heading">
                    <span class="chapter-pill">అధ్యాయం ${chapter}</span>
                    <span class="separator-mark">॥</span>
                </div>
                <div class="dhyana-sloka">
                    ${slokaText(data).map(line => `<p>${escapeHtml(line)}</p>`).join("")}
                </div>
                <p class="dhyana-meaning">${escapeHtml(meaning)}</p>
                <div class="ornament" aria-hidden="true">
                    <span></span><strong>శ్రీమాతే నమః</strong><span></span>
                </div>
            </article>
        `;
    }

    async function loadDhyanaSlokas() {
        try {
            const chapters = await Promise.all(
                Array.from({ length: 13 }, async (_, index) => {
                    const chapter = index + 1;
                    const response = await fetch(`data/sloka_${chapter}_dhyanam.json`);
                    if (!response.ok) throw new Error(`Chapter ${chapter} dhyana sloka is not available`);
                    return { chapter, data: await response.json() };
                })
            );
            list.innerHTML = chapters.map(({ chapter, data }) => renderChapter(chapter, data)).join("");
        } catch (error) {
            list.innerHTML = `<div class="empty-state"><h3>Content Not Available</h3><p>${escapeHtml(error.message)}</p></div>`;
        } finally {
            loading.classList.add("hidden");
        }
    }

    printBtn.addEventListener("click", () => window.print());
    loadDhyanaSlokas();
});
