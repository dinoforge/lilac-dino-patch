# GitHub issue #3 — Windows usability verification

- Date: 2026-10-12
- Branch: `codex/issue-3-windows-usability`
- Base: `856d40fc7b9f937315042fc753a0505e2cb4f955` (`codex/issue-2-patch-02-03`)

## Patch 03 home connection

Patch 03 ON now inserts the unified five-provider catalog at the top of the existing home screen and loads its browse results immediately. The existing provider-specific full catalog remains reachable from the new home. Patch 03 OFF leaves the original home and `#allView` available. The compatibility probe now requires the original `#homeView` anchor.

The isolated Windows Electron test used the official v0.5.15 `src/index.html` from commit `16c9a3d1631061a72831e0657434003940daf531`, copied to a temporary fixture with isolated Electron profile data. It verified ON/OFF rendering, original-catalog navigation, five provider calls, deduplication, search, merged episode choices, provider failure isolation, and Linkkf selection through a mocked resolver. The test made zero external requests; provider data and playback were simulated.

## Patch 02 and public provider reachability

The isolated v0.5.14 renderer check retained the embedded ChatGPT window and manual copy/import flow and saved a validated subtitle under a temporary profile. No real ChatGPT account was used. Web auto-submit, response extraction, and chat deletion remain unsupported and unverified.

One unauthenticated homepage GET was made per provider, without retries or access-control workarounds. These checks establish homepage reachability only; they do not establish app search, catalog contents, stream access, or playback.

| Provider | Result |
| --- | --- |
| RE:Anime | PASS — HTTP 200 |
| Miruro | PASS — HTTP 200 |
| Animenosub | PASS — HTTP 200 |
| 애니24 (`ani.ohli24.com`) | BLOCKED / NOT VERIFIED — fetch failed (`TypeError`) |
| Linkkf | BLOCKED / NOT VERIFIED — fetch failed (`TypeError`) |

## Verification and boundaries

- `node --test dino-lilac-patch/test/structure.test.cjs`: 10 passed, 0 failed, 0 skipped.
- The first full run found one stale synthetic compatibility fixture (390 passed, 1 failed); after adding the required `#homeView` anchor, final `npm test` with isolated official v0.5.14 and v0.5.15 source fixtures passed 391, failed 0, skipped 0.
- Patch 03 isolated Electron test: passed against actual v0.5.15 `src/index.html`; mocked provider IPC/resolvers; 0 external requests.
- Patch 02 isolated Electron test: passed with temporary profile and network blocked; no real account.
- Actual provider search and video playback were not tested. GitHub Actions were not run.
- `D:\LilacAnime`, user profiles, `main`, and actual media/user data were not accessed or modified. No ChatGPT web conversations were deleted.
