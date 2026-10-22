import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import extractor from '../src/productExtract.js';

function extract(html, url = 'https://www.aliexpress.com/item/123.html') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  try { return dom.window.eval('(' + extractor.readProductDocument.toString() + ')()'); }
  finally { dom.window.close(); }
}

describe('product facts from a browser page', () => {
  it('reads JSON-LD fields and preserves the AliExpress source URL', () => {
    const facts = extract(`<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product', name: 'Camera lens', sku: 'AE-123',
      description: 'A manual focus lens', image: ['/lens.jpg', 'javascript:bad'],
      offers: { price: '19.50', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    })}</script>`);
    expect(facts).toMatchObject({ supplier: 'aliexpress', title: 'Camera lens', sku: 'AE-123',
      price: 19.5, currency: 'USD', images: ['https://www.aliexpress.com/lens.jpg'],
      sourceUrl: 'https://www.aliexpress.com/item/123.html', evidence: 'schema.org/Product' });
    expect(facts.warnings).toContain('Variants, stock, shipping cost and fulfillment eligibility require separate verification');
  });

  it('falls back to page metadata and leaves unknown prices unknown', () => {
    const facts = extract('<script type="application/ld+json">broken</script><meta property="og:title" content="Desk lamp"><meta property="og:image" content="https://img.example/lamp.jpg">');
    expect(facts).toMatchObject({ title: 'Desk lamp', price: null, currency: null,
      images: ['https://img.example/lamp.jpg'], evidence: 'page metadata' });
    expect(facts.warnings).toContain('Price or currency was not verified');
  });

  it('rejects pages with no product signal', async () => {
    await expect(extractor.extractProduct({ evaluate: async fn => {
      const dom = new JSDOM('<html><body>Sign in</body></html>', { url: 'https://example.com', runScripts: 'outside-only' });
      try { return dom.window.eval('(' + fn.toString() + ')()'); } finally { dom.window.close(); }
    } })).rejects.toThrow('No product data found');
    await expect(extractor.extractProduct({ evaluate: async fn => {
      const dom = new JSDOM('<h1>Verify you are human</h1><meta property="og:image" content="/logo.png">', { url: 'https://www.aliexpress.com/item/123.html', runScripts: 'outside-only' });
      try { return dom.window.eval('(' + fn.toString() + ')()'); } finally { dom.window.close(); }
    } })).rejects.toThrow('No product data found');
  });
});
