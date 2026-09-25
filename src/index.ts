interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * EDINET — Japan's corporate-filings system (Financial Services Agency).
 *
 * EDINET is the Japanese counterpart of SEC EDGAR: securities reports
 * (有価証券報告書), quarterly and half-year reports, extraordinary reports,
 * large-shareholding reports (大量保有報告書), tender offers, and the XBRL /
 * PDF / CSV documents behind them, published by the FSA.
 *
 * TWO SOURCES, TWO ACCESS RULES — that split is the whole shape of this pack:
 *
 *  1. The EDINET code list (Edinetcode.zip) is published by the FSA with no
 *     credential at all. `edinet_search_filers` reads it, so the resolver step
 *     — "which EDINET code is Toyota?" — works for every caller.
 *  2. The EDINET API v2 (api.edinet-fsa.go.jp) needs a free Subscription-Key.
 *     Registration is self-service (email + emailed verification code +
 *     password + CAPTCHA) and is NOT restricted to Japanese entities, but the
 *     CAPTCHA makes it a human step. The two filing-list tools therefore take
 *     `_apiKey` and any caller can supply their own today.
 *
 * THIS PACK SHIPPED BYOK, AND THAT WAS A DECISION ABOUT A BROKEN VENDOR SITE,
 * NOT A PREFERENCE (fleet #1942, 2026-09-16). We have an EDINET account —
 * Bruce registered one — but EDINET's own key-issuance page renders BLANK on
 * their side, so the account cannot yield a key. Rather than hold a finished
 * pack behind a third party's outage, the keyless resolver ships for everyone
 * and the two keyed tools take the caller's key.
 *
 * DO NOT declare `platformKeyEnv: 'PLATFORM_EDINET_KEY'` until the secret is
 * actually set, in the SAME change. `keyBlockedTools()` sinks a tool that
 * declares `_apiKey` with no platformKeyEnv, so today the router honestly
 * returns no_match for the keyed legs; declaring the env var early un-sinks
 * routing and sends Japanese-filings questions to a tool that can only
 * refuse — strictly worse than the honest miss (the fda-inspections
 * precedent, #617).
 *
 * There is no company-search endpoint upstream: the API lists filings BY DATE
 * and nothing else. `edinet_company_filings` is the workaround — it walks the
 * daily lists over a bounded date range and keeps the rows for one filer. That
 * is one upstream request per day in the range, which is why the range is
 * capped.
 */


const UA = 'pipeworx-mcp-edinet/1.0 (+https://pipeworx.io)';
const API_BASE = 'https://api.edinet-fsa.go.jp/api/v2';
const CODELIST_URL = 'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip';

// The code list is a ~570 KB ZIP that changes once a day; re-pulling it per
// call would dominate the latency of a lookup that is otherwise a string match.
const CODELIST_TTL_SECONDS = 21_600; // 6h
const MAX_CODELIST_BYTES = 32 * 1024 * 1024;
const MAX_RANGE_DAYS = 31;

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'EDINET (Financial Services Agency)');
}

// ── EDINET code list (keyless) ──────────────────────────────────────────

export interface Filer {
  edinet_code: string;
  filer_type: string;
  listed: string | null;
  consolidated: string | null;
  capital_thousand_jpy: number | null;
  fiscal_year_end: string | null;
  filer_name: string;
  filer_name_en: string | null;
  filer_name_kana: string | null;
  location: string | null;
  industry: string | null;
  sec_code: string | null;
  ticker: string | null;
  corporate_number: string | null;
}

/** Filer types that identify a natural person rather than an organisation. */
function isIndividual(filerType: string): boolean {
  return filerType.startsWith('個人');
}

/** Minimal ZIP reader: sizes come from the central directory, per sec-ftd. */
async function unzipSingle(bytes: Uint8Array, suffix: string): Promise<Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65_558; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EDINET code list: ZIP central directory not found');
  const total = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  const ascii = new TextDecoder();

  for (let i = 0; i < total; i++) {
    if (offset + 46 > bytes.length || dv.getUint32(offset, true) !== 0x02014b50) break;
    const method = dv.getUint16(offset + 10, true);
    const compressedSize = dv.getUint32(offset + 20, true);
    const uncompressedSize = dv.getUint32(offset + 24, true);
    const nameLength = dv.getUint16(offset + 28, true);
    const extraLength = dv.getUint16(offset + 30, true);
    const commentLength = dv.getUint16(offset + 32, true);
    const localOffset = dv.getUint32(offset + 42, true);
    const name = ascii.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).toLowerCase();
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith(suffix)) continue;
    if (uncompressedSize > MAX_CODELIST_BYTES) throw new Error('EDINET code list exceeds size limit');
    if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLength = dv.getUint16(localOffset + 26, true);
    const localExtraLength = dv.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = bytes.subarray(start, start + compressedSize);
    if (method === 0) return payload;
    if (method === 8) {
      const src = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(payload); c.close(); } });
      const buf = await new Response(src.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error(`EDINET code list: unsupported ZIP compression method ${method}`);
  }
  throw new Error(`EDINET code list: ZIP contained no ${suffix} member`);
}

/** RFC4180-ish splitter — the code list quotes every field and names contain commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function blankToNull(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

async function loadFilers(): Promise<Filer[]> {
  const res = await pwFetch(CODELIST_URL, {
    cf: { cacheTtl: CODELIST_TTL_SECONDS, cacheEverything: true },
  } as RequestInit);
  if (!res.ok) throw new Error(`EDINET code list: HTTP ${res.status} from disclosure2dl.edinet-fsa.go.jp`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const csvBytes = await unzipSingle(zip, '.csv');
  // The FSA publishes this file in Shift_JIS, not UTF-8.
  const text = new TextDecoder('shift_jis').decode(csvBytes);

  const lines = text.split(/\r?\n/);
  const rows: Filer[] = [];
  // Line 0 is a "downloaded on <date>, <n> records" banner; line 1 is the header.
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    if (c.length < 13 || !c[0]) continue;
    const filerType = c[1].trim();
    const secCode = blankToNull(c[11]);
    const capital = Number(c[4]);
    rows.push({
      edinet_code: c[0].trim(),
      filer_type: filerType,
      listed: blankToNull(c[2]),
      consolidated: blankToNull(c[3]),
      capital_thousand_jpy: Number.isFinite(capital) && c[4].trim() !== '' ? capital : null,
      fiscal_year_end: blankToNull(c[5]),
      filer_name: c[6].trim(),
      filer_name_en: blankToNull(c[7]),
      filer_name_kana: blankToNull(c[8]),
      // An individual filer's 所在地 is a home address. Corporate registered
      // offices stay; personal ones are dropped rather than redistributed.
      location: isIndividual(filerType) ? null : blankToNull(c[9]),
      industry: blankToNull(c[10]),
      sec_code: secCode,
      // The list carries the 5-digit securities code (Toyota = "72030"); the
      // ticker everyone quotes is the leading 4 ("7203").
      ticker: secCode && /^\d{5}$/.test(secCode) ? secCode.slice(0, 4) : secCode,
      corporate_number: isIndividual(filerType) ? null : blankToNull(c[12]),
    });
  }
  if (rows.length === 0) throw new Error('EDINET code list parsed to zero filers — upstream format may have changed');
  return rows;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[\s　]+/g, '');
}

/** Does the query appear as a whole word (English) in either name form? */
function hasWholeWord(f: Filer, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return false;
  for (const name of [f.filer_name_en, f.filer_name]) {
    if (!name) continue;
    for (const token of name.toLowerCase().split(/[\s　,.、。()（）]+/)) {
      if (token && token === q) return true;
    }
  }
  return false;
}

function nameLength(f: Filer): number {
  return (f.filer_name_en ?? f.filer_name).length;
}

async function searchFilers(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new Error('edinet_search_filers requires a `query` — a company name in Japanese or English (e.g. "Toyota", "トヨタ自動車"), an EDINET code ("E02144"), or a securities code ("7203").');
  }
  const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50);
  const listedOnly = args.listed_only === true;

  const filers = await loadFilers();
  const q = normalise(query);
  const qDigits = query.replace(/\D/g, '');

  const scored: Array<{ filer: Filer; score: number }> = [];
  for (const f of filers) {
    if (listedOnly && f.listed !== '上場') continue;
    let score = 0;
    if (f.edinet_code.toLowerCase() === q) score = 100;
    else if (qDigits.length === 4 && f.ticker === qDigits) score = 95;
    else if (qDigits.length === 5 && f.sec_code === qDigits) score = 95;
    else {
      const name = normalise(f.filer_name);
      const nameEn = normalise(f.filer_name_en ?? '');
      const kana = normalise(f.filer_name_kana ?? '');
      if (name === q || nameEn === q) score = 90;
      else if (name.startsWith(q) || nameEn.startsWith(q)) score = 70;
      else if (name.includes(q) || nameEn.includes(q) || kana.includes(q)) score = 50;
      // A whole-word hit beats a prefix that merely happens to line up:
      // "toyota" prefix-matches TOYO TANSO CO.,LTD. once spaces are stripped.
      if (score > 0 && hasWholeWord(f, query)) score += 8;
    }
    if (score > 0) {
      // A listed operating company is what "Toyota" nearly always means.
      if (f.listed === '上場') score += 3;
      scored.push({ filer: f, score });
    }
  }
  scored.sort((a, b) =>
    b.score - a.score
    // Among equal scores the shorter name is the closer match: TOYOTA MOTOR
    // CORPORATION before TOYOTA BOSHOKU CORPORATION for "Toyota".
    || nameLength(a.filer) - nameLength(b.filer)
    || a.filer.edinet_code.localeCompare(b.filer.edinet_code));

  return {
    query,
    total_filers: filers.length,
    match_count: scored.length,
    filers: scored.slice(0, limit).map((s) => s.filer),
    source: 'EDINET code list (EDINETコードリスト), Financial Services Agency of Japan',
    note: scored.length === 0
      ? 'No filer matched. Try the Japanese name (トヨタ自動車), the English name as the FSA spells it (TOYOTA MOTOR CORPORATION), or the 4-digit ticker.'
      : undefined,
  };
}

// ── EDINET API v2 (needs a Subscription-Key) ────────────────────────────

interface EdinetDocument {
  seqNumber?: number;
  docID?: string;
  edinetCode?: string | null;
  secCode?: string | null;
  JCN?: string | null;
  filerName?: string | null;
  fundCode?: string | null;
  ordinanceCode?: string | null;
  formCode?: string | null;
  docTypeCode?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  submitDateTime?: string | null;
  docDescription?: string | null;
  issuerEdinetCode?: string | null;
  subjectEdinetCode?: string | null;
  parentDocID?: string | null;
  withdrawalStatus?: string | null;
  disclosureStatus?: string | null;
  xbrlFlag?: string | null;
  pdfFlag?: string | null;
  englishDocFlag?: string | null;
  csvFlag?: string | null;
  legalStatus?: string | null;
}

interface EdinetListResponse {
  metadata?: {
    resultset?: { count?: number };
    processDateTime?: string;
    status?: string;
    message?: string;
  };
  results?: EdinetDocument[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireKey(apiKey: string | undefined, tool: string): string {
  if (!apiKey) {
    throw new Error(
      `${tool} requires an API key: the EDINET API v2 needs a free Subscription-Key from the Financial Services Agency. Pass it as _apiKey. Register at https://api.edinet-fsa.go.jp/api/auth/index.aspx?mode=1 (email + password, open to non-Japanese registrants). The keyless edinet_search_filers tool still works without one.`,
    );
  }
  return apiKey;
}

function edinetApiError(status: number, tool: string): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `${tool} requires an API key that EDINET accepts (HTTP ${status}: invalid or missing Subscription-Key). Pass a valid key as _apiKey — register free at https://api.edinet-fsa.go.jp/api/auth/index.aspx?mode=1.`,
    );
  }
  if (status === 404) {
    return new Error(`EDINET ${tool}: no data for that date (HTTP 404). EDINET keeps daily lists for the last 10 years; future dates return nothing.`);
  }
  return new Error(`EDINET ${tool} error: HTTP ${status} from api.edinet-fsa.go.jp`);
}

function shapeDocument(d: EdinetDocument) {
  return {
    doc_id: d.docID ?? null,
    edinet_code: d.edinetCode ?? null,
    sec_code: d.secCode ?? null,
    ticker: d.secCode && /^\d{5}$/.test(d.secCode) ? d.secCode.slice(0, 4) : (d.secCode ?? null),
    corporate_number: d.JCN ?? null,
    filer_name: d.filerName ?? null,
    doc_type_code: d.docTypeCode ?? null,
    doc_description: d.docDescription ?? null,
    form_code: d.formCode ?? null,
    ordinance_code: d.ordinanceCode ?? null,
    period_start: d.periodStart ?? null,
    period_end: d.periodEnd ?? null,
    submitted_at: d.submitDateTime ?? null,
    subject_edinet_code: d.subjectEdinetCode ?? null,
    parent_doc_id: d.parentDocID ?? null,
    withdrawn: d.withdrawalStatus === '1',
    has_xbrl: d.xbrlFlag === '1',
    has_pdf: d.pdfFlag === '1',
    has_csv: d.csvFlag === '1',
    has_english: d.englishDocFlag === '1',
    // Append &Subscription-Key=<your key> to fetch: the key is never echoed
    // into a returned URL, so these are safe to hand on.
    document_paths: d.docID
      ? {
          xbrl_zip: `${API_BASE}/documents/${d.docID}?type=1`,
          pdf: `${API_BASE}/documents/${d.docID}?type=2`,
          english_zip: `${API_BASE}/documents/${d.docID}?type=4`,
          csv_zip: `${API_BASE}/documents/${d.docID}?type=5`,
        }
      : null,
  };
}

async function fetchDay(date: string, apiKey: string, tool: string): Promise<EdinetDocument[]> {
  const params = new URLSearchParams({ date, type: '2', 'Subscription-Key': apiKey });
  const res = await pwFetch(`${API_BASE}/documents.json?${params}`);
  if (!res.ok) throw edinetApiError(res.status, tool);
  const data = (await res.json()) as EdinetListResponse;
  const status = data.metadata?.status;
  if (status && status !== '200') {
    throw new Error(`EDINET ${tool}: upstream status ${status} — ${data.metadata?.message ?? 'no message'}`);
  }
  return data.results ?? [];
}

async function listFilings(args: Record<string, unknown>, apiKey: string | undefined) {
  const key = requireKey(apiKey, 'edinet_list_filings');
  const date = String(args.date ?? '').trim();
  if (!ISO_DATE.test(date)) {
    throw new Error(`edinet_list_filings requires \`date\` as YYYY-MM-DD (a single JST filing day, e.g. "2026-09-11"). Got "${date}".`);
  }
  const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 500);
  const edinetCode = blankToNull(args.edinet_code as string | undefined);
  const secCode = blankToNull(args.sec_code as string | undefined);
  const docType = blankToNull(args.doc_type_code as string | undefined);
  const xbrlOnly = args.xbrl_only === true;

  let docs = await fetchDay(date, key, 'edinet_list_filings');
  const total = docs.length;
  if (edinetCode) docs = docs.filter((d) => d.edinetCode === edinetCode);
  if (secCode) {
    const digits = secCode.replace(/\D/g, '');
    docs = docs.filter((d) => d.secCode === digits || (d.secCode ?? '').slice(0, 4) === digits);
  }
  if (docType) docs = docs.filter((d) => d.docTypeCode === docType);
  if (xbrlOnly) docs = docs.filter((d) => d.xbrlFlag === '1');

  return {
    date,
    filings_on_date: total,
    match_count: docs.length,
    filings: docs.slice(0, limit).map(shapeDocument),
    source: 'EDINET API v2 書類一覧API, Financial Services Agency of Japan',
  };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function companyFilings(args: Record<string, unknown>, apiKey: string | undefined) {
  const key = requireKey(apiKey, 'edinet_company_filings');
  const edinetCode = blankToNull(args.edinet_code as string | undefined);
  const secCodeArg = blankToNull(args.sec_code as string | undefined);
  if (!edinetCode && !secCodeArg) {
    throw new Error('edinet_company_filings requires `edinet_code` (e.g. "E02144") or `sec_code` (e.g. "7203"). Resolve either with edinet_search_filers, which needs no key.');
  }
  const to = String(args.to ?? '').trim();
  const from = String(args.from ?? '').trim();
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new Error(`edinet_company_filings requires \`from\` and \`to\` as YYYY-MM-DD. Got from="${from}", to="${to}".`);
  }
  if (from > to) throw new Error('edinet_company_filings: `from` must not be after `to`.');

  // One upstream request per day: EDINET has no company-search endpoint, so a
  // company's filings are found by walking the daily lists.
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > MAX_RANGE_DAYS) {
      throw new Error(`edinet_company_filings: range is capped at ${MAX_RANGE_DAYS} days (EDINET lists filings by date, so each day is one upstream request). Narrow the window, or call repeatedly.`);
    }
  }

  const digits = secCodeArg ? secCodeArg.replace(/\D/g, '') : null;
  const matches: EdinetDocument[] = [];
  const daysWithData: string[] = [];
  for (const day of days) {
    const docs = await fetchDay(day, key, 'edinet_company_filings');
    if (docs.length) daysWithData.push(day);
    for (const d of docs) {
      const hit = (edinetCode && d.edinetCode === edinetCode)
        || (digits && (d.secCode === digits || (d.secCode ?? '').slice(0, 4) === digits));
      if (hit) matches.push(d);
    }
  }
  matches.sort((a, b) => String(b.submitDateTime ?? '').localeCompare(String(a.submitDateTime ?? '')));

  return {
    edinet_code: edinetCode,
    sec_code: digits,
    from,
    to,
    days_scanned: days.length,
    days_with_filings: daysWithData.length,
    match_count: matches.length,
    filings: matches.map(shapeDocument),
    source: 'EDINET API v2 書類一覧API, Financial Services Agency of Japan',
    note: matches.length === 0
      ? 'No filings by this filer in the window. Japanese annual reports (有価証券報告書) cluster in the three months after a fiscal year end — most listed companies close 31 March and file in late June.'
      : undefined,
  };
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'edinet_search_filers',
    description:
      'Resolve a Japanese company to its EDINET code and securities code from the FSA\'s official EDINET filer list — the lookup every other EDINET call needs. Searches Japanese name, English name, kana, EDINET code and ticker across ~11,000 filers, and returns industry, listing status, fiscal year end and corporate number. Needs no API key. Example: edinet_search_filers({ query: "Toyota" }) → E02144 / 7203.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Company name in Japanese or English, an EDINET code (E02144), or a securities code / ticker (7203).',
        },
        listed_only: {
          type: 'boolean',
          description: 'Only return exchange-listed filers (上場). Default false.',
        },
        limit: { type: 'number', description: 'Max filers to return, 1-50. Default 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'edinet_list_filings',
    description:
      'Every disclosure document filed with EDINET on one day — annual and quarterly securities reports, extraordinary reports, large-shareholding reports, tender offers — with filer, document type, period and which formats (XBRL / PDF / CSV / English) exist. Optionally filter to one filer or document type. Requires a free EDINET Subscription-Key via _apiKey. Example: edinet_list_filings({ date: "2026-09-11", limit: 20 }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Filing date (JST) as YYYY-MM-DD. EDINET keeps the last 10 years.' },
        edinet_code: { type: 'string', description: 'Keep only this filer, e.g. "E02144".' },
        sec_code: { type: 'string', description: 'Keep only this securities code / ticker, e.g. "7203".' },
        doc_type_code: { type: 'string', description: 'Keep only this EDINET document-type code, e.g. "120" (annual securities report).' },
        xbrl_only: { type: 'boolean', description: 'Keep only filings that have XBRL. Default false.' },
        limit: { type: 'number', description: 'Max filings to return, 1-500. Default 50.' },
        _apiKey: { type: 'string', description: 'EDINET API v2 Subscription-Key.' },
      },
      required: ['date', '_apiKey'],
    },
  },
  {
    name: 'edinet_company_filings',
    description:
      'All EDINET filings by one Japanese company over a date range of up to 31 days, newest first. EDINET has no company-search endpoint, so this walks the daily filing lists and keeps that filer\'s rows. Identify the company with edinet_search_filers first. Requires a free EDINET Subscription-Key via _apiKey. Example: edinet_company_filings({ edinet_code: "E02144", from: "2026-06-01", to: "2026-06-30" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edinet_code: { type: 'string', description: 'EDINET code of the filer, e.g. "E02144" (Toyota).' },
        sec_code: { type: 'string', description: 'Securities code / ticker instead of an EDINET code, e.g. "7203".' },
        from: { type: 'string', description: 'Start date (JST) as YYYY-MM-DD.' },
        to: { type: 'string', description: 'End date (JST) as YYYY-MM-DD, at most 31 days after `from`.' },
        _apiKey: { type: 'string', description: 'EDINET API v2 Subscription-Key.' },
      },
      required: ['from', 'to', '_apiKey'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined) || undefined;
  delete args._apiKey;

  switch (name) {
    case 'edinet_search_filers':
      return searchFilers(args);
    case 'edinet_list_filings':
      return listFilings(args, apiKey);
    case 'edinet_company_filings':
      return companyFilings(args, apiKey);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 }, provider: 'EDINET (Financial Services Agency of Japan)' } satisfies McpToolExport;
