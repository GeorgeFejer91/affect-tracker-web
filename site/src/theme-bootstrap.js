(function restoreBrowserTheme() {
  try {
    const stored = JSON.parse(localStorage.getItem("affect-tracker-web/preferences-v1") ?? "null");
    if (stored?.retroTheme === true) document.documentElement.dataset.theme = "windows-95";
  } catch {
    // A missing or malformed browser-local preference leaves the modern theme active.
  }
}());
