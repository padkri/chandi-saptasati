document.addEventListener("DOMContentLoaded", () => {
    const config = window.DURGA_APP_CONFIG || {};
    document.body.classList.toggle("dev-mode", Boolean(config.publisherEnabled));
    document.body.classList.toggle("prod-mode", !config.publisherEnabled);

    document.querySelectorAll("[data-dev-only]").forEach(element => {
        element.hidden = !config.publisherEnabled;
    });
});
