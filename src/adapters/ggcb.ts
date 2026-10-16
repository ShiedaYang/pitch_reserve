import type { Page } from 'playwright';
import { targetDates } from '../domain.ts';
import type { Coverage, Observation, Policy, Resource, ScanResult } from '../domain.ts';
import type { ProviderSession } from '../browser.ts';

export async function scanGgcb(page: Page, resource: Resource, policy: Policy, session: ProviderSession): Promise<ScanResult> {
  const form = page.locator('#wc-bookings-booking-form'); await form.waitFor();
  await page.waitForFunction(() => !!document.querySelector('td[class*="date-year-"]'));
  const waitCalendar = () => page.waitForFunction(() => !Array.from(document.querySelectorAll('#wc-bookings-booking-form .blockUI')).some(el => (el as HTMLElement).getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none'), undefined, {timeout:25000});
  const wanted = targetDates(policy); const coverage = new Map<string, Coverage>(); const observations: Observation[] = [];
  let loadingNote='';let stage='初始月历';
  try {
  await waitCalendar();
  for (let month = 0; month < 3; month++) {
    session.assertAutomatic();
    const cells = await form.locator('td[class*="date-year-"]').evaluateAll(els => els.map(el => {
      const c = el.className; const year = c.match(/date-year-(\d+)/)?.[1]; const month = c.match(/date-month-(\d+)/)?.[1]; const day = c.match(/date-date-(\d+)/)?.[1];
      return { date: year && month && day ? `${year}-${String(Number(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}` : '', bookable: el.classList.contains('bookable'), classes: c };
    }));
    for (const cell of cells.filter(x => wanted.includes(x.date) && !coverage.has(x.date))) {
      session.assertAutomatic();
      if (!cell.bookable) { coverage.set(cell.date, { date: cell.date, status: 'UNKNOWN', note: '日期不可选择；尚未区分未放号与售罄' }); continue; }
      const d = new Date(`${cell.date}T12:00:00Z`);
      const dateLink = form.locator(`td.date-year-${d.getUTCFullYear()}.date-month-${d.getUTCMonth()}.date-date-${d.getUTCDate()} a`);
      if (await dateLink.count() !== 1 || !await dateLink.isVisible()) {
        coverage.set(cell.date, { date: cell.date, status: 'UNKNOWN', note: '日期标记可订但缺少可见选择按钮' }); continue;
      }
      const response = page.waitForResponse(res => {
        const u = new URL(res.url()); return u.hostname === 'ggcb.co.uk' && /wc-ajax|admin-ajax/.test(u.href) && ['xhr','fetch'].includes(res.request().resourceType());
      }, { timeout: 12000 }).catch(() => null);
      try { await dateLink.click(); } catch {
        coverage.set(cell.date, { date: cell.date, status: 'UNKNOWN', note: '日期点击未完成，具体时段未确认' }); await response; continue;
      }
      const loaded = await response; session.assertAutomatic();
      if (!loaded || !loaded.ok()) { coverage.set(cell.date, { date: cell.date, status: 'UNKNOWN', note: '时段加载未确认，避免使用上次日期结果' }); continue; }
      stage=`${cell.date}时段查询`;await waitCalendar();
      session.assertAutomatic();
      const text = await form.innerText();
      const times = await form.locator('a').allTextContents();
      const target = times.find(t => /^18:00\b/.test(t.trim()));
      if (target) {
        observations.push({ resourceId: resource.id, date: cell.date, start: '18:00', duration: 55, price: null, availability: 'AVAILABLE', note: '55分钟；是否接受待确认；未选择时间块，价格尚未核实' });
        coverage.set(cell.date, { date: cell.date, status: 'READ', note: '已加载具体18:00可选时间块，未选场' });
      } else if (/No blocks available/i.test(text)) {
        coverage.set(cell.date, { date: cell.date, status: 'UNKNOWN', note: '日期概览可订，但返回No blocks available；需复核' });
      } else if (times.some(t => /\b\d{2}:\d{2}\b/.test(t))) {
        observations.push({ resourceId: resource.id, date: cell.date, start: '18:00', duration: 55, price: null, availability: 'BOOKED', note: '已加载可选时间列表，其中没有18:00；未付款' });
        coverage.set(cell.date, { date: cell.date, status: 'READ', note: '已读取可选时间列表' });
      } else coverage.set(cell.date, { date: cell.date, status: 'UNKNOWN', note: '时段返回结构未识别' });
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    session.assertAutomatic();
    if (cells.some(x => x.date >= policy.dateTo)) break;
    const next = form.getByRole('button', { name: 'Next Month' });
    if (!await next.count() || !await next.isEnabled()) break;
    const old = await form.locator('.ui-datepicker-title').innerText();
    await next.click();
    try { await page.waitForFunction(previous => document.querySelector('.ui-datepicker-title')?.textContent !== previous, old, { timeout: 8000 }); }
    catch { break; }
    stage='翻月查询';await waitCalendar();
  }
  } catch {
    session.assertAutomatic();loadingNote=`${stage}未完成加载；保留本次已读结果，其余未确认`;
  }
  const allCoverage = wanted.map(date => coverage.get(date) || { date, status: 'UNKNOWN' as const, note: loadingNote || '未覆盖日期；可能尚未开放' });
  const read = allCoverage.filter(x => x.status === 'READ').length;
  return { observations, coverage: allCoverage, status: read === wanted.length ? 'OK' : !read && loadingNote?'ERROR':'PARTIAL', summary: `已确认 ${read}/${wanted.length} 个目标日期的时段；55分钟需明确接受，未加入购物篮。${loadingNote}` };
}
