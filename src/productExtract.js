'use strict';

// Runs in the page context. Read structured product facts without trusting page text as instructions.
function readProductDocument() {
  const limit = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const meta = (key) => document.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.content || '';
  const absoluteImage = (value) => {
    if (!value || typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  const nodes = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const root = JSON.parse(script.textContent || '');
      const visit = (item, depth = 0) => {
        if (!item || depth > 4) return;
        if (Array.isArray(item)) return item.forEach(x => visit(x, depth + 1));
        if (typeof item !== 'object') return;
        if (String(item['@type'] || '').toLowerCase().includes('product')) nodes.push(item);
        if (item['@graph']) visit(item['@graph'], depth + 1);
        if (item.mainEntity) visit(item.mainEntity, depth + 1);
      };
      visit(root);
    } catch { /* Invalid or unrelated JSON-LD is common. */ }
  }
  const product = nodes[0] || {};
  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
  const imageValues = Array.isArray(product.image) ? product.image : product.image ? [product.image] : [];
  const images = [...new Set([...imageValues.map(x => typeof x === 'string' ? x : x?.url), meta('og:image')]
    .map(absoluteImage).filter(Boolean))].slice(0, 20);
  const title = limit(product.name || meta('og:title') || document.querySelector('h1')?.textContent, 255);
  const description = limit(product.description || meta('og:description') || meta('description'), 20000);
  const rawPrice = offer.price ?? offer.lowPrice ?? meta('product:price:amount');
  const price = rawPrice !== undefined && rawPrice !== null && /^\d+(?:[.,]\d+)?$/.test(String(rawPrice).trim())
    ? Number(String(rawPrice).trim().replace(',', '.')) : null;
  const currency = limit(offer.priceCurrency || meta('product:price:currency'), 3).toUpperCase();
  const sourceUrl = location.href;
  return {
    sourceUrl, supplier: /(^|\.)aliexpress\./i.test(location.hostname) ? 'aliexpress' : location.hostname,
    title, description, images, price, currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
    sku: limit(product.sku || product.productID || offer.sku, 100) || null,
    availability: limit(offer.availability, 200) || null,
    seller: limit(typeof product.brand === 'string' ? product.brand : product.brand?.name, 255) || null,
    evidence: nodes.length ? 'schema.org/Product' : 'page metadata',
    warnings: [
      ...(!title ? ['No product title found'] : []),
      ...(price === null || !/^[A-Z]{3}$/.test(currency) ? ['Price or currency was not verified'] : []),
      ...(!images.length ? ['No product images found'] : []),
      'Variants, stock, shipping cost and fulfillment eligibility require separate verification',
    ],
  };
}

async function extractProduct(page) {
  const facts = await page.evaluate(readProductDocument);
  const challenge = /captcha|verify.{0,20}human|access denied|security check|sign[ -]?in|log[ -]?in/i.test(facts.title);
  if (!facts.title || challenge || (facts.evidence !== 'schema.org/Product' && facts.price === null && !facts.images.length)) {
    throw Object.assign(new Error('No product data found on this page'), { status: 422 });
  }
  return facts;
}

module.exports = { extractProduct, readProductDocument };
