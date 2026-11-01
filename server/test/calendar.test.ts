import { describe, expect, it } from 'vitest';
import { addBusinessMinutes, businessMinutesBetween, isBusinessTime, namibianPublicHolidays, type ServiceCalendar } from '../src/lib/calendar.js';
import { renderMask } from '../src/services/reference.js';
import { cosine, NaiveBayes, sentiment, TfIdf } from '../src/lib/text.js';
import { totp, verifyTotp, newTotpSecret } from '../src/lib/totp.js';

const hours: ServiceCalendar['businessHours'] = {
  '0': [], '1': [['07:30', '16:30']], '2': [['07:30', '16:30']], '3': [['07:30', '16:30']], '4': [['07:30', '16:30']], '5': [['07:30', '13:00']], '6': [],
};
const holidays2026 = new Set(namibianPublicHolidays(2026).map((h) => h.day));
const cal: ServiceCalendar = { utcOffsetMinutes: 120, businessHours: hours, holidays: holidays2026 };
const at = (local: string) => new Date(`${local}+02:00`);

describe('Namibian service calendar', () => {
  it('computes the 2026 public holidays including Easter and the Sunday rule', () => {
    const h = namibianPublicHolidays(2026);
    const days = Object.fromEntries(h.map((x) => [x.name, x.day]));
    expect(days['Good Friday']).toBe('2026-04-03');
    expect(days['Easter Monday']).toBe('2026-04-06');
    expect(days['Ascension Day']).toBe('2026-05-14');
    expect(days['Independence Day']).toBe('2026-03-21');
    expect(days["Heroes' Day"]).toBe('2026-08-26');
    // 2027-03-21 is a Sunday → observed on Monday 22 March
    expect(namibianPublicHolidays(2027).some((x) => x.day === '2027-03-22' && x.name.includes('observed'))).toBe(true);
  });

  it('does not let a weekend consume a response target', () => {
    // Friday 12:00 + 240 business minutes: 60 min Friday (to 13:00) + 180 min Monday from 07:30 → 10:30
    const due = addBusinessMinutes(cal, at('2026-10-30T12:00:00'), 240);
    expect(due.toISOString()).toBe(at('2026-11-02T10:30:00').toISOString());
  });

  it('skips public holidays', () => {
    // Thursday 2 April 2026 16:00 + 60 min → 30 min Thursday, Good Friday and Easter Monday skipped → Tuesday 08:00
    const due = addBusinessMinutes(cal, at('2026-04-02T16:00:00'), 60);
    expect(due.toISOString()).toBe(at('2026-04-07T08:00:00').toISOString());
  });

  it('counts business minutes between two instants', () => {
    expect(businessMinutesBetween(cal, at('2026-10-30T12:00:00'), at('2026-11-02T10:30:00'))).toBe(240);
    expect(businessMinutesBetween(cal, at('2026-10-31T09:00:00'), at('2026-11-01T18:00:00'))).toBe(0);
    expect(isBusinessTime(cal, at('2026-11-02T08:00:00'))).toBe(true);
    expect(isBusinessTime(cal, at('2026-11-01T10:00:00'))).toBe(false);
  });
});

describe('reference mask', () => {
  it('renders the port-prefixed sequence', () => {
    expect(renderMask('NAM-{PORT}-{YYYY}-{SEQ:6}', { port: 'WB', year: 2026, seq: 123 })).toBe('NAM-WB-2026-000123');
  });
});

describe('text toolkit', () => {
  it('ranks similar wording above unrelated wording', () => {
    const tf = new TfIdf(['berth allocation for vessel', 'invoice for cargo dues', 'container release delay']);
    const q = tf.vector('which berth is allocated to our vessel');
    expect(cosine(q, tf.vector('berth allocation for vessel'))).toBeGreaterThan(cosine(q, tf.vector('invoice for cargo dues')));
  });
  it('classifies with naive Bayes', () => {
    const nb = new NaiveBayes();
    nb.train('billing', 'invoice incorrect charged twice credit note');
    nb.train('berthing', 'berth allocation vessel quay window');
    expect(nb.predict('the invoice charged us twice')[0].label).toBe('billing');
  });
  it('detects frustration', () => {
    expect(sentiment('This is UNACCEPTABLE! Third time we are chasing and nobody responds!!')).toBeLessThan(-0.4);
    expect(sentiment('Thank you, that was helpful')).toBeGreaterThan(0);
  });
});

describe('TOTP', () => {
  it('verifies codes it generates', () => {
    const s = newTotpSecret();
    expect(verifyTotp(s, totp(s))).toBe(true);
    expect(verifyTotp(s, '000000') && totp(s) !== '000000').toBe(false);
  });
});
