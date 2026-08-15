/**
 * dsh-plugin-installer 的插件安装器宿主半侧（host half）。
 *
 * 在浏览器 GUI（设置 → 插件 → 安装）里直接安装/卸载 profile 插件，等价于在
 * 终端里执行 `dsh plugin --profile <name> add/remove <spec>` —— 不再需要打开 CLI：
 *
 *   - 宿主侧通过 `ctx.webServer` 注册一个 HTTP 路由 `POST /dsh-plugin-installer/api`，
 *     浏览器半边的安装 tab（src/installer-client.tsx）同源 fetch 调用它；
 *   - 每个请求在**当前 profile 目录**里转发给 pnpm（install = `pnpm add <spec>`，
 *     remove = `pnpm remove <pkg>`），成功后按已安装状态对账
 *     `dsh.profile.bundles` 层列表（与 `dsh plugin` CLI 的 reconcile 逻辑一致：
 *     声明了 `dsh.bundle` 的依赖加入层栈；被移除或丢失声明的依赖离开层栈）。
 *
 * 加载契约：具名导出 apply(ctx)；与主插件同包，经 `exports["./installer"]`
 * 被 cordis.patch.yml 的插件行按包名子路径加载。
 *
 * 安全说明：webServer 默认只绑定 127.0.0.1（回环），该端点等于在本机执行
 * pnpm —— git 安装会运行包的 prepare 脚本，pnpm ≥10 会先拒绝并要求在
 * profile 的 pnpm-workspace.yaml 里显式 allowBuilds（错误信息里会透传给用户）。
 * @module dsh-plugin-installer/installer
 */

import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-plugin-installer/installer'

// ---- 类型：请求 / 响应契约（与客户端 src/installer-client.tsx 共享形状）----

/** 一次 API 请求的方法。 */
export type InstallerMethod = 'list' | 'install' | 'remove'

/** HTTP API 请求体。 */
export interface InstallerRequest {
  method: InstallerMethod
  /** install 用：npm 包名 / github:user/repo / file: 链接 / tarball 或目录的绝对路径。 */
  spec?: string
  /** remove 用：已安装的包名。 */
  packageName?: string
}

/** 错误码 → 语义；客户端据此渲染提示。 */
export type InstallerErrorCode =
  | 'bad-request'
  | 'relative-path'
  | 'install-failed'
  | 'remove-failed'
  | 'method-not-found'
  | 'pnpm-missing'
  | 'internal'

/** 业务失败分支（方法从不 throw 业务错误）。 */
export interface InstallerError {
  code: InstallerErrorCode
  message: string
  /** pnpm 原始输出等附加信息，GUI 可展开查看。 */
  output?: string | undefined
}

/** 成功/失败判别联合（与 harness 的 RpcResult 同形）。 */
export type InstallerResponse<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: InstallerError }

/** list 返回的一个 bundle 层视图。 */
export interface BundleView {
  packageName: string
  /** 是否能在当前安装环境解析到（装了但没重启时同样可解析）。 */
  resolved: boolean
  /** 包声明的 patch 路径（dsh.bundle.patch）；非 bundle 时缺省。 */
  patch?: string
  /** 是否已挂载进当前运行的 Loader（false = 需要重启 dsh 生效）。 */
  active: boolean
}

/** list 返回的一个依赖视图。 */
export interface DependencyView {
  name: string
  spec: string
  isBundle: boolean
}

/** list 方法的值。 */
export interface InstallerListValue {
  profileName: string
  profileDir: string
  /** 按序的 bundle 层列表。 */
  bundles: BundleView[]
  /** profile 的全部 tree 外依赖。 */
  dependencies: DependencyView[]
}

/** install / remove 方法的值。 */
export interface InstallerChangeValue {
  output: string
  /** 本次新增的依赖名（install）。 */
  added?: string[]
  /** 新增依赖中已激活为 bundle 层的（install）。 */
  activated?: string[]
  /** 本次移除的依赖名（remove）。 */
  removed?: string[]
  /** reconcile 提示（如"未声明 dsh.bundle，仅作普通依赖"）。 */
  warning?: string | undefined
}

/** webServer 服务的最小结构面（运行时实例来自 ctx，完整契约见 @deepseek-ai/dsh-host-webserver）。 */
interface WebServerLike {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Loader 服务的最小结构面（用于标记 bundle 是否已挂载）。 */
interface LoaderLike {
  entries(): ReadonlyArray<{ options: { name?: string } }>
}

/** 路由前缀；客户端 fetch 的完整路径是 `${this}/api`。 */
export const ROUTE_PREFIX = '/dsh-plugin-installer'

/** 透传给 GUI 的 pnpm 输出上限（防止超大输出刷爆浏览器）。 */
const OUTPUT_CAP = 64 * 1024

// ---- profile manifest 读写与包解析（移植自 deepseek-harness 的
//      packages/boot/app-boot/src/profile.ts 与 apps/cli/src/plugin.ts，
//      不引入运行时依赖；语义与 `dsh plugin` CLI 完全一致）----

/** profile manifest 的最小切片（只读我们关心的字段）。 */
interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] }; bundle?: { patch?: string } }
}

/** 读取 profile 目录的 package.json。 */
function readManifest(dir: string): ProfileManifest {
  const path = join(dir, 'package.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProfileManifest | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`dsh-plugin-installer: profile manifest ${path} must hold a JSON object`)
  }
  return parsed
}

/** 2 空格缩进写回 profile 的 package.json（与 CLI writeProfileManifest 相同格式）。 */
function writeManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

/**
 * 从锚点按 Node 自己的 node_modules 查找顺序解析一个包的根目录。结果与
 * Loader 从同一锚点 import 会命中的目录一致；不要求包导出 ./package.json。
 */
function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  // resolve.paths 只对内置模块返回 null，而插件名不会是内置模块。
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** 一个已解析的依赖是否导出 profile patch（即是一个 bundle）。 */
function exportsPatch(packageName: string, profileDir: string): boolean {
  try {
    const dir = packageDirFromAnchor(join(profileDir, 'package.json'), packageName)
    if (dir === undefined) return false
    return readManifest(dir).dsh?.bundle?.patch !== undefined
  } catch {
    return false // 解析失败（未安装 / 缺依赖）按普通依赖处理
  }
}

/**
 * 按已安装状态对账 `dsh.profile.bundles`：pnpm 已经写好了真实依赖名并物化
 * 了包，这里把解析到 `dsh.bundle` 声明的依赖追加进层栈（依赖顺序），把已
 * 移除或丢失声明的依赖移出层栈。返回对账过程中的提示（如"未声明 bundle"）。
 */
function reconcilePlugins(before: ProfileManifest, profileDir: string): string[] {
  const after = readManifest(profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.profile?.bundles ?? []
  const warnings: string[] = []
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      warnings.push(
        `${packageName} 未声明 dsh.bundle —— 已作为普通依赖安装，未激活为配置层`
        + '（其后续版本若声明 bundle，安装后会自动激活）',
      )
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    // 只有依赖管理的条目才受移除影响；模板自带 bundle（dsh-base 等）不是依赖，永不触碰。
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (changed) {
    writeManifest(profileDir, {
      ...after,
      dsh: { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } },
    })
  }
  return warnings
}

// ---- pnpm 执行 ----

/** 在 profile 目录里运行一次 pnpm，收集 stdout+stderr 与退出码。 */
function runPnpm(profileDir: string, args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // Windows 上 pnpm 走 .cmd shim，spawn 无 shell 会因 CVE-2024-27980 加固被拒。
    const child = spawn('pnpm', [...args], {
      cwd: profileDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        resolve({ code: 127, output: 'pnpm not found on PATH — install pnpm first (e.g. npm i -g pnpm)' })
      } else {
        reject(error)
      }
    })
    child.on('close', (code) => resolve({ code: code ?? 1, output: output.slice(0, OUTPUT_CAP) }))
  })
}

/** git 托管 spec（其 prepare 脚本在安装时被 pnpm ≥10 默认拦截）。 */
function isGitSpec(spec: string): boolean {
  return /^git\+|^github:|\.git(?:#|$)/.test(spec)
}

// ---- 方法实现 ----

/** list：读 manifest 组装当前 bundle 层与依赖的视图。 */
function list(profileDir: string, loader: LoaderLike | undefined): InstallerListValue {
  const manifest = readManifest(profileDir)
  const loadedNames = new Set(
    (loader?.entries() ?? []).map((entry) => entry.options.name).filter((n): n is string => n !== undefined),
  )
  // bundle 行名可能是包名本身（如示例主插件行）或包名子路径（如安装器行
  // `dsh-plugin-installer/installer`）——二者都算该 bundle 已挂载。
  const isLoaded = (packageName: string): boolean =>
    [...loadedNames].some((name) => name === packageName || name.startsWith(`${packageName}/`))
  const bundles: BundleView[] = (manifest.dsh?.profile?.bundles ?? []).map((packageName) => {
    const dir = packageDirFromAnchor(join(profileDir, 'package.json'), packageName)
    if (dir === undefined) return { packageName, resolved: false, active: false }
    const patch = readManifest(dir).dsh?.bundle?.patch
    return { packageName, resolved: true, ...(patch === undefined ? {} : { patch }), active: isLoaded(packageName) }
  })
  const dependencies: DependencyView[] = Object.entries(manifest.dependencies ?? {})
    .map(([name, spec]) => ({ name, spec, isBundle: exportsPatch(name, profileDir) }))
  return { profileName: basename(profileDir), profileDir, bundles, dependencies }
}

/** install：pnpm add + 对账层列表。返回新增/激活的包名与提示。 */
async function install(spec: string, profileDir: string): Promise<InstallerResponse<InstallerChangeValue>> {
  const trimmed = spec.trim()
  if (trimmed === '') return { ok: false, error: { code: 'bad-request', message: '安装源不能为空' } }
  if (/^\.{1,2}(?:[/\\]|$)/.test(trimmed)) {
    return {
      ok: false,
      error: {
        code: 'relative-path',
        message: '浏览器无法锚定相对路径：本地目录 / tarball 请填写绝对路径；'
          + '网络包请填写 npm 包名（如 dsh-my-plugin）、github:user/repo 或 file: 链接',
      },
    }
  }
  const before = readManifest(profileDir)
  const { code, output } = await runPnpm(profileDir, ['add', trimmed])
  if (code !== 0) {
    const hint = isGitSpec(trimmed) && /allowBuilds/.test(output)
      ? '（pnpm ≥10 拦截了 git 依赖的 prepare 构建脚本：把上面输出里的包键加入该 profile '
        + 'pnpm-workspace.yaml 的 allowBuilds，然后重新安装）'
      : ''
    return { ok: false, error: { code: 'install-failed', message: `pnpm add 失败（退出码 ${code}）${hint}`, output } }
  }
  const warnings = reconcilePlugins(before, profileDir)
  const after = readManifest(profileDir)
  const beforeNames = new Set(Object.keys(before.dependencies ?? {}))
  const added = Object.keys(after.dependencies ?? {}).filter((name) => !beforeNames.has(name))
  const activated = added.filter((name) => (after.dsh?.profile?.bundles ?? []).includes(name))
  return {
    ok: true,
    value: {
      output,
      added,
      activated,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    },
  }
}

/** remove：pnpm remove + 对账层列表。 */
async function remove(packageName: string, profileDir: string): Promise<InstallerResponse<InstallerChangeValue>> {
  const trimmed = packageName.trim()
  if (trimmed === '') return { ok: false, error: { code: 'bad-request', message: '包名不能为空' } }
  const before = readManifest(profileDir)
  const { code, output } = await runPnpm(profileDir, ['remove', trimmed])
  if (code !== 0) {
    return { ok: false, error: { code: 'remove-failed', message: `pnpm remove 失败（退出码 ${code}）`, output } }
  }
  const warnings = reconcilePlugins(before, profileDir)
  const afterNames = new Set(Object.keys(readManifest(profileDir).dependencies ?? {}))
  const removed = Object.keys(before.dependencies ?? {}).filter((name) => !afterNames.has(name))
  return {
    ok: true,
    value: {
      output,
      removed,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    },
  }
}

/**
 * 处理一次安装器 API 请求（与 HTTP 解耦，便于冒烟测试直接调用）。
 * @param profileDir - 目标 profile 目录（当前运行的 profile）。
 * @param request - 请求体。
 * @param loader - 可选的 Loader 服务，用于标记 bundle 是否已挂载。
 */
export async function handleInstallerRequest(
  profileDir: string,
  request: InstallerRequest,
  loader?: LoaderLike | undefined,
): Promise<InstallerResponse<InstallerListValue | InstallerChangeValue>> {
  switch (request.method) {
    case 'list':
      return { ok: true, value: list(profileDir, loader) }
    case 'install':
      return install(request.spec ?? '', profileDir)
    case 'remove':
      return remove(request.packageName ?? '', profileDir)
    default:
      return {
        ok: false,
        error: { code: 'method-not-found', message: `unknown method ${JSON.stringify(request.method)}` },
      }
  }
}

// ---- 插件主体 ----

/** 从 Loader 锚定的 baseUrl（= profile 目录）解析当前 profile 目录。 */
function resolveProfileDirFromCtx(ctx: Context): string | undefined {
  const baseUrl = ctx.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined
  try {
    return fileURLToPath(baseUrl)
  } catch {
    return undefined
  }
}

/** apply 的可调参数（冒烟测试注入短等待窗口）。 */
export interface InstallerApplyOptions {
  /** 轮询 webServer 的间隔毫秒数。 */
  pollMs?: number
  /** 等待 webServer 激活的总时限毫秒数。 */
  waitMs?: number
}

/** 默认轮询间隔与总时限。 */
const DEFAULT_POLL_MS = 100
const DEFAULT_WAIT_MS = 10_000

/**
 * 插件主体：把安装器 API 挂到 webServer 上。webServer 行可能在安装器行之后
 * 才激活（Loader 的创建顺序不等于激活顺序），因此先同步尝试、再轮询等待；
 * 无头 profile 中等待超时后静默禁用 —— 既不用 `inject`（会让无头 profile 的
 * 启动审计把 pending 条目判为失败），也不让 bundle 加载失败。
 * @param ctx - 宿主根上下文。
 */
export function apply(ctx: Context, options: InstallerApplyOptions = {}): void {
  const profileDir = resolveProfileDirFromCtx(ctx)
  if (profileDir === undefined) {
    console.warn('[dsh-plugin-installer] cannot resolve profile dir from ctx.baseUrl; installer disabled')
    return
  }
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const deadline = Date.now() + waitMs

  ctx.effect(() => {
    let routeDisposer: (() => void) | undefined
    let registered = false

    const tryRegister = (): void => {
      if (registered) return
      const webServer = ctx.get('webServer') as WebServerLike | undefined
      if (webServer === undefined) return
      registered = true
      routeDisposer = webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'bad-request', message: 'only POST is accepted' } })
            return
          }
          let request: InstallerRequest
          try {
            request = JSON.parse(await readBody(req)) as InstallerRequest
          } catch {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '请求体不是合法 JSON' } })
            return
          }
          try {
            const loader = ctx.get('loader') as LoaderLike | undefined
            const response = await handleInstallerRequest(profileDir, request, loader)
            sendJson(res, response.ok ? 200 : 400, response)
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              error: { code: 'internal', message: `installer internal error: ${String(error)}` },
            })
          }
        },
      })
    }

    // 同步先试一次（webServer 已激活时零延迟），否则轮询等待其激活。
    tryRegister()
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer)
        if (!registered) {
          console.warn('[dsh-plugin-installer] webServer service never became available; installer disabled')
        }
        return
      }
      tryRegister()
    }, pollMs)

    // 插件卸载时：停掉轮询并注销路由。
    return () => {
      clearInterval(timer)
      routeDisposer?.()
    }
  })
}

/** 读满请求体（小型 JSON，无需流式处理）。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8') })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** 写 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

// 与主插件共享一个声明合并出口（本文件保持独立可加载，无需额外声明）。
export default apply
