# Speedbump

A Chrome extension that puts a speed bump in front of distracting sites. Each group of sites gets a daily budget split into short sessions with a cooldown between them, so the time can't all go in one sitting. Tightening your limits is instant. Loosening them takes a day.

## Install

```bash
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open the extension's **Details** and turn on **Allow in Incognito**, or private windows skip every limit.
4. Pin it so the countdown badge shows.

`npm run build` compiles `src/*.ts` into this folder, which is what Chrome loads. After a change, rebuild (or run `npm run watch`) and press the reload arrow on the extension card.

## How it works

- **Sessions.** By default X, Instagram, Facebook and Reddit get 3 sessions of 15 min a day (45 min total), and YouTube and TikTok get 3 sessions of 30 min. Every group has a 15 min cooldown between sessions.
- **The pause.** Groups with "Ask first" show a screen with a breathing timer. Closing the tab takes one click. "Continue" unlocks after 5 seconds, plus 5 more for every session that day that used all its time, up to 30. Backing out or ending a session early doesn't add to it.
- **Intent.** Before a session you can type what you're there for. It stays in a small timer in the corner of the page.
- **Ending.** A session ends when time's up, when you click End, or after 2 minutes away from the site. Unused minutes go back into the day's budget, and the cooldown still starts.
- **Loosening is slow.** Raising a limit, shortening a cooldown, removing a site, turning a group off, allow-listing a site or shortening the lock all count as loosening. You type a sentence (no pasting), then the change waits 24 hours. After that you have 24 hours to come back, type it again and confirm, or it lapses. Saving any other change in between cancels the request.
- **Extra time costs tomorrow.** On the cooldown or "done for today" screen you can borrow 10 minutes, once per group per day. You write why (40+ characters), type a sentence and wait 90 seconds with the tab in front. Those 10 minutes come off tomorrow's budget.
- **The one way out.** Turning the extension off in `chrome://extensions` can't be blocked. Everything else goes through the rules above.

## Why it's designed this way

- The [one sec study (PNAS, 2023)](https://one-sec.app/max-planck-study) found that a short pause before opening an app cut opens by 57% over six weeks. The biggest effect came from offering a clear way to back out, then from the delay itself. A reflection message alone didn't help. So "Close tab" is the main button and the delay grows with each full session.
- Research on [implementation intentions](https://pubmed.ncbi.nlm.nih.gov/21317315/) says swapping a habit for a specific alternative works better than "don't do X". Set the "Instead" button in Settings to something you'd rather do.
- A cooldown between sessions stops a 45 minute budget from turning into one 45 minute binge.

## Project layout

| Path | What it is |
|---|---|
| `src/core.ts` | Pure rules: sessions, budgets, cooldowns, borrowing, loosening checks. No `chrome.*`. |
| `src/background.ts` | Service worker: watches navigation, redirects to the gate, ends sessions, stores state. |
| `src/messages.ts` | Typed messages between the pages and the service worker. |
| `src/gate.ts` | The pause, session setup, cooldown and borrow screens. |
| `src/options.ts` | Settings page. |
| `src/popup.ts` | Toolbar popup with today's status. |
| `src/pill.ts` | Content script for the timer in the corner of limited sites. |
| `test/` | Node tests for `core.ts`. |

## Development

```bash
npm test           # runs test/*.test.ts with Node's built-in runner (Node 23.6+)
npm run typecheck  # strict type check of src and test
```

## License

MIT
