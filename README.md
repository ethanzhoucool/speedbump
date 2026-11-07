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

- **Sessions.** By default X, Instagram and Facebook get 3 sessions of 15 min a day (45 min total), Reddit gets 15 min a day, and YouTube and TikTok get 3 sessions of 30 min. Every group has a 15 min cooldown between sessions.
- **The pause.** Groups with "Ask first" show a screen with a breathing timer. Closing the tab takes one click. "Continue" unlocks after 5 seconds, plus 5 more for every session that day that used all its time, up to 30. Backing out or ending a session early doesn't add to it.
- **Intent.** Before a session you can type what you're there for. It stays in a small timer in the corner of the page.
- **Ending.** A session ends when time's up, when you click End, or after 2 minutes away from the site. Unused minutes go back into the day's budget, and the cooldown still starts.
- **Loosening is slow.** Raising a limit, shortening a cooldown, removing a site, turning a group off, allow-listing a site or shortening the lock all count as loosening. You type a sentence (no pasting), then the change waits 24 hours. After that you have 24 hours to come back, type it again and confirm, or it lapses. Saving any other change in between cancels the request.
- **Extra time costs tomorrow.** On the cooldown or "done for today" screen you can borrow 10 minutes, once per group per day. You write why (40+ characters), type a sentence and wait 90 seconds with the tab in front. Those 10 minutes come off tomorrow's budget.
- **Search only.** On a cooldown or once the day's time is gone, YouTube and Reddit stay open for looking things up instead of stopping at the gate. YouTube keeps a search page, one page of results and the video player, with no recommendations, comments, Shorts, channels or autoplay. Reddit keeps a search page, results and threads, with no feeds or subreddit pages. Any other URL goes back to the search page, and when a session runs out its tabs go there too. None of this uses up time. Other sites in the group, like TikTok, still stop at the gate. It's the "Search" checkbox in Settings: turning it off is instant, turning it on counts as loosening. "More time" on the page leads to the gate for borrowing.
- **Agent pass.** For letting Claude in Chrome read a limited site. Chrome won't let one extension read another's pages, so the pass is on `https://example.com/#speedbump=<url>` instead. It shows a random triple integral with a long exact-fraction answer. The problem can't be copied, the answer can't be pasted, and there are 2 minutes per problem. A reload or a wrong answer gives a new one. Solving it opens the site in that one tab for 15 minutes. Other tabs stay limited, and budgets, cooldowns, pauses and stats don't change.
- **Nuclear mode.** Pick a length in the popup (30 min by default, up to 24 h) and click twice. Every tab on a limited site closes right away, and so does any you open until the timer ends. Gate screens and agent-pass tabs close too. Running sessions end and their unused minutes go back into the day's budget. Always-allowed sites and groups that are turned off aren't touched. There's no off switch, and restarting Chrome doesn't end it.
- **The one way out.** Turning the extension off in `chrome://extensions` can't be blocked. Everything else goes through the rules above. Turning it back on resumes any nuclear mode that still has time left.

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
| `src/popup.ts` | Toolbar popup with today's status and the nuclear mode controls. |
| `src/agent.ts` | Content script for the agent pass page on example.com. |
| `src/pill.ts` | Content script for the timer in the corner of limited sites. |
| `src/strip.ts`, `strip.css` | Content script and rules for search-only mode on YouTube and Reddit. |
| `test/` | Node tests for `core.ts`. |

## Development

```bash
npm test           # runs test/*.test.ts with Node's built-in runner (Node 23.6+)
npm run typecheck  # strict type check of src and test
```

## License

MIT
