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
    var body = {message:'debug v15f '+new Date().toISOString(), content:content64};
    if (shaJson.sha) body.sha = shaJson.sha;
    var putRes = await fetch(apiUrl, {method:'PUT', headers:ghHdrs, body:JSON.stringify(body)});
    console.log('[save] GitHub:', putRes.status, putRes.ok?'OK':'FAIL');
  } catch(e){ console.log('[save] err:', e.message); }
}

async function main() {
  if (ODS_PASS.length < 2) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess = await login(); var cookie = sess.cookie; var ua = sess.ua;
  var findings = {ts:new Date().toISOString(), version:'v15f', sections:{}};
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};

  // A. JRS keyword search for Dispatch/Daily
  console.log('A. JRS keyword search...');
  var kws = ['Dispatch','Daily','DailyDispatch','Performance','Instore','Driver'];
  var kwResults = {};
  for (var ki=0; ki<kws.length; ki++) {
    var r = await fetch(ODS_URL+'/asp/rest_v2/resources?type=reportUnit&q='+encodeURIComponent(kws[ki])+'&limit=50', {headers:jhdrs});
    var j = await r.json();
    var items = (j.resourceLookup||[]).map(function(i){return {label:i.label,uri:i.uri};});
    console.log('  ['+kws[ki]+'] '+items.length+' hits');
    items.forEach(function(i){ console.log('    '+i.label+' -> '+i.uri); });
    if (items.length > 0) kwResults[kws[ki]] = items;
  }
  findings.sections.kwSearch = kwResults;

  // B. Recursive folder listing
  console.log('\nB. Folder listing...');
  var fr = await fetch(ODS_URL+'/asp/rest_v2/resources?folderUri=%2FReports%2FPizza_Hut&recursive=true&limit=500&type=reportUnit', {headers:jhdrs});
  var fj = await fr.json();
  var folderItems = (fj.resourceLookup||[]).map(function(i){return {label:i.label,uri:i.uri};});
  console.log('  /Reports/Pizza_Hut: '+folderItems.length+' reports');
  folderItems.forEach(function(i){ console.log('    '+i.label+' -> '+i.uri); });
  findings.sections.folderPH = folderItems;

  // C. Get full s3 HTML for area/29 submission — save chars 0-25000
  console.log('\nC. Full s3 response...');
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
  var s2Key = km2 ? km2[1] : 'e1s2';

  csrf = await freshCsrf(cookie, ua);
  var hp = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/x-www-form-urlencoded',
    'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+s2Key};
  hp[csrf.name] = csrf.value;
  var pb = '_eventId=retrieveReports&orgTypes=area&orgTypeValues=29&storesInOrgType=all&selectedDate=2026-04-19';
  var s3r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+encodeURIComponent(s2Key),
    {method:'POST', headers:hp, body:pb, redirect:'follow'});
  var s3ct = s3r.headers.get('content-type')||'';
  var s3html = await s3r.text();
  console.log('  s3 status='+s3r.status+' ct='+s3ct+' len='+s3html.length);
  if (s3ct.includes('pdf')) {
    findings.pdfHit = {bytes:s3html.length, method:'direct'};
  }
  // Save different windows of the HTML
  findings.sections.s3_0_5k   = s3html.substring(0,5000);
  findings.sections.s3_5_15k  = s3html.substring(5000,15000);
  findings.sections.s3_15_25k = s3html.substring(15000,25000);
  findings.sections.s3_flowKey = (s3html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/) || ['',''])[1];
  findings.sections.s3_ct = s3ct;
  findings.sections.s3_len = s3html.length;
  // Extract iframes and anchors
  var iframes = (s3html.match(/<iframe[^>]+src="([^"]+)"/g)||[]).map(function(m){return m;});
  var links = (s3html.match(/href="([^"]*(?:pdf|report|export|download)[^"]*)"/gi)||[]).map(function(m){return m;});
  findings.sections.s3_iframes = iframes.slice(0,10);
  findings.sections.s3_links = links.slice(0,10);
  console.log('  iframes:', iframes.slice(0,3));
  console.log('  links:', links.slice(0,3));
  console.log('  flowKey in s3:', findings.sections.s3_flowKey);

  await save(findings);
  await new Promise(function(r){ setTimeout(r,6000); });
  console.log('v15f done');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
