// ════════════════════════════════════════════════════════════
// api/daraz-fetch.js
// Vercel serverless function — fetches a Daraz product URL,
// parses the page, and returns structured product data.
//
// POST /api/daraz-fetch  { "url": "https://www.daraz.pk/products/..." }
// → { name, price, image, description, rating, reviews, affiliateUrl }
// ════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  // Sanity check
  const lower = url.toLowerCase();
  if (!lower.includes('daraz.pk') && !lower.includes('daraz.com')) {
    return res.status(400).json({ error: 'URL must be from daraz.pk' });
  }

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      }
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Daraz returned ${response.status}` });
    }

    const html = await response.text();
    const finalUrl = response.url || url;
    const product = parseProductData(html, url, finalUrl);
    return res.status(200).json(product);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Fetch failed' });
  }
}

function parseProductData(html, originalUrl, finalUrl) {
  const data = {
    name: '',
    price: 0,
    image: '',
    description: '',
    rating: 0,
    reviews: 0,
    affiliateUrl: originalUrl,
    sourceUrl: finalUrl,
    debug: []
  };

  // ── Strategy 1: JSON-LD structured data ──
  try {
    const jsonLdMatches = [...html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of jsonLdMatches) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const obj of arr) {
          if (obj['@type'] === 'Product' || (obj['@graph'] && obj['@graph'].some(g => g['@type'] === 'Product'))) {
            const prod = obj['@type'] === 'Product' ? obj : obj['@graph'].find(g => g['@type'] === 'Product');
            if (prod.name && !data.name) data.name = stripTags(prod.name);
            if (prod.image && !data.image) data.image = Array.isArray(prod.image) ? prod.image[0] : prod.image;
            if (prod.description && !data.description) data.description = stripTags(prod.description);
            if (prod.offers) {
              const offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
              if (offer.price && !data.price) data.price = parseFloat(offer.price);
            }
            if (prod.aggregateRating) {
              const r = prod.aggregateRating;
              if (r.ratingValue && !data.rating) data.rating = parseFloat(r.ratingValue);
              if ((r.reviewCount || r.ratingCount) && !data.reviews) data.reviews = parseInt(r.reviewCount || r.ratingCount);
            }
            data.debug.push('json-ld:product');
          }
        }
      } catch (e) { /* skip malformed */ }
    }
  } catch (e) { data.debug.push('json-ld:error'); }

  // ── Strategy 2: window.runParams (Daraz embeds full product JSON) ──
  try {
    const runParamsMatch = html.match(/window\.runParams\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (runParamsMatch) {
      const runParams = JSON.parse(runParamsMatch[1]);
      const d = (runParams.data || runParams) || {};
      const root = d.root || d;
      const fields = root.fields || d.fields || {};
      const skuBase = fields.skuBase || {};
      const skus = skuBase.skus || [];
      const skuInfos = fields.skuInfos || {};
      const firstSku = skus[0]?.skuId;
      const skuInfo = firstSku ? skuInfos[firstSku] : null;

      if (!data.name && fields.product && fields.product.title) data.name = stripTags(fields.product.title);
      if (!data.image && fields.skuGalleries && fields.skuGalleries[firstSku]) {
        const gallery = fields.skuGalleries[firstSku];
        if (gallery[0] && gallery[0].src) data.image = gallery[0].src;
      }
      if (!data.price && skuInfo && skuInfo.price && skuInfo.price.salePrice) {
        data.price = parseFloat(String(skuInfo.price.salePrice.value).replace(/[^\d.]/g, ''));
      }
      if (skuInfo && skuInfo.ratings) {
        if (!data.rating) data.rating = parseFloat(skuInfo.ratings.average);
        if (!data.reviews) data.reviews = parseInt(skuInfo.ratings.totalRatings || skuInfo.ratings.reviewCount || 0);
      }
      data.debug.push('runParams:hit');
    }
  } catch (e) { data.debug.push('runParams:error'); }

  // ── Strategy 3: Open Graph meta tags (fallback) ──
  try {
    if (!data.name) {
      const m = html.match(/<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i);
      if (m) data.name = decodeHTMLEntities(m[1].replace(/\s*\|\s*Daraz.*$/i, '').replace(/\s*-\s*Daraz.*$/i, ''));
    }
    if (!data.image) {
      const m = html.match(/<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i);
      if (m) data.image = m[1];
    }
    if (!data.description) {
      const m = html.match(/<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']/i);
      if (m) data.description = decodeHTMLEntities(m[1]);
    }
    if (!data.price) {
      const m = html.match(/<meta\s+(?:property|name)=["']product:price:amount["']\s+content=["']([^"']+)["']/i);
      if (m) data.price = parseFloat(m[1]);
    }
    data.debug.push('og:checked');
  } catch (e) { data.debug.push('og:error'); }

  // ── Strategy 4: Title tag fallback ──
  if (!data.name) {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) data.name = decodeHTMLEntities(m[1].replace(/\s*\|\s*Daraz.*$/i, '').replace(/\s*-\s*Buy.*$/i, '').trim());
  }

  // ── Strategy 5: Price from raw HTML (looks for Rs. or PKR followed by numbers) ──
  if (!data.price) {
    const priceMatches = [...html.matchAll(/(?:Rs\.?|PKR|₨)\s*([\d,]+(?:\.\d{1,2})?)/gi)];
    if (priceMatches.length) {
      const prices = priceMatches.map(m => parseFloat(m[1].replace(/,/g, ''))).filter(n => n > 0);
      if (prices.length) data.price = Math.min(...prices); // assume lowest is sale price
      data.debug.push('price:raw');
    }
  }

  // Normalize image URL (Daraz uses // prefix)
  if (data.image && data.image.startsWith('//')) data.image = 'https:' + data.image;

  // Clean up description (limit length)
  if (data.description && data.description.length > 500) {
    data.description = data.description.substring(0, 500) + '…';
  }

  // Round rating
  if (data.rating) data.rating = Math.round(data.rating * 10) / 10;

  return data;
}

function stripTags(s) { return String(s).replace(/<[^>]+>/g, '').trim(); }

function decodeHTMLEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}
