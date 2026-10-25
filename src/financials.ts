/**
 * Reading reported values out of an EDINET annual securities report.
 *
 * Pure functions only (no network) so the unit/period/basis rules are testable
 * without a Subscription-Key.
 *
 * The rules that matter, because getting them wrong is the expensive failure:
 *
 *  - UNIT AND CURRENCY come from the fact's own unit id in the filing, never
 *    from the filer's nationality. A value whose unit id is not an ISO-4217
 *    code is returned UNRESOLVED (value null, raw text kept), not guessed.
 *  - SCALE: XBRL facts carry the absolute amount ("1,000,000" million-yen
 *    display is stored as 1000000000000). The CSV does not carry the display
 *    rounding, so every value is reported in whole currency units and the
 *    response says so. Nothing is divided or multiplied here.
 *  - PERIOD: only the annual securities report (docTypeCode 120) is read, and
 *    only the CURRENT-year context, so a value is always the full fiscal year
 *    stated by the filing's own period start/end. Quarterly and half-year
 *    reports hold cumulative figures and are deliberately not read.
 *  - BASIS: consolidated values win; individual (non-consolidated) values are
 *    used only when no consolidated fact exists, and are labelled.
 */

export type Standard = 'J-GAAP' | 'IFRS' | 'US GAAP';
export type Basis = 'consolidated' | 'non_consolidated' | 'unspecified';

export interface CsvFact {
  elementId: string;
  label: string;
  contextId: string;
  relativeYear: string;
  basisText: string;
  unitId: string;
  value: string;
}

/** Decode the EDINET CSV (UTF-16LE, tab separated) into facts. */
export function parseFactsCsv(bytes: Uint8Array): CsvFact[] {
  let text: string;
  // EDINET writes UTF-16LE with a BOM; tolerate UTF-8 too.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
  else if (bytes.length >= 2 && bytes[1] === 0x00) text = new TextDecoder('utf-16le').decode(bytes);
  else text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const facts: CsvFact[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) { // line 0 is the header
    if (!lines[i]) continue;
    const c = lines[i].split('\t').map((s) => s.replace(/^"|"$/g, ''));
    if (c.length < 9) continue;
    facts.push({
      elementId: c[0], label: c[1], contextId: c[2], relativeYear: c[3],
      basisText: c[4], unitId: c[6], value: c[8],
    });
  }
  return facts;
}

interface LineSpec {
  key: string;
  label_en: string;
  period: 'duration' | 'instant';
  /** Local element names in priority order; statement elements before the business-results summary. */
  elements: Array<{ id: string; standard: Standard }>;
}

const LINES: LineSpec[] = [
  { key: 'net_sales', label_en: 'Net sales / revenue', period: 'duration', elements: [
    { id: 'NetSales', standard: 'J-GAAP' }, { id: 'OperatingRevenue1', standard: 'J-GAAP' },
    { id: 'RevenueIFRS', standard: 'IFRS' }, { id: 'Revenues', standard: 'US GAAP' },
    { id: 'NetSalesSummaryOfBusinessResults', standard: 'J-GAAP' }, { id: 'OperatingRevenue1SummaryOfBusinessResults', standard: 'J-GAAP' },
    { id: 'RevenueIFRSSummaryOfBusinessResults', standard: 'IFRS' }, { id: 'RevenuesUSGAAPSummaryOfBusinessResults', standard: 'US GAAP' },
  ] },
  { key: 'operating_income', label_en: 'Operating income', period: 'duration', elements: [
    { id: 'OperatingIncome', standard: 'J-GAAP' }, { id: 'OperatingProfitLossIFRS', standard: 'IFRS' },
    { id: 'OperatingIncomeLoss', standard: 'US GAAP' },
  ] },
  { key: 'net_income_attributable_to_owners', label_en: 'Net income attributable to owners of the parent', period: 'duration', elements: [
    { id: 'ProfitLossAttributableToOwnersOfParent', standard: 'J-GAAP' }, { id: 'ProfitLossAttributableToOwnersOfParentIFRS', standard: 'IFRS' },
    { id: 'NetIncomeLossAttributableToOwnersOfParent', standard: 'US GAAP' },
    { id: 'ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults', standard: 'J-GAAP' },
    { id: 'ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults', standard: 'IFRS' },
    { id: 'NetIncomeLossAttributableToOwnersOfParentUSGAAPSummaryOfBusinessResults', standard: 'US GAAP' },
    { id: 'NetIncomeLossSummaryOfBusinessResults', standard: 'J-GAAP' },
  ] },
  { key: 'total_assets', label_en: 'Total assets', period: 'instant', elements: [
    { id: 'Assets', standard: 'J-GAAP' }, { id: 'AssetsIFRS', standard: 'IFRS' },
    { id: 'TotalAssetsSummaryOfBusinessResults', standard: 'J-GAAP' }, { id: 'TotalAssetsIFRSSummaryOfBusinessResults', standard: 'IFRS' },
    { id: 'TotalAssetsUSGAAPSummaryOfBusinessResults', standard: 'US GAAP' },
  ] },
  { key: 'net_assets_equity', label_en: 'Net assets / total equity', period: 'instant', elements: [
    { id: 'NetAssets', standard: 'J-GAAP' }, { id: 'EquityIFRS', standard: 'IFRS' },
    { id: 'NetAssetsSummaryOfBusinessResults', standard: 'J-GAAP' }, { id: 'EquityIFRSSummaryOfBusinessResults', standard: 'IFRS' },
    { id: 'EquityIncludingPortionAttributableToNonControllingInterestUSGAAPSummaryOfBusinessResults', standard: 'US GAAP' },
  ] },
];

const ISO_CURRENCY = /^[A-Z]{3}$/;

export interface ReportedValue {
  line: string;
  label_en: string;
  label_ja: string;
  element_id: string;
  /** Whole currency units exactly as tagged in the filing; null when unresolved. */
  value: number | null;
  /** The text as it appears in the filing, always kept. */
  value_as_filed: string;
  currency: string | null;
  unit_id: string;
  unit_status: 'resolved' | 'unresolved';
  unit_note?: string;
  scale: 'whole currency units (not thousands or millions)';
  basis: Basis;
  period_kind: 'full_fiscal_year_duration' | 'fiscal_year_end_instant';
}

function localName(elementId: string): string {
  const i = elementId.indexOf(':');
  return i >= 0 ? elementId.slice(i + 1) : elementId;
}

function basisOf(f: CsvFact): Basis {
  if (f.basisText === '連結') return 'consolidated';
  if (f.basisText === '個別') return 'non_consolidated';
  return 'unspecified';
}

function shape(spec: LineSpec, f: CsvFact): ReportedValue {
  const raw = f.value.trim();
  const unit = f.unitId.trim();
  const numeric = /^-?\d+(\.\d+)?$/.test(raw.replace(/,/g, '')) ? Number(raw.replace(/,/g, '')) : null;
  const currencyOk = ISO_CURRENCY.test(unit);
  let value: number | null = null;
  let note: string | undefined;
  if (!currencyOk) note = `Unit id "${unit}" is not a currency code, so the amount is not returned as money.`;
  else if (numeric === null) note = 'The filed value is not a plain number.';
  else value = numeric;
  return {
    line: spec.key,
    label_en: spec.label_en,
    label_ja: f.label,
    element_id: f.elementId,
    value,
    value_as_filed: raw,
    currency: currencyOk ? unit : null,
    unit_id: unit,
    unit_status: value !== null ? 'resolved' : 'unresolved',
    ...(note ? { unit_note: note } : {}),
    scale: 'whole currency units (not thousands or millions)',
    basis: basisOf(f),
    period_kind: spec.period === 'duration' ? 'full_fiscal_year_duration' : 'fiscal_year_end_instant',
  };
}

export function selectFinancials(facts: CsvFact[]): { standard: Standard | null; values: ReportedValue[]; missing: string[] } {
  const standardsSeen = new Set<Standard>();
  const values: ReportedValue[] = [];
  const missing: string[] = [];
  for (const spec of LINES) {
    const ctx = spec.period === 'duration' ? 'CurrentYearDuration' : 'CurrentYearInstant';
    let chosen: { f: CsvFact; standard: Standard } | null = null;
    for (const el of spec.elements) {
      const cands = facts.filter((f) => localName(f.elementId) === el.id && f.contextId === ctx);
      if (cands.length === 0) continue;
      // Consolidated first; a non-consolidated fact is only a fallback.
      const pick = cands.find((f) => basisOf(f) === 'consolidated') ?? cands[0];
      chosen = { f: pick, standard: el.standard };
      break;
    }
    if (!chosen) { missing.push(spec.key); continue; }
    standardsSeen.add(chosen.standard);
    values.push(shape(spec, chosen.f));
  }
  // IFRS/US GAAP elements are distinct from J-GAAP ones, so the standard is
  // whichever the matched facts belong to; mixed means the filing is unclear.
  const standard = standardsSeen.size === 1 ? [...standardsSeen][0] : (standardsSeen.size === 0 ? null : (standardsSeen.has('IFRS') ? 'IFRS' : standardsSeen.has('US GAAP') ? 'US GAAP' : 'J-GAAP'));
  return { standard, values, missing };
}

/** Margin only when both lines share currency, basis and a resolved unit. */
export function margin(values: ReportedValue[], numeratorKey: string): { pct: number; basis: Basis; currency: string } | null {
  const num = values.find((v) => v.line === numeratorKey);
  const den = values.find((v) => v.line === 'net_sales');
  if (!num || !den || num.value === null || den.value === null || den.value === 0) return null;
  if (num.currency !== den.currency || num.basis !== den.basis || !num.currency) return null;
  return { pct: Math.round((num.value / den.value) * 10000) / 100, basis: num.basis, currency: num.currency };
}
