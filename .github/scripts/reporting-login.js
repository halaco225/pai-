'use strict';
// reporting-login-playwright-snippet.js
// Robust Playwright pattern for legacy reporting.smg.com ASP.NET login.

const REPORTING_ORIGIN = 'https://reporting.smg.com';
const LOGIN_URL = 'https://reporting.smg.com/MultiLanguage.aspx';

async function getAspxAuthCookie(context) {
  const cookies = await context.cookies(REPORTING_ORIGIN);
  return cookies.find(c => c.name === '.ASPXAUTH') || null;
}

async function waitForAspxAuthCookie(context, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cookie = await getAspxAuthCookie(context);
    if (cookie && cookie.value) return cookie;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

async function loginToReporting(page, context, username, password, options = {}) {
  const timeoutMs = options.timeoutMs || 45000;

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  const formDebug = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select, button')).map(el => ({
      tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'),
      id: el.getAttribute('id'), visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    }))
  );
  console.log('Reporting login form controls: ' + JSON.stringify(formDebug.filter(e => e.visible)));

  const usernameSelector = [
    'input[name*="User" i]', 'input[id*="User" i]', 'input[name*="Login" i]',
    'input[id*="Login" i]',  'input[type="text"]',   'input:not([type])',
  ].join(', ');

  const passwordSelector = [
    'input[type="password"]', 'input[name*="Password" i]', 'input[id*="Password" i]',
  ].join(', ');

  const userInput = page.locator(usernameSelector).first();
  const passInput = page.locator(passwordSelector).first();

  await userInput.waitFor({ state: 'visible', timeout: timeoutMs });
  await passInput.waitFor({ state: 'visible', timeout: timeoutMs });

  // Use click + keyboard typing to trigger legacy JS events
  await userInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await userInput.type(username, { delay: 25 });
  await userInput.evaluate(el => {
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  });

  await passInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await passInput.type(password, { delay: 25 });
  await passInput.evaluate(el => {
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('reporting.smg.com')) console.log('Reporting response: ' + response.status() + ' ' + url);
  });

  const submitCandidates = [
    'input[type="submit"]', 'button[type="submit"]', 'input[id*="Submit" i]',
    'input[name*="Submit" i]', 'input[id*="Login" i][type="submit"]', 'button[id*="Login" i]',
  ].join(', ');

  const submit = page.locator(submitCandidates).first();
  const authWait = waitForAspxAuthCookie(context, timeoutMs);

  if (await submit.count()) {
    await submit.click();
  } else {
    await passInput.press('Enter');
  }

  // Concrete success condition: .ASPXAUTH cookie
  const authCookie = await authWait;
  if (!authCookie) {
    const currentUrl = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    throw new Error('Reporting login did not produce .ASPXAUTH cookie. URL: ' + currentUrl + ' body: ' + bodyText.slice(0, 500));
  }

  console.log('Reporting login succeeded — .ASPXAUTH cookie acquired.');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);
  return authCookie;
}

module.exports = { loginToReporting, getAspxAuthCookie, waitForAspxAuthCookie };
