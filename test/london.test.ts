import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { londonTime, isLondonHour, inLondonSlot, previousWorkday, isWeekday, shortDay } from '../src/lib/london';
import { JOB_DEFS } from '../src/lib/job-defs';

describe('Europe/London guard', () => {
  it('09:20 London is 09:20 UTC in winter and 08:20 UTC in summer; the other UTC hour is the wrong one', () => {
    expect(isLondonHour(new Date('2026-11-23T09:20:00Z'), 9)).toBe(true);   // GMT
    expect(isLondonHour(new Date('2026-11-23T08:20:00Z'), 9)).toBe(false);
    expect(isLondonHour(new Date('2026-07-10T08:20:00Z'), 9)).toBe(true);   // BST
    expect(isLondonHour(new Date('2026-07-10T09:20:00Z'), 9)).toBe(false);
  });

  it('keeps the right hour across both clock changes (29 Mar and 25 Oct 2026)', () => {
    expect(londonTime(new Date('2026-03-28T23:30:00Z')).hour).toBe(23); // last GMT night
    expect(londonTime(new Date('2026-03-29T00:30:00Z')).hour).toBe(0);  // clocks go forward at 01:00 UTC: 00:30 is still GMT
    expect(londonTime(new Date('2026-03-29T01:30:00Z')).hour).toBe(2);  // now BST: 02:30
    expect(londonTime(new Date('2026-10-25T00:30:00Z')).hour).toBe(1);  // BST
    expect(londonTime(new Date('2026-10-25T01:30:00Z')).hour).toBe(1);  // back to GMT: 01:30 again
  });

  it('a slot can name a weekday (Friday 15:50 for the review)', () => {
    const slot = { hour: 15, weekday: 5 };
    expect(inLondonSlot(new Date('2026-11-20T15:50:00Z'), slot)).toBe(true);  // Fri, GMT
    expect(inLondonSlot(new Date('2026-11-20T14:50:00Z'), slot)).toBe(false);
    expect(inLondonSlot(new Date('2026-07-10T14:50:00Z'), slot)).toBe(true);  // Fri, BST
    expect(inLondonSlot(new Date('2026-11-19T15:50:00Z'), slot)).toBe(false); // Thursday
  });

  it('previous working day: Monday looks back to Friday, a weekend to Friday', () => {
    expect(previousWorkday('2026-11-23')).toBe('2026-11-20'); // Mon -> Fri
    expect(previousWorkday('2026-11-24')).toBe('2026-11-23'); // Tue -> Mon
    expect(previousWorkday('2026-11-22')).toBe('2026-11-20'); // Sun -> Fri
    expect(isWeekday('2026-11-21')).toBe(false);
    expect(shortDay('2026-11-23')).toBe('Mon 23 Nov');
  });

  it('every scheduled function declares the cron its job definition says, and the slot hour is one of its two UTC hours', () => {
    for (const j of JOB_DEFS) {
      const src = readFileSync(new URL(`../netlify/functions/${j.function}.mts`, import.meta.url), 'utf8');
      expect(/schedule: '([^']+)'/.exec(src)?.[1]).toBe(j.netlify_cron);
      if (j.slot) {
        const hours = j.netlify_cron.split(' ')[1].split(',').map(Number);
        expect(hours).toHaveLength(2);
        // the same London slot must be reachable in GMT (UTC hour = slot hour) and in BST (one hour earlier)
        expect(hours).toContain(j.slot.hour);
        expect(hours).toContain(j.slot.hour - 1);
      }
    }
  });
});
