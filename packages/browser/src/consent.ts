/**
 * Cookie-consent banners and dialogs of the common consent tools (HubSpot, OneTrust, Cookiebot,
 * CookieYes / Cookie Law Info, Complianz, Cookie Notice, Osano / Cookie Consent, Usercentrics,
 * TrustArc, Quantcast, Termly). They are third-party overlays with their own styles, shown over
 * the page until the visitor answers, so the page scripts leave them out of the site's typography,
 * colors, layout and touch-target measurements.
 */
export const CONSENT_SELECTOR = [
  "#hs-eu-cookie-confirmation",
  "#onetrust-consent-sdk",
  "#onetrust-banner-sdk",
  "#CybotCookiebotDialog",
  "#cookie-law-info-bar",
  "#cky-consent",
  ".cky-consent-container",
  "#cmplz-cookiebanner-container",
  "#cookie-notice",
  ".cc-window",
  ".osano-cm-window",
  "#usercentrics-root",
  "#truste-consent-track",
  "#qc-cmp2-container",
  "#termly-code-snippet-support",
].join(", ");

/** Script fragment defining `inConsent(el)` for the page scripts (plain strings, see page-scripts.ts). */
export const IN_CONSENT = `const inConsent = (el) => !!(el && el.closest && el.closest(${JSON.stringify(CONSENT_SELECTOR)}));`;
