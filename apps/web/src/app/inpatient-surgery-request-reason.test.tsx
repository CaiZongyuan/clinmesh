// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { SurgeryRequestReason } from './inpatient-surgery-request-reason.tsx'
const session: SessionContext = { user: { id: 'doctor', name: '医生', email: 'doctor@demo.clinmesh.local' }, actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, availableRoles: [] }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })
function mount() {
 const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}}); clients.push(client)
 function Harness() { const [reason,setReason] = useState(''); return <SurgeryRequestReason admissionId="admission-1" session={session} open locale="zh-CN" value={reason} onChange={setReason} id="request-reason" disabled={false} /> }
 render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
}
it('已有助手草稿自动填入同一输入框并标来源，医生仍可编辑', async () => {
 vi.stubGlobal('fetch',vi.fn(async () => Response.json({admissionId:'admission-1',taskId:'task-1',fingerprint:'a'.repeat(64),status:'succeeded',reason:'已核对主诊断及冠脉造影报告',failureCode:null})))
 mount()
 await waitFor(() => expect((screen.getByRole('textbox',{name:'手术申请理由'}) as HTMLInputElement).value).toBe('已核对主诊断及冠脉造影报告'))
 expect(screen.getByText('助手')).toBeDefined()
 await userEvent.setup().type(screen.getByRole('textbox',{name:'手术申请理由'}),'，医生补充')
 expect(screen.queryByText('助手')).toBeNull()
 expect((screen.getByRole('textbox',{name:'手术申请理由'}) as HTMLInputElement).value).toContain('医生补充')
})
it.each(['unavailable', 'failed', 'blocked', 'unknown'] as const)('%s 时输入保持为空且允许手填', async status => {
 vi.stubGlobal('fetch', vi.fn(async () => Response.json({admissionId:'admission-1',taskId:null,fingerprint:null,status,reason:null,failureCode:null})))
 mount()
 await waitFor(() => expect(fetch).toHaveBeenCalled())
 const input=screen.getByRole('textbox',{name:'手术申请理由'})
 expect((input as HTMLInputElement).value).toBe('')
 await userEvent.setup().type(input,'医生手填申请理由')
 expect((input as HTMLInputElement).value).toBe('医生手填申请理由')
 expect(screen.queryByText('助手')).toBeNull()
})
it('模型迟到不覆盖医生输入，医生清空后也不重新填回', async () => {
 let release!:()=>void
 const gate = new Promise<void>(resolve=>{release=resolve})
 vi.stubGlobal('fetch', vi.fn(async () => {await gate;return Response.json({admissionId:'admission-1',taskId:'task-1',fingerprint:'a'.repeat(64),status:'succeeded',reason:'迟到草稿',failureCode:null})}))
 mount()
 const user=userEvent.setup(),input=screen.getByRole('textbox',{name:'手术申请理由'})
 await user.type(input,'医生已编辑')
 release()
 await waitFor(()=>expect(fetch).toHaveBeenCalled())
 await user.clear(input)
 await waitFor(()=>expect((input as HTMLInputElement).value).toBe(''))
 expect(screen.queryByText('助手')).toBeNull()
})
it('只有可起草状态才请求一次，返回草稿后填入理由', async () => {
 const state={admissionId:'admission-1',taskId:null,fingerprint:'a'.repeat(64),status:'idle',reason:null,failureCode:null}
 const posts:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async (_path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){posts.push(String(init.body));return Response.json({data:{...state,taskId:'task-1',status:'succeeded',reason:'按已确认资料起草'},auditId:'audit-1',requestId:'receipt-1',effects:[],warnings:[]})}
  return Response.json(state)
 }))
 mount()
 await waitFor(()=>expect((screen.getByRole('textbox',{name:'手术申请理由'}) as HTMLInputElement).value).toBe('按已确认资料起草'))
 expect(posts).toEqual(['{"input":{}}'])
})
it('重新打开时读取失败不把缓存的旧助手理由填入空输入', async () => {
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});clients.push(client)
 let failed=false,failures=0
 vi.stubGlobal('fetch',vi.fn(async()=>{
  if(failed){failures+=1;return Response.json({error:{code:'UNAVAILABLE',message:'合成读取失败'}},{status:503})}
  return Response.json({admissionId:'admission-1',taskId:'task-1',fingerprint:'a'.repeat(64),status:'succeeded',reason:'缓存中的旧理由',failureCode:null})
 }))
 function Harness(){const [open,setOpen]=useState(true),[reason,setReason]=useState('');return <><button onClick={()=>{setReason('');setOpen(value=>!value)}}>{open?'关闭':'重新打开'}</button>{open?<SurgeryRequestReason admissionId="admission-1" session={session} open locale="zh-CN" value={reason} onChange={setReason} id="request-reason" disabled={false}/>:null}</>}
 render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>)
 const user=userEvent.setup()
 await waitFor(()=>expect((screen.getByRole('textbox',{name:'手术申请理由'}) as HTMLInputElement).value).toBe('缓存中的旧理由'))
 await user.click(screen.getByRole('button',{name:'关闭'}));failed=true
 await user.click(screen.getByRole('button',{name:'重新打开'}))
 await waitFor(()=>expect(failures).toBeGreaterThan(0))
 expect((screen.getByRole('textbox',{name:'手术申请理由'}) as HTMLInputElement).value).toBe('')
 expect(screen.queryByText('助手')).toBeNull()
})
