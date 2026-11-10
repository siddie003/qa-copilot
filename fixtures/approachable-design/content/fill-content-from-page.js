// Builds a QA Copilot approved-content document from the page you have open, then downloads it.
// Use: open https://www.approachabledesign.co/newsletter/ in Chrome → F12 → Console → paste this
// whole file → Enter. A file "approachable-design-approved-content.md" is downloaded.
// It reads the visible main content only (header, navigation and footer are skipped).
(() => {
  const main = document.querySelector("main") || document.body;
  const visible = (el) =>
    el.getBoundingClientRect().width > 0 && !el.closest("header, nav, footer");
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const lines = ["<!-- page: /newsletter/ -->", ""];
  for (const el of main.querySelectorAll(
    "h1, h2, h3, p, button, a[class*='button'], a[class*='btn']",
  )) {
    if (!visible(el)) continue;
    const text = clean(el.textContent || "");
    if (!text || text.split(" ").length < 2) continue; // skip one-word labels (names, ratings)
    if (el.closest("button") && el.tagName !== "BUTTON") continue;
    const tag = el.tagName.toLowerCase();
    lines.push(
      tag === "h1"
        ? `# ${text}`
        : tag === "h2"
          ? `## ${text}`
          : tag === "h3"
            ? `### ${text}`
            : text,
      "",
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: "approachable-design-approved-content.md",
  });
  a.click();
  console.log(
    `QA Copilot content document created with ${lines.filter(Boolean).length - 1} entries.`,
  );
})();
