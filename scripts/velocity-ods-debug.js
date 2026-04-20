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

function save(findings) {
  // Save to public/ for HTTP access
  var pub = '/opt/render/project/src/public/debug-output.json';
  fs.writeFileSync(pub, JSON.stringify(findings,null,2));
  console.log('[save] public/debug-output.json written');
  // Git push
  if (GH_TOKEN) {
    try {
      var exec = require('child_process').execSync;
      var d = '/opt/render/project/src';
      fs.writeFileSync(path.join(d,'debug-output.json'), JSON.stringify(findings,null,2));
      exec('git config user.email "harold@ayvaz.com"', {cwd:d});
      exec('git config user.name "PAi"', {cwd:d});
      exec('git add debug-output.json', {cwd:d});
      try { exec('git commit -m "debug v14 output"', {cwd:d}); } catch(e){}
      exec('git push https://'+GH_TOKEN+'@github.com/halaco225/pai-.git HEAD:main 2>&1', {cwd:d, timeout:30000});
      console.log('[save] git push OK');
    } catch(e) {
      console.log('[save] git err:', (e.stderr||e.message||'').toString().substring(0,150));
    }
  }
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  console.log('[env] GH_TOKEN len:', GH_TOKEN.length);
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;
  var findings = {ts: new Date().toISOString(), sections:{}};
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};
  var execHdrs = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/json','Accept':'application/json'};

  // A. List ALL report units (sorted, no limit)
  console.log('\n--- A. ALL report units ---');
  var r = await fetch(ODS_URL+'/asp/rest_v2/resources?type=reportUnit&limit=500&sortBy=label', {headers:jhdrs});
  var j = await r.json();
  var items = j.resourceLookup || [];
  console.log('Total:', items.length);
  items.forEach(function(i){ console.log('  '+i.label+' -> '+i.uri); });
  findings.sections.allReports = items.map(function(i){ return {label:i.label, uri:i.uri}; });

  // B. Operations folder - FULL with recursive
  console.log('\n--- B. All Operations items (recursive) ---');
  var folders = [
    '/Reports/Pizza_Hut/Operations',
    '/Reports/Multibrand/Operations',
    '/Reports/Cyclone_Anayas/Operations'
  ];
  var allOps = {};
  for (var fi=0; fi<folders.length; fi++) {
    var fr = await fetch(ODS_URL+'/asp/rest_v2/resources?folderUri='+encodeURIComponent(folders[fi])+'&recursive=true&limit=500', {headers:jhdrs});
    var fj = await fr.json();
    var fitems = fj.resourceLookup || [];
    allOps[folders[fi]] = fitems.map(function(i){ return {type:i.resourceType, label:i.label, uri:i.uri}; });
    console.log('\n' + folders[fi] + ' (' + fitems.length + ' items):');
    fitems.forEach(function(i){ console.log('  ['+i.resourceType+'] '+i.label+' -> '+i.uri); });
  }
  findings.sections.allOps = allOps;

  // C. Try reportExecution with many IST guesses (SUS pattern)
  console.log('\n--- C. IST URI brute-force ---');
  var guesses = [
    '/Reports/Pizza_Hut/Operations/SUS_IST',
    '/Reports/Pizza_Hut/Operations/PH_IST',
    '/Reports/Pizza_Hut/Operations/IST',
    '/Reports/Pizza_Hut/Operations/InStoreTime',
    '/Reports/Pizza_Hut/Operations/PH_InStoreTime',
    '/Reports/Pizza_Hut/Operations/PH_Instore_Time_Report',
    '/Reports/Pizza_Hut/Operations/PH_In_Store_Time',
    '/Reports/Pizza_Hut/Operations/PH_Speed_of_Service',
    '/Reports/Pizza_Hut/Operations/PH_SOS_Report',
    '/Reports/Pizza_Hut/Operations/SUS_InStore',
    '/Reports/Pizza_Hut/Operations/PH_Velocity',
    '/Reports/Pizza_Hut/Operations/PH_OPS_IST',
    '/Reports/Multibrand/Operations/IST',
    '/Reports/Multibrand/Operations/InStoreTime',
    '/Reports/Multibrand/Operations/SUS_IST',
    '/Dashboards/widgets/multibrand/IST',
  ];
  var istHits = [];
  for (var gi=0; gi<guesses.length; gi++) {
    var uri = guesses[gi];
    var er = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions',
      {method:'POST', headers:execHdrs,
       body:JSON.stringify({reportUnitUri:uri, outputFormat:'pdf', async:false, freshData:false})});
    var ej = await er.json();
    var hit = er.status === 200 && ej.requestId;
    console.log('  '+uri.split('/').pop().padEnd(35)+' -> '+er.status+(hit?' *** HIT! requestId='+ej.requestId:''));
    if (hit) {
      istHits.push({uri:uri, requestId:ej.requestId, pages:ej.totalPages});
      if (ej.exports && ej.exports.length) {
        var eid = ej.exports[0].id;
        var dlR = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions/'+ej.requestId+'/exports/'+eid+'/outputResource',
          {headers:{Cookie:cookie,'User-Agent':ua,'Accept':'*/*'}});
        var dlBuf = await dlR.buffer();
        var dlCt = dlR.headers.get('content-type')||'';
        console.log('  *** PDF: '+dlR.status+' '+dlCt+' '+dlBuf.length+' bytes ***');
        if (dlBuf.length > 1000) {
          fs.writeFileSync('/opt/render/project/src/public/ist-hit.pdf', dlBuf);
          console.log('  *** SAVED to public/ist-hit.pdf ***');
        }
      }
    }
  }
  findings.sections.istHits = istHits;

  // D. s1 lines 420-620 with categoryId=4
  console.log('\n--- D. s1 HTML lines 420-620 (categoryId=4) ---');
  var csrf4 = await (async function(){
    var r=await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
      headers:{'Cookie':cookie,'FETCH-CSRF-TOKEN':'1','User-Agent':ua}});
    var t=await r.text(); var c=t.indexOf(':');
    return {name:t.substring(0,c).trim(), value:t.substring(c+1).trim()};
  })();
  var dhdrs = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  dhdrs[csrf4.name] = csrf4.value;
  var s1r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4', {headers:dhdrs});
  var s1html = await s1r.text();
  var s1lines = s1html.split('\n');
  var region = s1lines.slice(419,620).join('\n');
  console.log(region);
  findings.sections.s1Region = region;
  findings.sections.s1TotalLines = s1lines.length;

  save(findings);
  console.log('\nDone.');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
