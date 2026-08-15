/**
 * dsh-plugin-installer 的包名入口（client 半边发现载体）。
 *
 * 本行本身不实现任何功能：harness 的 client-modules 按 Loader 条目名解析
 * package.json（`require.resolve('<条目名>/package.json')`），只有存在一条
 * `name` 等于包名（`dsh-plugin-installer`）的插件行，浏览器才会加载
 * `lib/client.js`（设置 → 插件 → 安装 tab）。安装器的宿主逻辑在
 * `src/installer.ts`，经 `dsh-plugin-installer/installer` 子路径行加载。
 *
 * 加载契约：模块具名导出 apply(ctx)；框架在依赖就绪后调用，卸载时自动回收
 * 所有通过 ctx 注册的监听器与 effect。本行没有依赖、没有注册，apply 为空。
 * @module dsh-plugin-installer
 */

import type { Context } from '@deepseek-ai/cordis'

/** 插件显示名（诊断日志中使用）。 */
export const name = 'dsh-plugin-installer'

/** 空实现：client 半边发现载体，宿主侧无事可做。 */
export function apply(_ctx: Context): void {}
