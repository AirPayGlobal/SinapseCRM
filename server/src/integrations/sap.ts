import { config } from '../config.js';
import { withSystem } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { systemCtx } from '../lib/context.js';
import { logIntegration } from './fabric.js';

/**
 * SAP S/4HANA — customer master alignment and billing/account reference lookup over OData
 * (API_BUSINESS_PARTNER, and the customer line-item service for account references). The data
 * objects are fixed in the mapping specification; anything beyond runs through change control.
 */
export const sapConfigured = () => Boolean(config.sap.baseUrl);

async function odata<T = any>(path: string): Promise<T> {
  const r = await fetch(`${config.sap.baseUrl.replace(/\/$/, '')}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${config.sap.username}:${config.sap.password}`).toString('base64')}`,
    },
  });
  if (!r.ok) throw new Error(`SAP OData ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export interface SapPartner { BusinessPartner: string; BusinessPartnerFullName: string; OrganizationBPName1?: string; SearchTerm1?: string; BusinessPartnerIsBlocked?: boolean }

export async function lookupPartner(sapCustomerId: string): Promise<SapPartner | null> {
  try {
    const j: any = await odata(`/API_BUSINESS_PARTNER/A_BusinessPartner('${encodeURIComponent(sapCustomerId)}')?$format=json`);
    const p = j.d ?? j;
    await logIntegration(null, { connector: 'sap', direction: 'outbound', operation: 'A_BusinessPartner.get', status: 'success', correlationId: sapCustomerId });
    return p;
  } catch (e) {
    await logIntegration(null, { connector: 'sap', direction: 'outbound', operation: 'A_BusinessPartner.get', status: 'failed', correlationId: sapCustomerId, error: (e as Error).message });
    throw e;
  }
}

export async function searchPartners(name: string): Promise<SapPartner[]> {
  const filter = encodeURIComponent(`substringof('${name.replace(/'/g, "''")}', BusinessPartnerFullName)`);
  const j: any = await odata(`/API_BUSINESS_PARTNER/A_BusinessPartner?$filter=${filter}&$top=10&$format=json`);
  await logIntegration(null, { connector: 'sap', direction: 'outbound', operation: 'A_BusinessPartner.search', status: 'success', payload: { name } });
  return j.d?.results ?? j.value ?? [];
}

/** Align a company with its SAP customer master record and record the comparison. */
export async function alignCompany(companyId: string) {
  return withSystem(async (tx) => {
    const c = (await tx.query('SELECT id, name, sap_customer_id FROM companies WHERE id = $1', [companyId])).rows[0];
    if (!c?.sap_customer_id) return { aligned: false, reason: 'no SAP customer id on the company' };
    const p = await lookupPartner(c.sap_customer_id);
    if (!p) return { aligned: false, reason: 'not found in SAP' };
    const result = { sap_name: p.BusinessPartnerFullName, crm_name: c.name, matches: p.BusinessPartnerFullName?.toLowerCase() === c.name.toLowerCase(), blocked: Boolean(p.BusinessPartnerIsBlocked) };
    await audit(tx, systemCtx('sap'), 'company.sap_aligned', 'company', companyId, undefined, result);
    return { aligned: true, ...result };
  });
}
