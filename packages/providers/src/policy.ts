// SPDX-License-Identifier: AGPL-3.0-only
// Policy router (ADR-0008 §3-4): a provider is used only when its descriptor satisfies the org policy.
// Refusals are explicit; there is never a silent fallback to a non-compliant provider.
import {
  ProviderPolicyError,
  type Capability,
  type OrgModelPolicy,
  type PolicyRefusalReason,
  type ProviderDescriptor,
} from './types.js';

export type PolicyDecision = { allowed: true } | { allowed: false; reason: PolicyRefusalReason };

/** Pure check of one descriptor against one policy. Evaluation order is the order of the reasons below. */
export function checkPolicy(
  policy: OrgModelPolicy,
  descriptor: ProviderDescriptor,
  capability?: Capability,
): PolicyDecision {
  if (capability !== undefined && descriptor.capability !== capability)
    return { allowed: false, reason: 'wrong_capability' };
  // Training on customer data is never acceptable, regardless of the rest of the policy.
  if (descriptor.trainingUse === 'default_on' || descriptor.retentionClass === 'trains_by_default')
    return { allowed: false, reason: 'training_use' };
  if (policy.selfHostOnly && descriptor.retentionClass !== 'self_hosted')
    return { allowed: false, reason: 'not_self_hosted' };
  if (
    policy.requireZdr &&
    descriptor.retentionClass !== 'self_hosted' &&
    descriptor.retentionClass !== 'zdr_contractual'
  )
    return { allowed: false, reason: 'retention_not_zdr' };
  if (policy.allowedVendors && !policy.allowedVendors.includes(descriptor.vendor))
    return { allowed: false, reason: 'vendor_not_allowed' };
  if (
    policy.allowedRegions &&
    !descriptor.regions.some((r) => r === 'local' || policy.allowedRegions!.includes(r))
  )
    return { allowed: false, reason: 'region_not_allowed' };
  return { allowed: true };
}

/**
 * Picks the first provider (in configured order) that the policy allows. Throws a ProviderPolicyError
 * naming the first refusal when none is allowed, so callers surface the policy conflict instead of
 * degrading to another vendor.
 */
export function selectProvider<P extends { descriptor: ProviderDescriptor }>(
  policy: OrgModelPolicy,
  providers: readonly P[],
  capability: Capability,
): P {
  let firstRefusal: { id: string; reason: PolicyRefusalReason } | null = null;
  for (const p of providers) {
    const d = checkPolicy(policy, p.descriptor, capability);
    if (d.allowed) return p;
    firstRefusal ??= { id: p.descriptor.id, reason: d.reason };
  }
  if (firstRefusal === null)
    throw new ProviderPolicyError(
      `no ${capability} provider configured`,
      'wrong_capability',
      'none',
    );
  throw new ProviderPolicyError(
    `provider ${firstRefusal.id} refused by org policy: ${firstRefusal.reason}`,
    firstRefusal.reason,
    firstRefusal.id,
  );
}
