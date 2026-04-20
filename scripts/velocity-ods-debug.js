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
async function pushToGitHub(findings) {
  if (!GH_TOKEN) { console.log('No GH_TOKEN'); return; }
  var content64 = Buffer.from(JSON.stringify(findings,null,2)).toString('base64');
  var shaRes = await fetch('https://api.github.com/repos/'+GH_REPO+'/contents/debug-output.json',
    {headers:{'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug','Accept':'application/vnd.github+json'}});
  var shaJson = shaRes.ok ? await shaRes.json() : {};
  var body = {message:'debug v11 '+new Date().toISOString(), content:content64};
  if (shaJson.sha) body.sha = shaJson.sha;
  var pr = await fetch('https://api.github.com/repos/'+GH_REPO+'/contents/debug-output.json',
    {method:'PUT',headers:{'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug',
      'Content-Type':'application/json','Accept':'application/vnd.github+json'},
     body:JSON.stringify(body)});
  console.log(pr.ok ? 'GitHub push OK' : 'GitHub push FAILED');
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;
  var findings = {ts: new Date().toISOString(), sections:{}};
  var jhdrs = {Cookie:cookie,'User-Agent':ua,'Accept':'application/json'};

  // A. Full Operations folder
  console.log('\n--- A. Full Operations folder (all items) ---');
  var opRes = await fetch(ODS_URL+'/asp/rest_v2/resources?folderUri=/Reports/Pizza_Hut/Operations&recursive=true&limit=500', {headers:jhdrs});
  var opJson = await opRes.json();
  var opItems = opJson.resourceLookup || [];
  console.log('Total items:', opItems.length);
  opItems.forEach(function(item){
    console.log('  ['+item.resourceType+'] '+item.label+' -> '+item.uri);
  });
  findings.sections.operations = opItems;

  // B. Search with many more terms
  console.log('\n--- B. Broad report search ---');
  var searchTerms = ['SUS','InStore','InStore Time','IST','Speed','Service','Velocity',
    'Above','Manager','Store','Operations','Report','PH_I','Summary','Ops'];
  var searchResults = {};
  for (var i=0; i<searchTerms.length; i++) {
    var term = searchTerms[i];
    var sr = await fetch(ODS_URL+'/asp/rest_v2/resources?q='+encodeURIComponent(term)+'&type=reportUnit&limit=50', {headers:jhdrs});
    var sj = await sr.json();
    var items = sj.resourceLookup || [];
    if (items.length) {
      searchResults[term] = items;
      console.log('\n['+term+'] '+items.length+' results:');
      items.forEach(function(item){ console.log('  '+item.label+' -> '+item.uri); });
    }
  }
  findings.sections.searchResults = searchResults;

  // C. List ALL report units accessible to this user
  console.log('\n--- C. ALL accessible report units ---');
  var allRes = await fetch(ODS_URL+'/asp/rest_v2/resources?type=reportUnit&limit=500&sortBy=label', {headers:jhdrs});
  var allJson = await allRes.json();
  var allItems = allJson.resourceLookup || [];
  console.log('Total reportUnits:', allItems.length);
  allItems.forEach(function(item){ console.log('  '+item.label+' -> '+item.uri); });
  findings.sections.allReportUnits = allItems;

  // D. Prove reportExecutions works: download PH_DriverHistory PDF
  console.log('\n--- D. reportExecution proof: PH_DriverHistory ---');
  var execHdrs = {Cookie:cookie,'User-Agent':ua,'Content-Type':'application/json','Accept':'application/json'};
  var exBody = {reportUnitUri:'/Reports/Pizza_Hut/Operations/PH_DriverHistory',
    outputFormat:'pdf', async:false, freshData:false};
  var exRes = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions',
    {method:'POST', headers:execHdrs, body:JSON.stringify(exBody)});
  var exJson = await exRes.json();
  console.log('Status:', exJson.status, 'requestId:', exJson.requestId, 'pages:', exJson.totalPages);
  if (exJson.requestId && exJson.exports && exJson.exports.length) {
    var exportId = exJson.exports[0].id;
    var dlUrl = ODS_URL+'/asp/rest_v2/reportExecutions/'+exJson.requestId+'/exports/'+exportId+'/outputResource';
    var dlRes = await fetch(dlUrl, {headers:{Cookie:cookie,'User-Agent':ua,'Accept':'*/*'}});
    var dlCt = dlRes.headers.get('content-type')||'';
    var dlBuf = await dlRes.buffer();
    console.log('Download:', dlRes.status, 'ct='+dlCt, 'size='+dlBuf.length);
    if (dlCt.indexOf('pdf')>=0 || dlBuf.length > 5000) {
      var pdfPath = '/opt/render/project/src/uploads/driver-history.pdf';
      fs.writeFileSync(pdfPath, dlBuf);
      console.log('*** SAVED proof PDF to uploads/driver-history.pdf ***');
      findings.sections.proofPdf = {status:dlRes.status, ct:dlCt, size:dlBuf.length, saved:pdfPath};
    }
  }

  // E. Try guessed IST URIs with reportExecution
  console.log('\n--- E. IST report URI guesses ---');
  var istUris = [
    '/Reports/Pizza_Hut/Operations/PH_IST',
    '/Reports/Pizza_Hut/Operations/SUS_IST',
    '/Reports/Pizza_Hut/Operations/PH_InStoreTime',
    '/Reports/Pizza_Hut/Operations/InStoreTime',
    '/Reports/Pizza_Hut/Operations/PH_Instore_Time',
    '/Reports/Pizza_Hut/Operations/IST',
    '/Reports/Pizza_Hut/Operations/PH_Speed_of_Service',
    '/Reports/Pizza_Hut/Operations/SpeedOfService',
    '/Reports/Pizza_Hut/Operations/PH_SOS',
    '/Reports/Pizza_Hut/Operations/PH_Velocity',
    '/Reports/Multibrand/Operations/InStoreTime',
    '/Reports/Multibrand/Operations/IST',
  ];
  var istResults = {};
  for (var ii=0; ii<istUris.length; ii++) {
    var uri = istUris[ii];
    var ir = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions',
      {method:'POST', headers:execHdrs,
       body:JSON.stringify({reportUnitUri:uri, outputFormat:'pdf', async:false, freshData:false})});
    var ij = await ir.json();
    istResults[uri] = {status:ir.status, body:JSON.stringify(ij).substring(0,200)};
    console.log('  '+uri.split('/').pop().padEnd(30)+' -> '+ir.status+' '+JSON.stringify(ij).substring(0,100));
    if (ir.status===200 && ij.requestId) {
      console.log('  *** FOUND! requestId='+ij.requestId+' pages='+ij.totalPages+' ***');
      // Download it
      if (ij.exports && ij.exports.length) {
        var eid = ij.exports[0].id;
        var edl = await fetch(ODS_URL+'/asp/rest_v2/reportExecutions/'+ij.requestId+'/exports/'+eid+'/outputResource',
          {headers:{Cookie:cookie,'User-Agent':ua}});
        var ebuf = await edl.buffer();
        fs.writeFileSync('/opt/render/project/src/uploads/ist-hit.pdf', ebuf);
        console.log('  *** IST PDF SAVED to uploads/ist-hit.pdf ***');
      }
    }
  }
  findings.sections.istResults = istResults;

  await pushToGitHub(findings);
  console.log('\nDone.');
}
main().catch(function(e){ console.error('FATAL:', e.message, e.stack); process.exit(1); });
