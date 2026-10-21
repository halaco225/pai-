// The in-app assistant's one endpoint.
//
// Behind requireAuth because the answer names pages and permissions that only
// make sense to someone already signed in, and because an open endpoint on
// somebody else's API key is an open tab on their bill.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const agent = require('../services/pai-agent');

router.use(requireAuth);

const MAX_QUESTION = 1000;

router.post('/ask', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Ask something first.' });
  if (question.length > MAX_QUESTION) {
    return res.status(400).json({ error: 'That is too long. Ask it in a sentence or two.' });
  }

  try {
    const answer = await agent.navigate({
      question,
      page: String(req.body?.page || '').slice(0, 120),
      user: req.session.user,
    });

    // The model is told to put a route on its own last line as "GO: /intel".
    // Pulling it out here, against the real list of routes, means a made-up
    // page becomes no button rather than a dead link.
    const ROUTES = ['/dashboard', '/intel', '/velocity', '/tracker', '/audits',
                    '/pl-analyzer', '/weekly-recap'];
    let go = null;
    const text = answer.replace(/^\s*GO:\s*(\S+)\s*$/im, (line, route) => {
      if (ROUTES.includes(route)) { go = route; return ''; }
      return '';
    }).trim();

    res.json({ answer: text, go });
  } catch (e) {
    console.error('agent/ask:', e);
    res.status(500).json({ error: e.message || 'P.AI could not answer that right now.' });
  }
});

module.exports = router;
