// ════════════════════════════════════════════════════════════
// api/daraz-fetch.js  (v2 — handles short links + JS redirects)
//
// POST /api/daraz-fetch  { "url": "https://s.daraz.pk/..." }
// → { name, price, image, description, rating, reviews, affiliateUrl }
//
// Strategy:
// 1. Follow short-link chains (up to 5 hops) — handles JS redirects,
//    meta refresh, and HTTP 30x in one pipeline.
// 2. Parse product data from JSON-LD / runParams / Next.js data /
//    OG meta / raw price patterns.
// 3. Return a specific error if parsing fails (never "Unknown error").
// ════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ur;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const lower = url.toLowerCase();
  if (!lower.includes('daraz.')) {
    return res.status(400).json({ error: 'URL must be from daraz.pk' });
  }

  try {
    const { html, finalUrl, hops } = await fetchFollowingAllRedirects(url, 5);

    if (!html || html.length < 500) {
      return res.status(422).json({ error: `Empty or too-small response from Daraz after ${hops} hop(s). The link may be expired or region-blocked.` });
    }

    const product = parseProductData(html, url, finalUrl);

    if (!product.name) {
      return res.status(422).json({
        error: `Could not find product info on page (followed ${hops} redirect${hops !== 1 ? 's' : ''}). Try opening the product in your phone browser and copying the full /products/...html URL instead.`,
        finalUrl,
        hops
      });
    }

    product.hops = hops;
    return res.status(200).json(product);
  } catch (e) {
    return res.status(500).json({ error: 'Fetch error: ' + (e.message || String(e)) });
  }
}

async function fetchFollowingAllRedirects(startUrl, maxHops) {
  let url = startUrl;
  let hops = 0;
  let html = '';
  let finalUrl = startUrl;

  for (hops = 0; hops < maxHops; hops++) {
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok) throw new Error(`HTTP ${r.status} at ${url}`);
    html = await r.text();
    finalUrl = r.url || url;

    const jsRedirect = html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
                       html.match(/location\.replace\(["']([^"']+)["']\)/i) ||
                       html.match(/window\.location\.assign\(["']([^"']+)["']\)/i);

    const metaRefresh = html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i);

    const isRedirectPage = html.length < 3000 && (jsRedirect || metaRefresh);

    if (isRedirectPage) {
      const next = (jsRedirect && jsRedirect[1]) || (metaRefresh && metaRefresh[1]);
      if (next) {
        try {
          url = new URL(next, finalUrl).toString();
          continue;
        } catch (e) { break; }
      }
    }

    // Smart fallback: page reached but no product data — scan for a product URL
    // This handles Daraz short links that redirect to a campaign/landing page
    // but contain a link to the actual product somewhere on the page
    const isProductPage = html.includes('"@type":"Product"') ||
                          html.includes('window.runParams') ||
                          html.includes('pdp-mod-product-badge') ||
                          /class="[^"]*pdp-product[^"]*"/.test(html) ||
                          html.includes('"skuBase"');

    if (!isProductPage) {
      // Try canonical link
      const canonical = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
      // Try og:url
      const ogUrl = html.match(/<meta\s+(?:property|name)=["']og:url["']\s+content=["']([^"']+)["']/i);
      // Try any /products/ URL on page
      const productUrlMatch = html.match(/https?:\/\/(?:www\.)?daraz\.pk\/products\/[^"'\s<>]+\.html/i);
      // Try app deeplink pattern: daraz://product/...
      const appDeeplink = html.match(/daraz:\/\/[^"'\s<>]*productId[=/]([^&"'\s<>]+)/i);

      let nextUrl = null;
      if (canonical && canonical[1].includes('/products/')) nextUrl = canonical[1];
      else if (ogUrl && ogUrl[1].includes('/products/')) nextUrl = ogUrl[1];
      else if (productUrlMatch) nextUrl = productUrlMatch[0];
      else if (appDeeplink) {
        // Convert daraz://product/123 to web URL
        nextUrl = `https://www.daraz.pk/products/i${appDeeplink[1]}.html`;
      }

      if (nextUrl && nextUrl !== finalUrl && nextUrl !== url) {
        try {
          url = new URL(nextUrl, finalUrl).toString();
          continue;
        } catch (e) {}
      }
    }
    break;
  }

  return { html, finalUrl, hops: hops + 1 };
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { redirect: 'follow', headers: COMMON_HEADERS, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

function parseProductData(html, originalUrl, finalUrl) {
  const data = {
    name: '',
    price: 0,
    originalPrice: 0,
    discount: 0,
    image: '',
    description: '',
    rating: 0,
    reviews: 0,
    sold: 0,
    affiliateUrl: originalUrl,
    sourceUrl: finalUrl,
  };

  // ── Strategy A: window.runParams — Daraz's main data store ──
  let runParams = null;
  try {
    const m = html.match(/window\.runParams\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script)/);
    if (m) runParams = JSON.parse(m[1]);
  } catch (e) {}

  if (runParams) {
    try {
      const root = runParams.data || runParams;
      const fields = (root.root && root.root.fields) || root.fields || root;

      // Product name
      if (fields.product) {
        if (fields.product.title) data.name = stripTags(fields.product.title);
        if (fields.product.desc) data.description = stripTags(fields.product.desc);
      }

      // SKU info — the price source of truth on Daraz
      const skuBase = fields.skuBase || {};
      const skus = skuBase.skus || [];
      const skuInfos = fields.skuInfos || {};
      const firstSkuId = skus[0] && skus[0].skuId;
      const skuInfo = firstSkuId ? skuInfos[firstSkuId] : null;

      if (skuInfo) {
        // Price extraction
        const price = skuInfo.price || {};
        const sale = price.salePrice;
        const orig = price.originalPrice;
        if (sale) {
          const val = typeof sale.value === 'number' ? sale.value : parseFloat(String(sale.value || '').replace(/[^\d.]/g, ''));
          if (val) data.price = val;
        }
        if (orig) {
          const val = typeof orig.value === 'number' ? orig.value : parseFloat(String(orig.value || '').replace(/[^\d.]/g, ''));
          if (val) data.originalPrice = val;
        }
        if (price.discount) data.discount = parseInt(String(price.discount).replace(/[^\d]/g, '')) || 0;
      }

      // Galleries (images)
      if (firstSkuId && fields.skuGalleries && fields.skuGalleries[firstSkuId]) {
        const gallery = fields.skuGalleries[firstSkuId];
        if (gallery[0] && gallery[0].src) data.image = gallery[0].src;
      }
      // Fallback: top-level gallery
      if (!data.image && fields.gallery && fields.gallery[0] && fields.gallery[0].src) {
        data.image = fields.gallery[0].src;
      }

      // Rating / reviews
      const rating = fields.review || fields.ratings || {};
      if (rating.ratings) {
        const r = rating.ratings;
        if (r.average && !data.rating) data.rating = parseFloat(r.average);
        if (!data.reviews) data.reviews = parseInt(r.totalRatings || r.reviewCount || r.total || 0);
      }
      // Alt: review object
      if (!data.rating && rating.averageStar) data.rating = parseFloat(rating.averageStar);
      if (!data.reviews && rating.ratingTotal) data.reviews = parseInt(rating.ratingTotal);
      if (!data.reviews && rating.reviewTotal) data.reviews = parseInt(rating.reviewTotal);

      // Sold count
      if (fields.product && fields.product.itemSoldCntShow) {
        const sm = String(fields.product.itemSoldCntShow).match(/(\d+)/);
        if (sm) data.sold = parseInt(sm[1]);
      }
      if (!data.sold && fields.product && fields.product.itemsSold) {
        data.sold = parseInt(fields.product.itemsSold) || 0;
      }
    } catch (e) {}
  }

  // ── Strategy B: JSON-LD ──
  try {
    const jsonLdMatches = [...html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of jsonLdMatches) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const obj of arr) {
          const candidates = [];
          if (obj['@type'] === 'Product') candidates.push(obj);
          if (obj['@graph']) candidates.push(...obj['@graph'].filter(g => g['@type'] === 'Product'));
          for (const prod of candidates) {
            if (prod.name && !data.name) data.name = stripTags(prod.name);
            if (prod.image && !data.image) data.image = Array.isArray(prod.image) ? prod.image[0] : prod.image;
            if (prod.description && !data.description) data.description = stripTags(prod.description);
            if (prod.offers) {
              const offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
              if (offer.price && !data.price) {
                const p = parseFloat(String(offer.price).replace(/[^\d.]/g, ''));
                if (p) data.price = p;
              }
            }
            if (prod.aggregateRating) {
              const r = prod.aggregateRating;
              if (r.ratingValue && !data.rating) data.rating = parseFloat(r.ratingValue);
              if (!data.reviews) data.reviews = parseInt(r.reviewCount || r.ratingCount || 0);
            }
          }
        }
      } catch (e) {}
    }
  } catch (e) {}

  // ── Strategy C: Open Graph meta tags ──
  if (!data.name) {
    const m = html.match(/<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (m) data.name = decodeHTMLEntities(m[1]).replace(/\s*[|–-]\s*Daraz.*$/i, '').trim();
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
    if (m) {
      const p = parseFloat(m[1].replace(/,/g, ''));
      if (p) data.price = p;
    }
  }

  // ── Strategy D: Title tag ──
  if (!data.name) {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) data.name = decodeHTMLEntities(m[1]).replace(/\s*[|–-]\s*Daraz.*$/i, '').replace(/\s*-\s*Buy.*$/i, '').trim();
  }

  // ── Strategy E: Targeted JSON key search (price, rating, etc.) ──
  if (!data.price) {
    // Search for salePrice or price in any JSON-like structure
    const patterns = [
      /"salePrice"\s*:\s*\{\s*"value"\s*:\s*"?([\d.]+)"?/i,
      /"salePrice"\s*:\s*"?([\d.]+)"?/i,
      /"priceShow"\s*:\s*"Rs\.\s*([\d,]+(?:\.\d+)?)"/i,
      /"price"\s*:\s*\{\s*"value"\s*:\s*"?([\d.]+)"?/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) { const p = parseFloat(m[1].replace(/,/g, '')); if (p) { data.price = p; break; } }
    }
  }
  if (!data.originalPrice) {
    const m = html.match(/"originalPrice"\s*:\s*\{\s*"value"\s*:\s*"?([\d.]+)"?/i) ||
              html.match(/"originalPriceShow"\s*:\s*"Rs\.\s*([\d,]+(?:\.\d+)?)"/i);
    if (m) data.originalPrice = parseFloat(m[1].replace(/,/g, ''));
  }
  if (!data.rating) {
    const m = html.match(/"averageRating"\s*:\s*"?([\d.]+)"?/i) ||
              html.match(/"ratingValue"\s*:\s*"?([\d.]+)"?/i) ||
              html.match(/"average"\s*:\s*"?([\d.]+)"?\s*,\s*"totalRatings"/i);
    if (m) data.rating = parseFloat(m[1]);
  }
  if (!data.reviews) {
    const m = html.match(/"totalRatings"\s*:\s*"?(\d+)"?/i) ||
              html.match(/"reviewCount"\s*:\s*"?(\d+)"?/i) ||
              html.match(/"ratingTotal"\s*:\s*"?(\d+)"?/i);
    if (m) data.reviews = parseInt(m[1]);
  }
  if (!data.sold) {
    const m = html.match(/"itemSoldCntShow"\s*:\s*"([^"]+)"/i) ||
              html.match(/"itemsSold"\s*:\s*"?(\d+)/i);
    if (m) {
      const sm = m[1].match(/(\d+)/);
      if (sm) data.sold = parseInt(sm[1]);
    }
  }

  // ── Strategy F: HTML class patterns (last resort, often unreliable) ──
  if (!data.price) {
    const pricePatterns = [
      /class="pdp-price[^"]*"[^>]*>\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
      /class="pdp-product-price[^"]*"[^>]*>\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ];
    for (const re of pricePatterns) {
      const m = html.match(re);
      if (m) { const p = parseFloat(m[1].replace(/,/g, '')); if (p) { data.price = p; break; } }
    }
  }

  // Normalize image
  if (data.image && data.image.startsWith('//')) data.image = 'https:' + data.image;
  if (data.image && !data.image.startsWith('http')) {
    try { data.image = new URL(data.image, finalUrl).toString(); } catch (e) {}
  }

  // Clean description
  if (data.description && data.description.length > 500) {
    data.description = data.description.substring(0, 500) + '…';
  }

  // Round rating
  if (data.rating) data.rating = Math.round(data.rating * 10) / 10;

  return data;
}

function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, '').trim(); }

function decodeHTMLEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
