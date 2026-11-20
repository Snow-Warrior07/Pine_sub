// Static inspection of the target repository. Gives the architect facts (files, exports,
// import graph, where requirement keywords appear) instead of asking a model to guess.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoInspection } from '../types.ts';

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'must', 'never', 'need', 'today', 'only', 'part', 'that', 'this', 'from', 'when', 'each', 'every', 'their']);

export function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) if (!STOPWORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w.replace(/s$/, '')))].slice(0, 12);
}

export function inspectRepo(dir: string, files: string[], requirementText: string): RepoInspection {
  const keywords = extractKeywords(requirementText);
  const jsFiles = files.filter((f) => f.endsWith('.js'));
  const result: RepoInspection = { files: [], keywordHits: [], dependents: {} };

  for (const path of jsFiles) {
    const text = readFileSync(join(dir, path), 'utf8');
    const exports = [...text.matchAll(/export (?:const|function|class) (\w+)/g)].map((m) => m[1]);
    const imports = [...text.matchAll(/from '(\.[^']+)'/g)].map((m) => resolveImport(path, m[1]));
    result.files.push({ path, lines: text.split('\n').length, exports, imports });
    for (const imp of imports) (result.dependents[imp] ??= []).push(path);
    const lower = text.toLowerCase();
    for (const kw of keywords) {
      const count = lower.split(kw).length - 1;
      if (count > 0) result.keywordHits.push({ path, keyword: kw, count });
    }
  }
  result.keywordHits.sort((a, b) => b.count - a.count);
  return result;
}

function resolveImport(from: string, spec: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
