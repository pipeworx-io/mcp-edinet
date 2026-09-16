# edinet — Japanese corporate filings (EDINET, Financial Services Agency)

**Status: PUBLIC, shipped BYOK 2026-09-16** (fleet #1942/#1928). The keyless
company lookup works for every caller with no credential; the two filing-list
tools take the CALLER's own EDINET Subscription-Key as `_apiKey`. See "Auth"
below for why it shipped that way rather than on a platform key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

EDINET is Japan's EDGAR: securities reports (有価証券報告書), quarterly and
half-year reports, extraordinary reports, large-shareholding reports
(大量保有報告書), tender offers, and the XBRL/PDF/CSV documents behind them.

## Tools

| Tool | Key? | What it does |
|---|---|---|
| `edinet_search_filers` | **no** | Resolve a Japanese company → EDINET code + securities code, from the FSA's official EDINET code list (~11,400 filers). Searches Japanese name, English name, kana, EDINET code and ticker. |
| `edinet_list_filings` | yes | Every document filed on one day, optionally filtered to a filer / document type / XBRL-only. |
| `edinet_company_filings` | yes | One filer's filings over a range of ≤31 days, newest first. |

## The two access rules

1. **The code list is keyless.** `https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip`
   is served by the FSA with no credential — a ~570 KB ZIP holding one
   Shift_JIS CSV. The pack unzips it (`DecompressionStream('deflate-raw')`) and
   decodes it (`TextDecoder('shift_jis')`); **both are supported in workerd**,
   verified 2026-09-13 on a local `wrangler dev`, which is worth knowing because
   no other pack in this repo decodes a legacy Japanese encoding.
2. **The API v2 needs a free Subscription-Key**, passed by the caller as
   `_apiKey`. Sent upstream as the `Subscription-Key` query parameter.

## Auth

**BYO key.** `edinet_search_filers` needs none. `edinet_list_filings` and
`edinet_company_filings` require an EDINET API v2 Subscription-Key, which the
caller supplies as `_apiKey`; without one they refuse with the words "requires
an API key", so the gateway books the refusal as a gate rather than as a defect
of ours.

Pipeworx holds **no** platform key for EDINET, and that is a decision, not an
oversight (fleet #1942, 2026-09-16). Bruce registered an EDINET account — the
account exists — but the FSA's own key-issuance page rendered **blank** on
their side, so the account could not yield a key. Rather than hold a finished
pack behind a third party's outage, the pack shipped BYOK.

*Anyone re-checking this:* the thing to look at is the key page behind a
logged-in EDINET account, not the pre-auth URL — `…/api/auth/index.aspx?mode=1`
302s to Azure B2C and answers normally whether or not the page behind the login
works, so probing it unauthenticated tells you nothing either way.

If a key is obtained, `platformKeyEnv: 'PLATFORM_EDINET_KEY'` goes in the
manifest in the **same change** that lands `wrangler secret put` — declaring it
early un-sinks routing and points Japanese-filings questions at tools that can
only refuse (the fda-inspections precedent, #617).

## Traps

- **There is no company-search endpoint.** The API lists filings BY DATE and
  nothing else (`documents.json?date=YYYY-MM-DD&type=2`). "Toyota's filings" is
  therefore a walk of the daily lists — one upstream request per day, which is
  why `edinet_company_filings` caps its range at 31 days. Resolve the company
  first with the keyless `edinet_search_filers`.
- **The securities code has five digits.** Toyota is `72030` in EDINET and
  `7203` on the exchange. Both tools accept either and return both
  (`sec_code` / `ticker`).
- **Shift_JIS, not UTF-8.** Decoding the code list as UTF-8 yields mojibake for
  every Japanese name, silently — the ASCII columns still parse.
- **Individual filers.** ~3,200 of the ~11,400 rows are natural persons
  (大量保有報告書 filers, `提出者種別` starting 個人). Their `所在地` is a home
  address, so the pack drops `location` for those rows and keeps it for
  organisations.
- **Annual reports cluster.** Most listed Japanese companies close 31 March and
  file in late June; an empty two-week window is usually the calendar, not a bug.

## Why there is no platform key (history)

EDINET API v2 registration is **not** 法人番号-gated (that was the worry carried
over from NTA houjin-bangou — see fleet #1928). It is an Azure AD B2C
self-service signup whose form asks for exactly four things:

    email · emailed verification code · password · CAPTCHA

Field IDs read live off the signup page, 2026-09-13:
`email`, `emailVerificationCode`, `newPassword`, `reenterPassword`,
`captchaEntered` / `challengeString` / `captchaControlChallengeCode`
("ボットを倒すお手伝いをします"). No organisation, no corporate number, no
Japanese address — a US individual can register.

The CAPTCHA made registration a human step, so it went to Bruce. He did it —
and then EDINET's key-issuance page came back blank (2026-09-16). The pack was
promoted BYOK at that point rather than waiting on a vendor website.

What is still outstanding, for whoever picks this up when the page recovers:

1. `wrangler secret put PLATFORM_EDINET_KEY` on the gateway.
2. Add `platformKeyEnv: 'PLATFORM_EDINET_KEY'` to the `edinet` entry in
   `workers/gateway/src/pack-manifest.json`, in that same change.
3. **Replace the two keyed `tool-examples.json` entries with calls that
   actually returned rows.** As shipped, `edinet:edinet_list_filings` and
   `edinet:edinet_company_filings` carry argument shapes taken from the FSA's
   own spec (ESE140206, *EDINET API仕様書 Version 2*) and from a real EDINET
   code we resolved live (`E02144` = Toyota) — but **the calls themselves have
   never completed**, because we have never held a key. Treat those two
   examples as unverified until someone runs them.

## Verified live (keyless half only)

2026-09-13, re-run 2026-09-16 against the promoted pack:

```
edinet_search_filers({query:"Toyota", limit:3})   → 6 matches of 11,389 filers
  E02144  7203  トヨタ自動車株式会社 / TOYOTA MOTOR CORPORATION
  E02505  8015  豊田通商株式会社   / TOYOTA TSUSHO CORPORATION
  E00540  3116  トヨタ紡織株式会社 / TOYOTA BOSHOKU CORPORATION
edinet_search_filers({query:"トヨタ自動車"})       → 1 match  (E02144)
edinet_search_filers({query:"7203"})               → 1 match  (E02144)
edinet_search_filers({query:"E02144"})             → 1 match  (E02144)
edinet_search_filers({query:"Mitsubishi UFJ", listed_only:true})
                                                   → E03606 / 8306
```

`edinet_list_filings` and `edinet_company_filings` refuse without a key, with the
words "requires an API key" so the gateway books the refusal as a gate rather
than an error.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "edinet": {
      "url": "https://gateway.pipeworx.io/edinet/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/edinet/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "edinet": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-edinet"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-edinet
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Edinet data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
