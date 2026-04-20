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
  console.log('\nPushing findings to GitHub...');
  var content64 = Buffer.from(JSON.stringify(findings,null,2)).toString('base64');
  // Get existing SHA if file exists
  var shaRes = await fetch('https://api.github.com/repos/'+GH_REPO+'/contents/debug-output.json',
    {headers:{'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug','Accept':'application/vnd.github+json'}});
  var shaJson = shaRes.ok ? await shaRes.json() : {};
  var body = {message:'auto debug output '+new Date().toISOString(), content:content64};
  if (shaJson.sha) body.sha = shaJson.sha;
  var pushRes = await fetch('https://api.github.com/repos/'+GH_REPO+'/contents/debug-output.json',
    {method:'PUT',
     headers:{'Authorization':'Bearer '+GH_TOKEN,'User-Agent':'PAi-debug',
               'Content-Type':'application/json','Accept':'application/vnd.github+json'},
     body:JSON.stringify(body)});
  var pushJson = await pushRes.json();
  if (pushRes.ok) {
    console.log('GitHub push OK: '+pushJson.content.html_url);
  } else {
    console.log('GitHub push FAILED: '+JSON.stringify(pushJson));
  }
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;
  var findings = {ts: new Date().toISOString(), sections:{}};

  // A. Require config - full aboveStore entries
  console.log('\n--- A. require.config.js ---');
  var rcRes = await fetch(ODS_URL+'/asp/optimized-scripts/require.config.js',
    {headers:{Cookie:cookie,'User-Agent':ua}});
  var rcText = await rcRes.text();
  var abLines = rcText.split('\n').filter(function(l){ return /aboveStore/i.test(l); });
  console.log('aboveStore entries ('+abLines.length+'):');
  abLines.forEach(function(l){ console.log('  '+l.trim()); });
  findings.sections.requireConfig = abLines;

  // Fetch all aboveStore dist files
  var distFiles = {};
  var seen = {};
  abLines.forEach(function(line){
    var m = line.match(/"aboveStore\/dist\/([^"]+)"/);
    if (m && !seen[m[1]]) { seen[m[1]]=true; distFiles[m[0]]=m[1]; }
  });
  for (var key in distFiles) {
    var modName = distFiles[key];
    var url = ODS_URL+'/asp/optimized-scripts/aboveStore/dist/'+modName+'.js';
    var dr = await fetch(url,{headers:{Cookie:cookie,'User-Agent':ua}});
    if (dr.ok) {
      var dt = await dr.text();
      console.log('\n['+modName+'] '+dt.length+' bytes full content:');
      console.log(dt);
      findings.sections['dist_'+modName] = dt;
    }
  }

  // B. commons.main.js deep search
  console.log('\n--- B. commons.main.js ---');
  var cmRes = await fetch(ODS_URL+'/asp/optimized-scripts/commons.main.js',
    {headers:{Cookie:cookie,'User-Agent':ua}});
  var cmText = await cmRes.text();

  var cmFindings = {};
  var searchTerms = ['categoryId','getReportsForView','aboveStoreInStore','exportType',
    'contentDisposition','InStoreTime','inStoreTime','storeId','reportDate','startDate'];
  searchTerms.forEach(function(term){
    var snippets=[]; var idx=0;
    while((idx=cmText.indexOf(term,idx))>=0 && snippets.length<5) {
      snippets.push(cmText.substring(Math.max(0,idx-120),Math.min(cmText.length,idx+200)));
      idx+=term.length;
    }
    cmFindings[term]=snippets;
    if(snippets.length) {
      console.log('\n['+term+'] found '+snippets.length+'x:');
      snippets.forEach(function(s){ console.log('  ...'+s.replace(/\n/g,' ')+'...'); });
    }
  });
  findings.sections.commonsMain = cmFindings;

  // C. Flow init with each categoryId
  console.log('\n--- C. categoryId init + getReportsForView ---');
  var catResults = [];
  var storeId=29865, dateStr='2026-04-18';
  for (var cat=1; cat<=8; cat++) {
    var csrf = await getFreshCsrf(cookie, ua);
    var hdrs = {Cookie:cookie,'User-Agent':ua,
      'X-Requested-With':'OWASP CSRFGuard Project',
      'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
    hdrs[csrf.name]=csrf.value;

    var initUrl = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId='+cat;
    var ir = await fetch(initUrl,{headers:hdrs});
    var ihtml = await ir.text();
    var iKey = (ihtml.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/))||[];
    iKey = iKey[1]||null;
    var iTitle = (ihtml.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    var catRes = {cat:cat,key:iKey,title:iTitle,getReportsForView:null};
    console.log('categoryId='+cat+': key='+iKey+' title="'+iTitle+'"');

    if (!iKey) { catResults.push(catRes); continue; }

    // Try getReportsForView GET
    csrf = await getFreshCsrf(cookie, ua);
    hdrs[csrf.name]=csrf.value;
    var pdfUrl = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
      +'&_flowExecutionKey='+encodeURIComponent(iKey)
      +'&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment'
      +'&storeId='+storeId+'&date='+dateStr+'&categoryId='+cat;
    var pr = await fetch(pdfUrl,{headers:hdrs});
    var pct = pr.headers.get('content-type')||'';
    var ptxt = await pr.text();
    var pt = (ptxt.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    var pnk = (ptxt.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/))||[];
    pnk=pnk[1]||null;
    catRes.getReportsForView = {status:pr.status,ct:pct,title:pt,newKey:pnk};
    console.log('  getReportsForView -> '+pr.status+' ct='+pct.substring(0,40)+' title="'+pt+'" newKey='+pnk);

    if (pct.indexOf('pdf')>=0||pct.indexOf('octet')>=0) {
      fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf',Buffer.from(ptxt));
      catRes.getReportsForView.PDF_SAVED=true;
      catResults.push(catRes);
      findings.sections.catResults=catResults;
      await pushToGitHub(findings);
      console.log('*** PDF SAVED ***'); return;
    }

    // If non-error new key, dump the response HTML key section
    if (pnk && pt.indexOf('Error')<0 && pt.indexOf('Login')<0) {
      var respLines = ptxt.split('\n');
      var keyLines = [];
      respLines.forEach(function(line,idx){
        var lc=line.toLowerCase();
        if(lc.indexOf('<input')>=0||lc.indexOf('<button')>=0||lc.indexOf('_eventid')>=0
           ||lc.indexOf('data-event')>=0||lc.indexOf('abovestore')>=0||lc.indexOf('categoryid')>=0) {
          keyLines.push('L'+(idx+1)+': '+line.trim().substring(0,200));
        }
      });
      catRes.getReportsForView.interestingLines = keyLines;
      console.log('  Interesting lines in response:');
      keyLines.slice(0,10).forEach(function(l){ console.log('    '+l); });
    }
    catResults.push(catRes);
  }
  findings.sections.catResults = catResults;

  // D. REST API + direct JRS report execution endpoint
  console.log('\n--- D. JRS REST report execution ---');
  var jrsPaths = [
    '/asp/rest_v2/reports/aboveStore/InStoreTime.pdf?storeId=29865&date=2026-04-18',
    '/asp/rest_v2/reports/aboveStore/inStoreTime.pdf?storeId=29865&date=2026-04-18',
    '/asp/rest_v2/reports/IST.pdf?storeId=29865&date=2026-04-18',
    '/asp/rest_v2/reportExecutions',
    '/asp/rest_v2/resources?type=reportUnit&q=inStore',
    '/asp/rest_v2/resources?type=reportUnit&q=aboveStore',
    '/asp/rest_v2/resources?type=reportUnit&q=InStore',
    '/asp/rest_v2/resources/aboveStore',
    '/asp/rest_v2/resources/reports/aboveStore',
  ];
  var restResults = {};
  for (var ri=0; ri<jrsPaths.length; ri++) {
    var rp=jrsPaths[ri];
    var csrf2=await getFreshCsrf(cookie,ua);
    var rhdrs={Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
               'Accept':'application/json'};
    rhdrs[csrf2.name]=csrf2.value;
    var rr=await fetch(ODS_URL+rp,{headers:rhdrs});
    var rct=rr.headers.get('content-type')||'';
    var rt=await rr.text();
    restResults[rp]={status:rr.status,ct:rct,body:rt.substring(0,2000)};
    console.log('  '+rp.padEnd(60)+' -> '+rr.status+' '+rct.substring(0,30)+'  '+rt.substring(0,100));
    if(rr.status===200&&(rct.indexOf('json')>=0||rct.indexOf('xml')>=0)) {
      console.log('    BODY: '+rt.substring(0,500));
    }
    if(rct.indexOf('pdf')>=0||rct.indexOf('octet')>=0) {
      fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf',Buffer.from(rt));
      console.log('  *** PDF SAVED ***');
    }
  }
  findings.sections.jrsRest = restResults;

  await pushToGitHub(findings);
  console.log('\nDone.');
}
main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
