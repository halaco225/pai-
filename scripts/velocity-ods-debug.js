'use strict';
var fs   = require('fs');
var path = require('path');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';

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
async function getFreshCsrf(cookie,ua) {
  var r=await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
    headers:{'Cookie':cookie,'FETCH-CSRF-TOKEN':'1','User-Agent':ua}});
  var t=await r.text(); var colon=t.indexOf(':');
  return {name:t.substring(0,colon).trim(), value:t.substring(colon+1).trim()};
}
async function get(url,cookie,ua) {
  var r=await fetch(url,{headers:{Cookie:cookie,'User-Agent':ua}});
  return {status:r.status,ct:r.headers.get('content-type')||'',text:await r.text()};
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var results = {};
  var sess=await login();
  var cookie=sess.cookie; var ua=sess.ua;
  results.loginOk = true;

  // 1. Full content of the tiny dist files
  var distFiles=['aboveStore.main','aboveStore.decoration','aboveStore.orgType','aboveStore.stores'];
  results.distFiles = {};
  for (var i=0;i<distFiles.length;i++) {
    var n=distFiles[i];
    var r=await get(ODS_URL+'/asp/optimized-scripts/aboveStore/dist/'+n+'.js',cookie,ua);
    results.distFiles[n]={status:r.status,size:r.text.length,content:r.text};
  }

  // 2. Check for bundle.js / app.js / chunk files
  var bundlePaths=[
    'aboveStore/dist/bundle.js','aboveStore/dist/app.js','aboveStore/dist/vendor.js',
    'aboveStore/dist/aboveStore.bundle.js','aboveStore/dist/inStoreTime.js',
    'aboveStore/dist/apps/inStoreTime/app.js','aboveStore/dist/apps/inStoreReports/app.js',
  ];
  results.bundles = {};
  for (var j=0;j<bundlePaths.length;j++) {
    var bp=bundlePaths[j];
    var br=await get(ODS_URL+'/asp/optimized-scripts/'+bp,cookie,ua);
    results.bundles[bp]={status:br.status,size:br.text.length};
    if (br.status===200&&br.text.length>500) {
      results.bundles[bp].content=br.text.substring(0,2000);
    }
  }

  // 3. Search require.config.js for "bundles" key
  var rcr=await get(ODS_URL+'/asp/optimized-scripts/require.config.js',cookie,ua);
  var bundles_idx=rcr.text.indexOf('"bundles"');
  if (bundles_idx<0) bundles_idx=rcr.text.indexOf('bundles:');
  results.requireConfigBundlesKey = (bundles_idx>=0) ?
    rcr.text.substring(bundles_idx, bundles_idx+500) : 'NOT FOUND';

  // 4. Try plugin servlet paths (JRS serves plugin resources differently)
  var pluginPaths=[
    '/asp/aboveStore/main.js',
    '/asp/plugins/aboveStore/main.js',
    '/asp/plugins/aboveStore/dist/aboveStore.main.js',
    '/asp/aboveStore/app.js',
    '/asp/aboveStore/bundle.js',
  ];
  results.pluginPaths={};
  for (var k=0;k<pluginPaths.length;k++) {
    var pp=pluginPaths[k];
    var pr=await get(ODS_URL+pp,cookie,ua);
    results.pluginPaths[pp]={status:pr.status,size:pr.text.length};
    if (pr.status===200&&pr.text.length>200) {
      results.pluginPaths[pp].sample=pr.text.substring(0,500);
    }
  }

  // 5. Try getReportsForView directly with no state (new session-less attempt)
  //    Some JRS custom flows bypass state entirely when called via REST
  var csrf=await getFreshCsrf(cookie,ua);
  var flowRes=await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',
    {headers:{Cookie:cookie,'User-Agent':ua}});
  var fHtml=await flowRes.text();
  var km=fHtml.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  var s1Key=km?km[1]:null;
  results.s1Key=s1Key;

  // Try every state from s1 to s9 with getReportsForView
  results.stateAttempts={};
  if (s1Key) {
    var baseKey=s1Key.replace(/s\d+$/,'');  // e.g. "e2" from "e2s1"
    for (var s=2;s<=9;s++) {
      var testKey=baseKey+'s'+s;
      var hdrs={Cookie:cookie,'User-Agent':ua,
        'X-Requested-With':'OWASP CSRFGuard Project',
        'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
      hdrs[csrf.name]=csrf.value;
      var tr=await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+encodeURIComponent(testKey)+'&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment',
        {headers:hdrs});
      var tct=tr.headers.get('content-type')||'';
      var ttxt=await tr.text();
      results.stateAttempts[testKey]={status:tr.status,ct:tct,
        isPdf:tct.indexOf('pdf')>=0||tct.indexOf('octet')>=0,
        title:(ttxt.match(/<title>([^<]+)<\/title>/)||['','?'])[1],
        size:ttxt.length};
      if (tct.indexOf('pdf')>=0||tct.indexOf('octet')>=0) {
        fs.writeFileSync('/tmp/ods-hit.pdf', Buffer.from(ttxt));
        results.stateAttempts[testKey].SAVED=true;
      }
    }
  }

  // Write results to a file in the project so it can be committed
  var outPath=path.join(__dirname,'..','debug-findings.json');
  fs.writeFileSync(outPath, JSON.stringify(results,null,2));
  console.log('Findings written to',outPath);
  console.log('s1Key:', s1Key);
  console.log('State attempts:');
  Object.keys(results.stateAttempts).forEach(function(k){
    var v=results.stateAttempts[k];
    console.log(' ',k,'->',v.status,v.isPdf?'*** PDF ***':v.title,'ct='+v.ct.substring(0,30));
  });
  console.log('distFiles content:');
  Object.keys(results.distFiles).forEach(function(k){
    console.log(' ',k,results.distFiles[k].size,'bytes:',results.distFiles[k].content);
  });
  console.log('requireConfigBundlesKey:', results.requireConfigBundlesKey.substring(0,200));
}
main().catch(function(e){console.error('FATAL:',e.message);process.exit(1);});
