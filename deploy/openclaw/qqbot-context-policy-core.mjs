const QQBOT_CONTEXT_DEFAULTS = Object.freeze({
  recentLimit: 2,
  matchLimit: 2,
  perEntryMaxChars: 240,
  totalMaxChars: 1600,
});

const QQBOT_CONTEXT_STOP_TERMS = new Set([
  "the",
  "and",
  "that",
  "this",
  "what",
  "how",
  "why",
  "can",
  "are",
  "with",
  "这个",
  "那个",
  "怎么",
  "什么",
  "为什么",
  "现在",
  "可以",
  "还是",
  "一下",
  "不是",
  "真的",
  "有没有",
  "以及",
  "然后",
  "我们",
  "你们",
  "已经",
  "比较",
]);

export const QQBOT_CONTEXT_POLICY_MARKER = "/* qqbot-context-policy-v1 */";

function qqbotContextText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function qqbotContextLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function qqbotContextTruncate(value, maxChars) {
  const text = qqbotContextText(value);
  const limit = Math.max(0, Math.floor(Number(maxChars)));
  if (limit === 0) return "";
  if (Array.from(text).length <= limit) return text;
  return `${Array.from(text).slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function qqbotContextLooksLikeMention(value) {
  const text = qqbotContextText(value);
  return /<@!?[^>]+>/u.test(text)
    || /(^|[\s])@[\p{L}\p{N}_-]{1,64}(?=\s|$)/u.test(text);
}

function qqbotContextTerms(value) {
  const text = qqbotContextText(value).toLocaleLowerCase();
  const terms = new Set();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]{1,31}/giu)) {
    if (!QQBOT_CONTEXT_STOP_TERMS.has(match[0])) terms.add(match[0]);
  }
  for (const match of text.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const characters = Array.from(match[0]);
    for (let index = 0; index < characters.length - 1; index += 1) {
      const term = characters.slice(index, index + 2).join("");
      if (!QQBOT_CONTEXT_STOP_TERMS.has(term)) terms.add(term);
    }
  }
  return terms;
}

function qqbotContextScore(value, currentTerms) {
  const candidateTerms = qqbotContextTerms(value);
  let score = 0;
  for (const term of candidateTerms) {
    if (currentTerms.has(term)) score += term.length >= 3 ? 2 : 1;
  }
  return score;
}

export function qqbotContextSelectRelevantGroupHistory(entries, currentContent = "", options = {}) {
  const recentLimit = qqbotContextLimit(options.recentLimit, QQBOT_CONTEXT_DEFAULTS.recentLimit);
  const matchLimit = qqbotContextLimit(options.matchLimit, QQBOT_CONTEXT_DEFAULTS.matchLimit);
  const perEntryMaxChars = qqbotContextLimit(options.perEntryMaxChars, QQBOT_CONTEXT_DEFAULTS.perEntryMaxChars);
  const totalMaxChars = qqbotContextLimit(options.totalMaxChars, QQBOT_CONTEXT_DEFAULTS.totalMaxChars);
  const source = Array.isArray(entries) ? entries : [];
  const normalized = source.map((entry, index) => {
    const base = entry && typeof entry === "object" ? entry : {};
    return { base, content: qqbotContextText(base.content), index };
  }).filter(({ content }) => content && !qqbotContextLooksLikeMention(content));

  const selected = new Map();
  for (const item of normalized.slice(-recentLimit)) selected.set(item.index, item);

  const currentTerms = qqbotContextTerms(currentContent);
  if (currentTerms.size > 0 && matchLimit > 0) {
    const recentIndexes = new Set(selected.keys());
    const matches = normalized
      .filter((item) => !recentIndexes.has(item.index))
      .map((item) => ({ item, score: qqbotContextScore(item.content, currentTerms) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.item.index - left.item.index)
      .slice(0, matchLimit);
    for (const { item } of matches) selected.set(item.index, item);
  }

  const ordered = [...selected.values()].sort((left, right) => left.index - right.index);
  const result = [];
  let remainingChars = totalMaxChars;
  for (const item of ordered) {
    if (remainingChars <= 0) break;
    const content = qqbotContextTruncate(item.content, Math.min(perEntryMaxChars, remainingChars));
    if (!content) continue;
    result.push({ ...item.base, content });
    remainingChars -= Array.from(content).length;
  }
  return result;
}

export function buildInjectedQqbotContextPolicySource() {
  const runtimeConstants = [
    `const QQBOT_CONTEXT_DEFAULTS = ${JSON.stringify(QQBOT_CONTEXT_DEFAULTS)};`,
    `const QQBOT_CONTEXT_STOP_TERMS = new Set(${JSON.stringify([...QQBOT_CONTEXT_STOP_TERMS])});`,
  ].join("\n");
  const runtimeFunctions = [
    qqbotContextText,
    qqbotContextLimit,
    qqbotContextTruncate,
    qqbotContextLooksLikeMention,
    qqbotContextTerms,
    qqbotContextScore,
    qqbotContextSelectRelevantGroupHistory,
  ].map((fn) => fn.toString()).join("\n\n");
  return [QQBOT_CONTEXT_POLICY_MARKER, runtimeConstants, runtimeFunctions].join("\n");
}
