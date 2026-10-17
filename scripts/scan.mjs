#!/usr/bin/env node
/**
 * 多仓库 GitHub Issue 监控 —— 抓取 / 对比水位线 / 生成汇总页
 * 零第三方依赖,Node 18+ (Actions 上用 Node 20)。
 *
 * 用法:
 *   GITHUB_TOKEN=xxx node scripts/scan.mjs
 *
 * 环境变量:
 *   GITHUB_TOKEN   必需(公共仓库测试时可省略,但只有 60 次/小时)
 *   CONCURRENCY    并发请求数,默认 8
 *   PER_PAGE       每个仓库抓取的 issue 数,默认 10
 *   NEW_TTL_DAYS   "最近新增"板块保留天数,默认 7
 *   DRY_RUN=1      只打印将要写什么,不落盘
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN || '';
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8));
const PER_PAGE = Math.max(1, Math.min(100, Number(process.env.PER_PAGE || 10)));
const NEW_TTL_DAYS = Number(process.env.NEW_TTL_DAYS || 7);
const DRY_RUN = process.env.DRY_RUN === '1';

const STATE_FILE = 'data/state.json';
const PUBLIC_FILE = 'docs/data.json';
const README_FILE = 'README.md';
const REPOS_FILE = 'repos.txt';

const START_MARK = '<!-- ISSUE-WATCH:START -->';
const END_MARK = '<!-- ISSUE-WATCH:END -->';

const DAY = 86400000;
const nowIso = () => new Date().toISOString();
const log = (...a) => console.log(...a);

/* ---------------------------------------------------------------- 工具 */

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeIfChanged(file, content) {
  let prev = null;
  try {
    prev = await readFile(file, 'utf8');
  } catch {
    /* 文件不存在 */
  }
  if (prev === content) return false;
  if (DRY_RUN) {
    log(`[dry-run] 将写入 ${file}`);
    return true;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  log(`写入 ${file}`);
  return true;
}

function parseRepos(raw) {
  const seen = new Set();
  const out = [];
  for (const line of raw.split('\n')) {
    const text = line.replace(/#.*$/, '').trim();
    if (!text) continue;
    const slug = text
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .replace(/^\/+/, '');
    const m = slug.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) {
      log(`! 跳过无法解析的仓库: ${text}`);
      continue;
    }
    const full = `${m[1]}/${m[2]}`;
    if (seen.has(full)) continue;
    seen.add(full);
    out.push(full);
  }
  return out;
}

/** 固定并发跑一批异步任务,单项失败不影响其它项 */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------------------------------------------------------------- 抓取 */

async function ghFetch(url, previousEtag) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'issue-watch',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  // 条件请求:命中返回 304,不消耗主配额,仓库多也不会打爆 rate limit
  if (previousEtag) headers['If-None-Match'] = previousEtag;

  const res = await fetch(url, { headers });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 180)}`.trim());
  }
  return {
    notModified: false,
    etag: res.headers.get('etag') || null,
    rateRemaining: res.headers.get('x-ratelimit-remaining'),
    data: await res.json(),
  };
}

const slimIssue = (i) => ({
  number: i.number,
  title: i.title,
  url: i.html_url,
  author: i.user?.login ?? 'ghost',
  createdAt: i.created_at,
  comments: i.comments ?? 0,
  labels: (i.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean)
    .slice(0, 4),
});

async function scanRepo(repo, prev) {
  const url = `${API}/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=${PER_PAGE}`;
  try {
    const res = await ghFetch(url, prev?.etag);
    if (res.notModified) {
      return { ...prev, repo, reachable: true, rateRemaining: res.rateRemaining };
    }
    const issues = (res.data ?? []).filter((i) => !i.pull_request).map(slimIssue);
    const newest = issues.length ? issues[0].createdAt : null;
    const watermark = [prev?.lastCreatedAt, newest].filter(Boolean).sort().pop() ?? null;
    // 首次抓取没有水位线 -> 只建基线,不把所有历史 issue 当成"新增"
    const fresh = prev?.lastCreatedAt ? issues.filter((i) => i.createdAt > prev.lastCreatedAt) : [];
    return {
      repo,
      etag: res.etag,
      lastCreatedAt: watermark,
      issues,
      fresh,
      reachable: true,
      rateRemaining: res.rateRemaining,
    };
  } catch (err) {
    return {
      repo,
      etag: prev?.etag ?? null,
      lastCreatedAt: prev?.lastCreatedAt ?? null,
      issues: prev?.issues ?? [],
      fresh: [],
      reachable: false,
      error: String(err?.message ?? err),
    };
  }
}

/* ---------------------------------------------------------------- 渲染 */

const fmtDate = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '—');

const ago = (iso) => {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '—';
  const h = Math.floor(diff / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function buildReadmeBlock(repos, recent, stats) {
  const rows = repos
    .filter((r) => r.reachable !== false)
    .sort((a, b) => {
      const da = a.issues?.[0]?.createdAt ?? '';
      const db = b.issues?.[0]?.createdAt ?? '';
      return db.localeCompare(da);
    })
    .map((r) => {
      const top = r.issues?.[0];
      const cell = top ? `[#${top.number} ${esc(top.title)}](${top.url})` : '_暂无 open issue_';
      return `| [${r.repo}](https://github.com/${r.repo}/issues) | ${r.issues?.length ?? 0} | ${cell} | ${ago(top?.createdAt)} |`;
    });

  const broken = repos.filter((r) => r.reachable === false);
  const brokenLine = broken.length
    ? `\n> **${broken.length} 个仓库抓取失败**: ${broken.map((b) => `\`${b.repo}\``).join('、')}\n`
    : '';

  const recentList = recent.length
    ? recent
        .slice(0, 30)
        .map((i) => `- \`${i.repo}\` [#${i.number} ${esc(i.title)}](${i.url}) — @${esc(i.author)} · ${ago(i.createdAt)}`)
        .join('\n')
    : '_最近没有新增 issue_';

  return `${START_MARK}
## Issue 总览

扫描时间:${fmtDate(stats.scannedAt)} · 仓库 ${stats.total} 个 · open issue ${stats.openIssues} 个 · 本轮新增 **${stats.fresh}** 个

### 最近新增(近 ${NEW_TTL_DAYS} 天)

${recentList}

### 各仓库状态

| 仓库 | open | 最新 issue | 时间 |
|---|--:|---|---|
${rows.join('\n')}
${brokenLine}
${END_MARK}`;
}

function upsertBlock(existing, block) {
  // 只认"独占一行"的标记,避免正文里为了举例出现的同名文本被误当成锚点
  const marked = /^<!-- ISSUE-WATCH:START -->[\s\S]*?^<!-- ISSUE-WATCH:END -->[ \t]*$/m;
  if (marked.test(existing)) return existing.replace(marked, block);
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  if (!existsSync(REPOS_FILE)) {
    console.error(`找不到 ${REPOS_FILE}`);
    process.exit(1);
  }
  if (!TOKEN) log('! 未设置 GITHUB_TOKEN,走匿名请求(60 次/小时),仅够几十个仓库');

  const repos = parseRepos(await readFile(REPOS_FILE, 'utf8'));
  if (!repos.length) {
    console.error(`${REPOS_FILE} 里没有有效仓库`);
    process.exit(1);
  }
  log(`仓库 ${repos.length} 个,并发 ${CONCURRENCY}`);

  const state = await readJson(STATE_FILE, { repos: {} });
  const prevState = state.repos ?? {};

  const results = await pool(repos, CONCURRENCY, (repo) => scanRepo(repo, prevState[repo]));

  const freshIssues = results.flatMap((r) =>
    (r.fresh ?? []).map((i) => ({ repo: r.repo, ...i, foundAt: nowIso() })),
  );

  // 最近新增滚动列表:去重 + 过期清理
  const prevRecent = await readJson('data/recent.json', []);
  const cutoff = Date.now() - NEW_TTL_DAYS * DAY;
  const merged = new Map();
  for (const item of [...prevRecent, ...freshIssues]) {
    const key = `${item.repo}#${item.number}`;
    if (Date.parse(item.createdAt) < cutoff) continue;
    merged.set(key, item);
  }
  const recent = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const openIssues = results.reduce((n, r) => n + (r.issues?.length ?? 0), 0);
  const stats = {
    scannedAt: nowIso(),
    total: repos.length,
    openIssues,
    fresh: freshIssues.length,
    unreachable: results.filter((r) => r.reachable === false).length,
  };

  // 1) 内部状态(etag + 水位线),不含时间戳,内容稳定才产生 diff
  const nextState = { repos: {} };
  for (const r of results) {
    nextState.repos[r.repo] = {
      etag: r.etag ?? null,
      lastCreatedAt: r.lastCreatedAt ?? null,
      issues: r.issues ?? [],
    };
  }
  await writeIfChanged(STATE_FILE, JSON.stringify(nextState, null, 1) + '\n');
  await writeIfChanged('data/recent.json', JSON.stringify(recent, null, 1) + '\n');

  // 2) 对外快照(给静态页用)
  const publicPayload = {
    generatedAt: stats.scannedAt,
    stats,
    repos: results
      .map((r) => ({
        repo: r.repo,
        url: `https://github.com/${r.repo}/issues`,
        reachable: r.reachable !== false,
        error: r.error ?? null,
        issues: r.issues ?? [],
      }))
      .sort((a, b) => (b.issues?.[0]?.createdAt ?? '').localeCompare(a.issues?.[0]?.createdAt ?? '')),
    recent,
  };
  const publicJson = JSON.stringify(publicPayload, null, 1) + '\n';
  const prevPublicRaw = await readFile(PUBLIC_FILE, 'utf8').catch(() => null);
  let sameData = false;
  if (prevPublicRaw) {
    try {
      const prev = JSON.parse(prevPublicRaw);
      sameData =
        JSON.stringify(prev.repos) === JSON.stringify(publicPayload.repos) &&
        JSON.stringify(prev.recent) === JSON.stringify(publicPayload.recent);
    } catch {
      /* 坏文件就重写 */
    }
  }
  // 只有数据真的变了才刷新时间戳,避免每轮都提交
  if (!sameData || !prevPublicRaw) {
    await writeIfChanged(PUBLIC_FILE, publicJson);
  }
  if (sameData && prevPublicRaw) {
    try {
      publicPayload.generatedAt = JSON.parse(prevPublicRaw).generatedAt;
    } catch {
      /* ignore */
    }
  }

  // 3) README 里维护一个标记块,不覆盖手写内容
  const readme = await readFile(README_FILE, 'utf8').catch(
    () => '# Issue Watch\n\n多仓库 GitHub Issue 汇总,由 `scripts/scan.mjs` 自动生成。\n',
  );
  await writeIfChanged(README_FILE, upsertBlock(readme, buildReadmeBlock(results, recent, stats)));

  // 4) 控制台摘要
  log('');
  log(`仓库 ${stats.total} · open issue ${openIssues} · 本轮新增 ${freshIssues.length} · 失败 ${stats.unreachable}`);
  log(`最近新增(近 ${NEW_TTL_DAYS} 天)共 ${recent.length} 条`);
  for (const i of freshIssues) log(`  + ${i.repo}#${i.number}  ${i.title}`);
  const remaining = results.map((r) => r.rateRemaining).filter(Boolean).pop();
  if (remaining) log(`API 剩余配额: ${remaining}`);
  if (stats.unreachable) process.exitCode = 0; // 单仓失败不阻断整体
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
