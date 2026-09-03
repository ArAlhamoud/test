/**
 * Puppeteer is only used by the optional forum-comments scraper (with a
 * serverless Chromium build), so never download a browser on `npm install`.
 */
module.exports = { skipDownload: true, skipChromeDownload: true, skipChromeHeadlessShellDownload: true };
