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
var CATEGORY_ID = '4';

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
    var body = {message:'debug v15c '+new Date().toISOString(), content:content64};
    if (shaJson.sha) body.sha = shaJson.sha;
    var putRes = await fetch(apiUrl, {method:'PUT', headers:ghHdrs, body:JSON.stringify(body)});
    console.log('[save] GitHub:', putRes.status, putRes.ok?'OK':'FAIL');
  } catch(e){ console.log('[save] err:', e.message); }
}

async function main() {
  if (ODS_PASS.length < 2) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess = await login(); var cookie = sess.cookie; var ua = sess.ua;
  var findings = {ts:new Date().toISOString(), version:'v15c', sections:{}};

  // S1 + S2 same as before
  var csrf = await freshCsrf(cookie, ua);
  var h1 = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  h1[csrf.name] = csrf.value;
  var s1r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId='+CATEGORY_ID, {headers:h1});
  var s1html = await s1r.text();
  var km = s1html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  var s1Key = km ? km[1] : 'e1s1';
  console.log('S1 key:', s1Key);

  csrf = await freshCsrf(cookie, ua);
  var h2 = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4'};
  h2[csrf.name] = csrf.value;
  var s2url = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
    +'&_flowExecutionKey='+encodeURIComponent(s1Key)
    +'&_eventId=selectParameters&selectedReportId='+REPORT_ID;
  var s2r = await fetch(s2url, {headers:h2});
  var s2html = await s2r.text();
  var km2 = s2html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  var s2Key = km2 ? km2[1] : 'e1s2';
  console.log('S2 key:', s2Key, 'html len:', s2html.length);

  // Extract the FULL form section from s2 — search for instore-specific content
  var formStart = s2html.indexOf('retrieveReportsForm');
  if (formStart < 0) formStart = s2html.indexOf('selectedDate');
  if (formStart < 0) formStart = s2html.indexOf('instore');
  var formSnippet = formStart >= 0 ? s2html.substring(Math.max(0,formStart-200), Math.min(s2html.length, formStart+3000)) : 'NOT_FOUND';
  console.log('Form snippet (selectedDate area):', formSnippet.substring(0,500).replace(/\s+/g,' '));
  findings.sections.s2FormSnippet = formSnippet;

  // Also look for aboveStore JS config
  var aboveStoreConfig = '';
  var acM = s2html.match(/aboveStore[\s\S]{0,2000}?selectedDate/);
  if (acM) aboveStoreConfig = acM[0];
  findings.sections.aboveStoreConfig = aboveStoreConfig.substring(0,2000);

  // Look for any onclick, href, action containing flow or report
  var flowRefs = [];
  var frx = /(?:href|action|onclick)="([^"]*(?:flow|report|getReport)[^"]*)"/g;
  var fm;
  while ((fm=frx.exec(s2html)) !== null) flowRefs.push(fm[1].substring(0,200));
  findings.sections.flowRefs = flowRefs.slice(0,20);
  console.log('Flow refs:', flowRefs.slice(0,5));

  // Fetch aboveStore.main JS to find form submit handler
  console.log('\nFetching aboveStore.main...');
  var mainR = await fetch(ODS_URL+'/asp/aboveStore/js/aboveStore.main.js', {
    headers:{Cookie:cookie,'User-Agent':ua}});
  var mainJs = mainR.ok ? await mainR.text() : '';
  if (!mainJs) {
    mainR = await fetch(ODS_URL+'/asp/optimized-scripts/aboveStore.main.js', {headers:{Cookie:cookie,'User-Agent':ua}});
    mainJs = mainR.ok ? await mainR.text() : '';
  }
  console.log('aboveStore.main len:', mainJs.length);
  // Find submit/getReport/viewReport logic
  var submitSnip = '';
  var si = mainJs.indexOf('getReportsForView');
  if (si < 0) si = mainJs.indexOf('viewReport');
  if (si < 0) si = mainJs.indexOf('selectedDate');
  if (si >= 0) submitSnip = mainJs.substring(Math.max(0,si-300), Math.min(mainJs.length,si+500));
  findings.sections.aboveStoreMainSnippet = submitSnip;
  console.log('aboveStore.main submit snippet:', submitSnip.substring(0,300).replace(/\s+/g,' '));

  // Try GET variants with correct field names using s2Key
  console.log('\nTrying GET variants with selectedDate...');
  var dateFormats = [TARGET_DATE, '2026-04-19', '04-19-2026'];
  var storeVals = [STORE_ID, '038729', '38729'];
  var eventIds = ['getReportsForView','viewReports','downloadReport','getReport','viewReport'];
  var gAttempts = [];
  csrf = await freshCsrf(cookie, ua);
  var h3 = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project','Referer':s2url};
  h3[csrf.name] = csrf.value;

  for (var ei=0; ei<eventIds.length; ei++) {
    for (var di=0; di<dateFormats.length; di++) {
      var gUrl = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
        +'&_flowExecutionKey='+encodeURIComponent(s2Key)
        +'&_eventId='+eventIds[ei]
        +'&exportType=pdf&contentDisposition=attachment'
        +'&selectedDate='+encodeURIComponent(dateFormats[di])
        +'&storesInOrgType='+storeVals[0]
        +'&orgTypes='+storeVals[0];
      var gr = await fetch(gUrl, {headers:h3, redirect:'follow'});
      var gct = gr.headers.get('content-type')||'';
      if (gct.includes('pdf') || gct.includes('octet')) {
        var buf = await gr.buffer();
        console.log('*** PDF HIT GET: event='+eventIds[ei]+' date='+dateFormats[di]+' ('+buf.length+' bytes)');
        findings.pdfHit = {method:'GET',event:eventIds[ei],date:dateFormats[di],bytes:buf.length};
        var pub = '/opt/render/project/src/public/test-dispatch.pdf';
        try { fs.writeFileSync(pub, buf); } catch(e){}
        await save(findings);
        await new Promise(function(r){ setTimeout(r,6000); });
        return;
      }
      gAttempts.push({event:eventIds[ei],date:dateFormats[di],status:gr.status,ct:gct.substring(0,40)});
      console.log('  GET '+eventIds[ei]+'/'+dateFormats[di]+': '+gr.status+' '+gct.substring(0,40));
    }
  }
  findings.sections.getAttempts = gAttempts;

  // Try POST with selectedDate + storesInOrgType
  console.log('\nTrying POST with selectedDate...');
  var postAttempts = [];
  csrf = await freshCsrf(cookie, ua);
  h3[csrf.name] = csrf.value;
  var h3p = Object.assign({}, h3, {'Content-Type':'application/x-www-form-urlencoded'});
  for (var ei2=0; ei2<eventIds.length; ei2++) {
    for (var di2=0; di2<dateFormats.length; di2++) {
      var pb = [
        '_flowExecutionKey='+encodeURIComponent(s2Key),
        '_eventId='+eventIds[ei2],
        'exportType=pdf',
        'contentDisposition=attachment',
        'selectedDate='+encodeURIComponent(dateFormats[di2]),
        'storesInOrgType='+STORE_ID,
        'orgTypes=Pizza_Hut'
      ].join('&');
      var pr = await fetch(ODS_URL+'/asp/flow.html', {method:'POST',headers:h3p,body:pb,redirect:'follow'});
      var pct = pr.headers.get('content-type')||'';
      if (pct.includes('pdf') || pct.includes('octet')) {
        var buf2 = await pr.buffer();
        console.log('*** PDF HIT POST: event='+eventIds[ei2]+' date='+dateFormats[di2]+' ('+buf2.length+' bytes)');
        findings.pdfHit = {method:'POST',event:eventIds[ei2],date:dateFormats[di2],bytes:buf2.length};
        try { fs.writeFileSync('/opt/render/project/src/public/test-dispatch.pdf', buf2); } catch(e){}
        await save(findings);
        await new Promise(function(r){ setTimeout(r,6000); });
        return;
      }
      postAttempts.push({event:eventIds[ei2],date:dateFormats[di2],status:pr.status,ct:pct.substring(0,40)});
      console.log('  POST '+eventIds[ei2]+'/'+dateFormats[di2]+': '+pr.status+' '+pct.substring(0,40));
    }
  }
  findings.sections.postAttempts = postAttempts;

  await save(findings);
  await new Promise(function(r){ setTimeout(r,6000); });
  console.log('v15c done — no PDF hit');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
