import { insuranceStateSchema } from '@clinmesh/contracts/insurance'
import { expect, test } from './fixtures.ts'
import { expectBillingFits, readBill, signInCashier, startBillingBrowserServer, submitPayment } from './billing-payments.fixture.ts'

for(const [plan,option,patientFen] of [['employee-v1','合成职工 v1',1216],['resident-v1','合成居民 v1',4740]] as const){
  test(`reviews ${plan} benefits, recovers the original lost confirmation, compensates and collects only patient funds`,async({page,webRoot})=>{
    test.setTimeout(180000)
    const server=await startBillingBrowserServer(webRoot)
    const path=`/api/his/v1/insurance/outpatient/${server.caseId}`
    try{
      await signInCashier(page,server)
      const panel=page.getByRole('region',{name:'患者医保待遇',exact:true})
      await panel.getByRole('button',{name:'患者医保待遇（合成）',exact:true}).click()
      await panel.getByLabel('固定合成方案',{exact:true}).click()
      await page.getByRole('option',{name:option,exact:true}).click()
      await panel.getByRole('button',{name:'预览医保待遇',exact:true}).click()
      await expectBillingFits(page)
      await panel.getByRole('button',{name:'审阅医保结算',exact:true}).click()
      const review=page.getByRole('alertdialog',{name:'确认医保结算',exact:true})
      await expect(review).toContainText('患者现金应付')
      expect((await readBill(page,server)).payments).toEqual([])
      let submitted=0
      await page.route(`**${path}/confirm`,async route=>{
        submitted+=1
        const response=await route.fetch()
        expect(response.status()).toBe(200)
        await route.abort('failed')
      })
      await review.getByRole('button',{name:'提交医保结算',exact:true}).click()
      await expect(review.getByRole('button',{name:'返回核对',exact:true})).toBeEnabled()
      await review.getByRole('button',{name:'返回核对',exact:true}).click()
      await expect(panel.getByRole('button',{name:'恢复原医保操作',exact:true})).toBeVisible()
      await page.reload()
      await panel.getByRole('button',{name:'患者医保待遇（合成）',exact:true}).click()
      await panel.getByRole('button',{name:'恢复原医保操作',exact:true}).click()
      await expect(panel.getByRole('button',{name:'恢复原医保操作',exact:true})).toHaveCount(0)
      expect(submitted).toBe(1)
      await page.unroute(`**${path}/confirm`)
      expect((await readBill(page,server)).charges.find(item=>item.chargeItemId===server.chargeItemId)).toMatchObject({paidFen:0,remainingFen:patientFen})
      await panel.getByRole('button',{name:'撤销原待遇',exact:true}).click()
      const cancel=page.getByRole('alertdialog',{name:'确认撤销医保',exact:true})
      await expect(cancel).toContainText('基金支付')
      await cancel.getByRole('button',{name:'提交撤销',exact:true}).click()
      await expect(cancel).toHaveCount(0)
      const state=insuranceStateSchema.parse(await(await page.request.get(server.origin+path)).json())
      expect(state.history).toHaveLength(2)
      expect(state.history[1]?.reversesId).toBe(state.history[0]?.id)
      expect(state.balance.outpatientFundFen).toBe(0)
      await panel.getByRole('button',{name:'预览医保待遇',exact:true}).click()
      await panel.getByRole('button',{name:'审阅医保结算',exact:true}).click()
      await review.getByRole('button',{name:'提交医保结算',exact:true}).click()
      await expect(review).toHaveCount(0)
      const paid=await submitPayment(page)
      expect(paid.amountFen).toBe(patientFen)
      const bill=await readBill(page,server)
      expect(bill.charges.find(item=>item.chargeItemId===server.chargeItemId)).toMatchObject({amountFen:6800,paidFen:patientFen,remainingFen:0})
      expect(bill.payments).toHaveLength(1)
    }finally{await server.close()}
  })
}
