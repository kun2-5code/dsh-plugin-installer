/**
 * dsh-plugin-installer 的浏览器半边（client plugin）：在 设置 → 插件 分区
 * 注册「安装」tab，让用户直接在 Web GUI 里安装/卸载 profile 插件 ——
 * 等价于在终端执行 `dsh plugin --profile <name> add/remove`，不用打开 CLI。
 *
 * 工作方式：
 * - 宿主半侧（src/installer.ts）通过 ctx.webServer 注册 `POST /dsh-plugin-installer/api`
 *   （当前 profile 目录内转发 pnpm + 对账 dsh.profile.bundles 层列表 +
 *   免重启热激活），本文件同源 fetch 该端点；
 * - 本文件在 `settings.plugins.tab` 插槽注册安装 tab（与内置的
 *   ui-settings-plugin-inventory 的「全部」tab 同一插槽），UI 实现见
 *   src/installer-client.ts。
 *
 * 加载契约：与 host 半边同包，经 package.json 的 `dsh.client` 声明 +
 * `exports["./client"]` 被 dsh 的 client-modules 发现，浏览器加载构建产物
 * lib/client.js（CJS + __ModuleLoader__.load 握手，见 tsdown.config.ts）。
 * 注意：client 半边只在插件以"包名"安装进 profile 时才会加载；`--patch`
 * overlay 用绝对源码路径挂载的插件行不会加载 client 半边。
 *
 * 依赖纪律：运行时只 import react（浏览器平台模块表提供），其余一律走 ctx
 * 服务，不直接 import 任何 @deepseek-ai 客户端包（避免跨插件值导入与版本分裂）。
 * @module dsh-plugin-installer/client
 */

import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { InstallerTab, installerApi, injectInstallerStyles } from './installer-client'

/** 依赖的服务：slots 就绪后本插件才会加载。 */
export const inject = ['slots']

/**
 * 客户端插件主体：注册安装 tab 到 `settings.plugins.tab` 插槽。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return

  injectInstallerStyles()

  // 插件安装器 tab（设置 → 插件 → 安装）：宿主半侧见 src/installer.ts ——
  // 在 GUI 里直接 pnpm add/remove profile 插件，无需打开 CLI。
  slots.inject('settings.plugins.tab', () => slots.register(
    { name: 'settings.plugins.tab', id: 'installer', order: 20, label: '安装' },
    () => React.createElement(InstallerTab, { api: installerApi }),
  ))
}
