'use strict';
var fs      = require('fs');
var path    = require('path');
var exec    = require('child_process').execSync;
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

function gitPush(findings) {
  var repoDir = '/opt/render/project/src';
  var outFile = path.join(repoDir, 'debug-output.json');
  fs.writeFileSync(outFile, JSON.stringify(findings, null, 2));
  if (!GH_TOKEN) {
    console.log('[gitPush] GH_TOKEN not set, skipping push');
    console.log('[gitPush] Saved to', outFile);
    return;
  }
  try {
    exec('git config user.email "harold@ayvaz.com"', {cwd:repoDir});
    exec('git config user.name "PAi"', {cwd:repoDir});
    exec('git add debug-output.json', {cwd:repoDir});
    try { exec('git commit -m "debug v12 output '+new Date().toISOString()+'"', {cwd:repoDir}); } catch(e) {}
    var pushUrl = 'https://'+GH_TOKEN+'@github.com/halaco225/pai-.git';
    var out = exec('git push '+pushUrl+' HEAD:main 2>&1', {cwd:repoDir, timeout:30000});
    console.log('[gitPush] OK:', (out||'').toString().substring(0,100));
  } catch(e) {
    console.log('[gitPush] Error:', (e.stderr||e.message||'').toString().substring(0,200));
    // Fallback: try GitHub API
    console.log('[gitPush] Trying API fallback...');
    var content64 = Buffer.from(JSON.stringify(findings,null,2)).toString('base64');
    require('node-fetch')('https://api.github.com/repos/halaco225/pai-/contents/debug-output.json',
      {headers:{'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi','Accept':'application/vnd.github+json'}})
    .then(function(r){ return r.json(); })
    .then(function(sha) {
      var body = {message:'debug v12 api '+new Date().toISOString(), content:content64};
      if (sha.sha) body.sha = sha.sha;
      return require('node-fetch')('https://api.github.com/repos/halaco225/pai-/contents/debug-output.json',
        {method:'PUT',headers:{'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi',
          'Content-Type':'application/json','Accept':'application/vnd.github+json'},
         body:JSON.stringify(body)});
    }).then(function(r){ console.log('[gitPush] API result:', r.status); })
    .catch(function(e){ console.log('[gitPush] API error:', e.message); });
  }
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  console.log('[env] GH_TOKEN set:', !!GH_TOKEN, 'length:', GH_TOKEN.length);
  var sess=await login();
  var cookie=sess.cookie; var ua=sess.ua;
  var findings = {ts: new Date().toISOString(), ghTokenSet: !!GH_TOKEN, sections:{}};
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};

  // A. Full list of ALL accessible report units
  console.log('\n--- A. ALL report units ---');
  var allRes = await fetch(ODS_URL+'/asp/rest_v2/resources?type=reportUnit&limit=500&sortBy=label', {headers:jhdrs});
  var allJson = await allRes.json();
  var allItems = allJson.resourceLookup || [];
  console.log('Total:', allItems.length);
  allItems.forEach(function(i){ console.log('  '+i.label+' -> '+i.uri); });
  findings.sections.allReportUnits = allItems;

  // B. Full Operations folder
  console.log('\n--- B. Operations folder (full) ---');
  var opRes = await fetch(ODS_URL+'/asp/rest_v2/resources?folderUri=/Reports/Pizza_Hut/Operations&recursive=false&limit=200', {headers:jhdrs});
  var opJson = await opRes.json();
  var opItems = opJson.resourceLookup || [];
  console.log('Total ops:', opItems.length);
  opItems.forEach(function(i){ console.log('  ['+i.resourceType+'] '+i.label+' -> '+i.uri); });
  findings.sections.opsFolder = opItems;

  // C. Multibrand and Cyclone ops folders
  console.log('\n--- C. Other brand folders ---');
  var folders = ['/Reports/Multibrand/Operations','/Reports/Cyclone_Anayas/Operations'];
  var otherFolders = {};
  for (var fi=0; fi<folders.length; fi++) {
    var fr = await fetch(ODS_URL+'/asp/rest_v2/resources?folderUri='+encodeURIComponent(folders[fi])+'&recursive=false&limit=200', {headers:jhdrs});
    var fj = await fr.json();
    var fi2 = fj.resourceLookup || [];
    otherFolders[folders[fi]] = fi2;
    console.log('\n'+folders[fi]);
    fi2.forEach(function(i){ console.log('  ['+i.resourceType+'] '+i.label+' -> '+i.uri); });
  }
  findings.sections.otherFolders = otherFolders;

  // D. Proof: download PH_DriverHistory and save PDF
  console.log('\n--- D. Proof download: PH_DriverHistory ---');
  var execHdrs = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/json','Accept':'application/json'};
  var exRes = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions',
    {method:'POST', headers:execHdrs,
     body:JSON.stringify({reportUnitUri:'/Reports/Pizza_Hut/Operations/PH_DriverHistory',
       outputFormat:'pdf', async:false, freshData:false})});
  var exJson = await exRes.json();
  console.log('Status:', exJson.status, 'pages:', exJson.totalPages, 'requestId:', exJson.requestId);
  findings.sections.proofExec = {status:exJson.status, pages:exJson.totalPages, requestId:exJson.requestId};
  if (exJson.requestId && exJson.exports && exJson.exports.length) {
    var eid = exJson.exports[0].id;
    var dlRes = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions/'+exJson.requestId+'/exports/'+eid+'/outputResource',
      {headers:{Cookie:cookie,'User-Agent':ua,'Accept':'*/*'}});
    var dlCt = dlRes.headers.get('content-type')||'';
    var dlBuf = await dlRes.buffer();
    console.log('PDF download:', dlRes.status, dlCt, dlBuf.length, 'bytes');
    findings.sections.proofExec.pdfStatus = dlRes.status;
    findings.sections.proofExec.pdfSize = dlBuf.length;
    findings.sections.proofExec.pdfCt = dlCt;
    if (dlBuf.length > 1000) {
      fs.writeFileSync('/opt/render/project/src/uploads/driver-history.pdf', dlBuf);
      console.log('*** Proof PDF saved to uploads/driver-history.pdf ***');
    }
  }

  gitPush(findings);
  // small delay for async API fallback
  await new Promise(function(r){ setTimeout(r, 3000); });
  console.log('\nDone.');
}
main().catch(function(e){ console.error('FATAL:', e.message, e.stack); process.exit(1); });
