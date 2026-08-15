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
import * as yaml from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-plugin-installer/installer'

// ---- 类型：请求 / 响应契约（与客户端 src/installer-client.tsx 共享形状）----

/** 一次 API 请求的方法。 */
export type InstallerMethod = 'list' | 'install' | 'remove' | 'set-enabled'

/** HTTP API 请求体。 */
export interface InstallerRequest {
  method: InstallerMethod
  /** install 用：npm 包名 / github:user/repo / file: 链接 / tarball 或目录的绝对路径。 */
  spec?: string
  /** remove / set-enabled 用：已安装的包名。 */
  packageName?: string
  /** set-enabled 用：true = 启用，false = 禁用。 */
  enabled?: boolean
}

/** 错误码 → 语义；客户端据此渲染提示。 */
export type InstallerErrorCode =
  | 'bad-request'
  | 'relative-path'
  | 'install-failed'
  | 'remove-failed'
  | 'set-enabled-failed'
  | 'builtin-protected'
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
  /** 是否整包禁用（其全部 insert 行在运行树中均为 disabled）。 */
  disabled?: boolean
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

/** install / remove / set-enabled 方法的值。 */
export interface InstallerChangeValue {
  output: string
  /** 本次新增的依赖名（install）。 */
  added?: string[]
  /** 新增依赖中已激活为 bundle 层的（install）。 */
  activated?: string[]
  /** 本次移除的依赖名（remove）。 */
  removed?: string[]
  /** set-enabled 本次切换的配置行 id（行级禁用状态落在 profile 的 cordis.patch.yml）。 */
  toggled?: string[]
  /**
   * 本次变更是否已热应用到运行中的配置树（true = 已生效，无需重启；
   * false / 缺省 = 已落盘，重启 dsh 后生效）。
   */
  hot?: boolean
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

/** Loader 条目最小结构面（用于热激活时改写根 include 的补丁列表）。 */
interface LoaderEntryLike {
  options: {
    id?: string
    name?: string
    disabled?: boolean
    config?: { path?: string; patches?: unknown[] }
  }
  update?(options: { config: { path?: string; patches?: unknown[] } }): Promise<void>
}

/** Loader 服务的最小结构面（用于标记 bundle 是否已挂载 + 热激活）。 */
interface LoaderLike {
  entries(): ReadonlyArray<LoaderEntryLike>
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

// ---- 免重启热激活 ----
//
// dsh 的运行中配置树是根 include 条目（id 固定为 `include`，见 harness
// `mountRootInclude`）上的一份补丁列表：bundle 层（package.json 的
// `dsh.profile.bundles`）+ profile 的 cordis.patch.yml + 用户层 + overlay，
// 全部拼成一个扁平列表。dsh 只对 cordis.patch.yml 的改动做配置热重载
// （HMR），bundle 层在启动时冻结 —— 因此仅靠改 package.json 无法免重启。
//
// 这里的自包含方案：安装/卸载成功后，**直接改写根 include 的补丁列表**，
// 把新 bundle 的补丁行追加进去（或把已卸载 bundle 的补丁行过滤掉），再等
// Loader 事务性应用 —— 新插件即刻激活/销毁，无需重启，也不依赖任何
// harness 源码改动。局限（见 README）：之后用户手工编辑 cordis.patch.yml
// 触发的重载仍以启动时的 bundle 层为准，热装的 bundle 会退回"需重启"
// 状态，重启后由 package.json 的 bundles 列表接管。

/** 根 include 条目的固定 id（与 harness mountRootInclude 的 pin 一致）。 */
const ROOT_INCLUDE_ID = 'include'

/** 热激活等待 Loader 反映变更的总时限。 */
const HOT_WAIT_MS = 6_000
/** 热激活轮询 Loader 的间隔。 */
const HOT_POLL_MS = 150

// include 的 entry-list YAML 方言：`!!js` 标量往返为 `{ __jsExpr }` 表达式
// 节点（与 @deepseek-ai/cordis-plugin-include 的 entryListSchema 同构，
// 本地复刻以避免引入运行时依赖；js-yaml 同主版本，解析结构一致）。
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: unknown) => ({ __jsExpr: data }),
  predicate: (value: unknown) => value instanceof Object && '__jsExpr' in (value as Record<string, unknown>),
  represent: (data: object) => (data as Record<string, unknown>)['__jsExpr'] as string,
})
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

/** 解析一个 bundle 的 patch 文件（与 loadOverlayPatches 同语义；导出供冒烟测试）。 */
export function parsePatchFile(path: string): Array<Record<string, unknown>> {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) {
    throw new Error(`dsh-plugin-installer: patch file ${path} must be a top-level YAML array`)
  }
  return parsed as Array<Record<string, unknown>>
}

/** 解析一个 bundle 的 `dsh.bundle.patch` 文件路径；非 bundle 或缺文件时缺省。 */
function bundlePatchPath(profileDir: string, packageName: string): string | undefined {
  const dir = packageDirFromAnchor(join(profileDir, 'package.json'), packageName)
  if (dir === undefined) return undefined
  const patch = readManifest(dir).dsh?.bundle?.patch
  return patch === undefined ? undefined : join(dir, patch)
}

/** 顺序无关的结构深比较（用于从运行中补丁列表里过滤出某 bundle 的行）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const left = a as unknown[]
    const right = b as unknown[]
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => deepEqual(left[key], right[key]))
}

/** 当前运行树中是否已有该包名的 Loader 条目（精确名或 `包名/子路径`）。 */
function hasLoadedName(packageName: string, names: ReadonlySet<string>): boolean {
  for (const name of names) {
    if (name === packageName || name.startsWith(`${packageName}/`)) return true
  }
  return false
}

/** 找到根 include 条目（其 config.patches 承载整棵树的补丁组合）。 */
function rootIncludeEntry(loader: LoaderLike | undefined): LoaderEntryLike | undefined {
  if (loader === undefined) return undefined
  return [...loader.entries()].find((entry) => entry.options.id === ROOT_INCLUDE_ID)
}

/** 轮询 Loader 直到断言成立或超时。 */
async function waitForLoadState(
  loader: LoaderLike | undefined,
  check: (names: ReadonlySet<string>) => boolean,
): Promise<boolean> {
  if (loader === undefined) return false
  const deadline = Date.now() + HOT_WAIT_MS
  while (Date.now() < deadline) {
    const names = new Set(
      [...loader.entries()].map((entry) => entry.options.name).filter((name): name is string => name !== undefined),
    )
    if (check(names)) return true
    await new Promise((resolve) => setTimeout(resolve, HOT_POLL_MS))
  }
  return false
}

/**
 * 热激活安装：把新增 bundle 的补丁行追加进根 include 的补丁列表并等待应用。
 * @returns 是否已确认热生效；false = 需要重启（无 Loader / 非 include 树 / 更新失败）。
 */
export async function hotApplyInstall(
  loader: LoaderLike | undefined,
  profileDir: string,
  activated: readonly string[],
): Promise<boolean> {
  const entry = rootIncludeEntry(loader)
  if (entry === undefined || entry.update === undefined) return false
  const current = entry.options.config
  const additions: Array<Record<string, unknown>> = []
  for (const packageName of activated) {
    const patchPath = bundlePatchPath(profileDir, packageName)
    if (patchPath === undefined) continue // 解析不到（极端竞态）→ 跳过该包
    additions.push(...parsePatchFile(patchPath))
  }
  if (additions.length === 0) return true // 没有需要激活的行，无需改写
  await entry.update({
    config: {
      ...(current ?? {}),
      patches: [...(current?.patches ?? []), ...additions],
    },
  })
  return true
}

/**
 * 热激活卸载：把已卸载 bundle 的补丁行从根 include 的补丁列表里过滤掉并等待应用。
 * @param removedPatches - pnpm remove 之前解析的该 bundle 的补丁行（卸载后文件已不在磁盘）。
 */
export async function hotApplyRemove(
  loader: LoaderLike | undefined,
  removedPatches: readonly Record<string, unknown>[],
): Promise<boolean> {
  const entry = rootIncludeEntry(loader)
  if (entry === undefined || entry.update === undefined) return false
  const current = entry.options.config
  const currentPatches = current?.patches ?? []
  if (removedPatches.length === 0 || currentPatches.length === 0) return true
  const next = currentPatches.filter(
    (patch) => !removedPatches.some((removed) => deepEqual(patch, removed)),
  )
  if (next.length === currentPatches.length) return true // 没有命中该 bundle 的行
  await entry.update({
    config: {
      ...(current ?? {}),
      patches: next,
    },
  })
  return true
}

// ---- 禁用 / 启用（set-enabled）----
//
// 禁用一个 bundle = 在 profile 的 cordis.patch.yml 里对它的每个 insert 行写
// 一条 id 覆盖补丁 `{ id, disabled: true }`（启用写 `disabled: false`）。
// 这个文件既是持久化（启动时作为用户层组合进配置树），也是热重载入口
// （dsh 的配置 HMR 监听它，改动即事务性应用）—— 因此禁用/启用默认免重启。
// 安装器把这类补丁集中维护在一个带标记的托管块里，避免污染用户自己的内容：
//
//   # >>> dsh-plugin-installer: managed (bundle state) — 安装器维护，请勿手改
//   - id: <row-id>
//     disabled: true
//   # <<< dsh-plugin-installer: managed
//
// 内置保护：`@deepseek-ai/*` 是 harness 核心（dsh-base / dsh-web-app 等），
// 禁用会导致 profile 无法启动或失去 GUI，因此 set-enabled 与 remove 一样拒绝。

/** profile 的 patch 文件名（与 harness 的 PROFILE_PATCH_FILENAME 一致）。 */
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** 托管块起始标记行。 */
const MANAGED_START = '# >>> dsh-plugin-installer: managed (bundle state) — 安装器维护，请勿手改'
/** 托管块结束标记行。 */
const MANAGED_END = '# <<< dsh-plugin-installer: managed'

/** 收集一个 bundle patch 文件里所有 insert 出的顶层行 id（禁用单位）。 */
function collectInsertRowIds(patches: readonly Record<string, unknown>[]): string[] {
  const ids: string[] = []
  for (const patch of patches) {
    const insert = patch.insert
    if (!Array.isArray(insert)) continue
    for (const row of insert) {
      if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string') {
        ids.push((row as Record<string, unknown>).id as string)
      }
    }
  }
  return ids
}

/** 从文件内容中切出托管块（标记之间的文本）；无标记时缺省。 */
function extractManagedBlock(content: string): string | undefined {
  const start = content.indexOf(MANAGED_START)
  const end = content.indexOf(MANAGED_END)
  if (start < 0 || end < start) return undefined
  return content.slice(start + MANAGED_START.length, end)
}

/** 读当前托管状态：行 id → 是否禁用（文件不存在/无托管块时为空）。 */
function readManagedState(profileDir: string): Map<string, boolean> {
  const path = join(profileDir, PROFILE_PATCH_FILENAME)
  if (!existsSync(path)) return new Map()
  const block = extractManagedBlock(readFileSync(path, 'utf8'))
  if (block === undefined) return new Map()
  const parsed = yaml.load(block, { schema: entryListSchema })
  const state = new Map<string, boolean>()
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry !== null && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        if (typeof record.id === 'string' && typeof record.disabled === 'boolean') {
          state.set(record.id, record.disabled)
        }
      }
    }
  }
  return state
}

/** 把托管块写回 profile 的 cordis.patch.yml（保留文件其余内容；文件缺失时新建）。 */
function writeManagedState(profileDir: string, state: Map<string, boolean>): void {
  const path = join(profileDir, PROFILE_PATCH_FILENAME)
  const entries = [...state].map(([id, disabled]) => ({ id, disabled }))
  const block = entries.length === 0
    ? null
    : `${MANAGED_START}\n${yaml.dump(entries)}${MANAGED_END}\n`

  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const trimmed = existing.trim()
  let next: string
  if (trimmed === '' || trimmed === '[]') {
    // 空文件 / 空数组：整个文件就是托管块（或为空）。
    next = block ?? '[]\n'
  } else {
    const start = existing.indexOf(MANAGED_START)
    const end = existing.indexOf(MANAGED_END)
    let base = existing
    if (start >= 0 && end >= start) {
      const endOfLine = existing.indexOf('\n', end)
      const regionEnd = endOfLine === -1 ? existing.length : endOfLine + 1
      base = existing.slice(0, start) + existing.slice(regionEnd)
    }
    const rest = base.trimEnd()
    if (block === null) {
      // 托管块被清空：剩余内容必须是合法 YAML 数组（空则写 `[]`）。
      next = rest === '' ? '[]\n' : rest + '\n'
    } else {
      next = (rest === '' ? '' : rest + '\n') + block
    }
  }
  writeFileSync(path, next)
}

/**
 * set-enabled：切换一个 bundle 所有 insert 行的禁用状态（写入 profile 的
 * cordis.patch.yml 托管块，持久化 + HMR 热应用）。
 * @returns 是否已确认热生效；false = 需要重启（无 Loader / 非 include 树 / 更新失败）。
 */
async function setEnabled(
  packageName: string,
  enabled: boolean,
  profileDir: string,
  loader: LoaderLike | undefined,
): Promise<InstallerResponse<InstallerChangeValue>> {
  const trimmed = packageName.trim()
  if (trimmed === '') return { ok: false, error: { code: 'bad-request', message: '包名不能为空' } }
  if (trimmed.startsWith('@deepseek-ai/')) {
    return {
      ok: false,
      error: {
        code: 'builtin-protected',
        message: `${trimmed} 是 harness 内置 bundle（核心 / GUI 本身），禁用或卸载会导致 profile 无法启动，因此不开放。`
          + '如需控制内置功能，请直接编辑 profile 的 cordis.patch.yml。',
      },
    }
  }
  const patchPath = bundlePatchPath(profileDir, trimmed)
  if (patchPath === undefined) {
    return { ok: false, error: { code: 'set-enabled-failed', message: `${trimmed} 无法解析或未声明 dsh.bundle` } }
  }
  let patches: Array<Record<string, unknown>>
  try {
    patches = parsePatchFile(patchPath)
  } catch (error) {
    return { ok: false, error: { code: 'set-enabled-failed', message: `解析 ${trimmed} 的 patch 失败：${String(error)}` } }
  }
  const rowIds = collectInsertRowIds(patches)
  if (rowIds.length === 0) {
    return {
      ok: true,
      value: { output: '', hot: true, warning: `${trimmed} 的 patch 没有可禁用的配置行（无 insert），无需切换` },
    }
  }

  const state = readManagedState(profileDir)
  for (const id of rowIds) {
    if (enabled) state.delete(id)
    else state.set(id, true)
  }
  writeManagedState(profileDir, state)

  const value: InstallerChangeValue = { output: '', toggled: rowIds }
  try {
    value.hot = await waitForEntries(loader, (entries) => {
      const byId = new Map(entries.map((entry) => [entry.options.id, entry]))
      // 启用：所有行在树中且未被禁用；禁用：所有行在树中且已禁用。
      // 行不在树中（如热装后未重启的临时状态）视为未确认。
      return rowIds.every((id) => {
        const entry = byId.get(id)
        return entry !== undefined && (enabled ? entry.options.disabled !== true : entry.options.disabled === true)
      })
    })
    if (value.hot !== true) {
      value.warning = '已写入 profile 的 cordis.patch.yml（重启后生效）；'
        + '若当前未生效，可能是该 bundle 刚热装、尚未重启，或热应用未完成'
    }
  } catch (error) {
    value.warning = `热应用失败（${String(error)}）—— 已写入 profile，重启后生效`
  }
  return { ok: true, value }
}

/** 轮询 Loader 条目直到断言成立或超时。 */
async function waitForEntries(
  loader: LoaderLike | undefined,
  check: (entries: ReadonlyArray<LoaderEntryLike>) => boolean,
): Promise<boolean> {
  if (loader === undefined) return false
  const deadline = Date.now() + HOT_WAIT_MS
  while (Date.now() < deadline) {
    if (check([...loader.entries()])) return true
    await new Promise((resolve) => setTimeout(resolve, HOT_POLL_MS))
  }
  return false
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
  const entries = [...(loader?.entries() ?? [])]
  const loadedNames = new Set(
    entries.map((entry) => entry.options.name).filter((n): n is string => n !== undefined),
  )
  const entriesById = new Map(entries.map((entry) => [entry.options.id, entry]))
  // bundle 行名可能是包名本身（如客户端发现载体行）或包名子路径（如安装器行
  // `dsh-plugin-installer/installer`）——二者都算该 bundle 已挂载。
  const isLoaded = (packageName: string): boolean =>
    [...loadedNames].some((name) => name === packageName || name.startsWith(`${packageName}/`))
  const bundles: BundleView[] = (manifest.dsh?.profile?.bundles ?? []).map((packageName) => {
    const dir = packageDirFromAnchor(join(profileDir, 'package.json'), packageName)
    if (dir === undefined) return { packageName, resolved: false, active: false }
    const bundleManifest = readManifest(dir)
    const patch = bundleManifest.dsh?.bundle?.patch
    const view: BundleView = {
      packageName,
      resolved: true,
      ...(patch === undefined ? {} : { patch }),
      active: isLoaded(packageName),
    }
    if (patch !== undefined) {
      try {
        const rowIds = collectInsertRowIds(parsePatchFile(join(dir, patch)))
        if (rowIds.length > 0) {
          // 整包禁用 = 其全部 insert 行在运行树中都是 disabled。
          view.disabled = rowIds.every((id) => entriesById.get(id)?.options.disabled === true)
        }
      } catch {
        // 解析失败（损坏的 patch）不影响列表，仅跳过 disabled 计算。
      }
    }
    return view
  })
  const dependencies: DependencyView[] = Object.entries(manifest.dependencies ?? {})
    .map(([name, spec]) => ({ name, spec, isBundle: exportsPatch(name, profileDir) }))
  return { profileName: basename(profileDir), profileDir, bundles, dependencies }
}

/** install：pnpm add + 对账层列表 + 热激活。返回新增/激活的包名与提示。 */
async function install(
  spec: string,
  profileDir: string,
  loader: LoaderLike | undefined,
): Promise<InstallerResponse<InstallerChangeValue>> {
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
  const value: InstallerChangeValue = {
    output,
    added,
    activated,
    warning: warnings.length > 0 ? warnings.join('\n') : undefined,
  }
  if (activated.length > 0) {
    // 热激活：改写根 include 的补丁列表，让新 bundle 的行立即进树；失败不致命，
    // 回退为"重启后生效"（与旧行为一致），提示里说明原因。
    try {
      const applied = await hotApplyInstall(loader, profileDir, activated)
      if (applied) {
        value.hot = await waitForLoadState(
          loader,
          (names) => activated.some((packageName) => hasLoadedName(packageName, names)),
        )
      }
      if (value.hot !== true) {
        value.warning = [
          ...(value.warning !== undefined ? [value.warning] : []),
          '已写入 profile，但运行中的配置树未确认热生效（可能正在应用，或缺少 Loader/include）—— 若持续未生效，请重启 dsh',
        ].join('\n')
      }
    } catch (error) {
      value.warning = [
        ...(value.warning !== undefined ? [value.warning] : []),
        `热激活失败（${String(error)}）—— 该插件未激活，且重启时同样会遇到此问题（错误若与热激活无关，如工具名/路由冲突，请先解决冲突）`,
      ].join('\n')
    }
  } else {
    value.hot = true // 没有 bundle 层需要激活，无变更即已生效
  }
  return { ok: true, value }
}

/** remove：pnpm remove + 对账层列表 + 热卸载。 */
async function remove(
  packageName: string,
  profileDir: string,
  loader: LoaderLike | undefined,
): Promise<InstallerResponse<InstallerChangeValue>> {
  const trimmed = packageName.trim()
  if (trimmed === '') return { ok: false, error: { code: 'bad-request', message: '包名不能为空' } }
  const before = readManifest(profileDir)
  // pnpm remove 会删掉包文件；先解析该 bundle 的补丁行，供热卸载过滤用。
  let removedPatches: Array<Record<string, unknown>> = []
  const patchPath = bundlePatchPath(profileDir, trimmed)
  if (patchPath !== undefined) {
    try {
      removedPatches = parsePatchFile(patchPath)
    } catch {
      removedPatches = [] // 解析失败按无行处理（非 bundle 或损坏文件）
    }
  }
  const { code, output } = await runPnpm(profileDir, ['remove', trimmed])
  if (code !== 0) {
    return { ok: false, error: { code: 'remove-failed', message: `pnpm remove 失败（退出码 ${code}）`, output } }
  }
  const warnings = reconcilePlugins(before, profileDir)
  const afterNames = new Set(Object.keys(readManifest(profileDir).dependencies ?? {}))
  const removed = Object.keys(before.dependencies ?? {}).filter((name) => !afterNames.has(name))
  const value: InstallerChangeValue = {
    output,
    removed,
    warning: warnings.length > 0 ? warnings.join('\n') : undefined,
  }
  if (removed.length > 0) {
    try {
      const applied = await hotApplyRemove(loader, removedPatches)
      if (applied) {
        value.hot = await waitForLoadState(
          loader,
          (names) => !removed.some((name) => hasLoadedName(name, names)),
        )
      }
      if (value.hot !== true) {
        value.warning = [
          ...(value.warning !== undefined ? [value.warning] : []),
          '已从 profile 移除，但运行中的配置树未确认热生效（可能正在应用，或缺少 Loader/include、更新失败）—— 重启 dsh 后完全生效',
        ].join('\n')
      }
    } catch (error) {
      value.warning = [
        ...(value.warning !== undefined ? [value.warning] : []),
        `热卸载失败（${String(error)}）—— 重启 dsh 后完全生效`,
      ].join('\n')
    }
  } else {
    value.hot = true // 没有依赖被移除，无变更即已生效
  }
  return { ok: true, value }
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
      return install(request.spec ?? '', profileDir, loader)
    case 'remove':
      return remove(request.packageName ?? '', profileDir, loader)
    case 'set-enabled':
      return setEnabled(request.packageName ?? '', request.enabled === true, profileDir, loader)
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
