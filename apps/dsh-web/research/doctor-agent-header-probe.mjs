import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Tools from '@deepseek-ai/dsh-tools'

async function scenario(duplicate = false, retry = false, delayedPre = false) {
 const ctx = new Context()
 const snapshots = []
 const nativeCalls = []
 const sourceCalls = new Map()
 const requests = []
 let registration = []
 let release
 const bothStarted = new Promise(resolve => { release = resolve })
 let entered = 0
 let isManual = false
 try {
  for (const plugin of [Sessions, SessionProjections, Llm, TokenMeter, Tools, SystemPrompt, Agents]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  function publish(binding) {
   for (const dispose of registration) dispose()
   registration = ['probe_one', 'probe_two'].map(name => ctx.tools.register({
    name, description: 'Synthetic request-header probe',
    parameters: { type: 'object', properties: { anchor: { type: 'string', const: binding } }, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute: async () => { if (!isManual) { entered++; if (entered === 2) release(); await bothStarted } return { executed: true } },
   }))
  }
  publish('A')
  if (delayedPre) ctx.on('tools/pre-execute', async (_execution, next) => { await setImmediate(); return next() })
  ctx.on('session/event', (session, event) => { if (event.type === 'tool/call') { nativeCalls.push({session: session.id, id: event.data.callId, name: event.data.name}); sourceCalls.set(session.id + ':' + event.data.callId + ':' + event.data.name, { header:session.requestHeader(), arguments:JSON.parse(event.data.arguments) }) } })
  ctx.on('tools/pre-execute', async (execution, next) => {
   const sourceKey = execution.agent.session.id + ':' + execution.callId + ':' + execution.name
   const source = sourceCalls.get(sourceKey)
   sourceCalls.delete(sourceKey)
   const header = execution.agent.session.requestHeader()
   const received = header?.tools?.find(tool => tool.name === execution.name)?.parameters.properties.anchor.const
   const current = ctx.tools.get(execution.name, execution.agent)?.parameters.properties.anchor.const
   snapshots.push({id:execution.callId, received, current, frozen:Object.isFrozen(header), manual:isManual,
     emittedCall: source !== undefined, sourceHeader:source?.header.tools[0].parameters.properties.anchor.const,
     argumentsMatch:source === undefined ? false : JSON.stringify(source.arguments) === JSON.stringify(execution.arguments)})
   return next()
  })
  class Model extends LlmAdapter {
   async resolveModel(provider, model) { return { provider, id:model, name:model } }
   async *stream(request) {
    const index = requests.push(request) - 1
    if (index === 0) {
     publish('B')
     if (retry) { yield { type:'finish', reason:{kind:'error',failure:{code:'SYNTHETIC',message:'probe retry'}} }; return }
    }
    if (index === (retry ? 1 : 0)) {
     for (const [offset, name] of ['probe_one', 'probe_two'].entries()) {
      yield { type:'block-start', index:offset, blockType:'tool-call' }
      yield { type:'block-end', index:offset, block:{ type:'tool-call',id:ToolCallId(duplicate ? 'repeated' : 'call-' + offset),name,arguments:'{}' } }
     }
     yield {type:'finish',reason:{kind:'tool-calls'}}
    } else yield {type:'finish',reason:{kind:'stop'}}
   }
  }
  if (retry) ctx.on('agent/request-error', async () => ({kind:'retry'}))
  ctx.llm.registerAdapter(['scripted'], new Model())
  const { agent } = await ctx.agents.create({sessionId:SessionId('header-probe-' + duplicate + '-' + retry),agentOptions:{provider:'scripted',model:'probe'}})
  agent.followup(createUserMessage({content:[{type:'text',text:'Synthetic header probe'}],source:{kind:'user'}}))
  await agent.whenIdle()
  assert.equal(snapshots.length,2)
  for (const snapshot of snapshots) { assert.equal(snapshot.received,'A'); assert.equal(snapshot.current,'B'); assert.equal(snapshot.frozen,true); assert.equal(snapshot.emittedCall,true); assert.equal(snapshot.sourceHeader,'A'); assert.equal(snapshot.argumentsMatch,true) }
  assert.equal(requests.at(-1).tools[0].parameters.properties.anchor.const,'B')
  const beforeManual = nativeCalls.length
  isManual = true
  await ctx.tools.execute({callId:ToolCallId('manual-id'),name:'probe_one',arguments:{},agent,signal:new AbortController().signal})
  assert.equal(nativeCalls.length,beforeManual)
  assert.equal(snapshots.at(-1).received,'B')
  assert.equal(snapshots.at(-1).emittedCall,false)
  let duplicateAgentRejected = false
  try { await ctx.agents.create({sessionId:agent.session.id,agentOptions:{provider:"scripted",model:"probe"}}) } catch { duplicateAgentRejected = true }
  assert.equal(duplicateAgentRejected,true)
  console.log(JSON.stringify({duplicate,retry,delayedPre,requests:requests.length,snapshots,duplicateAgentRejected}))
 } finally { await ctx.fiber.dispose() }
}
await scenario()
await scenario(false, true)
await scenario(true)

await scenario(false, false, true)
