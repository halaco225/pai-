'use strict';
var fs = require('fs');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var GH_TOKEN = process.env.GH_TOKEN || '';
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
    var body = {message:'debug v15g '+new Date().toISOString(), content:content64};
    if (shaJson.sha) body.sha = shaJson.sha;
    var putRes = await fetch(apiUrl, {method:'PUT', headers:ghHdrs, body:JSON.stringify(body)});
    console.log('[save] GitHub:', putRes.status, putRes.ok?'OK':'FAIL');
  } catch(e){ console.log('[save] err:', e.message); }
}

async function main() {
  if (ODS_PASS.length < 2) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess = await login(); var cookie = sess.cookie; var ua = sess.ua;
  var findings = {ts:new Date().toISOString(), version:'v15g', sections:{}};
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};

  // Step 1: call the same XHR the browser calls to get company list
  console.log('Step 1: fetch orgType company list (brandId=1)...');
  var brandIds = ['1','71','8','30'];
  var companyId = null;
  for (var bi=0; bi<brandIds.length; bi++) {
    var or = await fetch(ODS_URL+'/asp/rest_v2/aboveStore/orgType?brandId='+brandIds[bi]+'&orgType=company', {headers:jhdrs});
    var oct = or.headers.get('content-type')||'';
    var obody = await or.text();
    console.log('  brandId='+brandIds[bi]+': '+or.status+' '+oct.substring(0,30)+' -> '+obody.substring(0,300));
    findings.sections['orgType_brandId_'+brandIds[bi]] = {status:or.status, body:obody.substring(0,500)};
    if (or.status===200 && oct.includes('json')) {
      try {
        var oj = JSON.parse(obody);
        // Find Ayvaz entry
        var items = oj.item || oj.items || oj.companies || oj.data || [];
        items.forEach(function(item) {
          console.log('    item:', JSON.stringify(item));
          var n = (item.name||item.label||item.orgValue||'').toLowerCase();
          if (n.indexOf('ayvaz')>=0 || n.indexOf('pizza')>=0) {
            companyId = item.id || item.value || item.orgValueId || item.storeId || null;
            console.log('    *** AYVAZ found, id='+companyId);
          }
        });
      } catch(e) { console.log('  parse err:', e.message); }
    }
  }
  findings.sections.detectedCompanyId = companyId;

  // Also try orgTypeValue endpoint (the second XHR from browser)
  console.log('\nFetching orgTypeValue stores...');
  var ovr = await fetch(ODS_URL+'/asp/rest_v2/aboveStore/orgTypeValue?storeAccess=true&brandId=1&orgType=company', {headers:jhdrs});
  var ovbody = await ovr.text();
  console.log('  orgTypeValue:', ovr.status, ovbody.substring(0,400));
  findings.sections.orgTypeValueEndpoint = {status:ovr.status, body:ovbody.substring(0,1000)};

  // Step 2: get to s2
  console.log('\nStep 2: get s2...');
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
  var s2Key = km2 ? km2[1] : 'e1s2';
  console.log('  s2Key:', s2Key);

  // Step 3: POST with company + all stores
  var orgTypeValsToTry = companyId ? [String(companyId)] : [];
  orgTypeValsToTry = orgTypeValsToTry.concat(['8','206','71','1','30','0','all']);
  var postResults = [];
  for (var oi=0; oi<orgTypeValsToTry.length; oi++) {
    var ov = orgTypeValsToTry[oi];
    // Get fresh s2 each time
    csrf = await freshCsrf(cookie, ua);
    var h1b = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
      'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
    h1b[csrf.name] = csrf.value;
    var s1rb = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4', {headers:h1b});
    var s1hb = await s1rb.text();
    var kmb = s1hb.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
    var s1kb = kmb ? kmb[1] : 'e1s1';
    csrf = await freshCsrf(cookie, ua);
    var h2b = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
      'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4'};
    h2b[csrf.name] = csrf.value;
    var s2rb = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
      +'&_flowExecutionKey='+encodeURIComponent(s1kb)+'&_eventId=selectParameters&selectedReportId='+REPORT_ID, {headers:h2b});
    var s2hb = await s2rb.text();
    var km2b = s2hb.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
    var s2kb = km2b ? km2b[1] : 'e1s2';

    csrf = await freshCsrf(cookie, ua);
    var hp = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/x-www-form-urlencoded',
      'X-Requested-With':'OWASP CSRFGuard Project',
      'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+s2kb};
    hp[csrf.name] = csrf.value;
    var pb = '_eventId=retrieveReports&orgTypes=company&orgTypeValues='+encodeURIComponent(ov)+'&storesInOrgType=all&selectedDate=2026-04-19';
    var pr = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+encodeURIComponent(s2kb),
      {method:'POST', headers:hp, body:pb, redirect:'follow'});
    var pct = pr.headers.get('content-type')||'';
    var ploc = pr.headers.get('location')||'';
    if (pct.includes('pdf') || pct.includes('octet')) {
      var buf = await pr.buffer();
      console.log('*** PDF HIT: orgTypeValues='+ov+' ('+buf.length+' bytes)');
      findings.pdfHit = {orgTypeValues:ov, bytes:buf.length};
      try { fs.writeFileSync('/opt/render/project/src/public/test-dispatch.pdf', buf); } catch(e){}
      await save(findings);
      await new Promise(function(r){ setTimeout(r,6000); });
      return;
    }
    var phtml = await pr.text();
    var ptitle = (phtml.match(/<title>([^<]+)<\/title>/i)||['','?'])[1];
    var pkey = (phtml.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/) || ['',''])[1];
    // Save full HTML for first attempt
    if (oi===0) findings.sections.firstAttemptHtml = phtml.substring(0,30000);
    // Look for iframes, JS window.open, report URLs
    var iframes = (phtml.match(/src="([^"]*(?:report|viewer|execute|pdf)[^"]*)"/gi)||[]).slice(0,5);
    var jsurls = (phtml.match(/(?:window\.open|location\.href)\s*[=(]\s*['"]([^'"]+)['"]/g)||[]).slice(0,5);
    console.log('  orgTypeValues='+ov+': status='+pr.status+' title='+ptitle+' key='+pkey+' iframes='+iframes.length+' jsurls='+jsurls.length);
    postResults.push({ov:ov, status:pr.status, title:ptitle, key:pkey, iframes:iframes, jsurls:jsurls, htmlLen:phtml.length});
  }
  findings.sections.postResults = postResults;

  await save(findings);
  await new Promise(function(r){ setTimeout(r,6000); });
  console.log('v15g done');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
