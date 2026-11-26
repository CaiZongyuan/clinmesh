import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { AgentGlowRegion, AgentPanelShell, AlertDialog, Badge, Button, Card, Checkbox, Dialog, Field, IconButton, InlineConfirmBar, Input, Menu,
  NumberInput, Select, Switch, Table, Tabs, Textarea, themeTokens, useThemeFont, useToast, WorkspaceCardLayout } from '../packages/ui-kit';
import logo from '../../assets/logo.webp';

function DisplaySettings() {
  const { theme, fontScale, update } = useThemeFont();
  return <div className="catalog-settings">
    <h2>Display settings</h2>
    <Field label="Color scheme"><Select value={theme} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
      onValueChange={value => { if (value) update({ theme: value }); }} /></Field>
    <Field label="Font scale"><Select value={fontScale} options={[{ value: 'standard', label: 'Standard · 100%' }, { value: 'larger', label: 'Larger · 112.5%' }, { value: 'large', label: 'Large · 125%' }]}
      onValueChange={value => { if (value) update({ fontScale: value }); }} /></Field>
    <p>These preferences are saved on this device.</p>
  </div>;
}

function Examples() {
  const toast = useToast();
  const [activity, setActivity] = useState(true);
  const [draft, setDraft] = useState(true);
  const [title, setTitle] = useState('Example note');
  const [result, setResult] = useState('Draft');
  return <>
    <section className="catalog-section" aria-label="Form controls">
      <h2>Form controls</h2>
      <div className="catalog-fields">
        <Field label="Example title"><Input value={title} onValueChange={setTitle} /></Field>
        <Field label="Priority"><Select defaultValue="routine" options={[{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }]} /></Field>
        <Field label="Quantity"><NumberInput min={1} max={20} defaultValue={2} /></Field>
        <Field label="Example secret" description="Write-only to agents. Use dummy text."><Input type="password" data-agent-secret autoComplete="off" /></Field>
        <div className="catalog-wide"><Field label="Draft text"><Textarea placeholder="Type a sample note" rows={2} /></Field></div>
      </div>
    </section>
    <section className="catalog-section" aria-label="Agent presentation">
      <h2>Agent presentation</h2>
      <div className="catalog-columns">
        <AgentPanelShell title="Assistant panel" status={<Badge tone="info">Preview</Badge>}>
          <div className="catalog-settings"><Switch label="Show agent activity" checked={activity} onCheckedChange={setActivity} />
            <Checkbox label="Mark as agent draft" checked={draft} onCheckedChange={checked => setDraft(checked === true)} /></div>
        </AgentPanelShell>
        <AgentGlowRegion active={activity} draft={draft}>
          <div className="cm-section-heading"><h3>{title || 'Untitled example'}</h3><Badge tone={draft ? 'info' : 'neutral'}>{draft ? 'Agent draft' : 'Manual'}</Badge></div>
          <p>{activity ? 'Agent activity is visible.' : 'Agent activity is idle.'}</p>
        </AgentGlowRegion>
      </div>
    </section>
    <section className="catalog-section" aria-label="Actions and feedback">
      <h2>Actions and feedback</h2>
      <div className="cm-actions">
        <Button onClick={() => toast('Example notification', { description: 'The preview is ready.' })}>Show notification</Button>
        <Dialog triggers={['Open compact preview', 'Open detailed preview']} title="Component preview" close="Dismiss preview"><p>Both triggers open this named dialog.</p></Dialog>
        <Menu label="Example actions" items={[{ value: 'duplicate', label: 'Duplicate sample' }]} onAction={() => toast('Example duplicated')} />
        <AlertDialog title="Clear the example?" trigger="Review removal" confirmation="Clear this local sample title?" confirm="Clear title" cancel="Keep title" onConfirm={() => setTitle('')} />
      </div>
      <Card aria-label="Inline confirmation example"><div className="cm-section-heading"><h3>Inline confirmation</h3><Badge tone={result === 'Draft' ? 'neutral' : 'success'}>{result}</Badge></div>
        <InlineConfirmBar trigger="Review sample" confirmation="Mark this example as signed?" cancel="Keep draft" confirm="Sign sample" onConfirm={() => setResult('Signed')} />
      </Card>
    </section>
    <section className="catalog-section" aria-label="Data presentation">
      <h2>Data presentation</h2>
      <Tabs label="Reference views" items={[
        { value: 'states', label: 'Status badges', content: <div className="cm-actions"><Badge>Neutral</Badge><Badge tone="info">Information</Badge><Badge tone="success">Success</Badge><Badge tone="warning">Warning</Badge><Badge tone="destructive">Critical</Badge></div> },
        { value: 'table', label: 'Reference table', content: <Table caption="Control dimensions"><thead><tr><th scope="col">Element</th><th scope="col">Size</th></tr></thead>
          <tbody><tr><th scope="row">Top bar height</th><td>48 px</td></tr><tr><th scope="row">Control radius</th><td>6 px</td></tr><tr><th scope="row">Surface radius</th><td>8 px</td></tr></tbody></Table> },
      ]} />
    </section>
  </>;
}

export default function UiKitCatalog() {
  const [revision, reset] = useState(0);
  return <WorkspaceCardLayout header={<><img src={logo} width={26} height={26} alt="" /><strong>ClinMesh</strong><span className="catalog-product">Developer tools</span></>}
    queueLabel="Display preferences" queue={<DisplaySettings />}>
    <div className="cm-section-heading"><div><h1>UI component catalogue</h1><p>Theme contract v{themeTokens.version}</p></div>
      <IconButton label="Reset examples" onClick={() => reset(previous => previous + 1)}><RotateCcw size={16} aria-hidden /></IconButton></div>
    <Examples key={revision} />
  </WorkspaceCardLayout>;
}
