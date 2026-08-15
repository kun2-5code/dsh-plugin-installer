/**
 * dsh-plugin-installer 的插件安装器浏览器半边（client）：在 设置 → 插件 分区注册
 * 一个「安装」tab，让用户直接在 Web GUI 里安装/卸载 profile 插件 —— 等价于在终端
 * 执行 `dsh plugin --profile web add/remove <spec>`，不用打开 CLI。
 *
 * 工作方式：
 * - 宿主半边（src/installer.ts）通过 ctx.webServer 注册 `POST /dsh-plugin-installer/api`
 *   （当前 profile 目录内转发 pnpm + 对账 dsh.profile.bundles 层列表）；
 * - 本文件同源 fetch 该端点：install / remove / list 三个方法；
 * - tab 通过 `settings.plugins.tab` 插槽挂进 设置 → 插件 分区（与内置的
 *   ui-settings-plugin-inventory 的「全部」tab 同一插槽）。
 *
 * 依赖纪律：与 src/client.ts 相同 —— 运行时只 import react，其余走 ctx 服务与
 * 浏览器原生 fetch，不 import 任何 @deepseek-ai 客户端包。
 * @module dsh-plugin-installer/installer-client
 */

import React from 'react'

// ---- 最小 DOM 声明（tsconfig 无 dom lib；与 src/client.ts 的 document 声明同理）----

declare const fetch: (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>

declare const document: {
  createElement(tag: 'style'): { dataset: Record<string, string>; textContent: string }
  head: { appendChild(node: { dataset: Record<string, string>; textContent: string }): void }
}

// ---- 与宿主共享的契约形状（src/installer.ts 同形）----

export interface InstallerBundle {
  packageName: string
  resolved: boolean
  patch?: string
  active: boolean
  /** 是否整包禁用（其全部 insert 行在运行树中均为 disabled）。 */
  disabled?: boolean
}

export interface InstallerDependency {
  name: string
  spec: string
  isBundle: boolean
}

export interface InstallerList {
  profileName: string
  profileDir: string
  bundles: InstallerBundle[]
  dependencies: InstallerDependency[]
}

export interface InstallerChange {
  output: string
  added?: string[]
  activated?: string[]
  removed?: string[]
  /** set-enabled 本次切换的配置行 id。 */
  toggled?: string[]
  /** 是否已热应用到运行中的配置树（true = 已生效，无需重启）。 */
  hot?: boolean
  warning?: string | undefined
}

/** 安装器 API 面：tab 通过 inject 注入，宿主经 HTTP 实现。 */
export interface InstallerApi {
  list(): Promise<InstallerList>
  install(spec: string): Promise<InstallerChange>
  remove(packageName: string): Promise<InstallerChange>
  setEnabled(packageName: string, enabled: boolean): Promise<InstallerChange>
}

interface ApiErrorPayload {
  code: string
  message: string
  output?: string | undefined
}

type ApiPayload<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApiErrorPayload }

/** 调用宿主安装器端点；业务失败以带 output 的 Error 形式抛出。 */
async function call<T>(method: string, body: Record<string, string>): Promise<T> {
  const response = await fetch('/dsh-plugin-installer/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, ...body }),
  })
  let payload: ApiPayload<T>
  try {
    payload = await response.json() as ApiPayload<T>
  } catch {
    throw new Error(`安装器端点返回了非 JSON 响应（HTTP ${response.status}）—— 插件宿主半侧可能未加载`)
  }
  if (!payload.ok) {
    const error = new Error(payload.error.message) as Error & { code?: string | undefined; output?: string | undefined }
    error.code = payload.error.code
    error.output = payload.error.output
    throw error
  }
  return payload.value
}

/** 供 tab 注入的 API 实例。 */
export const installerApi: InstallerApi = {
  list: () => call('list', {}),
  install: (spec) => call('install', { spec }),
  remove: (packageName) => call('remove', { packageName }),
  setEnabled: (packageName, enabled) => call('set-enabled', { packageName, enabled: String(enabled) }),
}

// ---- tab UI 状态 ----

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; list: InstallerList }

type Message =
  | { kind: 'info' | 'warn' | 'error'; text: string; output?: string | undefined }
  | undefined

/** 「安装」tab：安装表单 + 已装 bundle 层列表 + 卸载按钮。 */
export function InstallerTab({ api }: { api: InstallerApi }): React.ReactElement | null {
  const [, forceRender] = React.useReducer((count: number) => count + 1, 0)
  const [listState, setListState] = React.useState<ListState>({ status: 'loading' })
  const [spec, setSpec] = React.useState('')
  const [busy, setBusy] = React.useState<string | undefined>(undefined)
  const [message, setMessage] = React.useState<Message>(undefined)
  const [expanded, setExpanded] = React.useState(false)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    let current = true
    void api.list().then(
      (list) => { if (current) setListState({ status: 'ready', list }) },
      () => { if (current) setListState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [api])

  const refresh = (): void => {
    void api.list().then(
      (list) => { setListState({ status: 'ready', list }); forceRender() },
      () => { setListState({ status: 'error' }) },
    )
  }

  const runInstall = (): void => {
    if (busy !== undefined || spec.trim() === '') return
    setBusy('install')
    setMessage(undefined)
    void api.install(spec).then(
      (change) => {
        const activated = change.activated ?? []
        const added = change.added ?? []
        const hot = change.hot === true
        const parts: string[] = []
        if (activated.length > 0) {
          parts.push(hot
            ? `已安装并激活 bundle：${activated.join('、')}（已热生效，无需重启）`
            : `已安装并激活 bundle：${activated.join('、')}（重启 dsh 后生效）`)
        } else if (added.length > 0) {
          parts.push(`已安装：${added.join('、')}（未激活为配置层）`)
        } else {
          parts.push('安装完成（没有新增依赖）')
        }
        if (change.warning !== undefined) parts.push(change.warning)
        setMessage({ kind: added.length > 0 && activated.length === 0 ? 'warn' : 'info', text: parts.join('；'), output: change.output })
        setSpec('')
        refresh()
      },
      (error: Error & { code?: string; output?: string }) => {
        setMessage({ kind: 'error', text: error.message, output: error.output })
      },
    ).finally(() => { setBusy(undefined); forceRender() })
  }

  const runRemove = (packageName: string): void => {
    if (busy !== undefined) return
    setBusy(packageName)
    setMessage(undefined)
    void api.remove(packageName).then(
      (change) => {
        const removed = change.removed ?? []
        const hot = change.hot === true
        setMessage({
          kind: 'info',
          text: removed.length > 0
            ? hot
              ? `已卸载：${removed.join('、')}（已热生效，无需重启）`
              : `已卸载：${removed.join('、')}（重启 dsh 后完全生效）`
            : '卸载完成',
          output: change.output,
        })
        refresh()
      },
      (error: Error & { code?: string; output?: string }) => {
        setMessage({ kind: 'error', text: error.message, output: error.output })
      },
    ).finally(() => { setBusy(undefined); forceRender() })
  }

  const runToggle = (bundle: InstallerBundle): void => {
    if (busy !== undefined) return
    const target = bundle.disabled === true ? false : true
    setBusy(`toggle:${bundle.packageName}`)
    setMessage(undefined)
    void api.setEnabled(bundle.packageName, target).then(
      (change) => {
        const toggled = change.toggled ?? []
        const hot = change.hot === true
        const label = target ? '启用' : '禁用'
        setMessage({
          kind: 'info',
          text: toggled.length > 0
            ? hot
              ? `已${label}：${bundle.packageName}（已热生效，无需重启）`
              : `已${label}：${bundle.packageName}（已写入 profile 的 cordis.patch.yml，重启后生效）`
            : `无需切换：${bundle.packageName} 没有可禁用的配置行`,
          output: change.output,
        })
        refresh()
      },
      (error: Error & { code?: string; output?: string }) => {
        setMessage({ kind: 'error', text: error.message, output: error.output })
      },
    ).finally(() => { setBusy(undefined); forceRender() })
  }

  return React.createElement(
    'div',
    { className: 'dsi-tab' },
    React.createElement(
      'p',
      { className: 'dsi-intro' },
      '在 profile 里安装/卸载/禁用插件（等价于 `dsh plugin add/remove` + 行级 disabled）。',
      '安装源支持 npm 包名、github:user/repo、file: 链接、tarball/目录的绝对路径；',
      '安装/卸载/禁用会热更新运行中的配置（无需重启）；热更新失败时才需要重启 dsh。',
      '需要 pnpm 在 dsh 进程的 PATH 上。',
    ),
    React.createElement(
      'div',
      { className: 'dsi-install-row' },
      React.createElement('input', {
        className: 'dsi-input',
        type: 'text',
        placeholder: '例如 dsh-my-plugin / github:user/repo / /abs/path.tgz',
        value: spec,
        disabled: busy !== undefined,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          setSpec((event.target as unknown as { value: string }).value),
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
          if ((event.target as unknown as { value: string }).value.trim() !== ''
            && (event as unknown as { key: string }).key === 'Enter') runInstall()
        },
      }),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsi-button dsi-button-primary',
          disabled: busy !== undefined || spec.trim() === '',
          onClick: runInstall,
        },
        busy === 'install' ? '安装中…' : '安装',
      ),
    ),
    renderMessage(message, expanded, setExpanded),
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsi-collapse',
        onClick: () => { setOpen(!open); forceRender() },
      },
      listState.status === 'ready'
        ? `${open ? '收起' : '展开'}已装插件（profile: ${listState.list.profileName}）`
        : '已装插件',
    ),
    open && listState.status === 'ready'
      ? React.createElement(
        'div',
        { className: 'dsi-list' },
        renderBundles(listState.list, busy, runRemove, runToggle),
        renderDependencies(listState.list),
      )
      : null,
  )
}

/** 消息区：错误/警告/成功 + 可展开的 pnpm 原始输出。 */
function renderMessage(
  message: Message,
  expanded: boolean,
  setExpanded: (value: boolean) => void,
): React.ReactElement | null {
  if (message === undefined) return null
  return React.createElement(
    'div',
    { className: `dsi-message dsi-message-${message.kind}` },
    React.createElement(
      'p',
      { className: 'dsi-message-text', role: 'status' },
      message.text,
    ),
    message.output !== undefined
      ? React.createElement(
        'details',
        { className: 'dsi-output', open: expanded, onToggle: () => setExpanded(!expanded) },
        React.createElement('summary', null, expanded ? '收起输出' : '展开 pnpm 输出'),
        React.createElement('pre', null, message.output),
      )
      : null,
  )
}

/** bundle 层列表：运行中 / 已禁用 / 需重启 + 内置徽标 + 禁用/启用与卸载按钮。 */
function renderBundles(
  list: InstallerList,
  busy: string | undefined,
  runRemove: (packageName: string) => void,
  runToggle: (bundle: InstallerBundle) => void,
): React.ReactElement {
  const rows = list.bundles.map((bundle) => {
    const isBuiltin = bundle.packageName.startsWith('@deepseek-ai/')
    const activeBadge = !bundle.active
      ? React.createElement('span', { className: 'dsi-badge' }, '需重启')
      : bundle.disabled === true
        ? React.createElement('span', { className: 'dsi-badge dsi-badge-off' }, '已禁用')
        : React.createElement('span', { className: 'dsi-badge dsi-badge-active' }, '运行中')
    const resolvedBadge = bundle.resolved
      ? null
      : React.createElement('span', { className: 'dsi-badge dsi-badge-warn' }, '未解析')
    const builtinBadge = isBuiltin
      ? React.createElement(
        'span',
        {
          className: 'dsi-badge dsi-badge-warn',
          title: 'harness 内置 bundle（核心 / GUI 本身），禁用或卸载会破坏 profile，故不开放',
        },
        '内置',
      )
      : null
    const toggleButton = !isBuiltin && bundle.resolved
      ? React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsi-button',
          disabled: busy !== undefined,
          onClick: () => runToggle(bundle),
        },
        busy === `toggle:${bundle.packageName}`
          ? '切换中…'
          : bundle.disabled === true ? '启用' : '禁用',
      )
      : null
    const removeButton = !isBuiltin && bundle.resolved
      ? React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsi-button',
          disabled: busy !== undefined,
          onClick: () => runRemove(bundle.packageName),
        },
        busy === bundle.packageName ? '卸载中…' : '卸载',
      )
      : null
    return React.createElement(
      'li',
      { className: 'dsi-row', key: bundle.packageName },
      React.createElement(
        'span',
        { className: 'dsi-row-name' },
        bundle.packageName,
        bundle.patch !== undefined ? React.createElement('span', { className: 'dsi-row-patch' }, bundle.patch) : null,
      ),
      activeBadge,
      resolvedBadge,
      builtinBadge,
      toggleButton,
      removeButton,
    )
  })
  return React.createElement(
    'section',
    { className: 'dsi-section' },
    React.createElement('h3', { className: 'dsi-heading' }, '配置层（bundles）'),
    rows.length > 0
      ? React.createElement('ul', { className: 'dsi-rows' }, rows)
      : React.createElement('p', { className: 'dsi-empty' }, '没有 bundle 层'),
  )
}

/** 全部依赖列表（含未声明 dsh.bundle 的普通依赖）。 */
function renderDependencies(list: InstallerList): React.ReactElement {
  const rows = list.dependencies.map((dep) =>
    React.createElement(
      'li',
      { className: 'dsi-row', key: dep.name },
      React.createElement('span', { className: 'dsi-row-name' }, dep.name),
      React.createElement('span', { className: 'dsi-row-spec' }, dep.spec),
      React.createElement(
        'span',
        { className: dep.isBundle ? 'dsi-badge dsi-badge-active' : 'dsi-badge dsi-badge-warn' },
        dep.isBundle ? 'bundle' : '普通依赖',
      ),
    ),
  )
  return React.createElement(
    'section',
    { className: 'dsi-section' },
    React.createElement('h3', { className: 'dsi-heading' }, '依赖'),
    rows.length > 0
      ? React.createElement('ul', { className: 'dsi-rows' }, rows)
      : React.createElement('p', { className: 'dsi-empty' }, '没有 tree 外依赖'),
  )
}

// ---- 样式：一次性注入 <style>（class 前缀 dsi-，颜色全走主题变量）----

let stylesInjected = false

export function injectInstallerStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-installer'
  tag.dataset.pluginCss = 'dsh-plugin-installer/tab'
  tag.textContent = `
.dsi-tab { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 16px; }
.dsi-intro { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dsi-install-row { display: flex; gap: 8px; }
.dsi-input {
  flex: 1; min-width: 0; height: 34px; padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsi-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsi-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsi-button {
  appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: none; color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.dsi-button:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dsi-button:disabled { opacity: 0.4; cursor: default; }
.dsi-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsi-button-primary { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); border-color: transparent; }
.dsi-button-primary:hover:not(:disabled) { color: var(--dsw-alias-bg-layer-3); }
.dsi-collapse {
  align-self: flex-start; appearance: none; border: 0; background: none; padding: 0;
  font: inherit; font-size: 13px; font-weight: 500; line-height: 1.5; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.dsi-collapse:hover { color: var(--dsw-alias-label-primary); }
.dsi-message { display: flex; flex-direction: column; gap: 6px; border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.5; }
.dsi-message-info { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dsi-message-warn { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); }
.dsi-message-error { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-error-primary); }
.dsi-message-text { margin: 0; white-space: pre-wrap; }
.dsi-output summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsi-output pre {
  margin: 8px 0 0; padding: 8px 10px; max-height: 240px; overflow: auto;
  border-radius: 6px; background: var(--dsw-alias-bg-layer-2);
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all;
}
.dsi-list { display: flex; flex-direction: column; gap: 14px; }
.dsi-section { display: flex; flex-direction: column; gap: 8px; }
.dsi-heading { margin: 0; font-size: 12px; font-weight: 600; line-height: 1.5; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary); }
.dsi-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden; }
.dsi-row { display: flex; align-items: center; gap: 8px; padding: 9px 12px; }
.dsi-row + .dsi-row { border-top: 1px solid var(--dsw-alias-border-l2); }
.dsi-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsi-row-patch { margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.dsi-row-spec { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsi-badge { flex: none; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; white-space: nowrap; font-weight: 500; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dsi-badge-active { color: var(--dsw-alias-label-primary); }
.dsi-badge-warn { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary)); }
.dsi-badge-off { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
.dsi-empty { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
`
  document.head.appendChild(tag)
}
