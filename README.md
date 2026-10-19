# Issue Watch

一个仓库、一个 token,监控散落在多个 org / 账号下的所有 GitHub 仓库,并自动发布成网页看板。

![dashboard](preview.png)

## 它怎么工作

```
每 15 分钟 (cron)
   └─ scan.mjs 读 repos.txt,并发抓取每个仓库的 open issues
        ├─ 带 If-None-Match:内容没变返回 304,不消耗 API 配额
        ├─ 和上一轮水位线比对,认出"新增"
        ├─ 写 data/state.json(内部状态)+ docs/data.json(公开快照)
        ├─ 更新 README 末尾的表格块
        └─ git commit && push(数据没变就不提交)
   └─ upload-pages-artifact(docs/) + deploy-pages
        └─ https://<owner>.github.io/<repo>/
```

关键点在于**它不是一个仓库一份 workflow**。你只在 `repos.txt` 里加行,跨 org、跨账号都行:

- `Fine-grained PAT` 可以同时勾选多个 **resource owner**,一个 token 覆盖全部仓库
- `ETag` 条件请求让稳态下的 API 消耗接近 0,几百个仓库也不用调低频率
- 状态合并只在单个 job 内做,`concurrency` 防止两个 run 同时改 `data/state.json`

## 仓库结构

| 路径 | 作用 |
|---|---|
| `repos.txt` | **唯一需要你维护的文件**,每行 `owner/repo`,支持完整 URL 和 `#` 注释 |
| `scripts/scan.mjs` | 抓取 + 比对 + 渲染,零第三方依赖,Node 18+ |
| `.github/workflows/issue-watch.yml` | 定时扫描 → 提交数据 → 发布 Pages |
| `data/state.json` | 内部状态(每仓 ETag、水位线、最近 issue),不要手改 |
| `data/recent.json` | "最近新增"滚动窗口,默认 7 天 |
| `docs/index.html` | 看板页面,无框架无 CDN |
| `docs/data.json` | 页面读取的公开快照,由脚本生成 |
| `README.md` | 末尾的仓库表格由脚本维护,其余内容随便写 |

脚本只会重写 README 里**独占一行**的 `ISSUE-WATCH:START` / `ISSUE-WATCH:END` 两个 HTML 注释之间的内容,标记块之前的一切保持原样。

## repos.txt 怎么写

一行一个仓库,空行和 `#` 后面的内容会被忽略,重复自动去重。下面 4 种写法都认,可以混着写:

```
owner/repo
https://github.com/owner/repo
https://github.com/owner/repo.git
git@github.com:owner/repo.git
```

跨 org、跨账号直接列在一起,token 有权限就能抓到。加完先校验格式(不联网、不需要 token):

```bash
node scripts/scan.mjs --check
```

它会打印解析出的仓库数和规范化后的地址;格式错的行走 `! 跳过无法解析的仓库:` 提示。

## 私有仓库怎么办

**当前版本只适合公开仓库。** `repos.txt` 在公开仓库里,`docs/data.json` 又是公开发布的,写进去等于把私有仓库名和 issue 标题一起公开。

想监控私有仓库,有三条路:

| 做法 | 代价 | 适合 |
|---|---|---|
| **双清单改造**:私有清单存 `WATCH_REPOS` secret,结果只写 README / artifact,不进 `docs/` | 需要改 `scan.mjs` | 私有仓库多、又想要公开看板 |
| 整个 hub 仓库转私有,关掉 Pages,只看 Actions artifact 或本地页面 | 没有在线看板 | 全部都是私有仓库 |
| 升级 GitHub Pro / Team | 私有仓库才能用 Pages | 愿意付费 |

本仓库目前走第一条路的「公开部分」:`repos.txt` 里只有 18 个公开仓库,私有仓库刻意没有写进来。

## 部署状态

本仓库已经完成:

- ✅ 公开仓库 `ruanbw/issue-watch`
- ✅ Pages 已启用,`build_type=workflow`(由 `actions/deploy-pages` 发布,不依赖分支目录设置)
- ✅ 工作流已跑通,数据回路正常(bot 会自动提交到 `main`)
- ⬜ **`ISSUE_WATCH_TOKEN` secret 尚未配置** —— 现在用的是匿名请求(60 次/小时),只够几个仓库

### 补上 token(必须做)

1. Settings → Developer settings → **Fine-grained tokens** → Generate new token
   - **Resource owner**:逐个添加,选上所有相关 org / 账号 ← 跨 owner 靠这一步
   - **Repository access**:All repositories,或手动挑要盯的仓库
   - **Permissions**:`Issues: Read-only`、`Metadata: Read-only`（若开启 PR 监控建议同时勾选 `Pull requests: Read-only`）
   - 有效期最长 1 年,到期重新生成
2. 本仓库 Settings → Secrets and variables → Actions → New repository secret
   - Name:`ISSUE_WATCH_TOKEN`
   - Value:上一步生成的 token
3. Actions → `issue-watch` → Run workflow,验证一轮

## 从零复刻(换 owner / 换仓库)

```bash
# 1. 推到你的仓库
git remote set-url origin git@github.com:<you>/<repo>.git
git push -u origin main

# 2. 命令行启用 Pages(等价于 Settings → Pages → Source: GitHub Actions)
gh api -X POST repos/<you>/<repo>/pages -f build_type=workflow

# 3. 配置 secret 后手动触发一次
gh workflow run issue-watch --repo <you>/<repo>
```

## 可调参数

写在 `.github/workflows/issue-watch.yml` 的 `env:` 或仓库 Variables (`Settings` → `Secrets and variables` → `Actions` → `Variables`) 里即可:

| 变量 | 默认 | 说明 |
|---|---|---|
| `WATCH_TYPE` | `issues` | 监控目标类型: `issues`(仅 Issue)、`prs`(仅 PR)、`all`(同时监听 Issue 和 PR) |
| `CONCURRENCY` | 8 | 并发请求数,token 配额充裕可以调到 16 |
| `PER_PAGE` | 10 | 每仓取多少个 open issue / PR,只影响看板展示 |
| `NEW_TTL_DAYS` | 7 | "最近新增"保留天数 |
| `DRY_RUN` | — | 设 `1` 只打印不落盘,本地调试用 |

扫描频率改 `cron`。注意是 **UTC**,且最小粒度 5 分钟。

## 本地调试

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/scan.mjs                  # 默认只抓 issue
WATCH_TYPE=all GITHUB_TOKEN=$(gh auth token) node scripts/scan.mjs   # 同时抓 issue 和 PR
WATCH_TYPE=prs GITHUB_TOKEN=$(gh auth token) node scripts/scan.mjs   # 只抓 PR
python3 -m http.server 8000 --directory docs                         # 预览看板
```

## 边界与坑

- **推送前先 `git pull --rebase`**:bot 会往 `main` 提交数据,直接 `git push` 会被拒。冲突一般只落在 `README.md` 和 `data/*.json`,重跑一次扫描即可覆盖。
- **首次运行不报新增**:第一轮只建水位线,否则历史 issue 会全被当成新的。
- **只看 open**:抓取用 `state=open`,开完立刻关掉的 issue 可能漏掉。
- **配额**:认证后 5000 次/小时。没命中 ETag 时,400 仓库 × 每 15 分钟 ≈ 1600 次/小时也够;命中 304 时为 0。超过约 1000 个仓库才需要把周期放宽到 30 分钟。
- **单仓失败不中断**:失败的仓库在看板上标红,并在 README 里列一行,不影响其它仓库。
- **私有仓库会露名字**:`docs/data.json` 是公开的,Pages 站点任何人都能访问。敏感就关掉 Pages,只在本地 `python3 -m http.server --directory docs` 看。
- **默认分支必须是 `main`**:`deploy` job 里 `checkout` 写死了 `ref: main`,分支不同要改。
- **公共仓库 60 天无活动**:定时 workflow 会被 GitHub 自动禁用。本流程每次数据变化都会提交,正常不会触发。
- **cron 会延迟**:高峰期排队几分钟很常见,不是故障。
- **Node 20 弃用警告**:来自 `configure-pages` / `deploy-pages` / `upload-artifact` 自身,不是本仓库代码,等官方升级即可。

## 变体:不要网页,要工单或 IM 通知

在 `scan.mjs` 拿到 `freshIssues` 后加一段:

```js
for (const i of freshIssues) {
  await fetch(`${API}/repos/${HUB}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({
      title: `[${i.repo}] #${i.number} ${i.title}`,
      body: `${i.url}\n\n@${i.author}`,
    }),
  });
}
```

发飞书 / 钉钉 / Slack 同理,把 URL 换成群机器人 webhook。这种情况也可以考虑直接上 **组织级 Webhook**(秒级、零配额),但要求仓库都在同一个 org 下。

## 什么时候该换方案

- 仓库都在同一个 org → Search API 一条 `q=org:xxx is:issue created:>...` 就够,不用轮询
- 要求秒级 → 组织级 Webhook 或 GitHub App
- 仓库数 > 2000,或需要历史趋势分析 → GraphQL 批量查询,或直接同步进数据库

<!-- ISSUE-WATCH:START -->
## Issue 总览

扫描时间:2026-10-19 06:55 UTC · 仓库 14 个 · open issue 0 个 · 本轮新增 **0** 个

### 最近新增(近 7 天)

_最近没有新增 issue_

### 各仓库状态

| 仓库 | open | 最新 issue | 时间 |
|---|--:|---|---|
| [bennett-dsh/dsh-plugin-usage](https://github.com/bennett-dsh/dsh-plugin-usage/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/agent-sweep](https://github.com/ruanbw/agent-sweep/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/bennett](https://github.com/ruanbw/bennett/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/bennett-agent](https://github.com/ruanbw/bennett-agent/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/bennett-usage](https://github.com/ruanbw/bennett-usage/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/CertFlow](https://github.com/ruanbw/CertFlow/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/conversation-clean](https://github.com/ruanbw/conversation-clean/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/DefaultAppManager](https://github.com/ruanbw/DefaultAppManager/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/janus](https://github.com/ruanbw/janus/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/logo-animated-svg](https://github.com/ruanbw/logo-animated-svg/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/mosaic-model-studio](https://github.com/ruanbw/mosaic-model-studio/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/nodem-clean](https://github.com/ruanbw/nodem-clean/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/pi-deepseek-cache](https://github.com/ruanbw/pi-deepseek-cache/issues) | 0 | _暂无 open issue_ | — |
| [ruanbw/provenance-check](https://github.com/ruanbw/provenance-check/issues) | 0 | _暂无 open issue_ | — |

<!-- ISSUE-WATCH:END -->
