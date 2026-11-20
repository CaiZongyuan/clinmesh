# 人眼慢速操作导览录屏（`1x` `.mp4`）

录制面向人眼观察的完整跨岗位操作导览视频（`1600×1000` · `30fps` · `1x` 原速 · 中文 `.mp4`）时查阅；PR 验收用的 3–4 倍速短片规则见 [浏览器与演示证据](browser-evidence.md)。其他主题见[工程记忆入口](memory.md)。

## 一、核心节奏参数

不用全局 `slowMo`（会拖慢内部 DOM 查询且无光标轨迹），改在驱动层使用 `HumanDriver` 注入平滑指针、点击波纹与底部防遮挡字幕：

| 维度 | 推荐参数 | 关键约束 |
| --- | --- | --- |
| **视口与输出** | `1600 × 1000` · `30fps` · `libx264` · `yuv420p` · `CRF 18` · `+faststart` | 全程严禁改 viewport；本地只保留 `00-`、`01-` 中文 `.mp4` 与章节索引，不留重复 `.webm` |
| **光标与点击** | `steps = clamp(8, 22, round(dist / 45))`；普通 `hover 280 / after 520ms`，关键提交 `350 / 900ms`，勾选框 `200 / 320ms` | 点击波纹绑定真实捕获阶段 `pointerdown`（`850ms` 扩散红圈） |
| **输入与驻留** | `≤10` 字 `55ms`、`≤26` 字 `35ms`、长句 `22ms`（密码/日期框瞬填）；普通确认驻留 `1.2–1.5s`，复杂台账/DRG `2.0–2.6s` | 片头卡 `2.4s`（渐隐 `400ms`），片尾 `2.2s` |
| **底部防遮挡字幕** | **方案 A（首选）**：FFmpeg `pad=1600:1080:0:0:#0b1120` 外扩 `80px` 底栏烧录 `22px` 字幕；**方案 B**：页内 `popover="manual"` 悬停 `bottom: 68px` | 严禁放顶部（易被顶栏/Toast/Modal 遮挡）；方案 B 须用 `MutationObserver` 在新 `<dialog>` 打开时重调 `showPopover()` 保持 Top Layer 置顶 |

## 二、三层流水线与 `HumanDriver` 模板

临时录制脚本放在未跟踪的 `.agent/video-walkthrough/`：第 1 层用 `apps/web/e2e/fixtures.ts` 的 `webRoot` 真实生产构建配合 `startBrowserServer` / `createPciAiBrowserApp`（100% 合成数据与本地受控模型流，同一闭环共用 `app` 实例、每章独立 `BrowserContext` 产出分章视频并延续业务状态）；第 2 层由 `HumanDriver` 驱动并记录秒级 `markers`；第 3 层用 FFmpeg 转码烧录底部字幕并 `concat` 合集。

```ts
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'

export const VIDEO_VIEWPORT = { width: 1600, height: 1000 } as const
export interface StepMarker { offsetSeconds: number; role: string; label: string }

export async function installRecordingOverlay(
  context: BrowserContext,
  options: { showInPageCaption?: boolean } = { showInPageCaption: true },
): Promise<void> {
  await context.addInitScript(({ showInPageCaption }) => {
    const state = { role: '系统导览', text: '准备进入工作台…', x: 800, y: 500 }
    ;(window as unknown as Record<string, unknown>).__clinmeshDemoState = state
    const promoteTopLayer = (el: HTMLElement | null) => {
      if (!el || typeof el.showPopover !== 'function') return
      try { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover() } catch {}
    }
    const mount = () => {
      if (!document.body) return
      if (showInPageCaption && !document.getElementById('clinmesh-demo-hud')) {
        const hud = document.createElement('div')
        hud.id = 'clinmesh-demo-hud'
        hud.setAttribute('popover', 'manual')
        Object.assign(hud.style, {
          position: 'fixed', inset: 'auto auto 68px 50%', transform: 'translateX(-50%)',
          margin: '0', border: '2px solid rgba(96,165,250,0.85)', pointerEvents: 'none',
          display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 22px',
          borderRadius: '14px', maxWidth: '1360px', background: 'rgba(15,23,42,0.94)',
          color: '#fff', boxShadow: '0 14px 36px rgba(0,0,0,0.55)',
          fontFamily: '"Microsoft YaHei","PingFang SC",system-ui,sans-serif', fontSize: '18px',
        })
        hud.innerHTML = '<span id="clinmesh-hud-role" style="padding:3px 11px;border-radius:8px;background:#2563eb;color:#fff;font-size:15px;font-weight:800;white-space:nowrap"></span><span id="clinmesh-hud-text" style="font-weight:700;line-height:1.4"></span>'
        document.body.append(hud)
        promoteTopLayer(hud)
      }
      if (!document.getElementById('clinmesh-demo-cursor')) {
        const cursor = document.createElement('div')
        cursor.id = 'clinmesh-demo-cursor'
        cursor.setAttribute('popover', 'manual')
        Object.assign(cursor.style, {
          position: 'fixed', inset: '0 auto auto 0', margin: '0', border: 'none',
          background: 'transparent', width: '28px', height: '28px', pointerEvents: 'none',
          transform: `translate(${state.x}px, ${state.y}px)`, filter: 'drop-shadow(0 2px 5px rgba(0,0,0,0.45))',
        })
        cursor.innerHTML = '<svg width="28" height="28" viewBox="0 0 26 26" fill="none"><path d="M4 2.5L21.5 12.2L13.2 14.3L9.8 22.5L4 2.5Z" fill="#111827" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>'
        document.body.append(cursor)
        promoteTopLayer(cursor)
      }
    }
    const sync = () => {
      mount()
      const roleEl = document.getElementById('clinmesh-hud-role')
      const textEl = document.getElementById('clinmesh-hud-text')
      if (roleEl) roleEl.textContent = state.role
      if (textEl) textEl.textContent = state.text
      promoteTopLayer(document.getElementById('clinmesh-demo-hud'))
      promoteTopLayer(document.getElementById('clinmesh-demo-cursor'))
    }
    ;(window as unknown as Record<string, unknown>).__clinmeshSyncHud = sync
    window.addEventListener('DOMContentLoaded', () => {
      sync()
      new MutationObserver(() => {
        promoteTopLayer(document.getElementById('clinmesh-demo-hud'))
        promoteTopLayer(document.getElementById('clinmesh-demo-cursor'))
      }).observe(document.body, { childList: true })
    })
    window.addEventListener('mousemove', e => {
      state.x = e.clientX; state.y = e.clientY; mount()
      const c = document.getElementById('clinmesh-demo-cursor')
      if (c) c.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`
    }, { capture: true, passive: true })
    window.addEventListener('pointerdown', e => {
      mount()
      const ring = document.createElement('div')
      ring.setAttribute('popover', 'manual')
      Object.assign(ring.style, {
        position: 'fixed', inset: `${e.clientY - 20}px auto auto ${e.clientX - 20}px`,
        margin: '0', width: '40px', height: '40px', borderRadius: '999px',
        border: '3px solid #ef4444', background: 'rgba(239,68,68,0.16)', pointerEvents: 'none',
      })
      document.body.append(ring); promoteTopLayer(ring)
      ring.animate([{ transform: 'scale(0.35)', opacity: 0.95 }, { transform: 'scale(1.45)', opacity: 0 }],
        { duration: 850, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }).finished.finally(() => ring.remove())
    }, true)
  }, options)
}

export class HumanDriver {
  private cursorX = 800; private cursorY = 500
  readonly markers: StepMarker[] = []
  constructor(readonly page: Page, private readonly startedAt = Date.now()) {}

  async step(role: string, label: string, pauseMs = 1000) {
    this.markers.push({ offsetSeconds: Number(((Date.now() - this.startedAt) / 1000).toFixed(1)), role, label })
    await this.page.evaluate(({ role, label }) => {
      const w = window as unknown as { __clinmeshDemoState?: { role: string; text: string }; __clinmeshSyncHud?: () => void }
      if (w.__clinmeshDemoState) { w.__clinmeshDemoState.role = role; w.__clinmeshDemoState.text = label }
      w.__clinmeshSyncHud?.()
    }, { role, label })
    if (pauseMs > 0) await this.page.waitForTimeout(pauseMs)
  }

  async glideTo(locator: Locator, hoverMs = 280) {
    await expect(locator).toBeVisible()
    await locator.scrollIntoViewIfNeeded()
    await this.page.waitForTimeout(160)
    const box = await locator.boundingBox()
    if (!box) throw new Error('Target has no boundingBox')
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2)
    const steps = Math.max(8, Math.min(22, Math.round(Math.hypot(x - this.cursorX, y - this.cursorY) / 45)))
    await this.page.mouse.move(x, y, { steps })
    this.cursorX = x; this.cursorY = y
    if (hoverMs > 0) await this.page.waitForTimeout(hoverMs)
  }

  async click(locator: Locator, opts: { hoverMs?: number; afterMs?: number } = {}) {
    await this.glideTo(locator, opts.hoverMs ?? 280)
    await locator.click()
    await this.page.waitForTimeout(opts.afterMs ?? 520)
  }

  async clickAndWaitForResponse(locator: Locator, predicate: Parameters<Page['waitForResponse']>[0], opts: { hoverMs?: number; afterMs?: number } = {}) {
    await this.glideTo(locator, opts.hoverMs ?? 320)
    const [response] = await Promise.all([this.page.waitForResponse(predicate), locator.click()])
    await this.page.waitForTimeout(opts.afterMs ?? 700)
    return response
  }

  async fill(locator: Locator, value: string, opts: { instant?: boolean; charDelayMs?: number; afterMs?: number } = {}) {
    await this.glideTo(locator, 240)
    const type = await locator.evaluate(el => (el instanceof HTMLInputElement ? el.type : '')).catch(() => '')
    if (opts.instant || ['datetime-local', 'date', 'time', 'password'].includes(type)) {
      await locator.click(); await locator.fill(value)
    } else {
      await locator.click(); await locator.fill('')
      await locator.pressSequentially(value, { delay: opts.charDelayMs ?? (value.length <= 10 ? 55 : value.length <= 26 ? 35 : 22) })
    }
    await this.page.waitForTimeout(opts.afterMs ?? 460)
  }
}
```

FFmpeg 底部独立字幕带转码与合集无损拼接（Windows 下滤镜写 `01-filter.txt` 如 `[0:v]pad=1600:1080:0:0:#0b1120,ass='raw/01.ass'[v]`）：

```powershell
& ffmpeg -y -i "raw\01.raw.webm" -filter_complex_script "raw\01-filter.txt" -map "[v]" -r 30 -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart -an ".data\videos\01-门诊患者准备与挂号分诊.mp4"
& ffmpeg -y -f concat -safe 0 -i "raw\concat-list.txt" -c copy -movflags +faststart ".data\videos\00-科灵脉智完整操作导览合集.mp4"
```

## 三、实战避坑清单

1. **Toast 自动淡出竞争**：慢速驻留 `1–2s` 后 `[data-slot="toast"]` 可能正自动卸载，禁止调 `driver.click` 滑行关闭，改用 `try { await closeBtn.click({ timeout: 1500 }) } catch {}` + `await expect(toast).toHaveCount(0, { timeout: 8000 })`。
2. **批量弹窗累计计数**：同一 `BrowserContext` 多次打开住院开嘱窗会累计显示 `已成功开立 N 项`，断言用 `/^已成功开立 \d+ 项$/` 并逐项核对 `${med.display} · 待护士校对`。
3. **住院状态与按钮位置**：护士集中核对后服务端 `state === 'verified'`（非 `'active'`）；在院收预交金需先切收费员 `出院` 页签打开 `住院收退款`；护士 `术前核对` 提交按钮在页面固定底栏而非单张申请卡片内。
4. **受控病史字段与检验单位**：问诊自动提取既往史字段为 `priorMedicalHistory`，引用须匹配句号结尾的完整分句；自定义检验真值 `valueQuantity` 须带 UCUM `code`（如 `'10*3/uL'`、`'g/dL'`）。
5. **`file:///` 中文视频路径**：导览 `index.html` 的 `<video src>` 必须使用 `'./' + encodeURIComponent(fileName)`。
6. **响应监听与时间轴校准**：严禁叠加全局 `slowMo`；监听接口时用 `clickAndWaitForResponse`（先滑行悬停再挂 `waitForResponse`）；`BrowserContext` 视频在 `context.close()` 后再转码并用解码画面校准片头起点。
7. **在院主操作与 DRG 四要素**：术后先在「病案」页勾选主操作（如 `36.0700`）保存更新预分组，再回「DRG 预分组」重算，同时核验分组状态、病组码（`FM39`）、支付参考与实际费用。
8. **折叠面板展开后的视口折线（Fold）校验**：展开 `<details>` 后对**内容体本身**（而非 `<summary>`）执行 `scrollIntoView({ behavior: 'smooth', block: 'center' })` 并用 `boundingBox()` 断言落在 `y ∈ [60, 940]` 可视安全区内，转码后按关键时间戳抽帧复核。
9. **长时限与像素红线**：`1x` 住院全程约 `22–25` 分钟，录制专用 `timeout` 设为 `1_800_000`；局部补录须在画面标注「新版流程补录」并在 `manifest.json` 记录新旧 commit；全程拦截 `/api/his/v1/imaging-studies` 与 `/api/his/v1/pathology-slides` 断言 `pixelRequests === 0`。

重录指令示例：`请参考 docs/memory/video-walkthrough.md 和 docs/memory/browser-evidence.md，按 1x 人眼节奏（1600×1000、平滑光标与波纹、底部防遮挡字幕、阅读停顿）重录 .data/videos 下的中文 .mp4 导览视频并更新索引。`
