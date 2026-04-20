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
function saveOutput(obj) {
  var outPath=path.join(__dirname,'..','uploads','debug-findings.json');
  try { fs.mkdirSync(path.dirname(outPath),{recursive:true}); } catch(e){}
  fs.writeFileSync(outPath, JSON.stringify(obj,null,2));
  console.log('Saved to',outPath);
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;
  var results={};

  // --- 1. Explore aboveStore REST API ---
  console.log('\n--- 1. aboveStore REST API exploration ---');
  var restEndpoints=[
    '/asp/rest_v2/aboveStore',
    '/asp/rest_v2/aboveStore/',
    '/asp/rest_v2/aboveStore/stores?storeAccess=true',
    '/asp/rest_v2/aboveStore/org/orgType?brandId=PH',
    '/asp/rest_v2/aboveStore/inStoreTime',
    '/asp/rest_v2/aboveStore/inStoreTime?date=2026-04-18',
    '/asp/rest_v2/aboveStore/report',
    '/asp/rest_v2/aboveStore/reports',
    '/asp/rest_v2/aboveStore/export',
    '/asp/rest_v2/aboveStore/export?format=pdf',
    '/asp/rest_v2/aboveStore/pdf',
    '/asp/rest_v2/aboveStore/inStoreTime/export',
    '/asp/rest_v2/aboveStore/inStoreTime/pdf',
    '/asp/rest_v2/aboveStore/velocity',
    '/asp/rest_v2/aboveStore/sos',
    '/asp/rest_v2/aboveStore/speedOfService',
  ];
  results.rest={};
  for(var i=0;i<restEndpoints.length;i++){
    var ep=restEndpoints[i];
    var r=await fetch(ODS_URL+ep,{headers:{Cookie:cookie,'User-Agent':ua,Accept:'application/json, application/pdf, */*'}});
    var ct=r.headers.get('content-type')||'';
    var body=await r.text();
    var isPdf=ct.indexOf('pdf')>=0||ct.indexOf('octet')>=0;
    results.rest[ep]={status:r.status,ct:ct.substring(0,40),size:body.length,
      sample:body.substring(0,300),isPdf:isPdf};
    console.log(ep.substring(30).padEnd(45),'->',r.status,isPdf?'*** PDF ***':ct.substring(0,30),'|',body.substring(0,80).replace(/\s+/g,' '));
    if(isPdf){fs.writeFileSync('/tmp/ods-rest-pdf.pdf',Buffer.from(body));console.log('  *** SAVED PDF ***');}
  }

  // --- 2. Flow events WITH form data (store/date params) ---
  console.log('\n--- 2. Flow events with store/date params ---');
  var csrf=await getFreshCsrf(cookie,ua);
  var fRes=await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',
    {headers:{Cookie:cookie,'User-Agent':ua}});
  var fHtml=await fRes.text(); var km=fHtml.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  var s1Key=km?km[1]:null;
  console.log('s1Key:',s1Key);

  var hdrs={Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Content-Type':'application/x-www-form-urlencoded',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  hdrs[csrf.name]=csrf.value;

  // Try various events with form data
  var eventsWithParams=[
    {ev:'view', params:'stores=all&date=2026-04-18&brandId=PH&reportType=inStoreTime'},
    {ev:'run',  params:'stores=all&date=2026-04-18&brandId=PH&reportType=inStoreTime'},
    {ev:'next', params:'stores=all&date=2026-04-18&brandId=PH'},
    {ev:'getReportsForView', params:'stores=all&date=2026-04-18&exportType=pdf&contentDisposition=attachment'},
    {ev:'viewInStoreTime', params:'stores=all&date=2026-04-18'},
    {ev:'runInStoreTime',  params:'stores=all&date=2026-04-18'},
    {ev:'inStoreTime',     params:'stores=all&date=2026-04-18'},
    {ev:'selectInStoreTime', params:'stores=all&date=2026-04-18'},
  ];
  results.flowWithParams={};
  for(var j=0;j<eventsWithParams.length;j++){
    var ev=eventsWithParams[j].ev; var params=eventsWithParams[j].params;
    var csrf2=await getFreshCsrf(cookie,ua);
    hdrs[csrf2.name]=csrf2.value;
    var pb='_flowExecutionKey='+encodeURIComponent(s1Key)+'&_eventId='+ev+'&'+params+'&'+csrf2.name+'='+encodeURIComponent(csrf2.value);
    var pr=await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',{method:'POST',headers:hdrs,body:pb});
    var pct=pr.headers.get('content-type')||''; var ptxt=await pr.text();
    var pkey=(ptxt.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/)||[])[1];
    var ptitle=(ptxt.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    var isPdf2=pct.indexOf('pdf')>=0||pct.indexOf('octet')>=0;
    results.flowWithParams[ev]={status:pr.status,ct:pct,isPdf:isPdf2,newKey:pkey,title:ptitle};
    console.log(' ',ev.padEnd(22),'->',pr.status,isPdf2?'*** PDF ***':ptitle,'newKey='+pkey);
    if(isPdf2){fs.writeFileSync('/tmp/ods-flow-pdf.pdf',Buffer.from(ptxt));console.log('  *** SAVED /tmp/ods-flow-pdf.pdf ***'); break;}
    // If we got a non-error new key, try getReportsForView from there
    if(pkey&&pkey!==s1Key&&ptitle.indexOf('Error')<0&&ptxt.indexOf('oneVIEW: Login')<0){
      console.log('    !! Got new key '+pkey+' -- trying getReportsForView');
      var csrf3=await getFreshCsrf(cookie,ua);
      var h3=Object.assign({},hdrs); h3[csrf3.name]=csrf3.value;
      var pu=ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+encodeURIComponent(pkey)+'&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment';
      var gr=await fetch(pu,{headers:h3}); var gct=gr.headers.get('content-type')||'';
      console.log('    -> getReportsForView: '+gr.status+' ct='+gct);
      if(gct.indexOf('pdf')>=0||gct.indexOf('octet')>=0){
        var gbuf=await gr.buffer(); fs.writeFileSync('/tmp/ods-flow-pdf.pdf',gbuf);
        console.log('    *** SAVED /tmp/ods-flow-pdf.pdf ***'); break;
      }
    }
  }

  // --- 3. Fetch commons.main to see if it fires flow events ---
  console.log('\n--- 3. commons.main module ---');
  var cmr=await fetch(ODS_URL+'/asp/optimized-scripts/commons.main.js',{headers:{Cookie:cookie,'User-Agent':ua}});
  console.log('commons.main.js -> '+cmr.status+' size='+(await cmr.text()).length);
  // Also try commons/main.js
  var cmr2=await fetch(ODS_URL+'/asp/optimized-scripts/commons/main.js',{headers:{Cookie:cookie,'User-Agent':ua}});
  var cmt2=await cmr2.text();
  console.log('commons/main.js ->',cmr2.status,'size='+cmt2.length);
  if(cmr2.ok&&cmt2.length>100){
    var flowLines=cmt2.split('\n').filter(function(l){return /eventId|flowExec|_event|getReport/i.test(l);});
    console.log('Flow refs in commons/main.js:',flowLines.slice(0,5).join('\n'));
  }

  saveOutput(results);
  console.log('\nDone.');
}
main().catch(function(e){console.error('FATAL:',e.message);process.exit(1);});
