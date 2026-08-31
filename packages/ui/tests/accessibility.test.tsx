// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../src/components/alert-dialog.tsx'
import { Button } from '../src/components/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '../src/components/dialog.tsx'
import { Spinner } from '../src/components/spinner.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../src/components/tabs.tsx'

describe('UI accessibility contracts', () => {
  afterEach(cleanup)

  it('announces an inline loading indicator as status', () => {
    render(<Spinner aria-label="正在提交" />)

    expect(screen.getByRole('status', { name: '正在提交' })).toBeTruthy()
  })

  it('moves tab focus with arrow keys and activates the focused panel on Enter', async () => {
    const user = userEvent.setup()
    render(
      <Tabs defaultValue="record">
        <TabsList aria-label="临床视图">
          <TabsTrigger value="record">病历</TabsTrigger>
          <TabsTrigger value="orders">医嘱</TabsTrigger>
        </TabsList>
        <TabsContent value="record">病历内容</TabsContent>
        <TabsContent value="orders">医嘱内容</TabsContent>
      </Tabs>,
    )

    const recordTab = screen.getByRole('tab', { name: '病历' })
    const ordersTab = screen.getByRole('tab', { name: '医嘱' })
    recordTab.focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(ordersTab)

    await user.keyboard('{Enter}')
    expect(ordersTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: '医嘱' }).textContent).toBe('医嘱内容')
  })

  it('names an alert dialog and restores focus when it is cancelled', async () => {
    const user = userEvent.setup()
    render(
      <AlertDialog>
        <AlertDialogTrigger render={<Button type="button" />}>删除草稿</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>确认删除草稿</AlertDialogTitle>
          <AlertDialogDescription>草稿删除后无法恢复。</AlertDialogDescription>
          <AlertDialogCancel>取消</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>,
    )

    const trigger = screen.getByRole('button', { name: '删除草稿' })
    await user.click(trigger)
    expect(await screen.findByRole('alertdialog', { name: '确认删除草稿' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(trigger)
  })

  it('names a browsing dialog and restores focus when it is closed', async () => {
    const user = userEvent.setup()
    render(
      <Dialog>
        <DialogTrigger render={<Button type="button" />}>选择诊断</DialogTrigger>
        <DialogContent>
          <DialogTitle>疾病目录</DialogTitle>
          <DialogDescription>当前发布目录</DialogDescription>
          <DialogClose render={<Button type="button" />}>取消</DialogClose>
        </DialogContent>
      </Dialog>,
    )

    const trigger = screen.getByRole('button', { name: '选择诊断' })
    await user.click(trigger)
    expect(await screen.findByRole('dialog', { name: '疾病目录' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(trigger)
  })
})
