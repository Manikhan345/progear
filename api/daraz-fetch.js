// ════════════════════════════════════════════════════════════
// api/daraz-fetch.js  v5 — proper JSON extraction + tighter parsing
//
// Key fix: window.runParams is a HUGE nested JSON object. Regex
// can't extract it reliably. v5 uses brace-balanced extraction
// so we get the FULL JSON, then parse properly.
//
// Also removes the unreliable "find any Rs. X" fallback that was
// matching Rs. 100 from voucher/shipping promo text.
// ════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ur;q=0.8',
  'Cache-Control': 'no-cache',
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

  let { url, debug } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing URL' });
  if (!url.toLowerCase().includes('daraz.')) {
    return res.status(400).json({ error: 'URL must be from daraz.pk' });
  }

  try {
    const { html, finalUrl, hops } = await fetchFollowingAllRedirects(url, 5);

    if (!html || html.length < 500) {
      return res.status(422).json({ error: `Empty response from Daraz after ${hops} hop(s).` });
    }

    const product = parseProductData(html, url, finalUrl);

    if (!product.name) {
      return res.status(422).json({
        error: `Could not find product info on page (followed ${hops} redirect${hops !== 1 ? 's' : ''}).`,
        finalUrl, hops,
        ...(debug ? { htmlLen: html.length, hasRunParams: html.includes('window.runParams') } : {})
      });
    }

    product.hops = hops;
    if (debug) product._debug = { finalUrl, hops, htmlLen: html.length, hasRunParams: html.includes('window.runParams') };
    return res.status(200).json(product);
  } catch (e) {
    return res.status(500).json({ error: 'Fetch error: ' + (e.message || String(e)) });
  }
}

// ── Redirect follower ──
async function fetchFollowingAllRedirects(startUrl, maxHops) {
  let url = startUrl;
  let hops = 0;
  let html = '';
  let finalUrl = startUrl;

  for (hops = 0; hops < maxHops; hops++) {
    const r = await fetchWithTimeout(url, 12000);
    if (!r.ok) throw new Error(`HTTP ${r.status} at ${url}`);
    html = await r.text();
    finalUrl = r.url || url;

    const jsRedirect = html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
                       html.match(/location\.replace\(["']([^"']+)["']\)/i);
    const metaRefresh = html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i);

    if (html.length < 3000 && (jsRedirect || metaRefresh)) {
      const next = (jsRedirect && jsRedirect[1]) || (metaRefresh && metaRefresh[1]);
      if (next) { try { url = new URL(next, finalUrl).toString(); continue; } catch (e) { break; } }
    }

    // Product URL discovery
    const isProductPage = html.includes('window.runParams') ||
                          html.includes('"@type":"Product"') ||
                          html.includes('"skuBase"') ||
                          html.includes('pdp-mod');

    if (!isProductPage) {
      const canonical = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
      const ogUrl = html.match(/<meta\s+(?:property|name)=["']og:url["']\s+content=["']([^"']+)["']/i);
      const productUrlMatch = html.match(/https?:\/\/(?:www\.)?daraz\.pk\/products\/[^"'\s<>]+\.html/i);
      const appDeeplink = html.match(/daraz:\/\/[^"'\s<>]*productId[=/]([^&"'\s<>]+)/i);

      let nextUrl = null;
      if (canonical && canonical[1].includes('/products/')) nextUrl = canonical[1];
      else if (ogUrl && ogUrl[1].includes('/products/')) nextUrl = ogUrl[1];
      else if (productUrlMatch) nextUrl = productUrlMatch[0];
      else if (appDeeplink) nextUrl = `https://www.daraz.pk/products/i${appDeeplink[1]}.html`;

      if (nextUrl && nextUrl !== url && nextUrl !== finalUrl) {
        try { url = new URL(nextUrl, finalUrl).toString(); continue; } catch (e) {}
      }
    }
    break;
  }
  return { html, finalUrl, hops: hops + 1 };
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { redirect: 'follow', headers: HEADERS, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// ── KEY FIX: Brace-balanced JSON extraction ──
// Regex can't reliably extract nested JSON. This walks character by
// character respecting strings & escapes, so we get the FULL object.
function extractBalancedJSON(html, markerRegex) {
  const m = html.match(markerRegex);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  const openIdx = html.indexOf('{', startIdx);
  if (openIdx === -1 || openIdx > startIdx + 20) return null; // marker not followed by {

  let depth = 0, inString = false, escape = false;
  for (let i = openIdx; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.substring(openIdx, i + 1);
    }
  }
  return null;
}

// Deep-search helper: walk a nested object looking for a value
function findInObject(obj, keys, maxDepth = 8) {
  if (!obj || typeof obj !== 'object' || maxDepth < 0) return undefined;
  for (const k of keys) if (k in obj) return obj[k];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findInObject(v, keys, maxDepth - 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ── Parser ──
function parseProductData(html, originalUrl, finalUrl) {
  const data = {
    name: '', price: 0, originalPrice: 0, discount: 0,
    image: '', description: '',
    rating: 0, reviews: 0, sold: 0,
    affiliateUrl: originalUrl, sourceUrl: finalUrl,
  };

  // ── A. window.runParams (the main data source on Daraz) ──
  const runParamsJSON = extractBalancedJSON(html, /window\.runParams\s*=\s*/);
  if (runParamsJSON) {
    try {
      const runParams = JSON.parse(runParamsJSON);
      const root = runParams.data || runParams;
      const fields = (root.root && root.root.fields) || root.fields || root;

      // -- Product info --
      const product = fields.product || {};
      if (product.title && !data.name) data.name = stripTags(product.title);
      if (product.desc && !data.description) data.description = stripTags(product.desc);

      // -- Sold count --
      if (product.itemSoldCntShow) {
        const sm = String(product.itemSoldCntShow).match(/([\d,]+)/);
        if (sm) data.sold = parseInt(sm[1].replace(/,/g, ''));
      } else if (product.itemsSold) {
        data.sold = parseInt(String(product.itemsSold).replace(/[^\d]/g, '')) || 0;
      }

      // -- SKU price (THE source of truth) --
      const skuBase = fields.skuBase || {};
      const skuInfos = fields.skuInfos || {};
      const skus = skuBase.skus || [];
      const firstSkuId = skus[0] && skus[0].skuId;
      const skuInfo = firstSkuId ? skuInfos[firstSkuId] : null;

      if (skuInfo && skuInfo.price) {
        const p = skuInfo.price;
        // Sale price
        if (p.salePrice) {
          const val = (typeof p.salePrice.value === 'number') ? p.salePrice.value :
                      parseFloat(String(p.salePrice.value || '').replace(/[^\d.]/g, ''));
          if (val > 0) data.price = val;
        }
        // Original price
        if (p.originalPrice) {
          const val = (typeof p.originalPrice.value === 'number') ? p.originalPrice.value :
                      parseFloat(String(p.originalPrice.value || '').replace(/[^\d.]/g, ''));
          if (val > 0) data.originalPrice = val;
        }
        // Discount
        if (p.discount) {
          data.discount = parseInt(String(p.discount).replace(/[^\d]/g, '')) || 0;
        }
      }

      // -- Fallback: deep search runParams for price keys --
      if (!data.price) {
        const found = findInObject(root, ['salePrice', 'price']);
        if (found) {
          let v = 0;
          if (typeof found === 'object' && found.value !== undefined) v = parseFloat(String(found.value).replace(/[^\d.]/g, ''));
          else if (typeof found === 'number') v = found;
          else if (typeof found === 'string') v = parseFloat(found.replace(/[^\d.]/g, ''));
          if (v > 0) data.price = v;
        }
      }

      // -- Image --
      if (!data.image && firstSkuId && fields.skuGalleries && fields.skuGalleries[firstSkuId]) {
        const g = fields.skuGalleries[firstSkuId];
        if (g[0] && g[0].src) data.image = g[0].src;
      }
      if (!data.image && fields.gallery && fields.gallery[0]) {
        const g0 = fields.gallery[0];
        if (typeof g0 === 'string') data.image = g0;
        else if (g0.src) data.image = g0.src;
      }

      // -- Reviews / rating --
      const review = fields.review || fields.ratings || {};
      if (review.ratings && typeof review.ratings === 'object') {
        const r = review.ratings;
        if (!data.rating) data.rating = parseFloat(r.average || r.averageStar || 0);
        if (!data.reviews) data.reviews = parseInt(r.totalRatings || r.reviewCount || r.total || 0);
      }
      if (!data.rating && review.averageStar) data.rating = parseFloat(review.averageStar);
      if (!data.reviews && review.ratingTotal) data.reviews = parseInt(review.ratingTotal);
      if (!data.reviews && review.reviewTotal) data.reviews = parseInt(review.reviewTotal);

      // Deep search for rating/reviews if not found
      if (!data.rating) {
        const r = findInObject(root, ['average', 'averageStar', 'ratingValue']);
        if (r) data.rating = parseFloat(r);
      }
      if (!data.reviews) {
        const rv = findInObject(root, ['totalRatings', 'ratingTotal', 'reviewCount', 'reviewTotal']);
        if (rv) data.reviews = parseInt(rv);
      }
    } catch (e) {}
  }

  // ── B. JSON-LD ──
  if (!data.name || !data.price || !data.rating) {
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
              if (prod.offers && !data.price) {
                const offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
                if (offer.price) {
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
  }

  // ── C. Open Graph (name + image only — DO NOT use for price) ──
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

  // ── D. Title tag ──
  if (!data.name) {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) data.name = decodeHTMLEntities(m[1]).replace(/\s*[|–-]\s*Daraz.*$/i, '').trim();
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
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
