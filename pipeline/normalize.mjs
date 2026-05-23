// Map the noisy upstream event_category labels into our 6 canonical buckets.
// Add to this table over time; LLM fallback for unknown labels comes later.

const MAP = {
  // Earnings cluster
  'FY26 Earnings Call':            'Earnings',
  'Earnings Call Transcript':      'Earnings',
  'Earnings Call Summary':         'Earnings',
  'Annual Results':                'Earnings',
  'Annual Financial Results':      'Earnings',
  'Annual Results Declared':       'Earnings',
  'Annual Results & Dividend':     'Earnings',
  'Audited Annual Results':        'Earnings',
  'Audited Results Approval':      'Earnings',
  'Audited Financial Results':     'Earnings',
  'Annual Audited Results':        'Earnings',
  'Audited Results':               'Earnings',
  'Financial Results':             'Earnings',
  'Financial Results Approval':    'Earnings',
  'Quarterly Results':             'Earnings',
  'Board Meeting Outcome':         'Earnings',

  // Concalls
  'Concall Summary':               'Concalls',
  'Conc Call Summary':             'Concalls',

  // Order wins
  'Major Order Received':          'Order Wins',
  'Major Order Inflow':            'Order Wins',

  // M&A
  'Acquisition Completion':        'M&A',
  'Acquisition':                   'M&A',
  'CCI Approval':                  'M&A',
  'Open Offer Outcome':            'M&A',

  // Credit / capital structure
  'Credit Rating Upgrade':         'Credit',
  'Credit Rating Update':          'Credit',
  'Credit Rating':                 'Credit',
  'Pledge Creation':               'Credit',
  'Promoter Warrant Issue':        'Credit',
  'Fundraise Board Meeting':       'Credit',
  'Monitoring Agency Report':      'Credit',

  // Regulatory
  'Auditor Appointment':           'Regulatory',

  // Catch-all
  'Investor Presentation':         'Other',
  'Other Important':               'Other',
};

const CANONICAL = ['Earnings', 'Concalls', 'Order Wins', 'M&A', 'Credit', 'Regulatory', 'Other'];

export function isCanonical(s) {
  return CANONICAL.includes(s);
}

export function normalizeCategory(raw, fallback = 'Other') {
  if (!raw) return fallback;
  if (MAP[raw]) return MAP[raw];
  // fuzzy match by keyword
  const r = raw.toLowerCase();
  if (r.includes('order'))                                  return 'Order Wins';
  if (r.includes('concall') || r.includes('earnings call')) return 'Concalls';
  if (r.includes('results') || r.includes('earnings'))      return 'Earnings';
  if (r.includes('financial') || r.includes('dividend'))    return 'Earnings';
  if (r.includes('rating') || r.includes('pledge'))         return 'Credit';
  if (r.includes('fundrais') || r.includes('warrant'))      return 'Credit';
  if (r.includes('acquisition') || r.includes('merger'))    return 'M&A';
  if (r.includes('cci') || r.includes('open offer'))        return 'M&A';
  if (r.includes('auditor') || r.includes('regulatory'))    return 'Regulatory';
  return fallback;
}
