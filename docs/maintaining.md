# 维护与仓库权限

本仓库（`SiriusYANG91/dsh-astro-plan`）的写权限**只属于仓库所有者一人**。这份文档说明谁能做什么、权限是怎么锁住的、以及你自己推送时该怎么做。

## 谁能做什么

| 角色 | 读 / 下载 | 改代码 | 说明 |
|---|---|---|---|
| **你（仓库所有者）** | ✓ | ✓ | 唯一能推送、改设置、发版的人 |
| 其他人（含没登录的人） | ✓ | ✗ | 公开仓库允许 clone、下载 zip、`git clone`、fork；**任何写入都会被 GitHub 拒绝** |
| 别人 fork 出来的仓库 | ✓ | 只能改他们自己的 fork | fork 是对他们账号的复制，改动不会回到你的仓库；只有你点 Merge 才会进来 |
| **助手（受你委托）** | ✓ | ✓ 仅当你明确要求 | 用你放在 `.github-token` 的写令牌代你推送；令牌只对这一个仓库有效，你随时可吊销 |
| GitHub Actions | ✓ | ✗ | 仓库里没有 workflow；Actions 权限设为只读，禁止建 PR |

**其他人只能下载，不能修改**——这是公开仓库的默认行为，也是本仓库的现状。**「公开仓库」的含义**：任何人都能下载和 fork，这是 GitHub 的设计，不是漏洞。你能控制的是**写入**，而这一条 GitHub 已经保证（只有所有者和被邀请的协作者能推）。要连下载都禁止，只能把仓库转私有——代价：awesome-dsh-plugin 列表读不到 `package.json` 会掉线，README 的 raw 图床与市场索引地址也会失效。

## 三道锁

1. **协作者为空**：仓库只有 `siriusyang91` 一个写权限账号。
2. **`main` 分支 ruleset `protect-main`**：拦截 **删除分支** 与 **强制推送**（`deletion` + `non_fast_forward`）。普通 `git push` 不受影响。
3. **写令牌只在你手里**：`.github-token` 是 fine-grained token，只授权 `dsh-astro-plan` 这一个仓库；助手的推送脚本默认只读模式，只有带 `--allow-push` 才会真正写（你要求时才加）。

## 助手代你推送

你明确要求时，助手用 `.github-token` 里的写令牌推送；除此之外它不会写任何东西（脚本默认只读模式，不带 `--allow-push` 只打印清单）。

| 动作 | 命令 |
|---|---|
| 查看将推送什么 | `node tools/push-repo.mjs`（dry-run，不写远端） |
| 真正推送 | `node tools/push-repo.mjs --allow-push` |
| 只推文档 | `node tools/push-docs.mjs --allow-push` |
| 只推市场索引 | `node tools/push-market-index.mjs --allow-push` |

写令牌的要点：

- 只授权 `dsh-astro-plan` 一个仓库（不是 All repositories）；
- 权限只需 **Contents: Read and write** + **Metadata: Read**；
- 设一个到期时间（如 90 天），到期前换新的，旧令牌在 GitHub 上删除；
- 令牌只存在本机 `.github-token`（已 gitignore），不会进仓库。
- 即使有人拿到令牌，ruleset `protect-main` 仍会拦住强制推送与删除分支，历史改不掉。

## 五处手动检查（管理权限在你手里，助手读不到这些设置）

| 位置 | 检查什么 | 期望 |
|---|---|---|
| Settings → **Rules → Rulesets** | 是否存在 `protect-main`，Target 含 `main`，勾 Restrict deletions + Block force pushes | 存在且 active |
| Settings → **Deploy keys** | 是否有可写的部署密钥（部署密钥能绕过账号直接推） | 没有，或全部只读 |
| Settings → **Applications** | 有 `Contents: write` 的 OAuth App / GitHub App 授权 | 没有多余的 |
| Settings → **Actions → General** | Workflow permissions 是否只读；是否允许 Actions 建 PR | Read only + 不允许 |
| Settings → **Code security** | Secret scanning 与 Push protection | 都开启 |

一键复查（只读，不会改任何东西）：

```bash
node tools/verify-repo-lock.mjs          # 逐项 ✓ / ✗ / ⚠，有问题退出码 1
node tools/verify-repo-lock.mjs --json   # 机器可读
```

## 你自己推送的三种方式

**A. 网页（改一两个文件最省事）**

仓库 → 打开文件 → 铅笔图标 → 改完 **Commit changes**。

**B. GitHub Desktop（整目录同步最省事）**

`File → Add local repository` 选 `dsh-astro-plan` 目录 → 改动会出现在左侧 → 写提交信息 → **Commit to main** → **Push origin**。

**C. 命令行 / SSH（长期开发推荐）**

```bash
cd dsh-astro-plan
git init -b main                 # 首次
git remote add origin git@github.com:SiriusYANG91/dsh-astro-plan.git
git add -A && git commit -m "feat: ..."
git push -u origin main
```

SSH 只需配一次：`ssh-keygen -t ed25519 -C "你的邮箱"` → 把 `~/.ssh/id_ed25519.pub` 贴到 GitHub → Settings → SSH and GPG keys。

> 助手代推时只需 `--allow-push`；你自己的日常推送用下面三种方式即可，不需要把令牌交给任何脚本。

## 写令牌怎么建 / 怎么换 / 怎么吊销

- 新建写令牌：Settings → Developer settings → **Personal access tokens → Fine-grained tokens** → Generate new token
  - Repository access：只选 `dsh-astro-plan`
  - Permissions：**Contents: Read and write**、**Metadata: Read-only**
  - Expiration：90 天（到期前换新）
- 换：把新令牌覆盖写入 `dsh-astro-plan/.github-token`（已 gitignore，不会进仓库）。
- 吊销：同一页面点 **Delete**，然后把 `.github-token` 清空。

## 万一令牌泄露

1. 立刻到 GitHub / npm 删除该令牌；
2. 若已进过 git 历史：先吊销，再决定是否用 `git filter-repo` 清历史（强推需要临时关掉 ruleset）；
3. 跑 `node tools/check-secrets.mjs` 确认本地文件里没有残留。

## 本地自检命令

```bash
node tools/verify-repo-lock.mjs              # 仓库写权限审计（只读）
node tools/check-secrets.mjs                 # 令牌/私钥扫描 + gitignore 覆盖检查
node tools/push-repo.mjs                     # 只打印将推送的文件（dry-run，不写远端）
node tools/push-repo.mjs --allow-push        # 只有可写令牌才行；只读令牌会提示改用你的凭据
node tools/publish.mjs --check               # 发布前体检（需要 npm 令牌）
```
