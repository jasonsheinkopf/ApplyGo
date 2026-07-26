(() => {
  const ua = navigator.userAgent || "";
  const isIPad = /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isMobile = !isIPad && (/Mobi|Android|iPhone/.test(ua) || matchMedia("(max-width: 720px)").matches);
  const device = isIPad ? "tablet" : isMobile ? "mobile" : "desktop";
  document.documentElement.dataset.device = device;
  document.documentElement.classList.add(`device-${device}`);
  document.querySelectorAll("[data-device-label]").forEach((node) => {
    node.textContent = device === "mobile" ? "Phone" : device === "tablet" ? "Tablet" : "Computer";
  });
})();
