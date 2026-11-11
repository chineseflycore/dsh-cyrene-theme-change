// 玻璃功能的回归测试（纯静态分析 + 少量运行时断言）。
//
// 起因：0.11.2 里踩了两个只有真机上才看得见的坑——
//   1. 删 overrideTokens 那段时把 ensureLiquidFilter() 一起删了，applySkin 还在调它；
//   2. 玻璃的两个监听器被写进了「桌宠」的 change 回调里，只有勾过桌宠之后滑块才活。
// 这类错误语法检查抓不到，单元测试也覆盖不到，所以单独用源码结构断言盯住。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let passed = 0
const failures = []
function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name} → ${detail}`)
  }
}

console.log('\n液态玻璃 · 结构回归')

// ── 1. 折射滤镜：定义与调用必须成对 ──────────────────────────────
ok('ensureLiquidFilter 有定义',
  /function ensureLiquidFilter\(\)/.test(source), '未找到定义')
ok('applySkin 里调用了 ensureLiquidFilter',
  /ensureLiquidFilter\(\)/.test(source.slice(source.indexOf('function applySkin()'))), '未找到调用')

const filterDef = source.indexOf('function ensureLiquidFilter()')
const filterCall = source.indexOf('ensureLiquidFilter()', filterDef + 10)
ok('定义在调用之前（不会撞 TDZ）', filterDef > 0 && filterCall > filterDef, [filterDef, filterCall])

// ── 2. SVG 滤镜参数（对齐 dsh-plugin-liquid-glass 的实测值）────────
ok('滤镜 id 与 CSS 引用一致',
  source.includes('PACKAGE_ID + "-liquid"') && /url\(#cyrene-theme-change-liquid\)/.test(source),
  'id 或引用不一致')
ok('滤镜区域 124%（否则边缘被裁）',
  /x="-12%" y="-12%" width="124%" height="124%"/.test(source), '滤镜区域缺失')
ok('feTurbulence 频率 0.006/0.010',
  /baseFrequency="0\.006 0\.010"/.test(source), '频率参数缺失')
ok('feDisplacementMap scale 26',
  /scale="26"/.test(source), '位移参数缺失')
ok('尊重 prefers-reduced-motion',
  /prefers-reduced-motion: reduce/.test(source), '缺少动效降级')

// ── 3. 折射必须走 backdrop-filter，不能给元素加 filter ────────────
ok('折射用 backdrop-filter:url(#…)',
  /backdrop-filter:url\(#cyrene-theme-change-liquid\)/.test(source), '没走 backdrop-filter')
ok('没有残留 filter:url(#…) 写法',
  !/[^-]filter:url\(#cyrene-theme-change-liquid\)/.test(source), '残留旧写法')

// ── 4. 监听器必须挂在顶层，不能嵌在别的控件回调里 ─────────────────
const petStart = source.indexOf('petBox.addEventListener("change"')
const petBlockEnd = source.indexOf('});', petStart)
const petBlock = source.slice(petStart, petBlockEnd + 3)
ok('玻璃监听器没有被写进桌宠回调',
  !petBlock.includes('glassAlphaRange') && !petBlock.includes('glassHeavyBox'),
  petBlock.slice(0, 120))
ok('glassAlphaRange 的 input 监听存在',
  /glassAlphaRange\.addEventListener\("input"/.test(source), '缺 input 监听')
ok('glassAlphaRange 的 change 监听存在',
  /glassAlphaRange\.addEventListener\("change"/.test(source), '缺 change 监听')

// ── 5. 拖拽期间 paint 不得回写（否则滑块会被拽回去）───────────────
ok('paint 里有 sliding 守卫',
  /sliding !== true/.test(source), '缺拖拽守卫')
ok('input 时置 sliding=true',
  /addEventListener\("input", \(\) => \{\s*\n\s*sliding = true/.test(source), '未置位')
ok('change 时置 sliding=false',
  /addEventListener\("change", \(\) => \{\s*\n\s*sliding = false/.test(source), '未复位')

// ── 6. 透明度统一走 CSS 变量（不要再有第二套机制）──────────────────
ok('玻璃 token 用 --cyre-glass-a 驱动',
  source.includes('var(--cyre-glass-a'), 'token 未接变量')
ok('applySkin 写入 --cyre-glass-a',
  /setProperty\("--cyre-glass-a"/.test(source), '未写入变量')

// ── 7. 折射必须有"可扭的纹理" ─────────────────────────────────────
ok('存在折射底光层（否则扭出来还是纯色，像塑料）',
  /GLOW_ID/.test(source) && /ensureGlow\(\)/.test(source), '缺光晕层')
ok('关掉折射时会移除光晕层',
  /removeGlow\(\)/.test(source), '缺清理')
ok('折射铺在大面积窗格上',
  /backdrop-filter:url\(#cyrene-theme-change-liquid\) blur\(10px\)/.test(source), '只作用于小卡片')

// ── 7. 面板上确实有这两个控件 ────────────────────────────────────
ok('模板里有折射复选框', /data-role="glassHeavy"/.test(source), '缺控件')
ok('模板里有透明度滑块', /data-role="glassAlpha"[^>]*type="range"|type="range"[^>]*data-role="glassAlpha"/.test(source), '缺滑块')
ok('滑块有样式（默认外观太细不好拖）', /\.cyre-range\{/.test(source), '缺 .cyre-range 样式')

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)