import fs from "node:fs";
import path from "node:path";

const PATCH_MARKER = "/* qqbot-duckduckgo-lite-v1 */";
const DIST_DIR = "/app/dist";
const HTML_ENDPOINT = 'const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";';
const LITE_ENDPOINT = 'const DDG_HTML_ENDPOINT = "https://lite.duckduckgo.com/lite";';

function findBundle() {
  for (const file of fs.readdirSync(DIST_DIR)) {
    if (/^ddg-client-.*\.js$/.test(file)) return path.join(DIST_DIR, file);
  }
  return null;
}

function patchBundle(file) {
  let source = fs.readFileSync(file, "utf8");
  const original = source;
  source = source.replace(HTML_ENDPOINT, LITE_ENDPOINT);
  if (!source.includes(PATCH_MARKER)) {
    const anchor = "\treturn results;\n}";
    const fallback = `	if (results.length === 0) {
		const liteResultRegex = /<a\\b(?=[^>]*\\bclass=['"][^'"]*\\bresult-link\\b[^'"]*['"][^>]*)([^>]*)>([\\s\\S]*?)<\\/a>/gi;
		for (const match of html.matchAll(liteResultRegex)) {
			const rawAttributes = match[1] ?? "";
			const rawTitle = match[2] ?? "";
			const rawUrl = /\\bhref=['"]([^'"]*)['"]/i.exec(rawAttributes)?.[1] ?? "";
			const matchEnd = (match.index ?? 0) + match[0].length;
			const trailingHtml = html.slice(matchEnd);
			const nextResultIndex = trailingHtml.search(/<a\\b(?=[^>]*\\bclass=['"][^'"]*\\bresult-link\\b)/i);
			const scopedTrailingHtml = nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
			const rawSnippet = /\\bclass=['"][^'"]*\\bresult-snippet\\b[^'"]*['"][^>]*>([\\s\\S]*?)<\\/(?:td|div|span)>/i.exec(scopedTrailingHtml)?.[1] ?? "";
			const title = decodeHtmlEntities(stripHtml(rawTitle));
			const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
			const snippet = decodeHtmlEntities(stripHtml(rawSnippet));
			if (title && url) results.push({ title, url, snippet });
		}
	}

	${PATCH_MARKER}
`;
    const first = source.indexOf(anchor);
    const second = source.indexOf(anchor, first + anchor.length);
    if (first < 0 || second >= 0) throw new Error("DuckDuckGo lite patch anchor is missing or ambiguous");
    source = source.replace(anchor, `${fallback}${anchor}`);
  }
  if (source === original) return false;
  const tempFile = `${file}.qqbot-duckduckgo-lite.tmp`;
  fs.writeFileSync(tempFile, source, "utf8");
  fs.renameSync(tempFile, file);
  return true;
}

const bundle = findBundle();
if (!bundle) throw new Error("DuckDuckGo client bundle was not found");
console.log(`${patchBundle(bundle) ? "Applied" : "Already applied"} DuckDuckGo lite search patch: ${bundle}`);
