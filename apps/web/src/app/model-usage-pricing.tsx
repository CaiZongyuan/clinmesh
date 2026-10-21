import type { ModelPricingConfig } from '@clinmesh/contracts/model-pricing'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Empty, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { modelUsageMessages } from './model-usage-i18n.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function ModelUsagePricing({ data, locale }: { data: ModelPricingConfig; locale: WorkspaceLocale }) {
  const messages = modelUsageMessages(locale)
  const format = (value: number | undefined) => value === undefined ? messages.notReturned
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value)
  return <Card className="min-w-0"><CardHeader><CardTitle>{messages.pricing}</CardTitle><CardDescription>{messages.priceDescription}</CardDescription></CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-4"><p>{messages.priceDetails}</p>
      {data.prices.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{messages.noPrices}</EmptyTitle></EmptyHeader></Empty> :
        <Table aria-label={messages.pricing}><TableHeader><TableRow>
          {[messages.provider, messages.model, messages.priceVersion, messages.currency, messages.inputTokens, messages.outputTokens,
            messages.rawCounterLabel('cacheReadTokens'), messages.rawCounterLabel('cacheWriteTokens'), messages.rawCounterLabel('reasoningTokens')]
            .map(label => <TableHead key={label}>{label}</TableHead>)}
        </TableRow></TableHeader><TableBody>{data.prices.map(price => <TableRow key={`${price.provider}:${price.model}`}>
          <TableCell>{price.provider}</TableCell><TableCell className="max-w-64 whitespace-normal break-all">{price.model}</TableCell>
          <TableCell>{price.version}</TableCell><TableCell>{price.currency}</TableCell>
          {(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const).map(key => <TableCell key={key}>{format(price.rates[key])}</TableCell>)}
        </TableRow>)}</TableBody></Table>}
      <h3 className="font-medium">{messages.rates}</h3>
      {data.exchangeRates.length === 0 ? <p>{messages.noRates}</p> : <Table aria-label={messages.rates}><TableHeader><TableRow>
        <TableHead>{messages.currency}</TableHead><TableHead>{messages.exchangeVersion}</TableHead><TableHead>CNY</TableHead>
      </TableRow></TableHeader><TableBody>{data.exchangeRates.map(rate => <TableRow key={rate.currency}>
        <TableCell>{rate.currency}</TableCell><TableCell>{rate.version}</TableCell><TableCell>{format(rate.cnyPerUnit)}</TableCell>
      </TableRow>)}</TableBody></Table>}
    </CardContent></Card>
}
