# P.AI

An AI command centre for Ayvaz Pizza LLC. Node/Express on Render at
https://pai-ayvaz.onrender.com, Postgres, no build step. `npm test` is Jest.

## Before you tell Harold something is ready

```
npm test && npm run preflight
```

`npm run preflight` talks to the live site over the real network with the real
key. It is not optional and it is not covered by the tests, because everything
it checks lives in the join between this code and something outside it — which
is where every launch-day fault has actually been:

- the API key with no credit behind it, so every reading 502s
- a question pointing at a picture that was never deployed
- the answer key leaking into what the phone gets
- two questions pointing at one video, so the wrong list gets read

Tests passed through all four. They had to.

If the reading fails, it is almost always billing. The Max plan's $100 of API
credit only reaches the API once an organisation is linked at
claude.ai/settings/billing, and it must be the organisation the key belongs
to. claude.ai "usage credits" are a different pot and do not count.

## Things that are not obvious from the code

- **Audit templates are database rows.** `data/audits/*.json` are seeds, lifted
  once ever via the `audit_template_seeds` ledger. Editing a file does not
  change a live walk — that goes through `POST /api/audits/templates`, and a
  file already in the ledger will never seed again.
- **Saving a template bumps its version, and a version change wipes answers for
  anyone mid-walk.** Do not edit a live template while stores are walking it.
- **This repo is public.** Nothing with a face, a phone number or a Pizza Hut
  confidentiality mark gets committed. `data/people.json` and `reference/*.pdf`
  are gitignored for that reason. Stage file by file; never `git add -A`.
- **Claude reads images, not video.** The phone takes one still a second off
  the clip and sends the strip; the video itself never leaves the phone.
- Walks are public (no login) — `/form`, `/stores`, `/check`, `/read-clip` and
  `/submit` must stay above `router.use(requireAuth)` in `routes/audits.js`.

## Working here

Smallest complete change. Finish every part it touches — callers, tests,
fixtures. Say what you skipped and what you did not check.
