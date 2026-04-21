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
async function getS2(cookie, ua) {
  var csrf = await freshCsrf(cookie, ua);
  var h = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  h[csrf.name] = csrf.value;
  var s1r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4', {headers:h});
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
  return {s2html:s2html, s2Key: km2 ? km2[1] : 'e1s2', cookie:cookie, ua:ua};
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
    var body = {message:'debug v15e '+new Date().toISOString(), content:content64};
    if (shaJson.sha) body.sha = shaJson.sha;
    var putRes = await fetch(apiUrl, {method:'PUT', headers:ghHdrs, body:JSON.stringify(body)});
    console.log('[save] GitHub:', putRes.status, putRes.ok?'OK':'FAIL');
  } catch(e){ console.log('[save] err:', e.message); }
}

async function tryPost(s2data, orgType, orgTypeVal, storeVal, date) {
  var cookie = s2data.cookie; var ua = s2data.ua; var s2Key = s2data.s2Key;
  var csrf = await freshCsrf(cookie, ua);
  var h = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/x-www-form-urlencoded',
    'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+s2Key};
  h[csrf.name] = csrf.value;
  var pb = ['_eventId=retrieveReports',
    'orgTypes='+encodeURIComponent(orgType),
    'orgTypeValues='+encodeURIComponent(orgTypeVal),
    'storesInOrgType='+encodeURIComponent(storeVal),
    'selectedDate='+encodeURIComponent(date)].join('&');
  var r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+encodeURIComponent(s2Key),
    {method:'POST', headers:h, body:pb, redirect:'follow'});
  var ct = r.headers.get('content-type')||'';
  if (ct.includes('pdf') || ct.includes('octet')) {
    var buf = await r.buffer();
    return {hit:true, bytes:buf.length, buf:buf};
  }
  var html = await r.text();
  var titleM = html.match(/<title>([^<]+)<\/title>/i);
  var title = titleM ? titleM[1] : '?';
  // Look for error messages
  var errM = html.match(/class="[^"]*error[^"]*"[^>]*>([^<]{5,80})</i);
  var errMsg = errM ? errM[1].trim() : '';
  return {hit:false, status:r.status, ct:ct.substring(0,30), title:title, err:errMsg, htmlLen:html.length,
    html5k: html.substring(0,5000)};
}

async function main() {
  if (ODS_PASS.length < 2) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess = await login(); var cookie = sess.cookie; var ua = sess.ua;
  var findings = {ts:new Date().toISOString(), version:'v15e', sections:{}};

  // First: probe REST API for orgTypeValues
  console.log('Probing orgTypeValues REST APIs...');
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};
  var orgRestEndpoints = [
    '/asp/rest_v2/aboveStore/orgTypeValues?orgType=area&categoryId=4&storeAccess=true',
    '/asp/rest_v2/aboveStore/orgTypeValues?orgType=area&categoryId=1&storeAccess=true',
    '/asp/rest_v2/aboveStore/orgTypeValues?orgType=area',
    '/asp/rest_v2/aboveStore/orgTypes?categoryId=4&storeAccess=true',
    '/asp/rest_v2/aboveStore/orgTypes?storeAccess=true',
    '/asp/rest_v2/aboveStore/stores?storeAccess=true&orgType=area',
    '/asp/rest_v2/aboveStore/hierarchy?storeAccess=true',
    '/asp/rest_v2/aboveStore/user'
  ];
  var restResults = {};
  for (var i=0; i<orgRestEndpoints.length; i++) {
    var ep = orgRestEndpoints[i];
    var r = await fetch(ODS_URL+ep, {headers:jhdrs});
    var ct = r.headers.get('content-type')||'';
    var body = await r.text();
    var isJson = ct.includes('json');
    restResults[ep] = {status:r.status, ct:ct.substring(0,40), body:body.substring(0,500), isJson:isJson};
    console.log(r.status, ep.substring(30), isJson?'JSON':'HTML');
    if (isJson && r.status===200) console.log('  >>>', body.substring(0,200));
  }
  findings.sections.restProbe = restResults;

  // Now try all realistic orgType+value combos
  // From the PDF: "Trade Area 29" → try area/29, area/29865 (storeId range)
  // Harold companyId=8, brandId=71, datasetId=30
  var combos = [
    {orgType:'area',   orgTypeVal:'29',    store:'all',   date:'2026-04-19'},
    {orgType:'area',   orgTypeVal:'29',    store:'29865', date:'2026-04-19'},
    {orgType:'company',orgTypeVal:'8',     store:'all',   date:'2026-04-19'},
    {orgType:'company',orgTypeVal:'206',   store:'all',   date:'2026-04-19'}, // companyId from filesDir CID206
    {orgType:'concept',orgTypeVal:'71',    store:'all',   date:'2026-04-19'},
    {orgType:'concept',orgTypeVal:'1',     store:'all',   date:'2026-04-19'},
    {orgType:'area',   orgTypeVal:'1',     store:'all',   date:'2026-04-19'},
    {orgType:'region', orgTypeVal:'29',    store:'all',   date:'2026-04-19'},
    {orgType:'market', orgTypeVal:'29',    store:'all',   date:'2026-04-19'},
    {orgType:'none',   orgTypeVal:'0',     store:'all',   date:'2026-04-19'},
    {orgType:'area',   orgTypeVal:'29',    store:'all',   date:'2026-04-20'},
    {orgType:'company',orgTypeVal:'8',     store:'29865', date:'2026-04-19'}
  ];

  var results = [];
  for (var ci=0; ci<combos.length; ci++) {
    var c = combos[ci];
    console.log('Trying: orgType='+c.orgType+' val='+c.orgTypeVal+' store='+c.store+' date='+c.date);
    var s2data = await getS2(cookie, ua);
    s2data.cookie = cookie; s2data.ua = ua;
    var res = await tryPost(s2data, c.orgType, c.orgTypeVal, c.store, c.date);
    console.log('  ->', res.hit ? '*** PDF HIT '+res.bytes+'b' : 'title='+res.title+' err='+res.err);
    if (res.hit) {
      findings.pdfHit = {orgType:c.orgType, orgTypeVal:c.orgTypeVal, store:c.store, date:c.date, bytes:res.bytes};
      try { fs.writeFileSync('/opt/render/project/src/public/test-dispatch.pdf', res.buf); } catch(e){}
      await save(findings);
      await new Promise(function(r){ setTimeout(r,6000); });
      return;
    }
    results.push({combo:c, status:res.status, title:res.title, err:res.err, htmlLen:res.htmlLen,
      html5k: ci < 3 ? res.html5k : undefined});
  }
  findings.sections.comboResults = results;

  await save(findings);
  await new Promise(function(r){ setTimeout(r,6000); });
  console.log('v15e done — no PDF hit');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
