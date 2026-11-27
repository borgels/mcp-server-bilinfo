# Changelog

## 0.1.0

- First version, built from the MCP server template: nine tools for a car
  dealer's everyday work in Bilinfo, from the APIs Bilinfo publishes on
  developer.bilinfo.net (read 27 November 2026).
- Listing API (HTTP Basic): `bilinfo_list_vehicles` lists a dealer's vehicles
  for sale with filters (make, model, fuel, price range, model year, free
  text), sorting and paging; `bilinfo_get_vehicle` returns one listing with
  every field Bilinfo sends; `bilinfo_stock_overview` counts listings and
  cars, adds up asking prices per price type and groups cars by make and by
  days since they were created in Bilinfo.
- Car API (OAuth 2.0, client credentials): `bilinfo_save_car` creates a car
  for the instance's dealer or changes one the connection created (the whole
  car, with a version that only grows), including taking its ad off Bilbasen
  and DBA with visibility `Internal`; `bilinfo_mark_car_sold` marks a car as
  sold; `bilinfo_list_car_options` reads the colours, upholstery and extra
  equipment a car's ids come from. Bilinfo's answer to a change is passed on
  as its status number and our own Danish sentence, never Bilinfo's message.
- Leads API: `bilinfo_list_leads` reads the dealer's leads from Bilbasen,
  Bilinfo and DBA by version; `bilinfo_update_lead` sets a lead's status and,
  when given, the customer's contact details.
- Model Catalog: `bilinfo_find_model` looks a car up by registration number,
  VIN, or make, model, year and fuel, for the variant id a car needs.
- Changes are off by default, logged before they are sent, sent once, and out
  of reach of the read tools. Nothing deletes a car or a lead. A change with
  `actAs` is refused: Bilinfo's APIs have no users to act as.
- `BILINFO_ENVIRONMENT=qa` uses Bilinfo's QA addresses; an optional
  subscription key of Bilinfo's API gateway is sent to the Car API, Leads API
  and Model Catalog.
- Nothing is stored: every tool call asks Bilinfo and passes the answer on.
  No answer is kept between calls, and neither is the access token.
- No credential is refused for its form: any length, with spaces, with æ, ø
  and å, or with words that also stand in the server's own texts. Secrets
  that can be told from ordinary text are redacted as whole values and
  checked for in every output.
- Tool titles and descriptions, errors and refusals are in Danish.
- Gateway (`./gateway`) in the template's shape: explicit credentials,
  instance policy from the host, call scopes, the sink check and a frozen
  tool catalog with the upstream request of each tool.
