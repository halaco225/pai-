'use strict';
var fs   = require('fs');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var GH_TOKEN = process.env.GH_TOKEN || '';

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
    headers:{'Cookie':mergeCookies(c1),'FETCH-CSRF-TOKEN':'1',
             'X-Requested-With':'XMLHttpRequest','User-Agent':UA}});
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
  try { fs.writeFileSync(pub, JSON.stringify(findings,null,2)); } catch(e) {}
  if (GH_TOKEN.length < 5) { console.log('[save] no GH_TOKEN'); return; }
  var content64 = Buffer.from(JSON.stringify(findings,null,2)).toString('base64');
  var apiUrl = 'https://api.github.com/repos/halaco225/pai-/contents/debug-output.json';
  var ghHdrs = {'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug',
    'Content-Type':'application/json','Accept':'application/vnd.github+json'};
  try {
    var shaRes = await fetch(apiUrl, {headers:ghHdrs});
    var shaJson = shaRes.ok ? await shaRes.json() : {};
    var body = {message:'debug v15 '+new Date().toISOString(), content:content64};
    if (shaJson.sha) body.sha = shaJson.sha;
    var putRes = await fetch(apiUrl, {method:'PUT', headers:ghHdrs, body:JSON.stringify(body)});
    console.log('[save] GitHub:', putRes.status, putRes.ok?'OK':'FAIL');
  } catch(e) { console.log('[save] err:', e.message); }
}

async function main() {
  if (ODS_PASS.length < 2) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  console.log('[env] GH_TOKEN len:', GH_TOKEN.length);
  var sess = await login(); var cookie = sess.cookie; var ua = sess.ua;
  console.log('Login OK');
  var findings = {ts:new Date().toISOString(), version:'v15', sections:{}};

  // A. JRS resources keyword search
  console.log('\n--- A. keyword search ---');
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};
  var keywords = ['IST','InStore','instore','SpeedOfService','SOS','Instore','Timing'];
  var allFound = {};
  for (var ki=0; ki<keywords.length; ki++) {
    var kw = keywords[ki];
    var r = await fetch(ODS_URL+'/asp/rest_v2/resources?type=reportUnit&q='+encodeURIComponent(kw)+'&limit=50', {headers:jhdrs});
    var j = await r.json();
    var items = (j.resourceLookup||[]).map(function(i){return {label:i.label,uri:i.uri};});
    console.log('  ['+kw+'] '+items.length+' hits');
    items.forEach(function(i){ console.log('    '+i.label+' -> '+i.uri); });
    if (items.length > 0) allFound[kw] = items;
  }
  findings.sections.keywordSearch = allFound;

  // B. Full folder recursive listing
  console.log('\n--- B. folder listings ---');
  var folders = ['/Reports/Pizza_Hut','/Reports/Multibrand'];
  var folderResults = {};
  for (var fi=0; fi<folders.length; fi++) {
    var fp = folders[fi];
    var fr = await fetch(ODS_URL+'/asp/rest_v2/resources?folderUri='+encodeURIComponent(fp)+'&recursive=true&limit=500&type=reportUnit', {headers:jhdrs});
    var fj = await fr.json();
    var items2 = (fj.resourceLookup||[]).map(function(i){return {label:i.label,uri:i.uri};});
    console.log('  '+fp+': '+items2.length+' reports');
    items2.forEach(function(i){ console.log('    '+i.label+' -> '+i.uri); });
    folderResults[fp] = items2;
  }
  findings.sections.folderListings = folderResults;

  // C. Flow categoryId scan 1-15
  console.log('\n--- C. categoryId scan ---');
  var csrf = await freshCsrf(cookie, ua);
  var flowHdrs = {Cookie:cookie,'User-Agent':ua,
    'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  flowHdrs[csrf.name] = csrf.value;
  var catResults = {};
  for (var catId=1; catId<=15; catId++) {
    var sr = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId='+catId, {headers:flowHdrs});
    var shtml = await sr.text();
    var rx = /selectedReportId=(\d+)">([^<]{1,80})<\/a>/g;
    var reports = []; var m;
    while ((m=rx.exec(shtml)) !== null) {
      var rname = m[2].replace(/<[^>]+>/g,'').trim();
      if (rname && rname.length > 0 && rname.length < 100) reports.push({id:m[1],name:rname});
    }
    catResults[catId] = reports;
    if (reports.length > 0) {
      console.log('  cat='+catId+': '+reports.map(function(r){return r.id+':'+r.name;}).join(', '));
    } else {
      console.log('  cat='+catId+': empty');
    }
    if (catId % 5 === 0) {
      csrf = await freshCsrf(cookie, ua);
      flowHdrs[csrf.name] = csrf.value;
    }
  }
  findings.sections.categoryReports = catResults;

  // D. URI brute-force via reportExecutions
  console.log('\n--- D. URI brute-force ---');
  var execHdrs = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/json','Accept':'application/json'};
  var guesses = [
    '/Reports/Pizza_Hut/Operations/SUS_IST',
    '/Reports/Pizza_Hut/Operations/PH_IST',
    '/Reports/Pizza_Hut/Operations/PH_InStoreTime',
    '/Reports/Pizza_Hut/Operations/PH_Speed_of_Service',
    '/Reports/Pizza_Hut/Operations/PH_Instore',
    '/Reports/Pizza_Hut/Operations/SUS_InStore',
    '/Reports/Pizza_Hut/Operations/PH_SOS',
    '/Reports/Pizza_Hut/Operations/PH_SpeedOfService',
    '/Reports/Pizza_Hut/Operations/PH_ServiceTimes',
    '/Reports/Pizza_Hut/Operations/PH_DailyIST',
    '/Reports/Pizza_Hut/Operations/IST',
    '/Reports/Pizza_Hut/Operations/InStoreTime',
    '/Reports/Pizza_Hut/Operations/PH_DailyOperations',
    '/Reports/Pizza_Hut/Operations/PH_DriverHistory',
    '/Reports/Pizza_Hut/Operations/PH_IST_Daily',
    '/Reports/Pizza_Hut/Operations/DailyIST',
    '/Reports/Pizza_Hut/Operations/PH_Timing',
    '/Reports/Pizza_Hut/Operations/PH_OvenTimes',
    '/Reports/Pizza_Hut/Operations/PH_OrderTimes',
    '/Reports/Multibrand/Operations/IST',
    '/Reports/Multibrand/Operations/PH_IST'
  ];
  var uriHits = [];
  for (var gi=0; gi<guesses.length; gi++) {
    var uri2 = guesses[gi];
    try {
      var er = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions',
        {method:'POST', headers:execHdrs,
         body:JSON.stringify({reportUnitUri:uri2,outputFormat:'pdf',async:false,freshData:false})});
      var ej = await er.json();
      var hit2 = er.status===200 && ej.requestId;
      var shortName = uri2.split('/').pop();
      if (hit2) {
        console.log('  HIT: '+shortName+' -> requestId='+ej.requestId);
        uriHits.push({uri:uri2,requestId:ej.requestId});
      } else if (er.status === 200 && ej.errorCode) {
        console.log('  '+er.status+' errorCode='+ej.errorCode+': '+shortName);
      }
    } catch(e) { console.log('  ERR '+uri2+': '+e.message); }
  }
  findings.sections.uriHits = uriHits;

  await save(findings);
  await new Promise(function(r){ setTimeout(r, 6000); });
  console.log('v15 done.');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
