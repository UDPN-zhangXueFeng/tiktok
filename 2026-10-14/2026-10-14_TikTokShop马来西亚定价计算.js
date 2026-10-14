#!/usr/bin/env node
'use strict';

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

/**
 * Edit the null values once to match your actual Seller Center and logistics costs.
 * If left null, the script asks for them at runtime; it never silently assumes them.
 */
const CONFIG = Object.freeze({
  cnyToMyr: 0.6102, // Mid-market reference on 2026-10-14; update to your actual payment rate.
  targetProfitMargin: 0.20, // Contribution profit / discounted selling price.
  otherUnitCostMyr: null, // Packaging, customs, tax, handling, expected returns, etc.; exclude freight below.
  platformFeeRate: null, // Combined percentage-based TikTok/payment fees as a decimal, e.g. 0.18.
  affiliateRate: 0, // Effective affiliate/ads rate as a decimal, e.g. 0.10; set if applicable.
  sellerDiscountRate: 0, // Seller-funded discount as a decimal; platform-funded vouchers are excluded.
  fixedFeeMyrPerOrder: 0, // Any fixed per-order platform fee.
  priceStepMyr: 0.10, // Round the recommended listing price upward to this increment.
});

function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label}必须是有效数字。`);
  }
}

function assertNonNegative(value, label) {
  assertFiniteNumber(value, label);
  if (value < 0) {
    throw new Error(`${label}不能小于 0。`);
  }
}

function assertPositive(value, label) {
  assertFiniteNumber(value, label);
  if (value <= 0) {
    throw new Error(`${label}必须大于 0。`);
  }
}

function assertRate(value, label) {
  assertFiniteNumber(value, label);
  if (value < 0 || value >= 1) {
    throw new Error(`${label}必须在 0–100%（不含 100%）范围内。`);
  }
}

function roundUpToStep(value, step) {
  assertPositive(step, '价格进位单位');
  const rounded = Math.ceil((value - 1e-10) / step) * step;
  return Number(rounded.toFixed(2));
}

/**
 * Estimates shipping using the user's reference image:
 * <=0.5 kg: CNY 15-30; 1 kg: CNY 25-45.
 * Between the two anchors, the range is linearly interpolated as a rough estimate.
 * Above 1 kg, use an actual shipping quote instead.
 */
function estimateShippingRangeCny(weightKg) {
  assertPositive(weightKg, '包裹计费重量（千克）');

  if (weightKg <= 0.5) {
    return { min: 15, max: 30, basis: '参考图：0.5kg以内' };
  }

  if (weightKg <= 1) {
    const progress = (weightKg - 0.5) / 0.5;
    return {
      min: Number((15 + progress * 10).toFixed(2)),
      max: Number((30 + progress * 15).toFixed(2)),
      basis: '参考图 0.5kg 与 1kg 区间的线性插值（粗估）',
    };
  }

  return null;
}

function calculateScenario(totalUnitCostMyr, settings) {
  const proportionalFeeRate = settings.platformFeeRate + settings.affiliateRate;
  const retainedRate = 1 - proportionalFeeRate - settings.targetProfitMargin;
  if (retainedRate <= 0) {
    throw new Error('平台/达人比例费率与目标利润率之和必须小于 100%。');
  }

  const minimumSalePriceMyr = totalUnitCostMyr / retainedRate;
  const minimumListPriceMyr = minimumSalePriceMyr / (1 - settings.sellerDiscountRate);
  const recommendedListPriceMyr = roundUpToStep(minimumListPriceMyr, settings.priceStepMyr);
  const discountedSalePriceMyr = recommendedListPriceMyr * (1 - settings.sellerDiscountRate);
  const proportionalFeesMyr = discountedSalePriceMyr * proportionalFeeRate;
  const profitMyr = discountedSalePriceMyr - proportionalFeesMyr - totalUnitCostMyr;

  return {
    totalUnitCostMyr,
    minimumSalePriceMyr,
    minimumListPriceMyr,
    recommendedListPriceMyr,
    discountedSalePriceMyr,
    proportionalFeesMyr,
    profitMyr,
    profitMargin: profitMyr / discountedSalePriceMyr,
  };
}

/**
 * Calculates conservative listing price and profit range from a freight range.
 * Weight is the packed, chargeable weight in kilograms.
 */
function calculatePrice({ costCny, weightKg, shippingRangeCny, settings }) {
  assertPositive(costCny, '采购价（人民币）');
  assertPositive(weightKg, '包裹计费重量（千克）');

  const {
    cnyToMyr,
    targetProfitMargin,
    otherUnitCostMyr,
    platformFeeRate,
    affiliateRate,
    sellerDiscountRate,
    fixedFeeMyrPerOrder,
    priceStepMyr,
  } = settings;

  assertPositive(cnyToMyr, '人民币兑马币汇率');
  assertRate(targetProfitMargin, '目标利润率');
  assertNonNegative(otherUnitCostMyr, '其他单件成本');
  assertRate(platformFeeRate, '平台及支付比例费率');
  assertRate(affiliateRate, '达人/广告比例费率');
  assertRate(sellerDiscountRate, '卖家折扣率');
  assertNonNegative(fixedFeeMyrPerOrder, '每单固定费用');
  assertPositive(priceStepMyr, '价格进位单位');
  assertNonNegative(shippingRangeCny.min, '运费低值（人民币）');
  assertNonNegative(shippingRangeCny.max, '运费高值（人民币）');
  if (shippingRangeCny.min > shippingRangeCny.max) {
    throw new Error('运费低值不能高于运费高值。');
  }

  const purchaseCostMyr = costCny * cnyToMyr;
  const shippingCostMyr = {
    min: shippingRangeCny.min * cnyToMyr,
    max: shippingRangeCny.max * cnyToMyr,
  };
  const costBeforeShippingMyr = purchaseCostMyr + otherUnitCostMyr + fixedFeeMyrPerOrder;
  const lowFreightScenario = calculateScenario(
    costBeforeShippingMyr + shippingCostMyr.min,
    settings,
  );
  const highFreightScenario = calculateScenario(
    costBeforeShippingMyr + shippingCostMyr.max,
    settings,
  );

  const recommendedListPriceMyr = highFreightScenario.recommendedListPriceMyr;
  const discountedSalePriceMyr = recommendedListPriceMyr * (1 - settings.sellerDiscountRate);
  const proportionalFeesMyr = discountedSalePriceMyr * (settings.platformFeeRate + settings.affiliateRate);
  const profitAtLowFreightMyr = discountedSalePriceMyr
    - proportionalFeesMyr
    - lowFreightScenario.totalUnitCostMyr;
  const profitAtHighFreightMyr = discountedSalePriceMyr
    - proportionalFeesMyr
    - highFreightScenario.totalUnitCostMyr;

  return {
    purchaseCostMyr,
    weightKg,
    shippingRangeCny,
    shippingCostMyr,
    otherUnitCostMyr,
    fixedFeeMyrPerOrder,
    lowFreightScenario,
    highFreightScenario,
    recommendedListPriceMyr,
    discountedSalePriceMyr,
    profitRangeMyr: {
      min: profitAtHighFreightMyr,
      max: profitAtLowFreightMyr,
    },
    profitMarginRange: {
      min: profitAtHighFreightMyr / discountedSalePriceMyr,
      max: profitAtLowFreightMyr / discountedSalePriceMyr,
    },
  };
}

function parseInputNumber(raw, label) {
  const value = Number(raw.trim());
  assertFiniteNumber(value, label);
  return value;
}

async function askNumber(rl, prompt, label, validate) {
  const value = parseInputNumber(await rl.question(prompt), label);
  validate(value, label);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && args.length !== 2) {
    throw new Error('用法：node 2026-10-14_TikTokShop马来西亚定价计算.js [采购价CNY 包裹计费重量kg]');
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const costCny = args.length === 2
      ? parseInputNumber(args[0], '采购价（人民币）')
      : await askNumber(rl, '请输入采购价（人民币 CNY）：', '采购价（人民币）', assertPositive);
    const weightKg = args.length === 2
      ? parseInputNumber(args[1], '包裹计费重量（千克）')
      : await askNumber(rl, '请输入包裹计费重量（千克，含包装；有体积重时请输入计费重量）：', '包裹计费重量（千克）', assertPositive);

    assertPositive(costCny, '采购价（人民币）');
    assertPositive(weightKg, '包裹计费重量（千克）');

    let shippingRangeCny = estimateShippingRangeCny(weightKg);
    if (shippingRangeCny === null) {
      console.log('参考图未提供超过 1kg 的运费，请使用当前物流渠道报价。');
      const min = await askNumber(rl, '请输入该重量的运费低值（人民币 CNY；无补贴时填卖家承担额）：', '运费低值', assertNonNegative);
      const max = await askNumber(rl, '请输入该重量的运费高值（人民币 CNY）：', '运费高值', assertNonNegative);
      shippingRangeCny = { min, max, basis: '手动输入的物流报价范围' };
    } else {
      const override = await rl.question('如有本商品实际净运费区间，请输入“低值,高值”CNY；直接回车使用参考图估算：');
      if (override.trim()) {
        const values = override.split(',').map((value) => parseInputNumber(value, '实际运费区间'));
        if (values.length !== 2) {
          throw new Error('实际运费区间格式应为：低值,高值，例如 15,25。');
        }
        const [min, max] = values;
        assertNonNegative(min, '运费低值');
        assertNonNegative(max, '运费高值');
        if (min > max) {
          throw new Error('运费低值不能高于运费高值。');
        }
        shippingRangeCny = { min, max, basis: '手动输入的实际净运费' };
      }
    }

    const otherUnitCostMyr = CONFIG.otherUnitCostMyr
      ?? await askNumber(rl, '请输入其他单件成本（RM；包装、税费、操作费等，不含上面的运费；无则填 0）：', '其他单件成本', assertNonNegative);
    const platformFeeRate = CONFIG.platformFeeRate
      ?? await askNumber(rl, '请输入 Seller Center 中平台及支付比例费用（%，例如 18）：', '平台及支付比例费用', assertNonNegative) / 100;
    const settings = { ...CONFIG, otherUnitCostMyr, platformFeeRate };
    const result = calculatePrice({ costCny, weightKg, shippingRangeCny, settings });
    const money = (value) => `RM ${value.toFixed(2)}`;

    console.log('=== TikTok Shop Malaysia 定价测算 ===');
    console.log('所有计算结果和建议价格均为马来西亚令吉（MYR / RM）；采购价、运费以人民币（CNY）输入。');
    console.log(`采购成本：输入 CNY ${costCny.toFixed(2)} → ${money(result.purchaseCostMyr)}（汇率 ${CONFIG.cnyToMyr}）`);
    console.log(`包裹计费重量：${weightKg.toFixed(3)} kg`);
    console.log(`运费折算后：${money(result.shippingCostMyr.min)}–${money(result.shippingCostMyr.max)}（${shippingRangeCny.basis}）`);
    console.log(`其他单件成本：${money(result.otherUnitCostMyr)}；每单固定费用：${money(result.fixedFeeMyrPerOrder)}`);
    console.log(`平台及支付费率：${(platformFeeRate * 100).toFixed(2)}%；达人/广告费率：${(CONFIG.affiliateRate * 100).toFixed(2)}%`);
    console.log(`卖家折扣：${(CONFIG.sellerDiscountRate * 100).toFixed(2)}%；目标贡献利润率：${(CONFIG.targetProfitMargin * 100).toFixed(2)}%`);
    console.log(`低运费场景的最低标价：${money(result.lowFreightScenario.recommendedListPriceMyr)}`);
    console.log(`按运费上限保障 20% 利润的建议标价：${money(result.recommendedListPriceMyr)}`);
    console.log(`该标价对应折后成交价：${money(result.discountedSalePriceMyr)}`);
    console.log(`预计单件贡献利润范围：${money(result.profitRangeMyr.min)}–${money(result.profitRangeMyr.max)}`);
    console.log(`预计贡献利润率范围：${(result.profitMarginRange.min * 100).toFixed(2)}%–${(result.profitMarginRange.max * 100).toFixed(2)}%`);
    console.log('注意：0.5–1kg 运费按参考图两端作线性插值，只是粗估；超过 1kg 请填实际报价。若有体积重、重量档位、活动补贴或买家承担运费，请按卖家实际承担的净运费调整。平台费用计费基数也以 Seller Center/结算单为准。');
  } finally {
    rl.close();
  }
}

module.exports = { calculatePrice, estimateShippingRangeCny, roundUpToStep };

if (require.main === module) {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
