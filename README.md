# mcp-server-bilinfo

A [Model Context Protocol](https://modelcontextprotocol.io) server for Bilinfo, the system Danish car dealers use to manage their cars and advertise them on Bilbasen and DBA. It lets an MCP client (Claude or any other MCP-capable assistant) do a dealer's everyday work in Bilinfo through the APIs Bilinfo publishes for integrators: read the cars for sale (Listing API), create a car, change its price, text and equipment, take its ad off Bilbasen and DBA, mark it as sold (Car API), read leads and set their status (Leads API), and look up the model of a car (Model Catalog).

> This is an independent, unofficial project. It is not developed, endorsed or supported by Bilinfo.

- Reads, and three changes: save a car, mark a car as sold, set the status of a lead. Changes are off until the one who sets the server up turns them on, a read tool is handed a client that cannot send a change, and a change is logged before it is sent and sent once.
- Nothing is deleted: there is no tool that deletes a car or a lead. Taking an ad down keeps the car in Bilinfo; a sold car keeps its history.
- Nothing is stored: every tool call reads from Bilinfo and passes the answer on. No answer is kept, on disk or in memory, between calls, and neither is an access token.
- One set of Bilinfo credentials per server instance; the server does no per-user authorization itself (see [Security model](#security-model)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.
- Tool titles and descriptions, and every text a person can meet while using a tool (errors, refusals), are in Danish, written for people in a dealership rather than for developers.

## Tools

| Tool | Purpose |
|---|---|
| `bilinfo_check_connection` | Which parts of Bilinfo the connection reaches (vehicles for sale, cars, leads, model catalog): `ok`, `refused`, `not_set_up` or `unavailable` for each, from one small request per API. Nothing Bilinfo answers is passed on. |
| `bilinfo_list_vehicles` | The dealer's vehicles for sale, one compact row per listing: make, model, variant, model year, mileage, fuel, price and price type, the date the listing was created in Bilinfo and the days since. Filters: `make`, `model`, `fuel`, `priceMin`/`priceMax`, `yearMin`/`yearMax` and free text (`query`). Sorting by price or time listed; paged (`page`, `pageSize`). |
| `bilinfo_get_vehicle` | One listing with every field Bilinfo returns (prices, mileage, first registration, equipment, description, picture addresses, taxes, leasing terms, the dealer's contact details), and the other listings of the same car. |
| `bilinfo_stock_overview` | Number of listings and cars, total and average asking price per price type, cars per make, and cars by days since they were created in Bilinfo. |
| `bilinfo_find_model` | Bilinfo's model catalog: the variants that fit a registration number or VIN, or a make, model, year and fuel, with the variant id a car needs. |
| `bilinfo_list_car_options` | One of the lists whose ids a car uses: colours, upholstery, upholstery colours or extra equipment. |
| `bilinfo_list_leads` | The dealer's leads from Bilbasen, Bilinfo and DBA: the customer, the car, the message and when it came. Oldest first, at most 200 at a time, paged by version. |
| `bilinfo_update_lead` | **Change.** Sets a lead's status (contacted, test drive, offer, sold, lost, ...) and, when given, the customer's contact details. Takes the lead's id and version from the list: the lead is read first and changed only when it is the instance's dealer's and has not changed since. |
| `bilinfo_save_car` | **Change.** Creates a car for the dealer, or changes one this connection created: prices (cash, without tax, leasing), mileage, description, equipment, pictures, status and visibility. Visibility `Internal` takes the ad off Bilbasen and DBA and keeps the car in Bilinfo. |
| `bilinfo_mark_car_sold` | **Change.** Marks a car this connection created as sold: Bilinfo removes it from Bilbasen and keeps it with its history. |

## What Bilinfo offers, and what is here

Bilinfo's developer portal ([developer.bilinfo.net](https://developer.bilinfo.net)) publishes, for each API, its requests, fields and scopes, and a set of PDF documents. Read 27 November 2026. What this server does follows from them.

| API | What Bilinfo publishes | Here |
|---|---|---|
| Listing API | `GET /api/export`: every vehicle of the account (PDF "Bilinfo Listing API", v3.4/3.5). | The three vehicle tools. |
| Car API | `POST /api/dealers/{dealerId}/cars` (create or change a car: the whole car, with a version), `POST /api/dealers/{dealerId}/cars/sell`, `POST /api/dealers/{dealerId}/cars/{carId}/transfercar`, `POST /api/image/upload`, the lists `GET /api/cardetail/*` and a deprecated `GET /api/operationstatus/{id}`. No request reads a car back. | Save, sell and the lists. Not here: moving a car to another dealer, and uploading pictures (a car takes the addresses of pictures Bilinfo already has). |
| Leads API | `GET /api/leads?version=` (at most 200, oldest first), `PUT /api/leads/{id}`, `POST /api/leads`, `DELETE /api/leads/{id}`. | Read leads and set their status. Not here: creating a lead (it comes from the customer) and deleting one (it removes its history). |
| Model Catalog | `GET /api/drill-down`, `GET /api/drill-down-by-reg-vin-number`, `GET /api/variants/{id}`. | The two lookups. |
| Case Plugin, Shared Services, Valuation | For finance and insurance companies, dealer and user lookups, and valuations. | Not here: they are not a dealer's own everyday work. |

How the Car API works, and what follows:

- **The whole car each time.** Bilinfo sets a car to exactly what the last request holds. A change therefore sends every field again, not only the one that changes, with a version number higher than the last.
- **Only cars this connection created.** The Car API changes the cars an integration created; a car created directly in Bilinfo cannot be changed through it (Bilinfo's status 73). Bilinfo can link to such a car with the integration's id and `carId`.
- **The answer is a status number.** Bilinfo answers a change with a number from a fixed list (10 received, 20 being processed, 30 done, 40 and above refused, with the reason) and a message in its own words. The server passes on its own Danish sentence for the number, and the number when it is in its own table; never the message, and never a number it does not know.
- **Versions only grow.** Without a version from the caller, a car upload gets the time in whole seconds, and always more than the last version the process sent.
- **Ad off, not deleted.** `visibility: Internal` keeps the car in Bilinfo and takes it off Bilbasen and DBA. Marking a car as sold removes it from Bilbasen, and Bilinfo keeps it.

How the vehicle tools follow from the Listing API:

- **One request.** The Listing API has a single request, `GET /api/export`, which returns every vehicle of the account. It has no request for one vehicle, no filters (other than the dealer) and no paging. Every tool therefore reads the whole list and filters, pages or sums it before it answers. Nothing is kept for the next call.
- **Listings and cars.** `vehicleId` is the id of a listing (`VehicleId`). One car can have more than one listing, typically one for sale and one for leasing; they share `VehicleSourceId`. The overview counts both and says which is which.
- **Prices.** `Price` means what `PriceType` says: `RetailPrice` (cash price), `RetailPriceWithoutTax` (without registration tax), `Leasing` (per month) or `CallForPrice` (no price). Price filters, price sorting and totals use the two purchase prices only, and never add a monthly leasing price to them.
- **Age.** The API has no "days in stock". `daysSinceCreated` counts calendar days in Denmark from `CreatedDate`, the day the listing was created in Bilinfo, which is not always the day the car arrived.
- **Not in the Listing API:** a status (reserved, sold), purchase or cost price, and views. Sold vehicles leave the list. Vehicles the dealer has not marked for external use are not returned.
- **Fields as Bilinfo sends them.** `bilinfo_get_vehicle` returns the listing's fields unchanged (Bilinfo sends almost every value as text, dates as `dd-MM-yyyy`), except `Id` and `EquipmentList`, which Bilinfo's documentation calls legacy and deprecated. A new field Bilinfo adds shows up without a change here.

## Bilinfo credentials

Bilinfo creates every credential by hand: an integration is set up with Bilinfo, tested in Bilinfo's QA environment and then moved to production. The server cannot create credentials, and it never sends them anywhere but to Bilinfo's hosts (`bilinfo.net`, `ecgh.dk`).

- **The Listing API** uses HTTP Basic authentication: the user name and password of a Bilinfo API account (`BILINFO_USERNAME`, `BILINFO_PASSWORD`).
- **The Car API, the Leads API and the Model Catalog** use OAuth 2.0 access tokens from Bilinfo's authorization service: a client id and a client secret (`BILINFO_CLIENT_ID`, `BILINFO_CLIENT_SECRET`), which Bilinfo registers together with the scopes the client may use. The server asks for a token for the scope a tool needs (client credentials), uses it for that one call and does not keep it. Bilinfo's API gateway (publicapi.bilinfo.net) may also give a subscription key (`BILINFO_SUBSCRIPTION_KEY`, sent as `Ocp-Apim-Subscription-Key`).
- **The dealer.** The Car API creates, changes and sells cars for one dealer, by the dealer's GUID (Bilinfo, under dealer settings): `BILINFO_DEALER_ID`, or `dealerId` in the gateway. It also limits the vehicles and leads that are read to that dealer. It is never taken from a tool's input.
- **The environment.** `BILINFO_ENVIRONMENT=qa` (or `environment: 'qa'`) uses Bilinfo's QA addresses as the developer portal lists them; `production` is the default.

Not yet confirmed against Bilinfo, and to be settled in the QA environment:

- Bilinfo's own Car API example gets its token with the authorization code flow, signing in as a user of the dealer (scope `dealer` and the Car API's scopes, at `www.bilinfo.net/oauth/connect/token`); the section on the Car API in the Auth Services document is missing from the published file. Bilinfo's authorization services list the Car API's scopes and the client credentials grant, and that is what this server uses.
- The production addresses of the Car API, Leads API and Model Catalog are the QA paths without `qa`; the portal lists only the QA ones.
- Whether `PUT /api/leads/{id}` takes the id of a lead that came from Bilbasen (the request names it `externalId`), and whether the contact details may be left out.

An instance may have either pair or both. A tool that needs the missing one says so. Credentials are used exactly as given. No user name, password, secret or key is refused for its length or its characters; the one exception is a user name or client id with a colon, which HTTP Basic cannot carry.

## Quick start

Requires Node.js 22 or later and a Bilinfo API account.

```bash
npx mcp-server-bilinfo
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-bilinfo.git
cd mcp-server-bilinfo
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add bilinfo \
  --env BILINFO_USERNAME=<user name> --env BILINFO_PASSWORD=<password> \
  -- npx -y mcp-server-bilinfo
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "bilinfo": {
      "command": "npx",
      "args": ["-y", "mcp-server-bilinfo"],
      "env": {
        "BILINFO_USERNAME": "<user name>",
        "BILINFO_PASSWORD": "<password>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-bilinfo`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name bilinfo-mcp -p 127.0.0.1:3000:3000 \
  -e BILINFO_USERNAME=<user name> \
  -e BILINFO_PASSWORD=<password> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-bilinfo:latest

claude mcp add --transport http bilinfo http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `BILINFO_AUDIT_LOG` into it (e.g. `-v bilinfo-audit:/audit -e BILINFO_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Upstream API

| Variable | Default | Description |
|---|---|---|
| `BILINFO_USERNAME` | – | User name of the Bilinfo API account (Listing API). |
| `BILINFO_PASSWORD` | – | Password of the Bilinfo API account (Listing API). |
| `BILINFO_CLIENT_ID` | – | Client id registered with Bilinfo's authorization service (every service but the Listing API). |
| `BILINFO_CLIENT_SECRET` | – | Client secret that goes with the client id. |
| `BILINFO_SUBSCRIPTION_KEY` | – | Subscription key of Bilinfo's API gateway, sent as `Ocp-Apim-Subscription-Key` to the Car API, Leads API and Model Catalog. |
| `BILINFO_ENVIRONMENT` | `production` | `production` or `qa`: Bilinfo's test environment, which an integration goes through before production. |
| `BILINFO_DEALER_ID` | – | GUID of the dealer. The Car API tools create, change and sell this dealer's cars and no other's; reads of vehicles and leads are limited to it. |
| `BILINFO_BASE_URL` | `https://gw.bilinfo.net/listingapi` | Base URL of the Listing API. Must be `https` on `bilinfo.net` (loopback `http` is allowed for local mocks). |
| `BILINFO_ALLOW_CUSTOM_BASE_URL` | `false` | Allow addresses outside `bilinfo.net` and `ecgh.dk`, the two domains Bilinfo's services are on. |
| `BILINFO_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `BILINFO_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `BILINFO_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). The whole list is one response, roughly 3 KB per vehicle, so the default holds a few thousand vehicles; raise it for a larger account. |

Reads that fail with 429, 502, 503 or 504, or with a transient network error, are retried up to three times with backoff, honouring `Retry-After`. A change is sent once and never retried. Bilinfo's documentation states no rate limit; every vehicle tool call is one request for the whole list, so a client that calls often asks Bilinfo for the whole list often.

### Access control

| Variable | Default | Description |
|---|---|---|
| `BILINFO_ENABLE_WRITES` | `false` | Enable the tools that change something in Bilinfo (`bilinfo_save_car`, `bilinfo_mark_car_sold`, `bilinfo_update_lead`). |
| `BILINFO_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `bilinfo_` prefix. |
| `BILINFO_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids in clear text, free text (search words, make, model, fuel) hashed, duration, status and the caller passed by an embedding host. No answer from Bilinfo is written to it. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createBilinfoGateway, bilinfoToolCatalog } from 'mcp-server-bilinfo/gateway';

const gateway = createBilinfoGateway({
  username: tenant.username,
  password: tenant.password,
  clientId: integrator.clientId,
  clientSecret: integrator.clientSecret,
  dealerId: tenant.dealerId,
  policy: { enableWrites: false, audit: record => log(record) },
});
const result = await gateway.callTool('list_vehicles', { make: 'Skoda' }, { caller: 'user@example.test' });
```

- **Explicit credentials.** At least one pair is required: `username` and `password` (Listing API), `clientId` and `clientSecret` (Car API, Leads API, Model Catalog), or both; a pair with one part missing, or no pair at all, throws when the gateway is created. `subscriptionKey`, `dealerId` (the dealer whose cars are changed; it also limits what is read), `environment` and `baseUrl` are optional. A gateway never reads `BILINFO_USERNAME`, `BILINFO_PASSWORD`, `BILINFO_CLIENT_ID`, `BILINFO_CLIENT_SECRET`, `BILINFO_SUBSCRIPTION_KEY`, `BILINFO_DEALER_ID`, `BILINFO_ENVIRONMENT` or `BILINFO_BASE_URL` from the environment, so one tenant cannot silently fall back to the process's credentials. Credentials are used exactly as given: nothing is trimmed, and nothing is refused for its length or its characters.
- **The client is the integrator's, the dealer is the tenant's.** Bilinfo registers a client for an integrating party, not for one dealer, so the same client id and secret can serve every tenant. What a tenant can reach with it is therefore decided here: cars are created, changed and sold for the instance's `dealerId` only, leads and vehicles are limited to it, and no tool has an input that selects another dealer.
- **Several tenants in one process.** Create one gateway per set of credentials (and per dealer). Each instance redacts error text, tool results and audit records with its own secrets only; no secret is kept in a process-wide registry, and a dropped instance releases its secrets. The dealer an instance reads is fixed when it is created: no tool has an input that selects another dealer.
- **Nothing is kept.** A gateway holds its credentials and its settings, and no data: each call reads from Bilinfo and returns the answer to the host.
- **Instance policy from the host.** Pass `policy` to `createBilinfoGateway`: `enableWrites` (default false; it gates `save_car`, `mark_car_sold` and `update_lead`), `disabledTools` (must name known tools) and `audit`, a function that receives each audit record instead of `BILINFO_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads no policy or audit variable from the environment.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON, as the MCP specification recommends (many clients read only the text). The JSON is built from the redacted result, so it holds exactly `structuredContent`. An error result has only its text (in Danish), and, when Bilinfo answered with an HTTP error, `failure: { httpStatus, requestId? }`: the status, and the vendor's request id from a response header (`REQUEST_ID_HEADERS` in `src/errors.ts`) only when it is a hex id of 8 to 64 characters (one run of hex digits, or groups of four or more joined by single hyphens, as in a UUID) and does not hold the shape of a personal number. A host can count failures from it without reading their text. Never the response body, the vendor's error code or message.
- **Act as a person.** A host that has verified the person a call is made for passes `actAs: { email, name? }` in the call context (`src/act-as.ts`). None of Bilinfo's APIs has users to act as: the Listing API reads the account's vehicles, and the Car API and Leads API act as the client Bilinfo registered. A read with a valid `actAs` is therefore a plain read with the connection's credentials. A change with `actAs` is refused (`actAsRefused: 'not_permitted'`) and not sent, because it could only be made as the connection itself. The email is never sent to Bilinfo. A malformed `actAs` refuses the call (`actAsRefused: 'invalid'`) before anything is sent, as on every server, and only an absent `actAs` means no person (`null` is refused). The server adds the email to no audit record, text or field of its own.
- **Tool catalog.** `bilinfoToolCatalog` is a frozen list of every tool: `name` (without the `bilinfo_` prefix), `title`, `description`, `riskLevel` (`read`, `write` or `destructive`; the three changes are `write`: each replaces what was there, but none deletes anything, so their MCP annotation says `destructiveHint: true` while the catalog says `write`; every other tool is `read`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (true when a tool can read more than its name says, so a host gives it only to roles that may read everything) and `upstream`, the API requests the tool may make: `access`, `method`, the Bilinfo `service` and the `path` relative to that service. The request for an access token is not listed; every tool outside the Listing API makes it first.

## Threat model

What this server guarantees about the credentials, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

An instance has up to four secrets: the password and the client secret, and
the two encoded pairs (name and secret in base64) that are sent in the
`Authorization` header. "The secrets" below means all of them. The user name
and the client id are treated as configuration: they are never quoted in an
error, but they are not redacted from data. An access token lives for one
call and is never written anywhere by us; it is not one of "the secrets".

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one account, keeps best-effort
redaction: its errors and audit records are redacted with its secrets, but it
is not held to these guarantees.

**Guaranteed:**

- **(a) The secrets never reach anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own secrets before they leave it. The
  credentials are sent in a header, never in a URL.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A successful
  answer that is not the documented list of vehicles is refused with a fixed
  text and not passed on.
  Errors never quote the credentials, the configured address or a refused configuration value.
- **(c) Results go only to the tenant whose credentials they are.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state, and no answer is kept at all. The MCP
  server serves one account.

**No credential is refused for its form.** Bilinfo issues the credentials,
and whatever it issues has to work: short, with spaces, with `æ`, `ø` and
`å`, or holding words that also stand in this server's own texts. Nothing is
trimmed either.

**What leaves a gateway holds no secret it can recognise.** Results, errors
and audit records are redacted before they are serialised: the exact secret
and its URL- and JSON-encoded forms, in strings, object keys and the string
form of numbers and booleans, are replaced by `"‹redacted›"`. Then every
output is checked in its final form at the sink, and one that still holds a
secret is replaced by a fixed fallback (`src/fallbacks.ts`). Every error a
gateway throws is a fresh error in final form: no `cause`, a `stack` of only
`name: message`, and name, message and stack masked against the secrets.

**Not guaranteed (residual risk):**

- A secret is recognised by its value only when it has 8 characters or more
  and does not occur in one of this server's own fixed texts
  (`src/fixed-corpus.generated.ts`, kept up to date by a test). A shorter
  one, or one that is a word of ours, cannot be told from ordinary text.
  Looking for it would blank normal words out of every answer. Such a secret
  is still never written by us: credentials only go into the request header,
  and nothing Bilinfo answers is quoted in an error. It is not caught if
  Bilinfo itself sends it back in data.
- Only whole values are looked for, not pieces. A piece of a password is
  often an ordinary word (a car make, a town), and blanking such words out of
  a dealer's answers would make the password unusable. A secret that comes
  back cut, split, reversed, re-encoded or hashed is not recognised.
- Data that contains the customer's own password reaches only the tenant
  whose credentials they are, which already holds them. A password that
  stands whole in the vehicles (a password that is exactly a make and model,
  say) makes that text come back as `‹redacted›`.

The standalone MCP server applies the same redaction to errors and audit
records on a best-effort basis; its successful results are passed on as built
from the API's answer.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured Bilinfo credentials. Keep the password and the client secret out of anything shared and have them changed when someone who knew them leaves.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the account can see, limited to one dealer when a dealer id is set. To separate data, run several instances.
- **Changes are gated.** One tool changes something in Bilinfo. It does not run unless changes are turned on for the instance, it does not run unless its audit start record is written, it is sent once and never retried, and a read tool is handed a view of the client that refuses to send a change, so the gate does not rest on tool annotations alone. Nothing here deletes anything: Bilinfo documents no request that does.
- **Nothing is stored.** No answer from Bilinfo is cached or written anywhere; the optional audit log holds who called which tool and when, never what Bilinfo answered.
- **Upstream content is untrusted input.** A vehicle's description and other fields are written by people. Tool results label them as data; clients that combine this server with other tools should treat them accordingly.
- **The credentials stay on Bilinfo's origins.** Redirects are never followed, every address must use `https` on `bilinfo.net` or `ecgh.dk`, and error messages and audit records are redacted (by each instance, with that instance's secrets) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

The tests mock HTTP and need no account, network or container. Their dealers and vehicles are invented, in the form the API answers in.

Project layout:

| Path | Contents |
|---|---|
| `src/tools/bilinfo.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/bilinfo/` | Upstream client, the vehicle list and what the tools build from it (`vehicles.ts`), policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml` (and [docs/NEW-SERVER.md](docs/NEW-SERVER.md)).

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them.
