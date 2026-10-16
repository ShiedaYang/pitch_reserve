import type { Page } from 'playwright';
import type { ProviderSession } from './browser.ts';

// Council's wizard belongs to the user until its contact/eligibility steps are
// complete. Reuse the foreground booking tab instead of navigating a second one.
export async function councilUserPage(session: ProviderSession): Promise<Page | undefined> {
  if (session.id !== 'council') return;
  const pages = session.context?.pages().filter(page => {
    if (page.isClosed()) return false;
    const url = new URL(page.url());
    return url.hostname === 'towerhamlets-self.achieveservice.com' && (/\/(?:en\/)?service\/Book_a_sports_pitch\/?$/.test(url.pathname) || /^\/(?:en\/)?AchieveForms\/?$/.test(url.pathname));
  }) || [];
  const ranked = [];
  for (const page of pages) {
    let progress = 0;
    for (const frame of page.frames()) {
      const score = await frame.evaluate(()=> {
        const visible=(el:Element)=>el.getClientRects().length>0 && getComputedStyle(el).visibility!=='hidden';
        const shown=(selector:string)=>Array.from(document.querySelectorAll(selector)).some(visible);
        if (shown('[role=grid],.ui-datepicker,.fc') || Array.from(document.querySelectorAll('h1,h2,h3')).some(el=>visible(el) && (el.textContent||'').trim()==='Booking a pitch')) return 40;
        if (shown('#manual_addressLine1')) return 30;
        if (shown('#addressSelector')) return 20;
        if (Array.from(document.querySelectorAll('h1,h2,h3')).some(el=>visible(el) && /^(Your details|Book pitch)$/.test((el.textContent||'').trim()))) return 10;
        return 0;
      }).catch(()=>0);
      progress=Math.max(progress,score);
    }
    const foreground=await page.evaluate(()=>document.visibilityState==='visible').catch(()=>false);
    ranked.push({page,progress,foreground});
  }
  ranked.sort((a,b)=>b.progress-a.progress || Number(b.foreground)-Number(a.foreground));
  if (ranked[0]?.progress) { session.manualPage=ranked[0].page; return session.manualPage; }
  if (session.manualPage && !session.manualPage.isClosed()) return session.manualPage;
  return pages[0];
}
