'use strict';

/**
 * Financial semantics for marketplace reporting.
 * Avoids conflating project price with collected cash.
 */

function sum(rows, key, predicate = () => true) {
  return rows.filter(predicate).reduce((n, r) => n + Number(r[key] || 0), 0);
}

function calculateProjectFinancials({ project, payments = [], payables = [] }) {
  const gmvCents = Number(project.customer_price_cents || 0);

  const cashCollectedCents = sum(
    payments,
    'amount_cents',
    p => p.status === 'paid' && p.kind !== 'refund'
  );

  const refundsCents =
    sum(payments, 'refunded_cents') +
    sum(payments, 'amount_cents', p => p.kind === 'refund' && p.status === 'paid');

  const paymentFeesCents = sum(payments, 'provider_fee_cents', p => p.status === 'paid');

  const contractorPayableCents = sum(
    payables,
    'payable_cents',
    p => !['cancelled'].includes(p.status)
  );

  const contractorPaidCents = sum(
    payables,
    'payable_cents',
    p => p.status === 'paid'
  );

  const netCashCents = cashCollectedCents - refundsCents - paymentFeesCents;
  const grossMarginCents = gmvCents - contractorPayableCents;
  const realizedContributionCents = netCashCents - contractorPaidCents;

  return {
    gmv_cents: gmvCents,
    cash_collected_cents: cashCollectedCents,
    refunds_cents: refundsCents,
    payment_fees_cents: paymentFeesCents,
    contractor_payable_cents: contractorPayableCents,
    contractor_paid_cents: contractorPaidCents,
    net_cash_cents: netCashCents,
    gross_margin_cents: grossMarginCents,
    realized_contribution_cents: realizedContributionCents,
    collection_pct: gmvCents ? Math.round(cashCollectedCents / gmvCents * 1000) / 10 : 0,
    gross_margin_pct: gmvCents ? Math.round(grossMarginCents / gmvCents * 1000) / 10 : 0,
  };
}

module.exports = { calculateProjectFinancials };
