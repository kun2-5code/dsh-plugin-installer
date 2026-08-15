// 构建产物冒烟测试：验证主插件注册 greet 工具、配置经 settings 命名空间实时接线、
// hook 权限门按配置拒绝/放行、插件安装器宿主半侧（webServer 路由 + API 方法）。
// 运行：node test/smoke.mjs（先 pnpm build）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { name, inject, apply } from '../lib/index.js'
import * as hook from '../lib/hook.js'
import { apply as applyInstaller, handleInstallerRequest, ROUTE_PREFIX } from '../lib/installer.js'

// 最小可用的 ctx：只实现本插件用到的成员。
// inject 存在但从不提供服务 —— 模拟"profile 里没有 settings 服务"，
// 此时 installSettingsSection 不执行，配置回退到 composition entry。
const registered = []
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
    },
  },
  on() {
    return () => {}
  },
  effect() {
    return () => {}
  },
  inject() {
    return () => {}
  },
}

const config = { greeting: 'Hi', maxRetries: 5 }
apply(ctx, config)

assert.equal(name, 'dsh-plugin-installer')
assert.deepEqual(inject, ['tools'])

const tool = registered.find((t) => t.name === 'greet')
assert.ok(tool, 'greet tool should be registered')
assert.equal(await tool.execute({ name: 'Ada' }), 'Hi, Ada!')

// settings 接线：模拟 settings 服务存在（installSettingsSection 的依赖立即满足），
// 断言 greet 工具实时读取命名空间的解析值，而不是静态配置。
{
  let liveValue = { greeting: 'Hey', maxRetries: 3 }
  const settingsCtx = {
    settings: {
      register(ns, schema, options) {
        assert.equal(ns, 'dsh-plugin-installer')
        assert.equal(options.base, config, 'composition entry 应作为 base 层传入')
        return {
          get() {
            return liveValue
          },
          watch() {
            return () => {}
          },
        }
      },
    },
    effect() {
      return () => {}
    },
  }
  const liveRegistered = []
  const liveCtx = {
    tools: { register(d) { liveRegistered.push(d) } },
    on() { return () => {} },
    effect() { return () => {} },
    inject(_names, callback) {
      callback(settingsCtx)
      return () => {}
    },
  }
  apply(liveCtx, config)
  const liveTool = liveRegistered.find((t) => t.name === 'greet')
  assert.ok(liveTool, 'greet tool should be registered')
  assert.equal(await liveTool.execute({ name: 'Bob' }), 'Hey, Bob!')
  liveValue = { greeting: 'Yo', maxRetries: 1 }
  assert.equal(await liveTool.execute({ name: 'Bob' }), 'Yo, Bob!', '配置变更应实时生效')
}

// hook 权限门：捕获注册的 tools/pre-execute 监听器，验证拒绝与放行两条路径。
let listener
const hookCtx = {
  on(_event, fn) {
    listener = fn
  },
}
hook.apply(hookCtx, { denyTools: ['bash'] })
assert.ok(listener, 'tools/pre-execute listener should be registered')

const denied = await listener({ name: 'bash' }, () => Promise.resolve({ kind: 'allow' }))
assert.deepEqual(denied, { kind: 'deny', reason: 'Tool "bash" is denied by policy.' })

const allowed = await listener({ name: 'greet' }, () => Promise.resolve({ kind: 'allow' }))
assert.deepEqual(allowed, { kind: 'allow' })

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

console.log('smoke ok')
