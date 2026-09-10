const fs = require('fs');
const config = require('../config');

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function loadProfileText() {
  const text = readFileSafe(config.PROFILE_PATH);
  if (!text.trim()) {
    throw new Error(
      `No profile found at ${config.PROFILE_PATH}. Create it (see data/profile.example.md) before running.`
    );
  }
  return text;
}

function loadCvTemplateText() {
  return readFileSafe(config.CV_TEMPLATE_PATH);
}

// Shorter version used for the cheap bulk pre-filter step, to keep that call small/fast.
async function loadProfileSummary() {
  const text = loadProfileText();
  return text.length > 1500 ? `${text.slice(0, 1500)}\n...(truncated)` : text;
}

module.exports = { loadProfileText, loadCvTemplateText, loadProfileSummary };
