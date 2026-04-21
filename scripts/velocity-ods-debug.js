'use strict';
var fs = require('fs');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var GH_TOKEN = process.env.GH_TOKEN || '';
var TARGET_DATE = '04/19/2026';
var STORE_ID = '29865';
var REPORT_ID = '457';

function fetch() { return require('node-fetch').apply(null, arguments); }
function parseCookies(r) {
  return (r.headers.raw()['set-cookie']||[]).map(function(c){return c.split(';')[0];});
}
function mergeCookies() {
  var map = new Map();
  [].concat.apply([], Array.from(arguments)).forEach(function(ck){
    if(ck){ var n=ck.split('=')[0]; map.set(n,ck); }
  });
  return Array.from(map.values()).join('; ');
}
async function login() {
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  var r1 = await fetch(ODS_URL+'/asp/login.html', {headers:{'User-Agent':UA}});
  var c1 = parseCookies(r1);
  var r2 = await fetch(ODS_URL+'/asp/JavaScriptServlet', {method:'POST',
    headers:{'Cookie':mergeCookies(c1),'FETCH-CSRF-TOKEN':'1','X-Requested-With':'XMLHttpRequest','User-Agent':UA}});
  var c2 = parseCookies(r2); var raw = await r2.text(); var colon = raw.indexOf(':');
  var cn = raw.substring(0,colon).trim(); var cv = raw.substring(colon+1).trim();
  var fb = ['orgId='+encodeURIComponent(ODS_ORG),'j_username='+encodeURIComponent(ODS_USER),
    'j_password='+encodeURIComponent(ODS_PASS),'j_password_pseudo='+encodeURIComponent(ODS_PASS),
    cn+'='+encodeURIComponent(cv)].join('&');
  var r3 = await fetch(ODS_URL+'/asp/j_spring_security_check', {method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':mergeCookies(c1,c2),
             'Referer':ODS_URL+'/asp/login.html','Origin':ODS_URL,'User-Agent':UA}, body:fb});
  var c3 = parseCookies(r3); var loc = r3.headers.get('location')||'';
  if (loc.indexOf('error')>=0) throw new Error('Login failed: '+loc);
  return {cookie:mergeCookies(c1,c2,c3), ua:UA};
}
async function freshCsrf(cookie, ua) {
  var r = await fetch(ODS_URL+'/asp/JavaScriptServlet', {method:'POST',
    headers:{'Cookie':cookie,'FETCH-CSRF-TOKEN':'1','User-Agent':ua}});
  var t = await r.text(); var c = t.indexOf(':');
  return {name:t.substring(0,c).trim(), value:t.substring(c+1).trim()};
}
async function save(findings) {
  var pub = '/opt/render/project/src/public/debug-output.json';
  try { fs.writeFileSync(pub, JSON.stringify(findings,null,2)); } catch(e){}
  if (GH_TOKEN.length < 5) return;
  var content64 = Buffer.from(JSON.stringify(findings,null,2)).toString('base64');
  var apiUrl = 'https://api.github.com/repos/halaco225/pai-/contents/debug-output.json';
  var ghHdrs = {'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug',
    'Content-Type':'application/json','Accept':'application/vnd.github+json'};
  try {
    var shaRes = await fetch(apiUrl, {headers:ghHdrs});
    var shaJson = shaRes.ok ? await shaRes.json() : {};
    var body = {message:'debug v15d '+new Date().toISOString(), content:content64};
    if (shaJson.sha) body.sha = shaJson.sha;
    var putRes = await fetch(apiUrl, {method:'PUT', headers:ghHdrs, body:JSON.stringify(body)});
    console.log('[save] GitHub:', putRes.status, putRes.ok?'OK':'FAIL');
  } catch(e){ console.log('[save] err:', e.message); }
}

async function getS2(cookie, ua) {
  var csrf = await freshCsrf(cookie, ua);
  var h1 = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  h1[csrf.name] = csrf.value;
  var s1r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4', {headers:h1});
  var s1html = await s1r.text();
  var km = s1html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  var s1Key = km ? km[1] : 'e1s1';
  csrf = await freshCsrf(cookie, ua);
  var h2 = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4'};
  h2[csrf.name] = csrf.value;
  var s2r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
    +'&_flowExecutionKey='+encodeURIComponent(s1Key)
    +'&_eventId=selectParameters&selectedReportId='+REPORT_ID, {headers:h2});
  var s2html = await s2r.text();
  var km2 = s2html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  return {s2html:s2html, s2Key: km2 ? km2[1] : 'e1s2'};
}

async function main() {
  if (ODS_PASS.length < 2) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess = await login(); var cookie = sess.cookie; var ua = sess.ua;
  var findings = {ts:new Date().toISOString(), version:'v15d', sections:{}};

  var s2data = await getS2(cookie, ua);
  var s2html = s2data.s2html;
  var s2Key = s2data.s2Key;
  console.log('S2 key:', s2Key, 'htmlLen:', s2html.length);

  // Extract FULL form section — everything from <form to </form>
  var formStart = s2html.indexOf('<form name="retrieveReportsForm"');
  var formEnd = s2html.indexOf('</form>', formStart) + 7;
  var formHtml = formStart >= 0 ? s2html.substring(formStart, formEnd) : 'NOT FOUND';
  console.log('Form HTML length:', formHtml.length);
  console.log('Form HTML:', formHtml.substring(0,4000).replace(/\s+/g,' '));
  findings.sections.fullForm = formHtml;

  // Extract orgTypes options
  var optRx = /<option\s+value="([^"]*)"[^>]*>([^<]*)<\/option>/g;
  var opts = []; var om;
  while ((om=optRx.exec(formHtml)) !== null) opts.push({val:om[1].trim(),label:om[2].trim()});
  console.log('\norgTypes options:', JSON.stringify(opts));
  findings.sections.orgTypesOptions = opts;

  // Also check the orgTypeValues and storesInOrgType REST calls
  // The JS calls OrgType.orgTypeChanged('1') on change — let's try the REST endpoint
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};
  var orgValR = await fetch(ODS_URL+'/asp/rest_v2/aboveStore/orgTypeValues?orgType=store&storeAccess=true', {headers:jhdrs});
  console.log('\norgTypeValues (store):', orgValR.status, (orgValR.headers.get('content-type')||'').substring(0,40));
  var orgValText = await orgValR.text();
  findings.sections.orgTypeValues_store = orgValText.substring(0,2000);
  console.log(orgValText.substring(0,300));

  // Try the stores endpoint with orgType param
  var storeR2 = await fetch(ODS_URL+'/asp/rest_v2/aboveStore/stores?storeAccess=true&orgType=store', {headers:jhdrs});
  console.log('stores (orgType=store):', storeR2.status);

  // Now POST retrieveReports with correct params
  // orgTypes options will tell us what value to use
  // Try 'store' as orgTypes value, storeId as orgTypeValues, and storeId as storesInOrgType
  var csrf = await freshCsrf(cookie, ua);
  var postHdrs = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/x-www-form-urlencoded',
    'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+s2Key};
  postHdrs[csrf.name] = csrf.value;
  var postResults = [];
  var orgTypeVals = ['store','concept','client','area','region','company','none'];
  // Use first non-none option from form if available
  if (opts.length > 1) orgTypeVals = [opts[1].val, opts[0].val].concat(orgTypeVals);
  var dateVals = [TARGET_DATE, '2026-04-19', '04-19-2026'];
  var storeVals2 = [STORE_ID, '038729', '29865'];

  for (var oi=0; oi<Math.min(orgTypeVals.length,4); oi++) {
    for (var di=0; di<dateVals.length; di++) {
      for (var si=0; si<storeVals2.length; si++) {
        var pb = [
          '_eventId=retrieveReports',
          'orgTypes='+encodeURIComponent(orgTypeVals[oi]),
          'orgTypeValues='+encodeURIComponent(storeVals2[si]),
          'storesInOrgType='+encodeURIComponent(storeVals2[si]),
          'selectedDate='+encodeURIComponent(dateVals[di])
        ].join('&');
        var actionUrl = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+encodeURIComponent(s2Key);
        var pr = await fetch(actionUrl, {method:'POST', headers:postHdrs, body:pb, redirect:'follow'});
        var pct = pr.headers.get('content-type')||'';
        var ploc = pr.headers.get('location')||'';
        if (pct.includes('pdf') || pct.includes('octet')) {
          var buf = await pr.buffer();
          console.log('*** PDF HIT: orgType='+orgTypeVals[oi]+' date='+dateVals[di]+' store='+storeVals2[si]+' ('+buf.length+' bytes)');
          findings.pdfHit = {orgType:orgTypeVals[oi],date:dateVals[di],store:storeVals2[si],bytes:buf.length};
          try { fs.writeFileSync('/opt/render/project/src/public/test-dispatch.pdf', buf); } catch(e){}
          await save(findings);
          await new Promise(function(r){ setTimeout(r,6000); });
          return;
        }
        var respText = await pr.text();
        var snip = respText.substring(0,300).replace(/\s+/g,' ');
        postResults.push({orgType:orgTypeVals[oi],date:dateVals[di],store:storeVals2[si],status:pr.status,ct:pct.substring(0,30),loc:ploc,snip:snip});
        console.log('  orgType='+orgTypeVals[oi]+' date='+dateVals[di]+': '+pr.status+' '+pct.substring(0,30)+' '+ploc.substring(0,60));
        // Need fresh key per attempt since flow advances
        s2data = await getS2(cookie, ua);
        s2Key = s2data.s2Key;
        postHdrs['Referer'] = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+s2Key;
        csrf = await freshCsrf(cookie, ua);
        postHdrs[csrf.name] = csrf.value;
      }
    }
  }
  findings.sections.postResults = postResults.slice(0,12);

  await save(findings);
  await new Promise(function(r){ setTimeout(r,6000); });
  console.log('v15d done');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
