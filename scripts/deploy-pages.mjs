/**
 * 把 dist/ 发布到 GitHub Pages（gh-pages 分支方式）。
 *
 * 用法：npm run build && npm run deploy
 *
 * 为什么不用 GitHub Actions：本机令牌需要有 `workflow` 权限才能推或改
 * .github/workflows/*，没有该权限时 push 会被 GitHub 直接拒收。分支方式只需要
 * 普通 repo 权限。想改回 Actions，见 README「部署」一节。
 *
 * 做的事：在一个临时 worktree 里组装 dist 的孤儿提交，推到 gh-pages，
 * 然后删掉 worktree——main 分支始终干净，不会混入构建产物。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist');
const branch = process.env.PAGES_BRANCH ?? 'gh-pages';
const remote = process.env.PAGES_REMOTE ?? 'origin';

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html 不存在：先跑 `npm run build`。');
  process.exit(1);
}

/** git 不一定在 PATH 上（Windows 上常见的就有三四种装法），找不到就按已知位置兜底。 */
function resolveGit() {
  const candidates = [
    process.env.GIT_EXE,
    'git',
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
    'C:/Program Files/Git/bin/git.exe',
    '/usr/bin/git',
    '/usr/local/bin/git',
  ].filter(Boolean);
  for (const exe of candidates) {
    try {
      execFileSync(exe, ['--version'], { stdio: 'ignore' });
      return exe;
    } catch {
      /* 试下一个 */
    }
  }
  console.error('找不到 git：把 git 加进 PATH，或用 GIT_EXE 指定完整路径。');
  process.exit(1);
}

/** 把远端 URL 变成带令牌的形式；没有令牌就原样返回，交给系统凭据管理器。 */
function authUrl(remoteUrl) {
  const token = process.env.DSH_SECRET_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) return remoteUrl;
  const m = /^https:\/\/(?:[^@/]+@)?github\.com\/(.+?)(?:\.git)?$/.exec(remoteUrl.trim());
  if (!m) return remoteUrl; // ssh 或其它远端：不动
  return `https://x-access-token:${token}@github.com/${m[1]}.git`;
}

/** 报错信息里不能留下令牌。 */
function scrub(text) {
  const token = process.env.DSH_SECRET_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  return token ? String(text).split(token).join('***') : String(text);
}

const GIT = resolveGit();
const git = (args, cwd = repo) =>
  execFileSync(GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const worktree = mkdtempSync(join(tmpdir(), 'seal-pages-'));
let added = false;
try {
  // 新提交要接在 gh-pages 现有 tip 之后（否则非快进被拒）；远端还没有这个分支就从 HEAD 起
  const remoteUrl = authUrl(git(['remote', 'get-url', remote]));
  let base = null;
  try {
    git(['fetch', '--quiet', remoteUrl, `refs/heads/${branch}`]);
    base = 'FETCH_HEAD';
  } catch {
    base = null;
  }
  git(base ? ['worktree', 'add', '--detach', worktree, base] : ['worktree', 'add', '--detach', worktree]);
  added = true;

  // 清空 worktree（保留 .git 指针文件），只放构建产物
  for (const name of readdirSync(worktree)) {
    if (name !== '.git') rmSync(join(worktree, name), { recursive: true, force: true });
  }
  cpSync(dist, worktree, { recursive: true });
  // 关掉 Jekyll：否则以下划线开头的文件/目录会被 Pages 忽略
  writeFileSync(join(worktree, '.nojekyll'), '');

  git(['add', '-A'], worktree);
  const count = readdirSync(worktree, { recursive: true }).length;
  if (!git(['diff', '--cached', '--name-only'], worktree)) {
    console.log(`构建产物与 ${remote}/${branch} 一致，无需发布。`);
  } else {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    git(['commit', '-q', '-m', `deploy: dist 构建产物（${stamp} UTC）`], worktree);

    // 令牌只出现在这一次 push 的 URL 里，不写进 .git/config
    git(['push', remoteUrl, `HEAD:refs/heads/${branch}`], worktree);
    console.log(`已发布到 ${remote}/${branch}（约 ${count} 个文件）。`);
    console.log('Pages 通常几十秒后重建：用 `node scripts/browser-check.mjs <线上地址> 25000 9222` 复核（需先起 headless chrome）。');
  }
} catch (err) {
  const stderr = err.stderr?.toString().trim();
  console.error('发布失败：', scrub(stderr || err.message));
  process.exitCode = 1;
} finally {
  if (added) {
    try {
      git(['worktree', 'remove', '--force', worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  } else {
    rmSync(worktree, { recursive: true, force: true });
  }
}
