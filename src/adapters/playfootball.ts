import type { Page } from 'playwright';
import { addDays, londonDate, targetDates, weekStart } from '../domain.ts';
import type { Observation, Policy, Resource, ScanResult, Coverage } from '../domain.ts';
import type { ProviderSession } from '../browser.ts';

export interface CalendarSnapshot { label: string; headers: string[]; rows: string[][]; }
const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function mapCalendar(snapshot: CalendarSnapshot, resource: Resource, reference: string): Observation[] {
  if (!snapshot.headers.length || snapshot.rows.length !== snapshot.headers.length) throw new Error('日历日期与库存行数量不一致');
  const weekdayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const range = snapshot.label.match(/(\d{1,2})(?:st|nd|rd|th)?(?:\s+[A-Za-z]+)?\s*-\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)/i);
  if (!range) throw new Error('周日期标题无法识别');
  const endMonth = monthNames.findIndex(m => m.toLowerCase() === range[3].slice(0,3).toLowerCase());
  const weekEnds: string[] = [];
  for (let offset = -7; offset <= 110; offset++) {
    const date = addDays(reference, offset); const d = new Date(`${date}T12:00:00Z`);
    if (d.getUTCMonth() === endMonth && d.getUTCDate() === Number(range[2]) && d.getUTCDay() === 0 && new Date(`${addDays(date, -6)}T12:00:00Z`).getUTCDate() === Number(range[1])) weekEnds.push(date);
  }
  if (weekEnds.length !== 1) throw new Error('周日期范围存在歧义');
  const weekStartDate = addDays(weekEnds[0], -6);
  const result: Observation[] = [];
  for (let i = 0; i < snapshot.headers.length; i++) {
    const header = snapshot.headers[i].match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*(\d{1,2})/);
    if (!header) throw new Error('日期表头无法识别');
    const candidates: string[] = [];
    for (let j = 0; j < 7; j++) {
      const date = addDays(weekStartDate, j); const d = new Date(`${date}T12:00:00Z`);
      if (d.getUTCDate() === Number(header[2]) && weekdayNames[d.getUTCDay()] === header[1]) candidates.push(date);
    }
    if (candidates.length !== 1) throw new Error(`日期映射存在歧义：${snapshot.label.trim()} / ${snapshot.headers[i]} / ${reference}`);
    const date = candidates[0];
    for (const text of snapshot.rows[i]) {
      const start = text.match(/\b(\d{2}:\d{2})\b/)?.[1]; if (start !== '18:00') continue;
      const duration = text.match(/(\d+)\s*min/i)?.[1]; const price = text.match(/£\s*\d[\d,]*(?:\.\d{2})?/)?.[0] || null;
      const availability = /Available nearby/i.test(text) ? 'NEARBY' : /Booked/i.test(text) ? 'BOOKED' : duration && price ? 'AVAILABLE' : 'UNKNOWN';
      result.push({ resourceId: resource.id, date, start, duration: duration ? Number(duration) : null, price, availability, note: availability === 'NEARBY' ? '附近其他场地，不是本场可订' : '普通单次租场页面观察；未选场或创建预订' });
    }
  }
  return result;
}
export async function readCalendar(page: Page): Promise<CalendarSnapshot> {
  return page.evaluate(() => {
    const root = document.querySelector('.bookings-calendar');
    const wrapper = root?.querySelector('.bookings-calendar-scroll-calendar-content-wrapper');
    const rows: string[][] = []; let row: string[] = [];
    for (const child of Array.from(wrapper?.children || [])) {
      if (child.classList.contains('clearfix')) { if (row.length) rows.push(row); row = []; }
      else if (child.classList.contains('booking-slot')) row.push((child as HTMLElement).innerText);
    }
    if (row.length) rows.push(row);
    return { label: (root?.querySelector('.bookings-calendar-picker') as HTMLElement)?.innerText || '',
      headers: Array.from(root?.querySelectorAll('.bookings-calendar-weekday') || []).map(el => (el as HTMLElement).innerText.replace(/\s+/g, ' ')), rows };
  });
}
export async function scanPlayFootball(page: Page, resource: Resource, policy: Policy, session: ProviderSession, dateReference?:string): Promise<ScanResult> {
  await page.locator('.booking-slot').first().waitFor({ state: 'attached' }); session.assertAutomatic();
  const reject = page.getByRole('button', { name: 'Reject optional cookies', exact: true });
  if (await reject.isVisible()) { session.assertAutomatic(); await reject.click(); }
  const reference = dateReference||londonDate();
  const wanted = targetDates(policy,reference,dateReference?new Date(`${reference}T12:00:00Z`):new Date()); const byDate = new Map<string, Observation>(); let navigation = '未尝试';
  const maxWeeks=Math.min(16,Math.max(1,Math.ceil((Date.parse(policy.dateTo)-Date.parse(reference))/604800000)+2));
  for (let week = 0; week < maxWeeks; week++) {
    session.assertAutomatic(); const snapshot = await readCalendar(page);
    for (const item of mapCalendar(snapshot, resource, reference)) if (wanted.includes(item.date)) byDate.set(item.date, item);
    const observedEnd = Array.from(byDate.keys()).sort().at(-1);
    if (observedEnd && observedEnd >= wanted.at(-1)!) break;
    if(week===maxWeeks-1){navigation='已达本轮安全翻页上限，剩余日期待下轮检查';break;}
    const next = page.locator('.bookings-calendar-date > button').filter({ has: page.locator('[data-icon="chevron-right"]') });
    if (await next.count() !== 1 || !await next.isEnabled()) { navigation = week ? '已翻周，已到当前导航边界' : '下一周按钮不可用'; break; }
    session.assertAutomatic(); await next.click();
    try {
      await page.waitForFunction(old => {
        const label = (document.querySelector('.bookings-calendar-picker') as HTMLElement)?.innerText;
        return !!label && label !== old && !!document.querySelector('.booking-slot');
      }, snapshot.label, { timeout: 15000 });
      // The week title and the actual day rows must both change before accepting inventory.
      await page.waitForFunction(old => Array.from(document.querySelectorAll('.bookings-calendar-weekday')).map(x => (x as HTMLElement).innerText.replace(/\s+/g, ' ')).join('|') !== old,
        snapshot.headers.join('|'), { timeout: 10000 });
      navigation = '翻周成功';
    } catch { navigation = '翻周未完成；未把原周库存套用到新日期'; break; }
  }
  const coverage: Coverage[] = wanted.map(date => byDate.has(date) ? { date, status: 'READ', note: '已读取18:00具体时间块' } : { date, status: 'UNKNOWN', note: '未扫描到该日期；未开放与翻页失败尚未区分' });
  const complete = coverage.every(x => x.status === 'READ');
  return { observations: [...byDate.values()], coverage, status: complete ? 'OK' : 'PARTIAL', navigation,
    summary: `已读取 ${byDate.size}/${wanted.length} 个目标日期；${navigation}。仅监测，未点击具体可订场次。` };
}
