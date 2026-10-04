exports.handler = async (event) => {
  const h = {'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'};
  if(event.httpMethod === 'OPTIONS') return {statusCode:204,headers:h,body:''};
  try{
    const q=event.queryStringParameters||{};
    const action=q.action||'search';
    const keywords=(q.q||'').trim();
    const asin=(q.asin||'').trim();
    const tag=process.env.AMAZON_PARTNER_TAG||'smartpick210f-20';
    const id=process.env.AMAZON_CREDENTIAL_ID;
    const secret=process.env.AMAZON_CREDENTIAL_SECRET;
    if(!id||!secret) return {statusCode:503,headers:h,body:JSON.stringify({error:'Amazon Creators API is not configured. Add AMAZON_CREDENTIAL_ID and AMAZON_CREDENTIAL_SECRET in Netlify environment variables.'})};
    const tokenRes=await fetch('https://api.amazon.co.uk/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:id,client_secret:secret,scope:'creatorsapi::default'})});
    const token=await tokenRes.json();
    if(!tokenRes.ok||!token.access_token) throw new Error(token.error_description||'Amazon authentication failed');
    let path,body;
    const resources=['images.primary.medium','itemInfo.title','itemInfo.byLineInfo','itemInfo.features','offersV2.listings.price','offersV2.listings.availability','offersV2.listings.dealDetails'];
    if(action==='item' && asin){path='/catalog/v1/getItems';body={itemIds:asin.split(',').slice(0,10),itemIdType:'ASIN',partnerTag:tag,marketplace:'www.amazon.in',resources};}
    else {path='/catalog/v1/searchItems';body={keywords:keywords||'popular products',partnerTag:tag,marketplace:'www.amazon.in',searchIndex:q.category||'All',itemCount:10,itemPage:Math.max(1,Math.min(10,Number(q.page)||1)),resources};if(q.maxPrice)body.maxPrice=Math.round(Number(q.maxPrice)*100);if(q.minPrice)body.minPrice=Math.round(Number(q.minPrice)*100);if(q.minRating)body.minReviewsRating=Number(q.minRating);}
    const r=await fetch('https://creatorsapi.amazon'+path,{method:'POST',headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json','x-marketplace':'www.amazon.in'},body:JSON.stringify(body)});
    const data=await r.json();
    if(!r.ok) return {statusCode:r.status,headers:h,body:JSON.stringify(data)};
    const items=data.searchResult?.items||data.items||[];
    const normalized=items.map(x=>{const l=x.offersV2?.listings?.[0]||{};const p=l.price?.money;const s=l.price?.savings;return {asin:x.asin,title:x.itemInfo?.title?.displayValue||x.itemInfo?.title?.value||'Amazon product',brand:x.itemInfo?.byLineInfo?.brand?.displayValue||'',image:x.images?.primary?.medium?.url||x.images?.primary?.small?.url||'',price:p?.amount??null,displayPrice:p?.displayAmount||null,saving:s?.percentage??null,availability:l.availability?.type||null,deal:l.dealDetails||null,url:'https://www.amazon.in/dp/'+x.asin+'/?tag='+encodeURIComponent(tag)};});
    return {statusCode:200,headers:h,body:JSON.stringify({items:normalized,total:data.searchResult?.totalResultCount||normalized.length,searchURL:data.searchResult?.searchURL||null})};
  }catch(e){return {statusCode:500,headers:h,body:JSON.stringify({error:e.message||'Server error'})}}
};