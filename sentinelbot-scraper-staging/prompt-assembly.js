function normalizeLineEndings(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function normalizePromptText(value) {
  return normalizeLineEndings(value)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function estimateTokenCount(value) {
  const text = normalizePromptText(value);
  return Math.max(1, Math.ceil(text.length / 4));
}

function formatPromptSection(title, value) {
  const body = normalizePromptText(value);
  return `=== ${String(title || "").toUpperCase()} ===\n${body}`.trim();
}

function assemblePromptDocument(sections) {
  const orderedSections = Array.isArray(sections) ? sections : [];
  const formattedSections = orderedSections
    .filter((section) => section && section.title)
    .map((section) => formatPromptSection(section.title, section.value));
  const prompt = normalizePromptText(formattedSections.join("\n\n"));

  return {
    prompt,
    byteSize: Buffer.byteLength(prompt, "utf8"),
    tokenEstimate: estimateTokenCount(prompt),
    sectionCount: formattedSections.length
  };
}

function summarizePromptDocument(document) {
  const prompt = normalizePromptText(document?.prompt || "");
  return {
    prompt,
    byteSize: Buffer.byteLength(prompt, "utf8"),
    tokenEstimate: estimateTokenCount(prompt)
  };
}

module.exports = {
  assemblePromptDocument,
  estimateTokenCount,
  formatPromptSection,
  normalizeLineEndings,
  normalizePromptText,
  summarizePromptDocument
};
