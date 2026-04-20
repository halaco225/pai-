'use strict';
var fs   = require('fs');
var path = require('path');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';
var GH_TOKEN = process.env.GH_TOKEN || '';
var GH_REPO  = 'halaco225/pai-';
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
async function pushToGitHub(findings) {
  if (!GH_TOKEN) { console.log('No GH_TOKEN, skipping push'); return; }
  var content64 = Buffer.from(JSON.stringify(findings,null,2)).toString('base64');
  var shaRes = await fetch('https://api.github.com/repos/'+GH_REPO+'/contents/debug-output.json',
    {headers:{'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug','Accept':'application/vnd.github+json'}});
  var shaJson = shaRes.ok ? await shaRes.json() : {};
  var body = {message:'debug v10 output '+new Date().toISOString(), content:content64};
  if (shaJson.sha) body.sha = shaJson.sha;
  var pushRes = await fetch('https://api.github.com/repos/'+GH_REPO+'/contents/debug-output.json',
    {method:'PUT',headers:{'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug',
      'Content-Type':'application/json','Accept':'application/vnd.github+json'},
     body:JSON.stringify(body)});
  var pj = await pushRes.json();
  console.log(pushRes.ok ? 'GitHub push OK' : 'GitHub push FAILED: '+JSON.stringify(pj));
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;
  var findings = {ts: new Date().toISOString(), sections:{}};
  var hdrs = function(csrf) {
    var h = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json, */*',
      'X-Requested-With':'XMLHttpRequest'};
    if (csrf) h[csrf.name]=csrf.value;
    return h;
  };

  // A. Fetch aboveStore.formValidation and app bundles
  console.log('\n--- A. aboveStore module files ---');
  var modPaths = [
    'aboveStore/dist/aboveStore.formValidation',
    'aboveStore/dist/apps/employeeHomeStore/app',
    'aboveStore/dist/apps/bucketViewer/app',
    'aboveStore/dist/apps/pollingAdmin/app',
    'aboveStore/dist/apps/bankingAdmin/app',
  ];
  var modContents = {};
  for (var i=0; i<modPaths.length; i++) {
    var mp = modPaths[i];
    var mr = await fetch(ODS_URL+'/asp/optimized-scripts/'+mp+'.js',
      {headers:{Cookie:cookie,'User-Agent':ua}});
    if (mr.ok) {
      var mt = await mr.text();
      modContents[mp] = mt;
      console.log('\n['+mp+'] '+mt.length+' bytes');
      // Search for flow/event patterns
      ['getReportsForView','eventId','flowExecutionKey','_eventId','categoryId','storeId',
       'date','export','pdf','contentDisposition','reportDate','run','submit'].forEach(function(term){
        var idx = mt.indexOf(term);
        if (idx>=0) {
          var ctx = mt.substring(Math.max(0,idx-80),Math.min(mt.length,idx+120));
          console.log('  FOUND "'+term+'": ...'+ctx.replace(/\n/g,' ')+'...');
        }
      });
      if (mt.length < 5000) { console.log('  Full:\n'+mt); }
    } else {
      console.log('['+mp+'] -> '+mr.status);
      modContents[mp] = null;
    }
  }
  findings.sections.modContents = modContents;

  // B. Browse JRS repository structure
  console.log('\n--- B. JRS repository browse ---');
  var browsePaths = [
    '/asp/rest_v2/resources?folderUri=/Reports&recursive=false&limit=100',
    '/asp/rest_v2/resources?folderUri=/Reports/Pizza_Hut&recursive=false&limit=100',
    '/asp/rest_v2/resources?folderUri=/Reports/Pizza_Hut/Operations&recursive=false&limit=100',
    '/asp/rest_v2/resources?folderUri=/aboveStore&recursive=false&limit=100',
    '/asp/rest_v2/resources?q=IST&limit=20',
    '/asp/rest_v2/resources?q=Velocity&limit=20',
    '/asp/rest_v2/resources?q=Time&type=reportUnit&limit=20',
    '/asp/rest_v2/resources?q=Above&type=reportUnit&limit=20',
    '/asp/rest_v2/resources?q=Labor&type=reportUnit&limit=20',
    '/asp/rest_v2/resources?q=Performance&type=reportUnit&limit=20',
    '/asp/rest_v2/resources?q=Daily&type=reportUnit&limit=20',
  ];
  var browseResults = {};
  for (var bi=0; bi<browsePaths.length; bi++) {
    var bp = browsePaths[bi];
    var br = await fetch(ODS_URL+bp,
      {headers:{Cookie:cookie,'User-Agent':ua,'Accept':'application/json'}});
    var bct = br.headers.get('content-type')||'';
    var bt = await br.text();
    browseResults[bp] = {status:br.status, body:bt.substring(0,3000)};
    console.log('\n'+bp.replace('/asp/rest_v2/resources','').substring(0,70)+' -> '+br.status);
    if (br.status===200) {
      try {
        var bj = JSON.parse(bt);
        var items = bj.resourceLookup || bj.folder || [];
        if (!Array.isArray(items)) items = [bj];
        items.forEach(function(item){
          console.log('  ['+item.resourceType+'] '+item.label+' -> '+item.uri);
        });
      } catch(e){ console.log('  '+bt.substring(0,500)); }
    }
  }
  findings.sections.browseResults = browseResults;

  // C. Try REST Report Execution API with discovered/guessed report URIs
  console.log('\n--- C. REST Report Execution attempts ---');
  var csrf = await getFreshCsrf(cookie, ua);
  var execHeaders = {Cookie:cookie,'User-Agent':ua,
    'Content-Type':'application/json','Accept':'application/json',
    'X-Requested-With':'XMLHttpRequest'};
  execHeaders[csrf.name] = csrf.value;

  var reportUris = [
    '/Reports/Pizza_Hut/Operations/PH_DriverHistory',
    '/aboveStore/reports/inStoreTime',
    '/aboveStore/reports/IST',
    '/aboveStore/inStoreTime',
    '/Reports/aboveStore/inStoreTime',
    '/Reports/InStoreTime',
    '/Reports/IST',
  ];
  var execResults = {};
  for (var ei=0; ei<reportUris.length; ei++) {
    var uri = reportUris[ei];
    var execBody = JSON.stringify({
      reportUnitUri: uri,
      outputFormat: 'pdf',
      parameters: {
        reportParameter: [
          {name:'STORE_ID', value:['29865']},
          {name:'DATE', value:['2026-04-18']},
          {name:'storeId', value:['29865']},
          {name:'date', value:['2026-04-18']},
          {name:'reportDate', value:['2026-04-18']},
          {name:'categoryId', value:['1']}
        ]
      },
      async: false, freshData: true
    });
    var er = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions',
      {method:'POST', headers:execHeaders, body:execBody});
    var ect = er.headers.get('content-type')||'';
    var et = await er.text();
    execResults[uri] = {status:er.status, ct:ect, body:et.substring(0,500)};
    console.log('  POST reportExecutions uri='+uri+' -> '+er.status+' | '+et.substring(0,200));
    if (er.status===200) {
      try {
        var ej = JSON.parse(et);
        console.log('  requestId='+ej.requestId+' status='+ej.status);
        // If we got a requestId, try to get the export
        if (ej.requestId) {
          var expR = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions/'+ej.requestId+'/exports/pdf/outputResource',
            {headers:{Cookie:cookie,'User-Agent':ua,'Accept':'application/pdf, */*'}});
          var expCt = expR.headers.get('content-type')||'';
          var expBuf = await expR.buffer();
          console.log('  Export -> '+expR.status+' ct='+expCt+' size='+expBuf.length);
          if (expCt.indexOf('pdf')>=0 || expBuf.length > 10000) {
            fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf', expBuf);
            console.log('  *** PDF SAVED ***');
          }
        }
      } catch(e){ console.log('  Parse error: '+e.message); }
    }
  }
  findings.sections.execResults = execResults;

  await pushToGitHub(findings);
  console.log('\nDone.');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
