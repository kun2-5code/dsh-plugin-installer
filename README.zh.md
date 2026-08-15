# dsh-plugin-installer

[English](README.md) | **简体中文**

DeepSeek Harness（`dsh`）的**插件安装器**：一个可直接安装的 bundle，让你在 Web GUI 里直接安装/卸载 profile 插件——不用打开终端，装完**默认免重启**立即生效。

- 宿主半侧 `src/installer.ts` 在 web 服务器上注册 `POST /dsh-plugin-installer/api`，等价于在终端执行 `dsh plugin --profile <name> add/remove`（转发给 profile 目录里的 `pnpm` + 对账 `dsh.profile.bundles` 层列表）；
- 浏览器半侧 `src/client.ts`（含 `src/installer-client.ts`）在 设置 → 插件 里注册**「安装」tab**：安装输入框、当前 bundle 层（带"运行中 / 需重启"徽标）、逐个卸载按钮。

本包按官方 [bundle 分发模型](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.zh.md) 组织：包内声明 `dsh.bundle` 与 `cordis.patch.yml`，用户 `dsh plugin add` 后即作为配置层生效。

## 目录结构

```
dsh-plugin-installer/
├── package.json        # npm 包清单 + dsh.bundle / dsh.client 声明 + prepare 构建脚本
├── tsconfig.json       # 严格模式类型检查配置（tsc --noEmit）
├── tsdown.config.ts    # 构建配置：Node 库（lib/）+ 客户端 bundle（lib/client.js），自包含、供 git 安装时 prepare 使用
├── cordis.patch.yml    # bundle 配置层：客户端发现载体行 + 安装器宿主行
├── dev/cordis.yml      # 本地开发 overlay（指向源码，配合 dsh web --patch；仅 host 半边）
├── src/
│   ├── index.ts        # 包名入口（client 半边发现载体）：空实现，host 侧无事可做
│   ├── installer.ts    # 安装器宿主半侧：webServer 路由 → pnpm add/remove + bundle 层对账 + 免重启热激活
│   ├── client.ts       # 浏览器半边入口：在 settings.plugins.tab 插槽注册「安装」tab
│   └── installer-client.ts  # 安装 tab 的 React 实现（同源 fetch 调宿主 API）
└── test/smoke.mjs      # 构建产物冒烟测试（路由 + API 方法 + 热激活）
```

## 快速开始

### 作为 bundle 安装（给用户用）

把本包装进带 GUI 的 `web` profile：

```sh
# 本地目录（先构建：本地目录安装不会自动跑 prepare）
cd /path/to/dsh-plugin-installer && pnpm build
dsh plugin --profile web add /path/to/dsh-plugin-installer

# 或直接从 GitHub 安装（git 安装会由 pnpm 自动跑 prepare 构建）
dsh plugin --profile web add github:you/dsh-plugin-installer
```

GitHub 安装时 pnpm ≥10 首次会拒绝执行 git 依赖的 prepare，把 pnpm 打印的包名加进 profile 的 `pnpm-workspace.yaml` 后重试：

```yaml
allowBuilds:
  dsh-plugin-installer: true
```

> 该 allowlist 相当于授权在安装时执行该包的代码，只应允许你信任的源码，并建议锁定 commit：`github:you/dsh-plugin-installer#<sha>`。

装完重启一次 `dsh web`（安装器本身要进树后才能工作），打开 `http://127.0.0.1:3080` → 左下角 **设置** → **插件** → **安装** tab。

> `--patch` overlay 只加载插件的 **host 半边**（模块路径解析不到包级声明），因此看不到浏览器半边的「安装」tab；要完整功能必须走上面的 profile 安装。

### 本地开发

在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码根目录，用 overlay 直接加载本仓库源码（免安装、免构建，只跑宿主半侧）：

```sh
pnpm dsh web --patch /absolute/path/to/dsh-plugin-installer/dev/cordis.yml
```

把 `dev/cordis.yml` 里的 `name` 改成这个仓库在你机器上的绝对路径。

开发循环内自己跑检查：

```sh
pnpm install --ignore-workspace   # 本包独立于 harness workspace，需单独安装依赖
pnpm typecheck
pnpm build
node test/smoke.mjs
```

## 安装器怎么用

```sh
# 把本包装进 web profile 并启动 GUI 后：
#   dsh plugin --profile web add /path/to/dsh-plugin-installer && dsh web
# 打开 http://127.0.0.1:3080 → 设置 → 插件 → 安装
```

安装源支持：npm 包名（`dsh-my-plugin`）、`github:user/repo`、`file:` 链接、本地目录/tarball 的**绝对路径**（相对路径会被拒绝——浏览器没有可锚定的工作目录）。

### 免重启：安装/卸载即时生效

装完**默认无需重启**：安装器在 `pnpm add/remove` + 对账成功后，会**直接改写运行中配置树的根 include 补丁列表**——把新 bundle 的补丁行追加进去（或把已卸载 bundle 的补丁行过滤掉），Loader 事务性应用后新插件即刻激活/销毁。这是安装器自包含实现，**不需要改 harness 源码**（dsh 只对 `cordis.patch.yml` 做配置热重载，bundle 层在启动时冻结，所以仅改 `package.json` 无法免重启）。

- 安装成功返回 `hot: true` 时，状态行显示"已热生效，无需重启"，bundle 行徽标变为"运行中"；
- 若运行中的树无法热应用（无 Loader / 找不到根 include / 补丁更新失败），自动回退为旧行为："重启 dsh 后生效"，bundle 行显示"需重启"——**重启总是最终兜底**，重启后由 `dsh.profile.bundles` 接管。

已知局限（重启即可恢复）：

- 热装的 bundle 行是**追加**在运行中补丁列表末尾的；如果你在热装之后、重启之前手工编辑 `cordis.patch.yml`，dsh 的配置热重载会以**启动时冻结的 bundle 层**重算整棵树，热装的行会暂时退出运行（bundle 行退回"需重启"），重启后恢复。
- 热装后、重启前，`cordis.patch.yml` 里针对该 bundle 行的 id 覆盖（如 `disabled`）不会生效——补丁按顺序应用，用户层在热装行之前。重启后由 bundle 层顺序接管，覆盖正常生效。
- 带浏览器半边的插件（声明了 `dsh.client`）热激活后，其 UI 需要**刷新页面**才会被发现（client-modules 按页面加载时扫描）。

> 热激活失败时，状态行会透传 Loader 的错误——**请先分辨这是不是与热激活无关的插件问题**（例如工具名/路由冲突：同一份模板装两份、两个插件都注册 `greet`）。这类冲突重启同样会遇到，先解决冲突再装。

注意：

- **dsh 进程的 PATH 上要有 pnpm。** git 安装会运行包的 `prepare` 脚本；pnpm ≥10 首次会拒绝，错误信息会透传 pnpm 输出，里面就有要加进该 profile `pnpm-workspace.yaml` 的 `allowBuilds` 包键。
- **不需要改 harness 源码**——安装 tab 走公开的 `settings.plugins.tab` 插槽 + 普通 webServer 路由，未修改的 harness 检出新代码即可用。
- 宿主半侧只在挂了 `webServer` 服务的 profile（即 web profile）里激活；无头 profile 下自动禁用，不会导致启动失败。
- 路由仅绑定回环（web 服务器默认 `127.0.0.1`），执行的是你机器上的 `pnpm`——信任边界与你自己跑 `dsh plugin add` 相同。

## 浏览器半边（client）是怎么工作的

- `package.json` 声明 `dsh.client: { platform: "web" }` + `exports["./client"]` → dsh 的 client-modules 发现 `lib/client.js` 并作为浏览器插件加载；
- **发现载体**：client-modules 按 Loader 条目名解析 package.json（`require.resolve('<条目名>/package.json')`），因此 `cordis.patch.yml` 里必须有一行 `name` 等于包名本身（`dsh-plugin-installer`，即 `src/index.ts`，空实现）——浏览器才会加载 `lib/client.js`；
- `src/client.ts` 在 `settings.plugins.tab` 插槽注册「安装」tab；`src/installer-client.ts` 通过同源 `fetch` 调 `/dsh-plugin-installer/api` 与宿主半侧通信；
- 宿主半侧 `src/installer.ts` 通过 `ctx.webServer` 注册该路由，转发 pnpm + 对账 bundle 层 + 免重启热激活；
- 运行时 client 半边只依赖 `react`（浏览器平台模块表提供），其余一律走 ctx 服务，不 import 任何 `@deepseek-ai` 客户端包——改代码时请保持这个纪律。

## 改成你自己的安装器（fork）

- 改包名：`package.json` 的 `name`、`src/index.ts` 的 `name`、`cordis.patch.yml` 里的两行 `name`/`id` 保持一致。**改包名后还要同步与浏览器半边有关的地方**：`tsdown.config.ts` 里 client bundle 的 `id`（`__ModuleLoader__.load({ id })`）、`package.json` 的 `dsh.client`、`src/client.ts` 的插槽 id。
- 换安装目录/换安装命令：改 `src/installer.ts` 里 `runPnpm` 的调用与 `ROUTE_PREFIX`。
- 记得 `declare module '@deepseek-ai/cordis'` 合并 `Context` / `Events` 类型，跨包边界才类型安全。

## 发布

- **npm**：`pnpm publish`（`files` 已包含构建产物与补丁，无需额外步骤）
- **tarball**：`pnpm pack`，用户 `dsh plugin --profile web add ./dsh-plugin-installer-0.1.0.tgz`
- **git**：用户 `dsh plugin add github:you/dsh-plugin-installer`（配合上面的 `allowBuilds`）
