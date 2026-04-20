'use strict';
var fs   = require('fs');
var path = require('path');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';
var GH_TOKEN = process.env.GH_TOKEN || '';
function fetch() { return require('node-fetch').apply(null, arguments); }
function parseCookies(r) {
  return (r.headers.raw()['set-cookie']||[]).map(function(c){return c.split(';')[0];});
}
function mergeCookies(a,b,c) {
  var map=new Map();
  [].concat(a||[],b||[],c||[]).forEach(function(ck){var n=ck.split('=')[0];map.set(n,ck);});
  return Array.from(map.values()).join('; ');
}
async function login() {
  var UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  var r1=await fetch(ODS_URL+'/asp/login.html',{headers:{'User-Agent':UA}});
  var c1=parseCookies(r1);
  var r2=await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
    headers:{'Cookie':mergeCookies(c1),'FETCH-CSRF-TOKEN':'1','X-Requested-With':'XMLHttpRequest','User-Agent':UA}});
  var c2=parseCookies(r2); var raw=await r2.text(); var colon=raw.indexOf(':');
  var cn=raw.substring(0,colon).trim(); var cv=raw.substring(colon+1).trim();
  var fb=['orgId='+encodeURIComponent(ODS_ORG),'j_username='+encodeURIComponent(ODS_USER),
    'j_password='+encodeURIComponent(ODS_PASS),'j_password_pseudo='+encodeURIComponent(ODS_PASS),
    cn+'='+encodeURIComponent(cv)].join('&');
  var r3=await fetch(ODS_URL+'/asp/j_spring_security_check',{method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':mergeCookies(c1,c2),
             'Referer':ODS_URL+'/asp/login.html','Origin':ODS_URL,'User-Agent':UA},body:fb});
  var c3=parseCookies(r3); var loc=r3.headers.get('location')||'';
  if(loc.indexOf('error')>=0) throw new Error('Login failed: '+loc);
  return {cookie:mergeCookies(c1,c2,c3),ua:UA};
}

async function save(findings) {
  // Save to public/ for HTTP access
  var pub = '/opt/render/project/src/public/debug-output.json';
  fs.writeFileSync(pub, JSON.stringify(findings,null,2));
  console.log('[save] Written to public/debug-output.json');
  // GitHub API push -- no local git state dependency
  if (!GH_TOKEN) { console.log('[save] GH_TOKEN not set (len=0)'); return; }
  console.log('[save] Pushing via GitHub API...');
  var content64 = Buffer.from(JSON.stringify(findings,null,2)).toString('base64');
  var apiUrl = 'https://api.github.com/repos/halaco225/pai-/contents/debug-output.json';
  var ghHdrs = {'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug',
    'Content-Type':'application/json','Accept':'application/vnd.github+json'};
  try {
    var shaRes = await fetch(apiUrl, {headers:ghHdrs});
    var shaJson = shaRes.ok ? await shaRes.json() : {};
    var body = {message:'debug output '+new Date().toISOString(), content:content64};
    if (shaJson.sha) body.sha = shaJson.sha;
    var putRes = await fetch(apiUrl, {method:'PUT', headers:ghHdrs, body:JSON.stringify(body)});
    var putJson = await putRes.json();
    console.log('[save] GitHub API:', putRes.status, putRes.ok ? 'OK' : JSON.stringify(putJson).substring(0,100));
  } catch(e) {
    console.log('[save] GitHub API error:', e.message);
  }
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  console.log('[env] GH_TOKEN len:', GH_TOKEN.length);
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;
  var findings = {ts: new Date().toISOString(), ghTokenLen: GH_TOKEN.length, sections:{}};
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};
  var execHdrs = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/json','Accept':'application/json'};

  // A. ALL accessible report units
  console.log('\n--- A. ALL report units ---');
  var r = await fetch(ODS_URL+'/asp/rest_v2/resources?type=reportUnit&limit=500&sortBy=label', {headers:jhdrs});
  var j = await r.json();
  var items = j.resourceLookup || [];
  console.log('Total:', items.length);
  items.forEach(function(i){ console.log('  '+i.label+' -> '+i.uri); });
  findings.sections.allReports = items.map(function(i){ return {label:i.label, uri:i.uri}; });

  // B. Full folder listings (recursive)
  console.log('\n--- B. Folder listings ---');
  var folders = ['/Reports/Pizza_Hut/Operations','/Reports/Multibrand/Operations','/Reports/Cyclone_Anayas/Operations'];
  var allOps = {};
  for (var fi=0; fi<folders.length; fi++) {
    var fr = await fetch(ODS_URL+'/asp/rest_v2/resources?folderUri='+encodeURIComponent(folders[fi])+'&recursive=true&limit=500', {headers:jhdrs});
    var fj = await fr.json();
    var fi2 = fj.resourceLookup || [];
    allOps[folders[fi]] = fi2.map(function(i){ return {type:i.resourceType, label:i.label, uri:i.uri}; });
    console.log('\n'+folders[fi]+' ('+fi2.length+'):');
    fi2.forEach(function(i){ console.log('  ['+i.resourceType+'] '+i.label+' -> '+i.uri); });
  }
  findings.sections.allOps = allOps;

  // C. IST URI brute-force via reportExecutions
  console.log('\n--- C. IST brute-force ---');
  var guesses = [
    '/Reports/Pizza_Hut/Operations/SUS_IST',
    '/Reports/Pizza_Hut/Operations/PH_IST',
    '/Reports/Pizza_Hut/Operations/PH_InStoreTime',
    '/Reports/Pizza_Hut/Operations/PH_Speed_of_Service',
    '/Reports/Pizza_Hut/Operations/PH_Instore',
    '/Reports/Pizza_Hut/Operations/SUS_InStore',
    '/Reports/Pizza_Hut/Operations/PH_OpsIST',
    '/Reports/Multibrand/Operations/IST',
    '/Reports/Multibrand/Operations/InStoreTime',
  ];
  var istHits = [];
  for (var gi=0; gi<guesses.length; gi++) {
    var uri = guesses[gi];
    var er = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions',
      {method:'POST', headers:execHdrs,
       body:JSON.stringify({reportUnitUri:uri, outputFormat:'pdf', async:false, freshData:false})});
    var ej = await er.json();
    var hit = er.status===200 && ej.requestId;
    console.log('  '+uri.split('/').pop().padEnd(30)+' -> '+er.status+(hit?' *** HIT requestId='+ej.requestId:''));
    if (hit) { istHits.push({uri:uri, requestId:ej.requestId, pages:ej.totalPages}); }
  }
  findings.sections.istHits = istHits;

  // D. s1 HTML lines 420-620 with categoryId=4
  console.log('\n--- D. s1 lines 420-620 (categoryId=4) ---');
  var csrf = await (async function(){
    var rr=await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
      headers:{'Cookie':cookie,'FETCH-CSRF-TOKEN':'1','User-Agent':ua}});
    var t=await rr.text(); var c=t.indexOf(':');
    return {name:t.substring(0,c).trim(),value:t.substring(c+1).trim()};
  })();
  var dh = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  dh[csrf.name]=csrf.value;
  var s1r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4', {headers:dh});
  var s1html = await s1r.text();
  var s1lines = s1html.split('\n');
  var region = s1lines.slice(419,620).join('\n');
  console.log(region.substring(0,3000));
  findings.sections.s1Region = region;

  await save(findings);
  // Allow async GitHub API call to complete
  await new Promise(function(r){ setTimeout(r,4000); });
  console.log('\nDone.');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
