#!/usr/bin/env node
'use strict';
/* Automatic version bump from conventional commits (ADR: release bot).
 * feat -> minor · fix -> patch · feat!/BREAKING CHANGE -> major
 * chore/docs/test/refactor/style/ci/build do not bump (no release).
 * CLI mode updates package.json, README marker and docs/changelog.md; the
 * CI workflow does the actual commit/tag/push. */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function parseBumpType(commits) {
  let type = null;
  const rank = { patch: 1, minor: 2, major: 3 };
  for (const msg of commits || []) {
    const text = String(msg);
    const breakingFooter = /(^|\n)BREAKING CHANGE[:(]/.test(text);
    const m = /^(\w+)(!)?(?::|\s)/.exec(text);
    let t = null;
    if (breakingFooter || (m && m[2] === '!')) t = 'major';
    else if (m) {
      const w = m[1].toLowerCase();
      if (w === 'feat' || w === 'feature') t = 'minor';
      else if (w === 'fix') t = 'patch';
    }
    if (t && (!type || rank[t] > rank[type])) type = t;
  }
  return type;
}

export function nextVersion(current, commits) {
  const bump = parseBumpType(commits);
  if (!bump) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(current));
  if (!m) throw new Error('unparseable current version: ' + current);
  let [x, y, z] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  if (bump === 'major') { x++; y = 0; z = 0; }
  else if (bump === 'minor') { y++; z = 0; }
  else z++;
  return `${x}.${y}.${z}`;
}

export function commitsSince(tag, runGit) {
  const git = runGit || ((cmd) => execSync(cmd, { encoding: 'utf8' }));
  const range = commitRange(tag, runGit);
  const out = git(`git log --format=%s ${range}`);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export function updateReadme(text, version) {
  const marker = /<!--\s*version:[^>]*-->/;
  if (marker.test(text)) return text.replace(marker, `<!-- version: ${version} -->`);
  return text;
}

export function changelogEntry(version, dateStr, commits) {
  const lines = [`## ${version} (${dateStr})`];
  for (const c of commits || []) lines.push('- ' + String(c).split(/\r?\n/)[0]);
  return lines.join('\n');
}

function lastTag(runGit) {
  const git = runGit || ((cmd) => execSync(cmd, { encoding: 'utf8' }));
  try {
    return git('git describe --tags --abbrev=0').trim();
  } catch {
    return null;
  }
}

function commitRange(tag, runGit) {
  const git = runGit || ((cmd) => execSync(cmd, { encoding: 'utf8' }));
  if (tag) return `${tag}..HEAD`;
  try {
    git('git symbolic-ref -q HEAD'); // on a branch?
    return 'HEAD'; // no tags yet: first-parent history of the current branch
  } catch {
    return 'HEAD';
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const tag = lastTag();
  const commits = commitsSince(tag);
  const next = nextVersion(pkg.version, commits);
  if (!next) {
    console.log(`bump: no release-worthy commits since ${tag || 'start'} — keeping ${pkg.version}`);
    return;
  }
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const readmePath = path.join(root, 'README.md');
  if (existsSync(readmePath)) {
    writeFileSync(readmePath, updateReadme(readFileSync(readmePath, 'utf8'), next));
  }
  const changelogPath = path.join(root, 'docs', 'changelog.md');
  if (existsSync(changelogPath)) {
    const today = new Date().toISOString().slice(0, 10);
    const old = readFileSync(changelogPath, 'utf8');
    const stripped = old.replace(/^## Unreleased\r?\n?/, '');
    writeFileSync(changelogPath, `# Changelog\n\n## Unreleased\n${changelogEntry(next, today, commits)}\n${stripped}`.replace(/\n{3,}/g, '\n\n'));
  }
  console.log(`bump: ${pkg.version && next} -> ${next} (${parseBumpType(commits)}) from ${commits.length} commit(s) since ${tag || 'start'}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
