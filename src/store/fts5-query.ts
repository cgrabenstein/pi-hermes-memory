/**
 * FTS5 query builder — converts natural language queries into
 * FTS5-compatible match expressions.
 *
 * Tokenizes the input, strips common English stop words,
 * and joins remaining terms with OR for broad recall.
 * Queries already containing FTS5 operators (OR, AND, NOT, NEAR)
 * are passed through unchanged for power users.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'because', 'as', 'until',
  'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to',
  'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
  'very', 'just', 'because', 'done', 'do', 'does', 'did', 'doing',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having',
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you',
  'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them',
  'their', 'theirs', 'themselves',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'would', 'could', 'should', 'might', 'may', 'can', 'shall', 'will',
  'dont', "don't", 'doesnt', "doesn't", 'didnt', "didn't", 'wont', "won't",
  'wouldnt', "wouldn't", 'shouldnt', "shouldn't", 'cant', "can't", 'couldnt',
  "couldn't", 'isnt', "isn't", 'arent', "aren't", 'wasnt', "wasn't",
  'werent', "weren't", 'hasnt', "hasn't", 'havent', "haven't", 'hadnt',
  "hadn't",
  'please', 'let', 'us', 'yes', 'no', 'ok', 'okay',
  'hi', 'hello', 'hey', 'thanks', 'thank', 'welcome',
  'get', 'got', 'getting', 'go', 'goes', 'went', 'going',
  'make', 'makes', 'made', 'making', 'use', 'uses', 'used', 'using',
  'take', 'takes', 'took', 'taking', 'know', 'knows', 'knew', 'knowing',
  'like', 'likes', 'liked', 'liking', 'see', 'sees', 'saw', 'seeing',
  'want', 'wants', 'wanted', 'wanting', 'look', 'looks', 'looked', 'looking',
  'need', 'needs', 'needed', 'needing', 'think', 'thinks', 'thought', 'thinking',
]);

const FTS5_OPERATOR_RE = /\b(OR|AND|NOT|NEAR)\b/;

/**
 * Escape special characters for use inside an FTS5 quoted-string term.
 */
function escapeTerm(term: string): string {
  return term.replace(/"/g, '""');
}

/**
 * Normalize a query string: lowercase, strip punctuation that splits tokens,
 * collapse whitespace.
 */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[?:!.,;()\[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build an FTS5 MATCH expression from a user-supplied query string.
 *
 * Power-user path: If the query already contains FTS5 operators
 * (OR, AND, NOT, NEAR), it is returned verbatim.
 *
 * Default path: The query is tokenized, common English stop words
 * are removed, and remaining terms are joined with OR for broad recall.
 */
export function buildFts5Query(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Power-user path: pass through queries with explicit FTS5 operators
  if (FTS5_OPERATOR_RE.test(trimmed)) {
    return trimmed;
  }

  const normalized = normalize(trimmed);
  if (!normalized) return '';

  const terms = normalized.split(/\s+/).filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  // If all words were stop words, fall back to the first 3 raw terms
  if (terms.length === 0) {
    const allTerms = normalized.split(/\s+/).filter((t) => t.length > 0);
    if (allTerms.length === 0) return '';
    return allTerms.slice(0, 3).map((t) => `"${escapeTerm(t)}"`).join(' AND ');
  }

  // Join with OR for broad recall
  return terms.map((t) => `"${escapeTerm(t)}"`).join(' OR ');
}
