'use strict';
var fs = require('fs');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var GH_TOKEN = process.env.GH_TOKEN || '';
var TARGET_DATE = process.env.TARGET_DATE || '04/19/2026';  // MM/DD/YYYY
var STORE_ID = process.env.STORE_ID || '29865';
var REPORT_ID = '457';  // Daily Dispatch Performance
var CATEGORY_ID = '4';

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
  if (GH_TOKEN.length < 5) { console.log('[save] no GH_TOKEN'); return; }
  var content64 = Buffer.from(JSON.stringify(findings,null,2)).toString('base64');
  var apiUrl = 'https://api.github.com/repos/halaco225/pai-/contents/debug-output.json';
  var ghHdrs = {'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug',
    'Content-Type':'application/json','Accept':'application/vnd.github+json'};
  try {
    var shaRes = await fetch(apiUrl, {headers:ghHdrs});
    var shaJson = shaRes.ok ? await shaRes.json() : {};
    var body = {message:'debug v15b '+new Date().toISOString(), content:content64};
    if (shaJson.sha) body.sha = shaJson.sha;
    var putRes = await fetch(apiUrl, {method:'PUT', headers:ghHdrs, body:JSON.stringify(body)});
    console.log('[save] GitHub:', putRes.status, putRes.ok?'OK':'FAIL');
  } catch(e){ console.log('[save] err:', e.message); }
}

async function main() {
  if (ODS_PASS.length < 2) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess = await login(); var cookie = sess.cookie; var ua = sess.ua;
  console.log('Login OK, TARGET_DATE='+TARGET_DATE);
  var findings = {ts:new Date().toISOString(), version:'v15b', reportId:REPORT_ID, targetDate:TARGET_DATE, steps:{}};

  // STEP 1: GET s1 with categoryId to get flowExecutionKey
  console.log('\nStep 1: GET s1 with categoryId='+CATEGORY_ID);
  var csrf = await freshCsrf(cookie, ua);
  var h1 = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  h1[csrf.name] = csrf.value;
  var s1r = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId='+CATEGORY_ID, {headers:h1});
  var s1html = await s1r.text();
  var s1status = s1r.status;
  // Extract flowExecutionKey
  var keyM = s1html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  if (!keyM) keyM = s1html.match(/name="_flowExecutionKey"\s+value="([^"]+)"/);
  if (!keyM) keyM = s1html.match(/flowExecutionKey[=:]["']([^"']+)["']/);
  var s1Key = keyM ? keyM[1] : 'NOT_FOUND';
  console.log('  s1Key='+s1Key+' status='+s1status);
  findings.steps.s1 = {status:s1status, key:s1Key, htmlLen:s1html.length,
    snippet:s1html.substring(0,500).replace(/\s+/g,' ')};

  // STEP 2: GET selectParameters for reportId=457 → go to s2 (parameter form)
  console.log('\nStep 2: selectParameters for reportId='+REPORT_ID);
  csrf = await freshCsrf(cookie, ua);
  var h2 = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId='+CATEGORY_ID};
  h2[csrf.name] = csrf.value;
  var s2url = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
    +'&_flowExecutionKey='+encodeURIComponent(s1Key)
    +'&_eventId=selectParameters&selectedReportId='+REPORT_ID;
  console.log('  URL: '+s2url);
  var s2r = await fetch(s2url, {headers:h2});
  var s2html = await s2r.text();
  var s2status = s2r.status;
  var s2loc = s2r.headers.get('location')||'';
  // Extract new flowExecutionKey for s2
  var s2keyM = s2html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  if (!s2keyM) s2keyM = s2html.match(/name="_flowExecutionKey"\s+value="([^"]+)"/);
  var s2Key = s2keyM ? s2keyM[1] : 'NOT_FOUND';
  console.log('  s2Key='+s2Key+' status='+s2status+' loc='+s2loc);
  // Extract all input/select/textarea names from the form
  var inputRx = /(?:name|id)="([^"]+)"/g;
  var formFields = []; var fm;
  while ((fm=inputRx.exec(s2html)) !== null) {
    var fn2 = fm[1];
    if (fn2 && fn2.length > 0 && fn2.length < 60 && formFields.indexOf(fn2)<0) formFields.push(fn2);
  }
  console.log('  Form fields:', formFields.slice(0,30).join(', '));
  // Dump full s2 HTML (first 6000 chars)
  findings.steps.s2 = {
    status:s2status, key:s2Key, loc:s2loc, htmlLen:s2html.length,
    formFields:formFields,
    html:s2html.substring(0,8000)
  };

  // STEP 3: Try to submit form — attempt several date param name variations
  console.log('\nStep 3: submit parameters');
  csrf = await freshCsrf(cookie, ua);
  var h3 = {Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Content-Type':'application/x-www-form-urlencoded',
    'Referer':s2url};
  h3[csrf.name] = csrf.value;

  // Build date variants
  var dateParts = TARGET_DATE.split('/');
  var mm = dateParts[0], dd = dateParts[1], yyyy = dateParts[2];
  var dateVariants = [
    TARGET_DATE,         // MM/DD/YYYY
    yyyy+'-'+mm+'-'+dd,  // YYYY-MM-DD
    dd+'/'+mm+'/'+yyyy,  // DD/MM/YYYY
    mm+'-'+dd+'-'+yyyy   // MM-DD-YYYY
  ];

  var s3Results = [];
  for (var vi=0; vi<dateVariants.length; vi++) {
    var dv = dateVariants[vi];
    var paramNames = ['BUSINESS_DATE','business_date','DATE','date','p_date','p_business_date',
      'startDate','start_date','endDate','end_date','reportDate','report_date'];
    for (var pi=0; pi<paramNames.length; pi++) {
      var pn = paramNames[pi];
      var body3Parts = [
        '_flowExecutionKey='+encodeURIComponent(s2Key),
        '_eventId=getReportsForView',
        'exportType=pdf',
        'contentDisposition=attachment',
        pn+'='+encodeURIComponent(dv),
        'storeId='+STORE_ID,
        'store_id='+STORE_ID,
        'STORE_ID='+STORE_ID,
        'selectedStoreId='+STORE_ID,
        'unitNumber=038729',
        'UNIT_NUMBER=038729'
      ].join('&');
      var r3 = await fetch(ODS_URL+'/asp/flow.html', {
        method:'POST', headers:h3, body:body3Parts
      });
      var ct3 = r3.headers.get('content-type')||'';
      if (ct3.includes('pdf') || ct3.includes('octet')) {
        var buf = await r3.buffer();
        console.log('  *** PDF HIT: '+pn+'='+dv+' ('+buf.length+' bytes)');
        var tmpPdf = '/opt/render/project/src/public/test-dispatch.pdf';
        try { fs.writeFileSync(tmpPdf, buf); } catch(e){}
        s3Results.push({hit:true, param:pn, dateVal:dv, bytes:buf.length, status:r3.status});
        findings.steps.s3 = s3Results;
        findings.pdfHit = {param:pn, dateVal:dv, bytes:buf.length};
        await save(findings);
        await new Promise(function(r){ setTimeout(r,6000); });
        console.log('Done (PDF found).');
        return;
      } else {
        var respText = await r3.text();
        var brief = respText.substring(0,200).replace(/\s+/g,' ');
        s3Results.push({hit:false, param:pn, dateVal:dv, status:r3.status, ct:ct3, snippet:brief});
      }
    }
  }
  console.log('  No PDF hit from parameter form. Trying GET variants...');

  // STEP 3b: Try GET getReportsForView from s2Key
  var keyToUse = s2Key !== 'NOT_FOUND' ? s2Key : s1Key;
  var s3gUrl = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
    +'&_flowExecutionKey='+encodeURIComponent(keyToUse)
    +'&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment';
  var rg = await fetch(s3gUrl, {headers:{Cookie:cookie,'User-Agent':ua,
    'Referer':s2url,'X-Requested-With':'OWASP CSRFGuard Project'}});
  var ctg = rg.headers.get('content-type')||'';
  if (ctg.includes('pdf') || ctg.includes('octet')) {
    var buf2 = await rg.buffer();
    console.log('  *** GET PDF HIT ('+buf2.length+' bytes)');
    findings.pdfHitGet = {bytes:buf2.length};
  }
  findings.steps.s3 = s3Results.slice(0,8); // first 8 only to keep size down

  await save(findings);
  await new Promise(function(r){ setTimeout(r,6000); });
  console.log('v15b done.');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
