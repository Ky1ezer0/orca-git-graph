export const defaults = Object.freeze({ layout: 'flexible', diffView: 'main', initialBranch: '', showStashes: false, showTags: true, includeReflogs: false, firstParent: false, issueLinks: Object.freeze([]) });

export function preferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid repository settings.');
  const result = { ...defaults };
  for (const key of Object.keys(defaults).filter(key => key !== 'issueLinks')) {
    if (!(key in value)) continue;
    if (typeof value[key] !== typeof defaults[key]) throw new Error('Invalid setting: ' + key);
    result[key] = typeof value[key] === 'string' ? value[key].trim() : value[key];
  }
  if (!['compact', 'flexible'].includes(result.layout) || !['main', 'inline'].includes(result.diffView)) throw new Error('Choose a valid layout and diff location.');
  for (const [key, max] of [['initialBranch', 1024]]) {
    if (result[key].length > max || /[\x00-\x1f\x7f]/.test(result[key])) throw new Error('Invalid setting: ' + key);
  }
  if (result.initialBranch && result.initialBranch !== 'HEAD' && !/^refs\/(heads|remotes|tags)\//.test(result.initialBranch)) throw new Error('Choose an initial branch from the repository.');
  // Preserve the single issue template saved by earlier plugin versions.
  const rules = 'issueLinks' in value ? value.issueLinks : value.issueUrl ? [{ prefix: '#', url: value.issueUrl }] : [];
  if (!Array.isArray(rules) || rules.length > 20) throw new Error('Use up to 20 issue-link rules.');
  const prefixes = new Set();
  result.issueLinks = rules.map(rule => {
    if (!rule || typeof rule.prefix !== 'string' || typeof rule.url !== 'string') throw new Error('Enter an issue prefix and URL template.');
    const prefix = rule.prefix.trim(), url = rule.url.trim();
    if (!prefix || prefix.length > 40 || /[\s\x00-\x1f\x7f]/.test(prefix)) throw new Error('Issue prefixes need 1–40 characters without spaces.');
    if (prefixes.has(prefix)) throw new Error('Each issue-link rule needs a different prefix.');
    prefixes.add(prefix);
    if (url.length > 2000 || /[\x00-\x1f\x7f]/.test(url)) throw new Error('Invalid issue URL template.');
    if (!url.includes('{issue}')) throw new Error('Issue URL must contain {issue}.');
    linkUrl(url, { issue: '123' });
    return { prefix, url };
  });
  return result;
}

export function linkUrl(template, values) {
  const expanded = template.replace(/\{([^}]+)\}/g, (_, key) => {
    if (key !== 'issue' || typeof values[key] !== 'string') throw new Error('Unknown URL placeholder: ' + key);
    return encodeURIComponent(values[key]);
  });
  const url = new URL(expanded);
  if (url.protocol !== 'https:' || url.username || url.password || /[{}]/.test(expanded)) throw new Error('Use an HTTPS URL without embedded credentials or unmatched braces.');
  return url.href;
}

export function findIssueLinks(message, rules) {
  if (!rules.length) return [];
  const templates = new Map(rules.map(rule => [rule.prefix, rule.url]));
  const prefixes = [...templates.keys()].sort((a, b) => b.length - a.length).map(prefix => prefix.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp('(' + prefixes.join('|') + ')([0-9]+)(?![\\p{L}\\p{N}_])', 'gu');
  return [...message.matchAll(pattern)].filter(match => !/[\p{L}\p{N}_]/u.test(message.slice(0, match.index).at(-1) || '')).map(match => ({
    index: match.index, text: match[0], url: linkUrl(templates.get(match[1]), { issue: match[2] })
  }));
}
