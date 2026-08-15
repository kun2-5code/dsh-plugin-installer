# dsh-plugin-installer

**English** | [简体中文](README.zh.md)

A **plugin installer** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): a ready-to-install bundle that lets you install/remove profile plugins straight from the Web GUI — no terminal needed, and installs take effect **without a restart by default**.

- Host half (`src/installer.ts`) registers `POST /dsh-plugin-installer/api` on the web server — the exact same operation as `dsh plugin --profile <name> add/remove` (forwards to `pnpm` inside the profile directory + reconciles the `dsh.profile.bundles` layer stack).
- Browser half (`src/client.ts`, with `src/installer-client.ts`) registers an **安装 (Install) tab** under Settings → Plugins: an install input, the current bundle layers with run/needs-restart badges, and per-bundle uninstall buttons.

The package follows the official [bundle distribution model](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md): it declares `dsh.bundle` plus `cordis.patch.yml`, and `dsh plugin add` activates it as a config layer.

## Directory structure

```
dsh-plugin-installer/
├── package.json        # npm manifest + dsh.bundle / dsh.client declarations + prepare build script
├── tsconfig.json       # strict type-check configuration (tsc --noEmit)
├── tsdown.config.ts    # build config: Node library (lib/) + client bundle (lib/client.js), self-contained for git-install prepare
├── cordis.patch.yml    # bundle config layer: client-discovery carrier row + installer host row
├── dev/cordis.yml      # local dev overlay (points at source; use with dsh web --patch; host half only)
├── src/
│   ├── index.ts        # package-name entry (client-half discovery carrier): no-op, host side does nothing
│   ├── installer.ts    # host half of the plugin installer: webServer route → pnpm add/remove + bundle reconcile + no-restart hot activation + disable/enable
│   ├── client.ts       # browser half entry: registers the 安装 tab in the settings.plugins.tab slot
│   └── installer-client.ts  # the Install tab's React implementation (same-origin fetch to the host API)
└── test/smoke.mjs      # smoke test on the build output (routes + API methods + hot activation)
```

## Quick start

### Install as a bundle (for users)

Install this package into the GUI-bearing `web` profile:

```sh
# local directory (build first: a local-directory install does not run prepare)
cd /path/to/dsh-plugin-installer && pnpm build
dsh plugin --profile web add /path/to/dsh-plugin-installer

# or directly from GitHub (a git install runs prepare automatically)
dsh plugin --profile web add github:you/dsh-plugin-installer
```

On a GitHub install, pnpm ≥10 refuses the git dependency's `prepare` script the first time; add the package name pnpm prints to the profile's `pnpm-workspace.yaml` and retry:

```yaml
allowBuilds:
  dsh-plugin-installer: true
```

> This allowlist authorizes executing that package's code at install time — only allow source you trust, and prefer pinning a commit: `github:you/dsh-plugin-installer#<sha>`.

Restart `dsh web` once (the installer itself must enter the tree before it can work), then open `http://127.0.0.1:3080` → bottom-left **Settings** → **Plugins** → **安装** tab.

> A `--patch` overlay only loads the plugin's **host half** (module resolution cannot reach package-level declarations), so the browser-half 安装 tab is invisible under an overlay; full functionality requires the profile install above.

### Local development

From the root of a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) source checkout, load this repo's source directly via an overlay (no install, no build; host half only):

```sh
pnpm dsh web --patch /absolute/path/to/dsh-plugin-installer/dev/cordis.yml
```

Set `name` in `dev/cordis.yml` to this repo's absolute path on your machine.

Run the checks yourself during development:

```sh
pnpm install --ignore-workspace   # this package is standalone; install its own deps
pnpm typecheck
pnpm build
node test/smoke.mjs
```

## Using the installer

```sh
# After installing this bundle into the web profile and booting the GUI:
#   dsh plugin --profile web add /path/to/dsh-plugin-installer && dsh web
# open http://127.0.0.1:3080 → Settings → Plugins → 安装
```

Install sources: npm package names (`dsh-my-plugin`), `github:user/repo`, `file:` links, and **absolute** paths to local directories/tarballs (relative paths are rejected — the browser has no working directory to anchor them to).

### Disable / enable

Every **non-built-in** bundle row gets a 禁用/启用 (disable/enable) button: the installer keeps a marker-delimited managed block (`# >>> dsh-plugin-installer: managed …`) in the profile's `cordis.patch.yml`, writing `{ id, disabled: true/false }` overrides for each of the bundle's config rows. That file is both the persistence (composed into the config tree at boot as the user layer) and the hot-reload entry point (dsh's config HMR watches it), so disable/enable is also **restart-free**. Badge states: 运行中 (running) / 已禁用 (disabled) / 需重启 (needs restart).

Built-in bundles (`@deepseek-ai/*` — the harness core `dsh-base` and the GUI itself `dsh-web-app`) carry an 内置 (built-in) badge and are **not open to disable or removal**: they are not profile dependencies, and disabling/removing them breaks the profile. To fine-control built-in features (e.g. disable one of their tool rows), edit the profile's `cordis.patch.yml` directly and write `disabled: true` on the target row.

### No-restart installs/uninstalls (hot activation)

Installs take effect **without a restart by default**: after `pnpm add/remove` + reconciliation, the installer **rewrites the running tree's root-include patch list directly** — appending the new bundle's patch rows (or filtering out the removed bundle's rows), which the Loader applies transactionally so the plugin starts/stops immediately. This is fully self-contained; **no harness source change is needed** (dsh only hot-reloads `cordis.patch.yml` config patches; the bundle layer is frozen at boot, so editing `package.json` alone cannot avoid a restart).

- When the install responds with `hot: true`, the status line reads "已热生效，无需重启" and the bundle row badge flips to "运行中";
- If the live tree cannot apply the change (no Loader, no root include, or a failed update), it degrades to the old behavior: "重启 dsh 后生效" with a "需重启" badge — **a restart is always the fallback**, and after it the bundle is owned by `dsh.profile.bundles` as usual.

Known limitations (all recoverable by restarting):

- Hot-applied bundle rows are **appended to the end** of the running patch list. If you hand-edit `cordis.patch.yml` after a hot install but before a restart, dsh's config reload recomposes from the **boot-frozen bundle layer**, so the hot rows leave the live tree (the bundle row falls back to "需重启") until the next restart.
- Before a restart, id-targeted overrides of a hot-installed bundle's rows in `cordis.patch.yml` (e.g. `disabled: true`) do not apply — patches apply in order and the user layer runs before the appended rows. After a restart the bundle-layer order takes over and overrides work normally.
- Plugins with a browser half (`dsh.client`) need a **page refresh** after hot activation for their UI to be discovered (client-modules scans on page load).

> When hot activation fails, the status line surfaces the Loader's error verbatim — **first check whether it is a plugin problem unrelated to hot activation** (e.g. a tool/route name collision: two copies of the same template both registering `greet`). Such conflicts fail on restart too; resolve the conflict first.

Notes:

- **pnpm must be on the harness process PATH.** Git installs run the package's `prepare` script; on pnpm ≥10 the first one is refused and the error surfaces the exact package key to add under `allowBuilds` in the profile's `pnpm-workspace.yaml` (the GUI shows the full pnpm output).
- **No harness source edit needed** — the installer tab goes through the public `settings.plugins.tab` slot plus a plain web-server route, so it works on an unmodified harness checkout.
- The host half only activates in profiles that mount `webServer` (the web profile). In headless profiles it disables itself instead of failing the boot.
- The route is loopback-only (the web server binds `127.0.0.1`), and running it executes `pnpm` on your machine — same trust boundary as running `dsh plugin add` yourself.

## How the browser half works

- `package.json` declares `dsh.client: { platform: "web" }` + `exports["./client"]` → dsh's client-modules discovers `lib/client.js` and loads it as a browser plugin;
- **Discovery carrier**: client-modules resolves package.json by the Loader entry name (`require.resolve('<entry-name>/package.json')`), so `cordis.patch.yml` must keep one row whose `name` equals the package name itself (`dsh-plugin-installer`, backed by `src/index.ts`, a no-op) — only then does the browser load `lib/client.js`;
- `src/client.ts` registers the 安装 tab in the `settings.plugins.tab` slot; `src/installer-client.ts` calls the host half through a same-origin `fetch` to `/dsh-plugin-installer/api`;
- the host half (`src/installer.ts`) registers that route via `ctx.webServer`, forwards pnpm, reconciles the bundle layers, and performs the no-restart hot activation;
- at runtime the client half depends only on `react` (provided by the browser platform module table); everything else goes through `ctx` services and no `@deepseek-ai` client package is imported — keep that discipline when editing.

## Making it your own installer (fork)

- Rename the package: keep `package.json` `name`, `src/index.ts` `name`, and both rows' `name`/`id` in `cordis.patch.yml` consistent. **Renaming also touches the browser-half spots:** the client bundle `id` in `tsdown.config.ts` (`__ModuleLoader__.load({ id })`), `dsh.client` in `package.json`, and the slot id in `src/client.ts`.
- Change the install target / command: edit `runPnpm` calls and `ROUTE_PREFIX` in `src/installer.ts`.
- Remember to `declare module '@deepseek-ai/cordis'` to merge `Context` / `Events` types — that is what keeps cross-package boundaries type-safe.

## Publishing

- **npm**: `pnpm publish` (`files` already includes the build output and the patch; no extra steps)
- **tarball**: `pnpm pack`, then `dsh plugin --profile web add ./dsh-plugin-installer-0.1.0.tgz`
- **git**: `dsh plugin add github:you/dsh-plugin-installer` (combined with the `allowBuilds` step above)
