// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DataGenerationLabPage } from './data-generation-lab-page.tsx'

describe('合成患者库 UI Lab', () => {
  afterEach(cleanup)

  it('可在五种页面候选之间切换', async () => {
    const user = userEvent.setup()
    render(<DataGenerationLabPage />)

    const candidateGroup = screen.getByRole('group', { name: '数据生成页面候选' })
    expect(within(candidateGroup).getAllByRole('button')).toHaveLength(5)

    await user.click(within(candidateGroup).getByRole('button', { name: 'D · 候诊运营台' }))

    expect(screen.getByRole('heading', { name: '患者就诊准备度' })).toBeTruthy()
  })

  it('健康档案不重复展示就诊历史', async () => {
    const user = userEvent.setup()
    render(<DataGenerationLabPage />)

    expect(screen.queryByRole('heading', { name: '纵向健康记录' })).toBeNull()

    await user.click(screen.getByRole('tab', { name: '就诊历史' }))

    expect(screen.getByRole('tab', { name: '就诊历史' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByText('2026-06-18').length).toBeGreaterThan(0)
  })

  it('生成患者时默认选择 Synthea 且单批最多十人', async () => {
    const user = userEvent.setup()
    render(<DataGenerationLabPage />)

    await user.click(screen.getByRole('button', { name: '生成患者' }))

    const generationSheet = screen.getByRole('dialog', { name: '生成合成患者' })
    expect(within(generationSheet).getByRole('button', { name: /Synthea 完整病史/ }).getAttribute('aria-pressed')).toBe('true')
    expect(within(generationSheet).getByRole('spinbutton', { name: '患者人数' }).getAttribute('max')).toBe('10')
  })

  it('可从患者档案发起门诊就诊', async () => {
    const user = userEvent.setup()
    render(<DataGenerationLabPage />)

    await user.click(screen.getByRole('button', { name: '发起门诊就诊' }))

    expect(screen.getByRole('dialog', { name: '发起门诊就诊' })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认发起就诊' }).disabled).toBe(false)
  })

  it('可批量发起所选患者的门诊就诊', async () => {
    const user = userEvent.setup()
    render(<DataGenerationLabPage />)

    const candidateGroup = screen.getByRole('group', { name: '数据生成页面候选' })
    await user.click(within(candidateGroup).getByRole('button', { name: 'B · 患者注册簿' }))
    await user.click(screen.getByRole('checkbox', { name: '选择 张伟' }))
    await user.click(screen.getByRole('checkbox', { name: '选择 李静' }))
    await user.click(screen.getByRole('button', { name: '批量发起 2' }))

    const queueSheet = screen.getByRole('dialog', { name: '批量发起门诊就诊' })
    expect(within(queueSheet).getByText('已选择 2 名患者')).toBeTruthy()
  })
})
