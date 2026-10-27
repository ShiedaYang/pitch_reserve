export type ProviderId = 'ggcb' | 'council' | 'playfootball';
export type Availability = 'AVAILABLE' | 'BOOKED' | 'UNAVAILABLE' | 'UNKNOWN';
export interface Resource { id: string; provider: ProviderId; name: string; format: string; url: string; }
export const resources: Resource[] = [
  { id: 'ggcb-half', provider: 'ggcb', name: 'GGCB', format: '6v6 · 半场 · 55分钟', url: 'https://ggcb.co.uk/booking/6-a-side-3g-half-pitch/' },
  { id: 'stepney-third', provider: 'council', name: 'Stepney Green', format: '三分之一场', url: 'https://towerhamlets-self.achieveservice.com/service/Book_a_sports_pitch' },
  { id: 'westferry-5', provider: 'playfootball', name: 'Westferry', format: '普通5v5 · 产品85', url: 'https://www.playfootball.net/venues/canary-wharf/book-a-pitch/85/5-a-Side3GPitchHire' },
  { id: 'poplar-7', provider: 'playfootball', name: 'Poplar', format: '普通7v7 · 产品88', url: 'https://www.playfootball.net/venues/canary-wharf-poplar/book-a-pitch/88/7-a-Side3GPitchHire' }
];
export const providerIds: ProviderId[] = ['ggcb', 'council', 'playfootball'];
export const loginUrls: Record<ProviderId, string> = {
  ggcb: 'https://ggcb.co.uk/my-account/',
  council: 'https://towerhamlets-self.achieveservice.com/login?return_url=%2FRenderAchieveForms&lang=en&appName=Self',
  playfootball: 'https://partners.playfootball.net/Login'
};
export const lookaheads = ['7d', '14d', '1m', '2m', '3m'] as const;
export type Lookahead = typeof lookaheads[number];
export interface Policy { dateFrom: string; dateTo: string; timezone: string; intervalMinutes: number; autoHold: false; lookahead?: Lookahead | null; }
export interface Observation { resourceId: string; date: string; start: string; duration: number | null; availability: Availability; price: string | null; note: string; bookingUrl?:string; priceNote?:string; }
export interface Coverage { date: string; status: 'READ' | 'UNKNOWN' | 'OUTSIDE_RELEASE_WINDOW' | 'ERROR'; note: string; }
export interface ScanResult {
  observations: Observation[]; coverage: Coverage[]; summary: string;
  status: 'OK' | 'PARTIAL' | 'LOGIN_REQUIRED' | 'ERROR'; navigation?: string;
  form?: { stage:'ADDRESS'; manualEnabled:boolean; manualVisible:boolean; manualComplete:boolean; addressPickerVisible:boolean; actions:Array<{label:string;inViewport:boolean}> };
}
// Compatibility for observations saved by the earlier nearby-inventory parser.
export function normalizeScanResult(result: ScanResult): ScanResult {
  return {...result,observations:result.observations.map(item=>String(item.availability)==='NEARBY'
    ? {...item,availability:'UNAVAILABLE',price:null,duration:null,note:'该场地该时段无可订场次'} : item)};
}
export type SessionStatus = 'UNKNOWN' | 'ANONYMOUS_READABLE' | 'AUTHENTICATED' | 'LOGIN_REQUIRED';
export type Mode = 'AUTOMATION' | 'MANUAL_CONTROL' | 'PAUSED';
export function londonDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(date: string, count: number): string {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10);
}
export function targetDates(policy: Policy, today = londonDate(), now = new Date()): string[] {
  const result: string[] = [];
  const time = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hour12:false }).format(now);
  for (let day = policy.dateFrom > today ? policy.dateFrom : today; day <= policy.dateTo; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 4 && !(day === londonDate(now) && time >= '18:00')) result.push(day);
  }
  return result;
}
export function lookaheadEnd(today: string, lookahead: Lookahead): string {
  if (lookahead === '7d' || lookahead === '14d') return addDays(today, lookahead === '7d' ? 7 : 14);
  const d = new Date(`${today}T12:00:00Z`); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + Number(lookahead[0]));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay)); return d.toISOString().slice(0, 10);
}
export function resolvePolicy(policy: Policy, now = new Date()): Policy {
  if (!policy.lookahead) return { ...policy, autoHold: false };
  const dateFrom = addDays(londonDate(now), 1);
  return { ...policy, dateFrom, dateTo: lookaheadEnd(dateFrom, policy.lookahead), timezone: 'Europe/London', autoHold: false };
}
export function initialPolicy(now = new Date()): Policy {
  return resolvePolicy({ dateFrom: londonDate(now), dateTo: londonDate(now), lookahead: '2m', timezone: 'Europe/London', intervalMinutes: 15, autoHold: false }, now);
}
export function isCandidate(item: Observation): boolean {
  return item.availability === 'AVAILABLE' && item.start === '18:00' && item.duration !== null && item.duration >= 55 && item.duration <= 60;
}
export function weekStart(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return addDays(date, -((day + 6) % 7));
}
