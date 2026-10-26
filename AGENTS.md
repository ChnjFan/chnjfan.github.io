# AGENTS.md

Hugo 静态博客，主题为 Git submodule [`hugo-bearneo`](themes/hugo-bearneo)，部署到 GitHub Pages（<https://chnjfan.github.io/>）。

本文件只记录 AI 助手无法从仓库直接推断的操作信息。主题功能与参数说明见[主题中文手册](themes/hugo-bearneo/docs/README_zh.md)；当前配置以 [hugo.toml](hugo.toml) 为准。

## 开始前

- 站点尚无内容：`content/`、`static/`、`layouts/` 均未创建，需要时新建。
- 没有测试框架；改动的验收标准是 `hugo --gc --minify` 构建成功，且相关页面/链接输出正确。
- `hugo.toml` 中作者 `Rokcso`、邮箱 `example@example.com`、版权、Kudos 地址、Follow ID 仍是主题示例值。
- ⚠️ 部署工作流目前是无扩展名文件 `.github/workflows`，GitHub Actions 不识别；首次部署前应改为 `.github/workflows/deploy.yml`，否则 push 不会触发构建。

## 常用命令

```bash
# 本地预览（含草稿）
hugo server -D

# 生产构建；提交前必须通过（与 CI 相同）
hugo --gc --minify

# 新建文章 / 独立页面（使用主题 archetypes）
hugo new content/blog/<slug>.md
hugo new content/<page>.md

# 首次克隆后初始化主题
git submodule update --init --recursive

# 更新主题（先确认）
git submodule update --remote themes/hugo-bearneo
```

主题要求 Hugo ≥ 0.110.0；CI 固定 Hugo Extended 0.168.0。

## 项目结构

```text
hugo.toml                 # 站点配置
.github/workflows         # 部署工作流（文件名见上）
themes/hugo-bearneo/      # 主题 submodule，只读
content/                  # 文章与页面（待创建）
static/img/               # 图片（待创建）
layouts/partials/         # 覆盖主题 partial（待创建）
public/                   # 构建产物，不提交
```

## 内容约定

- frontmatter 用 TOML（`+++`），日期带时区。
- 显式写 `slug`（英文、短横线）：文章 URL 为 `/p/<slug>`；不写时由 Hugo 生成，容易随标题变化。
- 标题从 `##` 开始，TOC 只收 h2–h3；独立页面模板不输出标题和日期，正文需自带 `# 标题`。
- `hugo new content/<page>.md` 默认写入 `menu = "main"`，不需要就从 frontmatter 删除。
- `hugo new content/blog/<slug>.md` 会把站点已有标签填入 `tags`，按需删改。
- 图片放 `static/img/`，用 `/img/<文件名>` 引用；`alt` 会显示为图注；加 `#minipic` 缩至 50%。
- Mermaid 需在 frontmatter 写 `mermaid = true`；脚本从 CDN 加载，需联网。
- 单页可用 `toc`、`upvote` 覆盖站点开关；`hidden = true` 使文章不出现在列表。
- 当前外链同标签页打开，并自动带 `rel="noopener noreferrer"`；标签页为 `/blog/<tag>`（`/tags/` 列表页已关闭）。
- 当前列表按年分组、仅按标题搜索、不分页；界面文案为英文硬编码。

## 配置与定制

- 站点参数集中在 `hugo.toml` 的 `[params]`；修改前先读文件中的双语注释和主题手册，不要臆造键名。
- 点赞、Follow Claim、作者头像、RSS、页脚、SEO 等细节见主题手册，本文件不重复。
- 定制主题时，在本项目 `layouts/` 放同路径模板，或使用 `layouts/partials/custom_head.html`、`custom_body.html`；不要改 submodule。
- 代码块高亮为 `github`（浅色）/ `github-dark`（深色），配色由 `static/css/chroma.css` 提供、在 `custom_head.html` 引入；改 `markup.highlight.style` 后须按该文件头部注释重新生成。

## 修改边界

可以：

- 创建或编辑 `content/`、`static/img/`、`archetypes/`、`layouts/partials/custom_*.html`。
- 调整 `hugo.toml` 的展示参数（标题、描述、日期格式、页脚开关等），并运行构建。

先确认：

- 修改 `baseURL`、`theme`、`permalinks`、`disableKinds` 等核心配置。
- 修改 CI 工作流、覆盖 `layouts/` 下其他模板、更新 submodule。
- 启用 `upvote`（需先部署 Kudos）、填写 Follow ID、替换作者邮箱/版权等公开信息。

禁止：

- 修改 `themes/hugo-bearneo/` 内的任何文件。
- 提交 `public/`、`.hugo_build.lock`、密钥或 Token。
- 未经确认执行 `git push --force` 或 `git reset --hard`。

## Git 与部署

- 提交信息用 Conventional Commits，如 `content: 新增文章`、`fix: 修复链接`、`chore: 更新主题`。
- push 到 `main` 触发 GitHub Actions：`hugo --gc --minify` → 上传 Pages artifact → `actions/deploy-pages`。
- 不使用 `gh-pages` 分支；仓库 Settings → Pages → Source 需设为 **GitHub Actions**。
- 主题更新后先本地构建验证，再同步本文件中的版本与配置说明。

## 维护本文件

- 只写非显而易见、可直接执行的信息；能从主题手册或 `hugo.toml` 得知的内容不要复制。
- 配置、目录结构或部署方式变化时更新对应小节，保持简短。
