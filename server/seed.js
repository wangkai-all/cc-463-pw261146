/**
 * Synthetic source data for the reconciliation workbench.
 *
 * The seed deliberately contains the situations the reconciliation has to
 * survive:
 *   - duplicate order rows inside one export and across two exports
 *   - a revision (re-export) of the orders source for one business day
 *   - orders paid in two or three instalments, and a part-payment left open
 *   - refunds booked on the day after the payment (cross-day settlement)
 *   - a refund that exceeds what was captured
 *   - payments whose order number was mistyped in the payment feed
 *   - an order that never received any payment row (missing feed)
 *   - a business day whose payment export has not arrived yet
 *
 * All amounts are integer cents.
 */

export const ENGINE_VERSION = 'recon-engine/1.0.0';

const DAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];

function order(orderNo, date, gross, opts = {}) {
  return {
    source_row_id: opts.rowId || `ORD-${orderNo}`,
    order_no: orderNo,
    customer_id: opts.customer || `C${(Number(orderNo.slice(-4)) % 97 + 1).toString().padStart(3, '0')}`,
    ordered_at: opts.at || `${date}T10:12:00+08:00`,
    business_date: date,
    currency: 'CNY',
    gross: gross.toFixed(2),
    discount: (opts.discount || 0).toFixed(2),
    status: opts.status || 'confirmed',
    ...(opts.extra || {}),
  };
}

function payment(paymentNo, orderNo, date, amount, opts = {}) {
  return {
    source_row_id: opts.rowId || `PAY-${paymentNo}`,
    payment_no: paymentNo,
    order_no: orderNo,
    paid_at: opts.at || `${date}T10:14:00+08:00`,
    business_date: date,
    amount: amount.toFixed(2),
    channel: opts.channel || 'alipay',
    status: opts.status || 'captured',
    ...(opts.extra || {}),
  };
}

function refund(refundNo, orderNo, paymentNo, date, amount, opts = {}) {
  return {
    source_row_id: opts.rowId || `REF-${refundNo}`,
    refund_no: refundNo,
    payment_no: paymentNo,
    order_no: orderNo,
    refunded_at: opts.at || `${date}T09:05:00+08:00`,
    business_date: date,
    amount: amount.toFixed(2),
    reason: opts.reason || 'customer_return',
    status: opts.status || 'settled',
    ...(opts.extra || {}),
  };
}

export function seedPlan() {
  const batches = [];

  /* ---------------------------------------------------------------- orders */

  const d02Orders = [
    order('SO-20261102-0001', '2026-11-02', 1280),
    order('SO-20261102-0002', '2026-11-02', 640, { discount: 40 }),
    order('SO-20261102-0003', '2026-11-02', 2199),
    order('SO-20261102-0004', '2026-11-02', 320.5),
    order('SO-20261102-0005', '2026-11-02', 899),
    order('SO-20261102-0006', '2026-11-02', 4580, { customer: 'C900' }),
  ];
  batches.push({
    source: 'orders', source_ref: 'erp-orders-20261102-v1', business_date: '2026-11-02',
    revision: 1, rows: d02Orders, note: 'ERP 每日订单导出',
  });

  const d03Orders = [
    order('SO-20261103-0001', '2026-11-03', 1560),
    order('SO-20261103-0002', '2026-11-03', 780),
    order('SO-20261103-0003', '2026-11-03', 999, { discount: 50 }),
    order('SO-20261103-0004', '2026-11-03', 268),
    order('SO-20261103-0005', '2026-11-03', 3400),
    // in-export duplicate: the same order number exported twice with different row ids
    order('SO-20261103-0005', '2026-11-03', 3400, { rowId: 'ORD-SO-20261103-0005-R2' }),
    order('SO-20261103-0006', '2026-11-03', 129),
  ];
  batches.push({
    source: 'orders', source_ref: 'erp-orders-20261103-v1', business_date: '2026-11-03',
    revision: 1, rows: d03Orders, note: 'ERP 每日订单导出（含重复行）',
  });

  const d04Orders = [
    order('SO-20261104-0001', '2026-11-04', 2100),
    order('SO-20261104-0002', '2026-11-04', 560),
    order('SO-20261104-0003', '2026-11-04', 1880),
    order('SO-20261104-0004', '2026-11-04', 720),
    order('SO-20261104-0005', '2026-11-04', 430),
  ];
  batches.push({
    source: 'orders', source_ref: 'erp-orders-20261104-v1', business_date: '2026-11-04',
    revision: 1, rows: d04Orders, note: 'ERP 每日订单导出',
  });
  // revision of the 11-04 export: one order corrected (1880 -> 1740, discount added)
  const d04OrdersV2 = d04Orders.map((row) => {
    if (row.order_no !== 'SO-20261104-0003') return row;
    return { ...row, gross: '1740.00', discount: '140.00', corrected: 'original gross 1880.00 was a keying error' };
  });
  if (process.env.RECON_SEED_REVISION !== '0') {
    batches.push({
      source: 'orders', source_ref: 'erp-orders-20261104-v2', business_date: '2026-11-04',
      revision: 2, rows: d04OrdersV2, supersedes_source_ref: 'erp-orders-20261104-v1',
      note: '订单导出修订：SO-20261104-0003 金额由 1880.00 更正为 1740.00',
    });
  }

  /* -------------------------------------------------------------- payments */

  const d02Payments = [
    payment('PAY-20261102-0001', 'SO-20261102-0001', '2026-11-02', 1280),
    payment('PAY-20261102-0002', 'SO-20261102-0002', '2026-11-02', 300, { channel: 'wechat' }),
    payment('PAY-20261102-0003', 'SO-20261102-0002', '2026-11-02', 300, { channel: 'wechat' }),
    payment('PAY-20261102-0004', 'SO-20261102-0003', '2026-11-02', 2199, { channel: 'unionpay' }),
    // duplicate payment row (same payment number different row id) - PSP re-delivery
    payment('PAY-20261102-0004', 'SO-20261102-0003', '2026-11-02', 2199, {
      rowId: 'PAY-20261102-0004-R2', channel: 'unionpay',
    }),
    payment('PAY-20261102-0005', 'SO-20261102-0004', '2026-11-02', 300.5, { channel: 'wechat' }),
    payment('PAY-20261102-0007', 'SO-20261102-0004', '2026-11-02', 20, { channel: 'wechat', status: 'pending' }),
    payment('PAY-20261102-0006', 'SO-20261102-0005', '2026-11-02', 899),
    // SO-20261102-0006 is deliberately absent: order without any payment feed row
  ];
  batches.push({
    source: 'payments', source_ref: 'psp-payments-20261102-v1', business_date: '2026-11-02',
    revision: 1, rows: d02Payments, note: 'PSP 支付流水日结',
  });

  const d03Payments = [
    payment('PAY-20261103-0001', 'SO-20261103-0001', '2026-11-03', 1560),
    payment('PAY-20261103-0002', 'SO-20261103-0002', '2026-11-03', 780),
    payment('PAY-20261103-0003', 'SO-20261103-0003', '2026-11-03', 400),
    payment('PAY-20261103-0004', 'SO-20261103-0003', '2026-11-03', 549, {
      at: '2026-11-03T18:41:00+08:00', status: 'pending',
    }),
    payment('PAY-20261103-0005', 'SO-20261103-0004', '2026-11-03', 268, { channel: 'wechat' }),
    payment('PAY-20261103-0006', 'SO-20261103-0005', '2026-11-03', 3400, { channel: 'unionpay' }),
    // mistyped order number: date segment transposed (1130 vs 1103)
    payment('PAY-20261103-0007', 'SO-20261103-0906', '2026-11-03', 129, { channel: 'wechat' }),
  ];
  batches.push({
    source: 'payments', source_ref: 'psp-payments-20261103-v1', business_date: '2026-11-03',
    revision: 1, rows: d03Payments, note: 'PSP 支付流水日结',
  });

  const d04Payments = [
    payment('PAY-20261104-0001', 'SO-20261104-0001', '2026-11-04', 2100),
    payment('PAY-20261104-0002', 'SO-20261104-0002', '2026-11-04', 560),
    // settled against the pre-revision amount of SO-20261104-0003
    payment('PAY-20261104-0003', 'SO-20261104-0003', '2026-11-04', 1880, { channel: 'unionpay' }),
    payment('PAY-20261104-0004', 'SO-20261104-0004', '2026-11-04', 720),
  ];
  batches.push({
    source: 'payments', source_ref: 'psp-payments-20261104-v1', business_date: '2026-11-04',
    revision: 1, rows: d04Payments, note: 'PSP 支付流水日结',
  });
  // 11-05 payments have not been delivered at all -> missing payment batch.

  const d05Orders = [
    order('SO-20261105-0001', '2026-11-05', 1660),
    order('SO-20261105-0002', '2026-11-05', 240),
  ];
  batches.push({
    source: 'orders', source_ref: 'erp-orders-20261105-v1', business_date: '2026-11-05',
    revision: 1, rows: d05Orders, note: 'ERP 每日订单导出（支付批次未到）',
  });

  /* --------------------------------------------------------------- refunds */

  const d03Refunds = [
    // refund for a 11-02 payment, booked the next business day
    refund('RF-20261103-0001', 'SO-20261102-0004', 'PAY-20261102-0005', '2026-11-03', 120.5, {
      reason: 'partial_return',
    }),
    // refund on the duplicated order SO-20261103-0005
    refund('RF-20261103-0002', 'SO-20261103-0005', 'PAY-20261103-0006', '2026-11-03', 400, { reason: 'damaged' }),
    // refund without a payment reference (payment_no null) - needs key work
    refund('RF-20261103-0003', 'SO-20261103-0004', null, '2026-11-03', 268, { reason: 'full_return' }),
  ];
  batches.push({
    source: 'refunds', source_ref: 'oms-refunds-20261103-v1', business_date: '2026-11-03',
    revision: 1, rows: d03Refunds, note: '售后系统退款日结',
  });

  const d04Refunds = [
    // refund larger than the remaining captured amount
    refund('RF-20261104-0001', 'SO-20261104-0002', 'PAY-20261104-0002', '2026-11-04', 660, { reason: 'price_adjust' }),
    refund('RF-20261104-0002', 'SO-20261104-0001', 'PAY-20261104-0001', '2026-11-04', 2100, { reason: 'full_return' }),
  ];
  batches.push({
    source: 'refunds', source_ref: 'oms-refunds-20261104-v1', business_date: '2026-11-04',
    revision: 1, rows: d04Refunds, note: '售后系统退款日结',
  });

  return { batches, days: DAYS };
}
