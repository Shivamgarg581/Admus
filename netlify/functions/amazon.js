const TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const API_URL = 'https://creatorsapi.amazon';
let cachedToken = null;
let tokenExpiresAt = 0;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

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

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return {statusCode: 204, headers, body: ''};

  try {
    const q = event.queryStringParameters || {};
    const action = q.action || 'search';
    const keywords = (q.q || '').trim();
    const asin = (q.asin || '').trim();
    const tag = process.env.AMAZON_PARTNER_TAG || 'smartpick210f-20';
    const id = process.env.AMAZON_CREDENTIAL_ID;
    const secret = process.env.AMAZON_CREDENTIAL_SECRET;

    if (!id || !secret) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: 'Amazon Creators API is not configured. Add AMAZON_CREDENTIAL_ID and AMAZON_CREDENTIAL_SECRET in Netlify environment variables.'
        })
      };
    }

    const token = await getToken(id, secret);
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

    let path;
    let body;

    if (action === 'item' && asin) {
      path = '/catalog/v1/getItems';
      body = {
        itemIds: asin.split(',').map(x => x.trim()).filter(Boolean).slice(0, 10),
        itemIdType: 'ASIN',
        partnerTag: tag,
        marketplace: 'www.amazon.in',
        resources
      };
    } else {
      const page = Math.max(1, Math.min(10, Math.floor(num(q.page, 1))));
      const itemCount = Math.max(1, Math.min(10, Math.floor(num(q.itemCount, 10))));
      body = {
        keywords: keywords || 'popular products',
        partnerTag: tag,
        marketplace: 'www.amazon.in',
        searchIndex: q.category || 'All',
        itemCount,
        itemPage: page,
        resources
      };
      if (q.maxPrice) body.maxPrice = Math.round(Number(q.maxPrice) * 100);
      if (q.minPrice) body.minPrice = Math.round(Number(q.minPrice) * 100);
      if (q.minRating) body.minReviewsRating = Number(q.minRating);
      if (q.minSaving) body.minSavingPercent = Number(q.minSaving);
      if (q.brand) body.brand = q.brand;
      if (q.sort) body.sortBy = q.sort;
      path = '/catalog/v1/searchItems';
    }

    const res = await fetch(API_URL + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'x-marketplace': 'www.amazon.in'
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) return {statusCode: res.status, headers, body: JSON.stringify(data)};

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
        saving: savings?.percentage ?? null,
        availability: listing.availability?.type || null,
        deal: listing.dealDetails || null,
        features: x.itemInfo?.features?.displayValues || [],
        url: 'https://www.amazon.in/dp/' + x.asin + '/?tag=' + encodeURIComponent(tag)
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        items,
        total: data.searchResult?.totalResultCount || items.length,
        searchURL: data.searchResult?.searchURL || null,
        refinements: data.searchResult?.searchRefinements || null,
        page: Number(q.page) || 1,
        itemCount: items.length
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({error: e.message || 'Server error'})
    };
  }
};
