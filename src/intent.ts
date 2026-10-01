// Deterministic intent parser for conversational job creation.
// No LLM, no API key. Pure functions, fully testable.

export interface ParsedIntent {
  provider: string;        // 0x address, checksummed
  amountUsdc: number;      // human USDC, e.g. 5
  amountUnits: bigint;     // 6-decimal units for the contract
  description: string;
  expiresAt: number;       // unix seconds
  expiryLabel: string;     // "in 2 hours"
  confidence: number;      // 0..1 — how complete the parse is
  missing: string[];       // fields we could not resolve
}

const USDC_DECIMALS = 6;

export class ParseError extends Error {
  public missing: string[];
  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = 'ParseError';
    this.missing = missing;
  }
}

const ADDR_RE = /0x[a-fA-F0-9]{40}/;

// "5 USDC", "$5", "5 dollars", "pay 5", "20.50 usdc"
function extractAmount(text: string): number | null {
  const patterns = [
    /\$\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\b/i,
    /\bpay\s+(\d+(?:\.\d+)?)\b/i,
    /\b(\d+(?:\.\d+)?)\s*\$/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// "in 2 hours", "in 30 minutes", "by Friday", "in 1 day"
function extractExpiry(text: string, now = Math.floor(Date.now() / 1000)): { ts: number; label: string } | null {
  const units: Record<string, number> = {
    minute: 60, min: 60,
    hour: 3600, hr: 3600,
    day: 86400,
    week: 604800,
  };
  const m = text.match(/\bin\s+(\d+)\s*(minute|min|hour|hr|day|week)s?\b/i);
  if (m) {
    const secs = Number(m[1]) * units[m[2].toLowerCase()];
    if (Number.isFinite(secs) && secs > 0 && secs <= 30 * 86400) {
      return { ts: now + secs, label: `in ${m[1]} ${m[2].toLowerCase()}${Number(m[1]) > 1 ? 's' : ''}` };
    }
  }
  const hourMatch = text.match(/\bin\s+(\d+)\s*h\b/i);
  if (hourMatch) {
    return { ts: now + Number(hourMatch[1]) * 3600, label: `in ${hourMatch[1]} hours` };
  }
  return null;
}

// Everything after the address, minus money/expiry phrases, as the deliverable.
function extractDescription(text: string): string {
  let d = text;
  // drop the address
  d = d.replace(ADDR_RE, ' ');
  // drop money phrases
  d = d.replace(/\$\s*\d+(?:\.\d+)?/g, ' ');
  d = d.replace(/\b\d+(?:\.\d+)?\s*(?:usdc|usd|dollars?)\b/gi, ' ');
  // drop expiry phrases
  d = d.replace(/\bin\s+\d+\s*(?:minute|min|hour|hr|day|week)s?\b/gi, ' ');
  d = d.replace(/\bin\s+\d+\s*h\b/gi, ' ');
  // drop command scaffolding: leading verb/noun phrases and orphaned prepositions
  d = d.replace(
    /^\s*(please\s+)?(create|make|start|set up|send|pay|hold|lock|escrow)?\s*(a|an|the|new)?\s*(escrow\s+)?(job|payment|contract|order|hold)?\s*/i,
    '',
  );
  // Removing the address/amount/expiry can leave several dangling prepositions
  // ("to ... for ...") — strip leading ones until none remain.
  let prev;
  do {
    prev = d;
    d = d.replace(/^\s*(to|for|with|from|of|on)\s+/i, '');
  } while (d !== prev);
  d = d.replace(/\s+/g, ' ').trim();
  d = d.replace(/[.,;:]+$/, '').trim();
  return d;
}

function isValidAddress(a: string): boolean {
  if (!/^0x[a-fA-F0-9]{40}$/.test(a)) return false;
  if (/^0x0{40}$/i.test(a)) return false;
  if (a.toLowerCase() === '0x000000000000000000000000000000000000dead') return false; // Arc blocklists it
  return true;
}

export function parseIntent(input: string, now = Math.floor(Date.now() / 1000)): ParsedIntent {
  const text = input.trim();
  if (!text) throw new ParseError('Tell me what to pay and who to pay.');

  const missing: string[] = [];
  const addrMatch = text.match(ADDR_RE);
  let provider = '';
  if (addrMatch) {
    if (isValidAddress(addrMatch[0])) provider = addrMatch[0];
    else if (addrMatch[0].toLowerCase() === '0x000000000000000000000000000000000000dead') {
      missing.push('provider (that address is blocked on Arc)');
    } else missing.push('provider (invalid address)');
  } else {
    missing.push('provider address');
  }

  const amountUsdc = extractAmount(text);
  if (amountUsdc === null) missing.push('amount');

  const exp = extractExpiry(text, now) ?? { ts: now + 86400, label: 'in 24 hours (default)' };
  const description = extractDescription(text) || 'No description provided';

  if (missing.length > 0 || amountUsdc === null) {
    throw new ParseError(`I need a bit more: ${missing.join(', ')}.`, missing);
  }

  const required = 3;
  const found = required - missing.length;

  return {
    provider,
    amountUsdc,
    amountUnits: BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS)),
    description,
    expiresAt: exp.ts,
    expiryLabel: exp.label,
    confidence: found / required,
    missing: [],
  };
}

export const USDC = {
  address: '0x3600000000000000000000000000000000000000' as const,
  decimals: USDC_DECIMALS,
};

export const ESCROW = '0x4E557f34FFA44ce32d804737ad2c7Cb30849a445' as const;