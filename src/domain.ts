export type ProviderId = 'ggcb' | 'council' | 'playfootball';
export type Availability = 'AVAILABLE' | 'BOOKED' | 'UNAVAILABLE' | 'UNKNOWN' | 'NEARBY';
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
export interface Policy { dateFrom: string; dateTo: string; timezone: string; intervalMinutes: number; autoHold: false; }
export interface Observation { resourceId: string; date: string; start: string; duration: number | null; availability: Availability; price: string | null; note: string; bookingUrl?:string; priceNote?:string; }
export interface Coverage { date: string; status: 'READ' | 'UNKNOWN' | 'OUTSIDE_RELEASE_WINDOW'; note: string; }
export interface ScanResult {
  observations: Observation[]; coverage: Coverage[]; summary: string;
  status: 'OK' | 'PARTIAL' | 'LOGIN_REQUIRED' | 'ERROR'; navigation?: string;
  form?: { stage:'ADDRESS'; manualEnabled:boolean; manualVisible:boolean; manualComplete:boolean; addressPickerVisible:boolean; actions:Array<{label:string;inViewport:boolean}> };
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
export function initialPolicy(): Policy {
  const dateFrom = londonDate();
  const d = new Date(`${dateFrom}T12:00:00Z`); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 3); d.setUTCDate(0);
  const maxDay = d.getUTCDate(); d.setUTCDate(Math.min(day, maxDay));
  return { dateFrom, dateTo: d.toISOString().slice(0, 10), timezone: 'Europe/London', intervalMinutes: 15, autoHold: false };
}
export function isCandidate(item: Observation): boolean {
  return item.availability === 'AVAILABLE' && item.start === '18:00' && item.duration !== null && item.duration >= 55 && item.duration <= 60;
}
export function weekStart(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return addDays(date, -((day + 6) % 7));
}
