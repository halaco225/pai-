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
async function getFreshCsrf(cookie,ua) {
  var r=await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
    headers:{'Cookie':cookie,'FETCH-CSRF-TOKEN':'1','User-Agent':ua}});
  var t=await r.text(); var colon=t.indexOf(':');
  return {name:t.substring(0,colon).trim(), value:t.substring(colon+1).trim()};
}

function saveOutput(findings) {
  // Save to public/ so it's accessible via HTTP at /debug-output.json
  var publicPath = path.join('/opt/render/project/src/public/debug-output.json');
  fs.writeFileSync(publicPath, JSON.stringify(findings, null, 2));
  console.log('[save] Written to public/debug-output.json (accessible via HTTP)');

  // Also try git push
  if (GH_TOKEN) {
    try {
      var exec = require('child_process').execSync;
      var repoDir = '/opt/render/project/src';
      // Copy to root for git
      fs.writeFileSync(path.join(repoDir,'debug-output.json'), JSON.stringify(findings,null,2));
      exec('git config user.email "harold@ayvaz.com"', {cwd:repoDir});
      exec('git config user.name "PAi"', {cwd:repoDir});
      exec('git add debug-output.json', {cwd:repoDir});
      try { exec('git commit -m "debug v13 '+new Date().toISOString()+'"', {cwd:repoDir}); } catch(e){}
      exec('git push https://'+GH_TOKEN+'@github.com/halaco225/pai-.git HEAD:main', {cwd:repoDir, timeout:30000});
      console.log('[save] git push OK');
    } catch(e) {
      console.log('[save] git push failed:', (e.stderr||e.message||'').toString().substring(0,100));
    }
  } else {
    console.log('[save] GH_TOKEN not set -- file is in public/ only');
  }
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  console.log('[env] GH_TOKEN present:', !!GH_TOKEN, '| length:', GH_TOKEN.length);
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;
  console.log('[login] OK');
  var findings = {ts: new Date().toISOString(), ghTokenLen: GH_TOKEN.length, sections:{}};
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};

  // A. s1 HTML with categoryId=4 -- dump the aboveStore content section
  console.log('\n--- A. s1 HTML with categoryId=4 ---');
  var csrf = await getFreshCsrf(cookie, ua);
  var hdrs = {Cookie:cookie,'User-Agent':ua,
    'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  hdrs[csrf.name] = csrf.value;
  var s1Res = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4', {headers:hdrs});
  var s1Html = await s1Res.text();
  var s1Lines = s1Html.split('\n');
  var s1Key = (s1Html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/))||[];
  s1Key = s1Key[1]||null;
  console.log('s1Key:', s1Key, '| Total lines:', s1Lines.length);
  // Dump lines 420-620 (aboveStore content region)
  var contentSection = s1Lines.slice(419,620).join('\n');
  console.log('\n== Lines 420-620 (aboveStore content region): ==');
  console.log(contentSection);
  // Also dump any script blocks that contain 'categoryId', 'date', 'store', 'ajax', 'flow'
  console.log('\n== Inline scripts with flow/ajax/category: ==');
  var scriptBlocks = s1Html.match(/<script[^>]*>[\s\S]*?<\/script>/gi)||[];
  scriptBlocks.forEach(function(block){
    var lc = block.toLowerCase();
    if (lc.indexOf('categoryid')>=0 || lc.indexOf('ajax')>=0 || lc.indexOf('eventid')>=0 ||
        lc.indexOf('flowexecutionkey')>=0 || lc.indexOf('abovestore')>=0) {
      console.log('\n[SCRIPT BLOCK]: ' + block.substring(0,800));
    }
  });
  // Look for any data- attributes that might hint at flow config
  var dataAttrs = s1Html.match(/data-[a-z-]+="[^"]*"/gi)||[];
  var relevantData = dataAttrs.filter(function(a){ return /category|store|date|report|flow|event/i.test(a); });
  if (relevantData.length) {
    console.log('\n== Relevant data-* attributes ==');
    relevantData.forEach(function(a){ console.log('  '+a); });
  }
  findings.sections.s1WithCat = {
    key: s1Key,
    lines420_620: contentSection,
    relevantDataAttrs: relevantData.slice(0,20)
  };

  // B. Try aboveStore REST endpoints that might set session state
  console.log('\n--- B. aboveStore REST endpoints ---');
  var restEndpoints = [
    '/asp/rest_v2/aboveStore/orgType?orgId='+ODS_ORG,
    '/asp/rest_v2/aboveStore/orgType?org='+ODS_ORG+'&categoryId=4',
    '/asp/rest_v2/aboveStore/stores?storeAccess=true&categoryId=4',
    '/asp/rest_v2/aboveStore/categories',
    '/asp/rest_v2/aboveStore/categories?orgId='+ODS_ORG,
    '/asp/rest_v2/aboveStore/reports',
    '/asp/rest_v2/aboveStore/reports?categoryId=4',
    '/asp/rest_v2/aboveStore/reportConfig',
    '/asp/rest_v2/aboveStore/reportConfig?categoryId=4',
    '/asp/rest_v2/aboveStore/config',
    '/asp/rest_v2/aboveStore/config?categoryId=4',
  ];
  var restResults = {};
  for (var i=0; i<restEndpoints.length; i++) {
    var ep = restEndpoints[i];
    var rr = await fetch(ODS_URL+ep, {headers:jhdrs});
    var rct = rr.headers.get('content-type')||'';
    var rt = await rr.text();
    restResults[ep] = {status:rr.status, ct:rct, body:rt.substring(0,1000)};
    console.log('  '+ep.replace('/asp/rest_v2/aboveStore','').padEnd(50)+' -> '+rr.status+' | '+rt.substring(0,150));
  }
  findings.sections.restEndpoints = restResults;

  // C. Try posting to flow WITH JSON body (some JRS flows accept JSON)
  console.log('\n--- C. POST flow with JSON body ---');
  if (s1Key) {
    csrf = await getFreshCsrf(cookie, ua);
    var jsonHdrs = {Cookie:cookie,'User-Agent':ua,
      'Content-Type':'application/json','Accept':'application/json',
      'X-Requested-With':'OWASP CSRFGuard Project'};
    jsonHdrs[csrf.name] = csrf.value;
    var jsonBody = JSON.stringify({
      _flowExecutionKey: s1Key,
      _eventId: 'getReportsForView',
      exportType: 'pdf',
      contentDisposition: 'attachment',
      categoryId: 4,
      storeId: 29865,
      date: '2026-04-18',
      stores: [29865]
    });
    var jr = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',
      {method:'POST', headers:jsonHdrs, body:jsonBody});
    var jct = jr.headers.get('content-type')||'';
    var jtxt = await jr.text();
    var jt = (jtxt.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    console.log('JSON POST -> '+jr.status+' ct='+jct+' title='+jt);
    findings.sections.jsonPost = {status:jr.status, ct:jct, title:jt};
    if (jct.indexOf('pdf')>=0 || jct.indexOf('octet')>=0) {
      fs.writeFileSync('/opt/render/project/src/public/debug-hit.pdf', Buffer.from(jtxt));
      console.log('*** PDF saved to public/debug-hit.pdf ***');
    }
  }

  saveOutput(findings);
  console.log('\nDone. Access output at: https://pai-ayvaz.onrender.com/debug-output.json');
}
main().catch(function(e){ console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
