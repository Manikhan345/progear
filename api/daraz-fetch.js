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

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36';

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
    image: '',
    description: '',
    rating: 0,
    reviews: 0,
    affiliateUrl: originalUrl,
    sourceUrl: finalUrl,
  };

  // 1. JSON-LD
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
              if (offer.price && !data.price) data.price = parseFloat(String(offer.price).replace(/,/g, ''));
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

  // 2. window.runParams
  try {
    const runParamsMatch = html.match(/window\.runParams\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (runParamsMatch) {
      const runParams = JSON.parse(runParamsMatch[1]);
      const d = runParams.data || runParams;
      const fields = (d.root && d.root.fields) || d.fields || {};
      const skuBase = fields.skuBase || {};
      const skuInfos = fields.skuInfos || {};
      const firstSku = skuBase.skus && skuBase.skus[0] && skuBase.skus[0].skuId;
      const skuInfo = firstSku ? skuInfos[firstSku] : null;

      if (!data.name && fields.product && fields.product.title) data.name = stripTags(fields.product.title);
      if (!data.image && firstSku && fields.skuGalleries && fields.skuGalleries[firstSku] && fields.skuGalleries[firstSku][0]) {
        data.image = fields.skuGalleries[firstSku][0].src;
      }
      if (!data.price && skuInfo && skuInfo.price && skuInfo.price.salePrice && skuInfo.price.salePrice.value) {
        data.price = parseFloat(String(skuInfo.price.salePrice.value).replace(/[^\d.]/g, ''));
      }
      if (skuInfo && skuInfo.ratings) {
        if (!data.rating) data.rating = parseFloat(skuInfo.ratings.average || 0);
        if (!data.reviews) data.reviews = parseInt(skuInfo.ratings.totalRatings || skuInfo.ratings.reviewCount || 0);
      }
    }
  } catch (e) {}

  // 3. __NEXT_DATA__
  try {
    const nextMatch = html.match(/<script\s+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
    if (nextMatch) {
      const nextData = JSON.parse(nextMatch[1]);
      const props = (nextData.props && nextData.props.pageProps) || {};
      const product = props.product || (props.data && props.data.product) || {};
      if (!data.name && product.name) data.name = stripTags(product.name);
      if (!data.image && product.image) data.image = product.image;
      if (!data.price && product.price) data.price = parseFloat(String(product.price).replace(/[^\d.]/g, ''));
    }
  } catch (e) {}

  // 4. OG meta
  try {
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
      if (m) data.price = parseFloat(m[1].replace(/,/g, ''));
    }
  } catch (e) {}

  // 5. Title fallback
  if (!data.name) {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) data.name = decodeHTMLEntities(m[1]).replace(/\s*[|–-]\s*Daraz.*$/i, '').replace(/\s*-\s*Buy.*$/i, '').trim();
  }

  // 6. Daraz HTML class patterns for price
  if (!data.price) {
    const pricePatterns = [
      /class="[^"]*pdp-price[^"]*"[^>]*>\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
      /class="[^"]*price-content[^"]*"[^>]*>\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
      /class="[^"]*pdp-product-price[^"]*"[^>]*>\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
      /"salePrice"\s*:\s*\{[^}]*"value"\s*:\s*"?([\d.]+)"?/i,
      /"priceShow"\s*:\s*"Rs\.\s*([\d,]+)"/i,
    ];
    for (const re of pricePatterns) {
      const m = html.match(re);
      if (m) { const p = parseFloat(m[1].replace(/,/g, '')); if (p) { data.price = p; break; } }
    }
  }

  // 7. Raw price scan
  if (!data.price) {
    const priceMatches = [...html.matchAll(/(?:Rs\.?|PKR|₨)\s*([\d,]+(?:\.\d{1,2})?)/gi)];
    if (priceMatches.length) {
      const prices = priceMatches
        .map(m => parseFloat(m[1].replace(/,/g, '')))
        .filter(n => n >= 50 && n < 10000000);
      if (prices.length) {
        prices.sort((a, b) => a - b);
        data.price = prices[0];
      }
    }
  }

  // 8. Rating/reviews patterns
  if (!data.rating) {
    const rm = html.match(/"averageRating"\s*:\s*"?([\d.]+)"?/i) ||
               html.match(/"ratingValue"\s*:\s*"?([\d.]+)"?/i) ||
               html.match(/class="[^"]*score-average[^"]*"[^>]*>([\d.]+)/i);
    if (rm) data.rating = parseFloat(rm[1]);
  }
  if (!data.reviews) {
    const rvm = html.match(/"reviewCount"\s*:\s*"?(\d+)"?/i) ||
                html.match(/"totalRatings"\s*:\s*"?(\d+)"?/i) ||
                html.match(/\((\d+)\s*Ratings?\)/i);
    if (rvm) data.reviews = parseInt(rvm[1]);
  }

  if (data.image && data.image.startsWith('//')) data.image = 'https:' + data.image;
  if (data.image && !data.image.startsWith('http')) {
    try { data.image = new URL(data.image, finalUrl).toString(); } catch (e) {}
  }

  if (data.description && data.description.length > 500) {
    data.description = data.description.substring(0, 500) + '…';
  }

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
