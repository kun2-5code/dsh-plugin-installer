// 构建产物冒烟测试：验证主入口（client 发现载体）为空实现、插件安装器宿主
// 半侧（webServer 路由 + API 方法 + 免重启热激活）。
// 运行：node test/smoke.mjs（先 pnpm build）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { name, apply } from '../lib/index.js'
import {
  apply as applyInstaller,
  handleInstallerRequest,
  hotApplyInstall,
  hotApplyRemove,
  parsePatchFile,
  ROUTE_PREFIX,
} from '../lib/installer.js'

// 主入口（包名载体行）：只负责 client 半边发现，apply 应为空实现、不抛错。
assert.equal(name, 'dsh-plugin-installer')
assert.doesNotThrow(() => apply({}), 'carrier apply should be a no-op')

// 插件安装器宿主半侧：临时 profile 目录 + 伪 ctx（webServer 捕获路由注册）。
{
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-installer-smoke-'))
  try {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-smoke',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, undefined, 2) + '\n')

    // apply 应在 webServer 可用时注册前缀路由；effect 返回注销函数（停轮询+注销路由）。
    const routes = []
    const disposers = []
    const installerCtx = {
      baseUrl: `file://${profileDir}/`,
      get(service) {
        if (service === 'webServer') return {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
        return undefined
      },
      effect(callback) {
        disposers.push(callback())
        return () => {}
      },
    }
    applyInstaller(installerCtx)
    assert.equal(routes.length, 1, 'installer should register one route')
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, ROUTE_PREFIX)

    // webServer 延迟出现：短轮询窗口内应自动注册路由。
    {
      const lateRoutes = []
      let webServerAvailable = false
      const lateDisposers = []
      applyInstaller({
        baseUrl: `file://${profileDir}/`,
        get() {
          return webServerAvailable ? { register: (route) => { lateRoutes.push(route); return () => {} } } : undefined
        },
        effect(callback) {
          lateDisposers.push(callback())
          return () => {}
        },
      }, { pollMs: 5, waitMs: 500 })
      webServerAvailable = true
      for (let i = 0; i < 200 && lateRoutes.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(lateRoutes.length, 1, 'installer should register the route once webServer appears')
      for (const dispose of lateDisposers) dispose()
    }

    // list：读临时 profile 的 manifest，bundle 层在此环境不可解析（resolved: false）。
    const listed = await handleInstallerRequest(profileDir, { method: 'list' })
    assert.equal(listed.ok, true)
    if (!listed.ok) throw new Error('unreachable')
    assert.equal(listed.value.profileName.startsWith('dsh-installer-smoke-'), true,
      `unexpected profileName ${listed.value.profileName}`)
    assert.equal(listed.value.bundles.length, 1)
    assert.equal(listed.value.bundles[0].packageName, '@deepseek-ai/dsh-base')
    assert.equal(listed.value.bundles[0].resolved, false)
    assert.deepEqual(listed.value.dependencies, [])

    // active 匹配：Loader 条目名是包名的子路径（如 `dsh-plugin-installer/installer`）
    // 时，该 bundle 应标记为已挂载。
    {
      // 造一个可解析的假包，让 bundle 层 resolved: true，active 判断才会走到 loader 匹配。
      const fakePkgDir = join(profileDir, 'node_modules', 'dsh-plugin-installer')
      mkdirSync(fakePkgDir, { recursive: true })
      writeFileSync(join(fakePkgDir, 'package.json'), JSON.stringify({
        name: 'dsh-plugin-installer',
        version: '0.1.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-smoke',
        private: true,
        dependencies: { 'dsh-plugin-installer': 'link:./node_modules/dsh-plugin-installer' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-installer'] } },
      }, undefined, 2) + '\n')
      const matched = await handleInstallerRequest(profileDir, { method: 'list' }, {
        entries: () => [{ options: { name: 'dsh-plugin-installer/installer' } }],
      })
      assert.equal(matched.ok, true)
      if (!matched.ok) throw new Error('unreachable')
      const installerView = matched.value.bundles.find((b) => b.packageName === 'dsh-plugin-installer')
      assert.ok(installerView, 'dsh-plugin-installer bundle should be listed')
      assert.equal(installerView.resolved, true, 'fake package should resolve')
      assert.equal(installerView.active, true, 'subpath entry name should count as loaded')
    }

    // 校验路径：相对路径 / 空 spec 在碰到 pnpm 之前就被拒绝。
    const relative = await handleInstallerRequest(profileDir, { method: 'install', spec: './some-plugin' })
    assert.equal(relative.ok, false)
    if (relative.ok) throw new Error('unreachable')
    assert.equal(relative.error.code, 'relative-path')

    const empty = await handleInstallerRequest(profileDir, { method: 'install', spec: '' })
    assert.equal(empty.ok, false)
    if (empty.ok) throw new Error('unreachable')
    assert.equal(empty.error.code, 'bad-request')

    const unknown = await handleInstallerRequest(profileDir, { method: 'nope' })
    assert.equal(unknown.ok, false)
    if (unknown.ok) throw new Error('unreachable')
    assert.equal(unknown.error.code, 'method-not-found')

    // 无 webServer / 无 baseUrl 的 ctx：静默禁用而不是抛错（effect 不执行回调，无定时器泄漏）。
    assert.doesNotThrow(() => applyInstaller({ baseUrl: `file://${profileDir}/`, get: () => undefined, effect: () => {} }))
    assert.doesNotThrow(() => applyInstaller({ get: () => ({ register: () => () => {} }), effect: () => {} }))

    // 清理主用例的定时器与路由。
    for (const dispose of disposers) dispose()
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
}

// 免重启热激活：直接改写根 include（id 固定为 `include`）的补丁列表，
// 无需任何 harness 改动即可让新 bundle 立即进树 / 卸载后立即出树。
{
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-hot-apply-'))
  try {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-hot',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, undefined, 2) + '\n')

    // 假 bundle 包：声明 dsh.bundle.patch，patch 文件里既有 insert 行也含
    // 一个 !!js 表达式节点（验证 include 方言解析）。
    const fakePkgDir = join(profileDir, 'node_modules', 'dsh-fake-plugin')
    mkdirSync(fakePkgDir, { recursive: true })
    writeFileSync(join(fakePkgDir, 'package.json'), JSON.stringify({
      name: 'dsh-fake-plugin',
      version: '0.1.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(fakePkgDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: fake-row',
      '      name: dsh-fake-plugin',
      '      config:',
      '        greeting: !!js "process.env.DSH_FAKE_GREETING || \'hi\'"',
      '',
    ].join('\n'))

    // 1) 安装：新 bundle 的补丁行应追加进根 include 的补丁列表并调用 update。
    let updatedConfig
    const entryWithUpdate = {
      options: { id: 'include', name: 'cordis:include', config: { path: 'file:///x/cordis.yml', patches: [] } },
      async update(options) { updatedConfig = options.config },
    }
    const applied = await hotApplyInstall({ entries: () => [entryWithUpdate] }, profileDir, ['dsh-fake-plugin'])
    assert.equal(applied, true, 'hotApplyInstall should apply')
    assert.equal(updatedConfig.patches.length, 1, 'new bundle patches should be appended')
    assert.equal(updatedConfig.patches[0].insert[0].id, 'fake-row')
    assert.equal(updatedConfig.patches[0].insert[0].config.greeting.__jsExpr.includes('DSH_FAKE_GREETING'), true,
      '!!js 表达式应按 include 方言解析为 { __jsExpr } 节点')

    // 2) 卸载：从运行中的补丁列表过滤掉该 bundle 的行。removedPatches 用
    //    fresh 解析（模拟 pnpm remove 前的磁盘状态），与运行中的克隆结构匹配。
    let removedConfig
    const removedEntry = {
      options: { id: 'include', name: 'cordis:include', config: { path: 'file:///x/cordis.yml', patches: updatedConfig.patches } },
      async update(options) { removedConfig = options.config },
    }
    const removed = await hotApplyRemove(
      { entries: () => [removedEntry] },
      parsePatchFile(join(fakePkgDir, 'cordis.patch.yml')),
    )
    assert.equal(removed, true, 'hotApplyRemove should apply')
    assert.equal(removedConfig.patches.length, 0, 'removed bundle rows should be filtered out')

    // 3) 无根 include（非 profile 树 / 无 Loader）：返回 false（调用方回退为"需重启"）。
    const noTree = await hotApplyInstall({ entries: () => [] }, profileDir, ['dsh-fake-plugin'])
    assert.equal(noTree, false, 'hotApplyInstall without a root include should report not-applied')
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
}

console.log('smoke ok')
