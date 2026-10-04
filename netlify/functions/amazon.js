const TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const API_URL = 'https://creatorsapi.amazon';

let cachedToken = null;
let tokenExpiresAt = 0;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function affiliateUrl(url, tag) {
  try {
    const u = new URL(url);
    u.searchParams.set('tag', tag);
    return u.toString();
  } catch {
    return url;
  }
}

async function getToken(id, secret) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
      scope: 'creatorsapi::default'
    })
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Amazon authentication failed');
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000;
  return cachedToken;
}

function parseMoney(text) {
  if (!text) return null;
  const match = String(text).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function buildAmazonSearchUrl(query, page = 1, tag = 'smartpick210f-20') {
  const u = new URL('https://www.amazon.in/s');
  u.searchParams.set('k', query || 'popular products');
  if (page > 1) u.searchParams.set('page', String(page));
  if (tag) u.searchParams.set('tag', tag);
  return u.toString();
}

async function searchAmazonHtml({keywords, page, tag, maxPrice, minPrice, brand, sort}) {
  const u = new URL('https://www.amazon.in/s');
  u.searchParams.set('k', keywords || 'popular products');
  u.searchParams.set('page', String(page || 1));

  if (sort) u.searchParams.set('s', sort);
  if (minPrice || maxPrice) {
    const lo = minPrice ? String(Math.round(Number(minPrice))) : '';
    const hi = maxPrice ? String(Math.round(Number(maxPrice))) : '';
    u.searchParams.set('rh', 'p_36:' + lo + '-' + hi);
  }
  if (brand) {
    const existing = u.searchParams.get('rh');
    u.searchParams.set('rh', (existing ? existing + ',' : '') + 'p_89:' + encodeURIComponent(brand));
  }

  const res = await fetch(u.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-IN,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  if (!res.ok) throw new Error('Amazon search returned HTTP ' + res.status);

  const html = await res.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  const items = [];

  $('div[data-component-type="s-search-result"][data-asin]').each((_, card) => {
    const asin = ($(card).attr('data-asin') || '').trim();
    if (!asin) return;

    let title = cleanText($(card).find('h2').first().text());
    let href = $(card).find('h2 a').first().attr('href') || '';
    if (!href) {
      href = $(card).find('a[href*="/dp/"]').first().attr('href') || '';
    }

    if (!title) {
      title = cleanText($(card).find('a[href*="/dp/"]').first().text());
    }
    if (!title) return;

    const image = $(card).find('img.s-image').first().attr('src') || null;

    const prices = [];
    $(card).find('.a-price .a-offscreen').each((__, el) => {
      const p = parseMoney($(el).text());
      if (p != null && !prices.includes(p)) prices.push(p);
    });

    const price = prices[0] ?? null;
    const originalPrice = prices[1] ?? null;

    const ratingText = cleanText($(card).find('.a-icon-alt').first().text());
    const ratingMatch = ratingText.match(/[0-5](?:\.\d+)?/);
    const rating = ratingMatch ? Number(ratingMatch[0]) : null;

    let ratingCount = null;
    $(card).find('a').each((__, el) => {
      const t = cleanText($(el).text()).replace(/,/g, '');
      if (/^\d+$/.test(t) && ratingCount == null) ratingCount = Number(t);
    });

    const brand = cleanText(
      $(card).find('.a-size-base-plus.a-color-base').first().text() ||
      $(card).find('.a-size-base.a-color-base').first().text()
    );

    const sponsored = /sponsored/i.test(cleanText($(card).text()).slice(0, 500));

    const productUrl = new URL(href || '/dp/' + asin, 'https://www.amazon.in');
    productUrl.search = '';
    productUrl.hash = '';

    let saving = null;
    if (price != null && originalPrice != null && originalPrice > price) {
      saving = Math.round(((originalPrice - price) / originalPrice) * 100);
    }

    items.push({
      asin,
      title,
      brand,
      image,
      price,
      displayPrice: price != null ? '₹' + price.toLocaleString('en-IN') : null,
      originalPrice,
      saving,
      rating,
      ratingCount,
      sponsored,
      availability: null,
      deal: null,
      features: [],
      url: affiliateUrl(productUrl.toString(), tag)
    });
  });

  const hasNext = !!$('a.s-pagination-next:not(.s-pagination-disabled)').length;

  return {
    items,
    total: items.length,
    searchURL: buildAmazonSearchUrl(keywords, page, tag),
    refinements: null,
    page: Number(page) || 1,
    itemCount: items.length,
    hasNextPage: hasNext,
    mode: 'amazon-html'
  };
}

async function searchCreatorsApi({keywords, page, itemCount, tag, minPrice, maxPrice, minRating, minSaving, brand, sort}) {
  const token = await getToken(process.env.AMAZON_CREDENTIAL_ID, process.env.AMAZON_CREDENTIAL_SECRET);

  const resources = [
    'images.primary.medium',
    'images.variants.medium',
    'itemInfo.title',
    'itemInfo.byLineInfo',
    'itemInfo.features',
    'itemInfo.productInfo',
    'itemInfo.contentInfo',
    'offersV2.listings.price',
    'offersV2.listings.availability',
    'offersV2.listings.dealDetails',
    'browseNodeInfo.browseNodes'
  ];

  const body = {
    keywords: keywords || 'popular products',
    partnerTag: tag,
    marketplace: 'www.amazon.in',
    searchIndex: 'All',
    itemCount: Math.max(1, Math.min(10, Number(itemCount) || 10)),
    itemPage: Math.max(1, Math.min(10, Number(page) || 1)),
    resources
  };

  if (maxPrice) body.maxPrice = Math.round(Number(maxPrice) * 100);
  if (minPrice) body.minPrice = Math.round(Number(minPrice) * 100);
  if (minRating) body.minReviewsRating = Number(minRating);
  if (minSaving) body.minSavingPercent = Number(minSaving);
  if (brand) body.brand = brand;
  if (sort) body.sortBy = sort;

  const res = await fetch(API_URL + '/catalog/v1/searchItems', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'x-marketplace': 'www.amazon.in'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error_description || data.error || 'Amazon Creators API request failed');
  }

  const rawItems = data.searchResult?.items || data.items || [];

  const items = rawItems.map(x => {
    const listing = x.offersV2?.listings?.[0] || {};
    const money = listing.price?.money;
    const savings = listing.price?.savings;

    return {
      asin: x.asin,
      title: x.itemInfo?.title?.displayValue || x.itemInfo?.title?.value || 'Amazon product',
      brand: x.itemInfo?.byLineInfo?.brand?.displayValue || '',
      image: x.images?.primary?.medium?.url || x.images?.primary?.small?.url || '',
      price: money?.amount ?? null,
      displayPrice: money?.displayAmount || null,
      originalPrice: null,
      saving: savings?.percentage ?? null,
      availability: listing.availability?.type || null,
      deal: listing.dealDetails || null,
      features: x.itemInfo?.features?.displayValues || [],
      url: 'https://www.amazon.in/dp/' + x.asin + '/?tag=' + encodeURIComponent(tag)
    };
  });

  return {
    items,
    total: data.searchResult?.totalResultCount || items.length,
    searchURL: data.searchResult?.searchURL || buildAmazonSearchUrl(keywords, page, tag),
    refinements: data.searchResult?.searchRefinements || null,
    page: Number(page) || 1,
    itemCount: items.length,
    hasNextPage: items.length >= 10,
    mode: 'creators-api'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {statusCode: 204, headers, body: ''};
  }

  try {
    const q = event.queryStringParameters || {};
    const keywords = (q.q || '').trim();
    const page = Math.max(1, Math.min(50, Math.floor(num(q.page, 1))));
    const tag = process.env.AMAZON_PARTNER_TAG || 'smartpick210f-20';

    const hasCreatorsCredentials =
      Boolean(process.env.AMAZON_CREDENTIAL_ID) &&
      Boolean(process.env.AMAZON_CREDENTIAL_SECRET);

    let result;

    if (hasCreatorsCredentials) {
      result = await searchCreatorsApi({
        keywords,
        page,
        itemCount: q.itemCount,
        tag,
        minPrice: q.minPrice,
        maxPrice: q.maxPrice,
        minRating: q.minRating,
        minSaving: q.minSaving,
        brand: q.brand,
        sort: q.sort
      });
    } else {
      result = await searchAmazonHtml({
        keywords,
        page,
        tag,
        maxPrice: q.maxPrice,
        minPrice: q.minPrice,
        brand: q.brand,
        sort: q.sort
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: e.message || 'Amazon request failed',
        hint: 'ADMUS is currently using the Amazon.in search fallback because Creators API credentials are not configured.'
      })
    };
  }
};
