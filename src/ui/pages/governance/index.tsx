import React from 'react';
import { OrganizationsPages } from './Organizations';
import { ConfigPages } from './Config';
import { BillingPages } from './Billing';
import { TrustedAdvisorPages } from './TrustedAdvisor';

export function GovernancePages({ svc, path }: { svc: string; path: string }) {
  switch (svc) {
    case 'organizations': return <OrganizationsPages path={path} />;
    case 'config': return <ConfigPages path={path} />;
    case 'billing': return <BillingPages path={path} />;
    case 'trustedadvisor': return <TrustedAdvisorPages path={path} />;
    default: return null;
  }
}
